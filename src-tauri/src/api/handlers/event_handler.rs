//! FMS Vision Pipeline — Rust EventHandler
//!
//! Receives detection events from the Python StreamProcessor (via gRPC push
//! or WebSocket) and handles:
//!   - Zone entry/exit detection using Ray-Casting point-in-polygon
//!   - Batched SQLite inserts (every 2 seconds) to prevent I/O blocking
//!   - Track deduplication and access log generation
//!   - Event coalescing per (person, zone) to avoid duplicate logs
//!
//! Architecture:
//!   Python StreamProcessor → gRPC stream → EventHandler.ingest()
//!                                              ↓
//!                                     ZoneEngine.check()
//!                                              ↓
//!                                    InsertBuffer.push()
//!                                              ↓
//!                                   (every 2s) batch INSERT → SQLite

use rusqlite::params;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::db;
use crate::db::DbPool;
use crate::api::state::AppState;

// ────────────────────────────────────────────────────────────────────
// Zone Engine — High-performance polygon containment
// ────────────────────────────────────────────────────────────────────

/// A loaded zone polygon for fast containment checks.
#[derive(Debug, Clone)]
pub struct ZonePolygon {
    pub zone_id: String,
    pub zone_name: String,
    pub vertices: Vec<(f64, f64)>,
}

/// High-performance point-in-polygon using Ray-Casting algorithm.
///
/// Tests whether point (px, py) lies inside the polygon defined by `vertices`.
/// Handles convex and concave polygons, and correctly processes edge cases
/// where the ray passes through a vertex.
///
/// Time complexity: O(n) where n = number of vertices.
#[inline]
pub fn is_point_in_polygon(px: f64, py: f64, polygon: &[(f64, f64)]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }

    let mut inside = false;
    let mut j = n - 1;

    for i in 0..n {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];

        // Check if the ray from (px, py) going right crosses edge (i, j)
        if ((yi > py) != (yj > py))
            && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
        {
            inside = !inside;
        }
        j = i;
    }

    inside
}

/// Compute the bottom-center point of a bounding box.
/// This is the "foot position" used for zone containment checks,
/// since a person's feet determine which zone they're standing in.
#[inline]
pub fn bbox_bottom_center(x1: f64, y1: f64, x2: f64, y2: f64) -> (f64, f64) {
    let cx = (x1 + x2) / 2.0;
    let by = y2; // bottom y
    (cx, by)
}

/// Load zone polygons from SQLite.
pub fn load_zone_polygons(db_pool: &DbPool) -> Vec<ZonePolygon> {
    db::with_db(db_pool, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, zonePolygon FROM zones WHERE zonePolygon IS NOT NULL AND zonePolygon != ''"
        )?;

        let zones = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let polygon_json: String = row.get(2)?;
            Ok((id, name, polygon_json))
        })?;

        let mut result = Vec::new();
        for zone in zones {
            if let Ok((id, name, json_str)) = zone {
                if let Ok(coords) = serde_json::from_str::<Vec<Vec<f64>>>(&json_str) {
                    let vertices: Vec<(f64, f64)> = coords
                        .iter()
                        .filter(|c| c.len() >= 2)
                        .map(|c| (c[0], c[1]))
                        .collect();

                    if vertices.len() >= 3 {
                        result.push(ZonePolygon {
                            zone_id: id,
                            zone_name: name,
                            vertices,
                        });
                    }
                }
            }
        }
        Ok::<Vec<ZonePolygon>, rusqlite::Error>(result)
    })
    .unwrap_or_default()
}

// ────────────────────────────────────────────────────────────────────
// Insert Buffer — Batched SQLite writes
// ────────────────────────────────────────────────────────────────────

/// A pending database insert for an access log entry.
#[derive(Debug, Clone)]
struct PendingInsert {
    id: String,
    person_id: String,
    person_name: String,
    employee_id: String,
    zone_id: String,
    camera_id: String,
    action: String,
    confidence: f64,
    provider: String,
    timestamp: String,
    track_id: i64,
    metadata_json: Option<String>,
}

/// A pending face recognition event insert.
#[derive(Debug, Clone)]
struct PendingFaceEvent {
    id: String,
    person_id: String,
    person_name: String,
    status: String,
    score: f64,
    threshold: f64,
    zone_id: String,
    camera_id: String,
    track_id: i64,
    raw_result_json: Option<String>,
    created_at: String,
}

/// Batched insert buffer that flushes to SQLite every `flush_interval`.
///
/// Instead of inserting each detection event immediately (which would cause
/// I/O blocking under high throughput), we buffer events and flush them in
/// a single transaction every 2 seconds.
pub struct InsertBuffer {
    access_logs: Vec<PendingInsert>,
    face_events: Vec<PendingFaceEvent>,
    last_flush: Instant,
    flush_interval: Duration,
    db_pool: DbPool,
}

impl InsertBuffer {
    pub fn new(db_pool: DbPool, flush_interval_secs: u64) -> Self {
        Self {
            access_logs: Vec::with_capacity(64),
            face_events: Vec::with_capacity(64),
            last_flush: Instant::now(),
            flush_interval: Duration::from_secs(flush_interval_secs),
            db_pool,
        }
    }

    /// Push an access log entry into the buffer.
    pub fn push_access_log(
        &mut self,
        person_id: &str,
        person_name: &str,
        zone_id: &str,
        camera_id: &str,
        action: &str,
        confidence: f64,
        track_id: i64,
        metadata: Option<serde_json::Value>,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        self.access_logs.push(PendingInsert {
            id: db::gen_id(),
            person_id: person_id.to_string(),
            person_name: person_name.to_string(),
            employee_id: person_id.to_string(),
            zone_id: zone_id.to_string(),
            camera_id: camera_id.to_string(),
            action: action.to_string(),
            confidence,
            provider: "ai-tracking".to_string(),
            timestamp: now.clone(),
            track_id,
            metadata_json: metadata.map(|m| m.to_string()),
        });
    }

    /// Push a face recognition event into the buffer.
    pub fn push_face_event(
        &mut self,
        person_id: &str,
        person_name: &str,
        status: &str,
        score: f64,
        threshold: f64,
        zone_id: &str,
        camera_id: &str,
        track_id: i64,
        raw_result: Option<serde_json::Value>,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        self.face_events.push(PendingFaceEvent {
            id: db::gen_id(),
            person_id: person_id.to_string(),
            person_name: person_name.to_string(),
            status: status.to_string(),
            score,
            threshold,
            zone_id: zone_id.to_string(),
            camera_id: camera_id.to_string(),
            track_id,
            raw_result_json: raw_result.map(|r| r.to_string()),
            created_at: now,
        });
    }

    /// Check if it's time to flush and do so if needed.
    /// Returns the number of rows written.
    pub fn maybe_flush(&mut self) -> usize {
        if self.access_logs.is_empty() && self.face_events.is_empty() {
            return 0;
        }
        if self.last_flush.elapsed() < self.flush_interval {
            return 0;
        }
        self.flush()
    }

    /// Force flush all buffered inserts to SQLite in a single transaction.
    pub fn flush(&mut self) -> usize {
        let access_batch: Vec<PendingInsert> = self.access_logs.drain(..).collect();
        let face_batch: Vec<PendingFaceEvent> = self.face_events.drain(..).collect();
        self.last_flush = Instant::now();

        let total = access_batch.len() + face_batch.len();
        if total == 0 {
            return 0;
        }

        let pool = self.db_pool.clone();
        let result: Result<usize, rusqlite::Error> = db::with_db(&pool, move |conn| {
            let tx = conn.unchecked_transaction()?;

            // Batch insert access logs
            for entry in &access_batch {
                tx.execute(
                    "INSERT INTO access_logs (id, personId, personName, employeeId, zoneId, cameraId, action, confidence, provider, timestamp, metadata, updatedAt) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        entry.id,
                        entry.person_id,
                        entry.person_name,
                        entry.employee_id,
                        entry.zone_id,
                        entry.camera_id,
                        entry.action,
                        entry.confidence,
                        entry.provider,
                        entry.timestamp,
                        entry.metadata_json,
                        entry.timestamp,
                    ],
                )?;
            }

            // Batch insert face recognition events
            for event in &face_batch {
                tx.execute(
                    "INSERT INTO face_recognition_events (id, personId, personName, status, score, threshold, provider, rawResultJson, createdAt, zoneId, cameraId, trackId) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        event.id,
                        event.person_id,
                        event.person_name,
                        event.status,
                        event.score,
                        event.threshold,
                        "python-local",
                        event.raw_result_json,
                        event.created_at,
                        event.zone_id,
                        event.camera_id,
                        event.track_id,
                    ],
                )?;
            }

            tx.commit()?;
            Ok(access_batch.len() + face_batch.len())
        });

        match result {
            Ok(count) => {
                if count > 0 {
                    tracing::debug!("[event-handler] Flushed {} rows to SQLite", count);
                }
                count
            }
            Err(e) => {
                tracing::error!("[event-handler] Batch flush failed: {}", e);
                0
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Event Handler — Main detection event processor
// ────────────────────────────────────────────────────────────────────

/// Key for deduplicating zone entry events: (person_id, zone_id).
type DeduplicationKey = (String, String);

/// Tracks the last time an access event was logged for a (person, zone) pair.
struct EventCooldown {
    last_logged: Instant,
}

/// Processes detection events from the Python StreamProcessor.
///
/// Responsibilities:
///   - Final zone entry/exit determination (Python sends preliminary zone_status,
///     Rust does the authoritative check with its own polygon data)
///   - Event deduplication (cooldown per person×zone)
///   - Batched SQLite inserts via InsertBuffer
///   - Sync queue management for cloud sync
pub struct EventHandler {
    insert_buffer: InsertBuffer,
    zone_polygons: Vec<ZonePolygon>,
    cooldowns: HashMap<DeduplicationKey, EventCooldown>,
    cooldown_duration: Duration,
}

impl EventHandler {
    /// Create a new EventHandler.
    ///
    /// * `db_pool` — SQLite connection pool
    /// * `flush_interval_secs` — How often to flush buffered inserts (default: 2)
    /// * `cooldown_secs` — Minimum time between duplicate access logs for the same person+zone
    pub fn new(db_pool: DbPool, flush_interval_secs: u64, cooldown_secs: u64) -> Self {
        let zone_polygons = load_zone_polygons(&db_pool);
        tracing::info!(
            "[event-handler] Loaded {} zone polygons",
            zone_polygons.len()
        );

        Self {
            insert_buffer: InsertBuffer::new(db_pool, flush_interval_secs),
            zone_polygons,
            cooldowns: HashMap::new(),
            cooldown_duration: Duration::from_secs(cooldown_secs),
        }
    }

    /// Reload zone polygons from DB (call after zone config changes).
    pub fn reload_zones(&mut self, db_pool: &DbPool) {
        self.zone_polygons = load_zone_polygons(db_pool);
        tracing::info!(
            "[event-handler] Reloaded {} zone polygons",
            self.zone_polygons.len()
        );
    }

    /// Ingest a batch of detection events from one frame.
    ///
    /// This is called for each `FrameDetections` message received from Python.
    /// It performs zone containment checks, deduplication, and buffers DB writes.
    pub fn ingest(&mut self, frame: &FrameDetection) {
        let stream_id = &frame.stream_id;
        let zone_id = &frame.zone_id;

        for detection in &frame.detections {
            // Skip unidentified persons for access logging
            if detection.person_id.is_empty() {
                continue;
            }

            // Authoritative zone check using Rust's polygon data
            let zone_status = self.check_zone_status(detection, zone_id);

            // Only log on zone entry events
            if zone_status == "entered" {
                let dedup_key = (detection.person_id.clone(), zone_id.clone());

                if self.is_cooled_down(&dedup_key) {
                    // Record the access log
                    self.insert_buffer.push_access_log(
                        &detection.person_id,
                        &detection.person_name,
                        zone_id,
                        stream_id,
                        "zone-entry",
                        detection.confidence as f64,
                        detection.track_id,
                        Some(serde_json::json!({
                            "trackId": detection.track_id,
                            "trackCached": detection.track_cached,
                            "isReidentified": detection.is_reidentified,
                            "pipeline": &frame.pipeline,
                        })),
                    );

                    // Record face recognition event
                    self.insert_buffer.push_face_event(
                        &detection.person_id,
                        &detection.person_name,
                        "recognized",
                        detection.confidence as f64,
                        0.5,
                        zone_id,
                        stream_id,
                        detection.track_id,
                        None,
                    );

                    // Update cooldown
                    self.cooldowns.insert(
                        dedup_key,
                        EventCooldown {
                            last_logged: Instant::now(),
                        },
                    );
                }
            }
        }

        // Flush if interval elapsed
        self.insert_buffer.maybe_flush();
    }

    /// Force flush any remaining buffered inserts.
    pub fn flush(&mut self) -> usize {
        self.insert_buffer.flush()
    }

    /// Check zone containment for a detection using the Rust-side polygon data.
    fn check_zone_status(
        &self,
        detection: &Detection,
        zone_id: &str,
    ) -> String {
        // Find the zone polygon
        let polygon = self.zone_polygons.iter().find(|z| z.zone_id == zone_id);

        if let Some(zone) = polygon {
            let (cx, by) = bbox_bottom_center(
                detection.bbox_x1 as f64,
                detection.bbox_y1 as f64,
                detection.bbox_x2 as f64,
                detection.bbox_y2 as f64,
            );

            if is_point_in_polygon(cx, by, &zone.vertices) {
                // Trust Python's zone_status for entered/inside distinction
                // since Python tracks the state transitions per-track
                if detection.zone_status == "entered" {
                    "entered".to_string()
                } else {
                    "inside".to_string()
                }
            } else {
                "outside".to_string()
            }
        } else {
            // No polygon configured — treat Python's zone_status as authoritative
            detection.zone_status.clone()
        }
    }

    /// Check if enough time has passed since the last log for this person+zone.
    fn is_cooled_down(&mut self, key: &DeduplicationKey) -> bool {
        // Clean up old cooldowns periodically
        if self.cooldowns.len() > 500 {
            let cutoff = Instant::now() - self.cooldown_duration * 2;
            self.cooldowns.retain(|_, v| v.last_logged > cutoff);
        }

        match self.cooldowns.get(key) {
            Some(cd) => cd.last_logged.elapsed() >= self.cooldown_duration,
            None => true,
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Wire format types (mirrors the proto messages as plain Rust structs
// for use without full gRPC codegen dependency)
// ────────────────────────────────────────────────────────────────────

/// A single detection event received from Python.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Detection {
    pub track_id: i64,
    pub person_id: String,
    pub person_name: String,
    pub confidence: f32,
    #[serde(default)]
    pub bbox_x1: f32,
    #[serde(default)]
    pub bbox_y1: f32,
    #[serde(default)]
    pub bbox_x2: f32,
    #[serde(default)]
    pub bbox_y2: f32,
    #[serde(default)]
    pub person_bbox: Option<Vec<f32>>,
    #[serde(default)]
    pub track_cached: bool,
    #[serde(default)]
    pub is_reidentified: bool,
    #[serde(default)]
    pub zone_status: String,
}

impl Detection {
    /// Populate bbox fields from person_bbox array if present.
    pub fn normalize_bbox(&mut self) {
        if let Some(ref bbox) = self.person_bbox {
            if bbox.len() >= 4 {
                self.bbox_x1 = bbox[0];
                self.bbox_y1 = bbox[1];
                self.bbox_x2 = bbox[2];
                self.bbox_y2 = bbox[3];
            }
        }
    }
}

/// A frame's worth of detections received from Python.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FrameDetection {
    pub stream_id: String,
    pub zone_id: String,
    pub frame_number: u64,
    pub timestamp_epoch: f64,
    pub detections: Vec<Detection>,
    #[serde(default)]
    pub persons_detected: u32,
    #[serde(default)]
    pub persons_identified: u32,
    #[serde(default)]
    pub pipeline: String,
    #[serde(default)]
    pub inference_ms: f32,
}

// ────────────────────────────────────────────────────────────────────
// Async wrapper for tokio runtime
// ────────────────────────────────────────────────────────────────────

/// Thread-safe async wrapper around EventHandler.
pub struct AsyncEventHandler {
    inner: Arc<Mutex<EventHandler>>,
}

impl AsyncEventHandler {
    pub fn new(state: &AppState, flush_interval_secs: u64, cooldown_secs: u64) -> Self {
        let handler = EventHandler::new(
            state.db.clone(),
            flush_interval_secs,
            cooldown_secs,
        );
        Self {
            inner: Arc::new(Mutex::new(handler)),
        }
    }

    /// Ingest a frame detection (called from gRPC/WebSocket handler).
    pub async fn ingest(&self, mut frame: FrameDetection) {
        // Normalize bboxes
        for det in &mut frame.detections {
            det.normalize_bbox();
        }
        let mut handler = self.inner.lock().await;
        handler.ingest(&frame);
    }

    /// Force flush remaining buffered inserts.
    pub async fn flush(&self) -> usize {
        let mut handler = self.inner.lock().await;
        handler.flush()
    }

    /// Reload zone polygons after configuration change.
    pub async fn reload_zones(&self, db_pool: &DbPool) {
        let mut handler = self.inner.lock().await;
        handler.reload_zones(db_pool);
    }

    /// Start periodic flush task.
    pub fn spawn_flush_task(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let handler = Arc::clone(&Arc::new(self.clone()));
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;
                handler.flush().await;
            }
        })
    }
}

impl Clone for AsyncEventHandler {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_in_polygon_square() {
        let square = vec![
            (0.0, 0.0),
            (10.0, 0.0),
            (10.0, 10.0),
            (0.0, 10.0),
        ];
        assert!(is_point_in_polygon(5.0, 5.0, &square));
        assert!(is_point_in_polygon(1.0, 1.0, &square));
        assert!(!is_point_in_polygon(11.0, 5.0, &square));
        assert!(!is_point_in_polygon(-1.0, 5.0, &square));
        assert!(!is_point_in_polygon(5.0, -1.0, &square));
    }

    #[test]
    fn test_point_in_polygon_triangle() {
        let tri = vec![
            (0.0, 0.0),
            (10.0, 0.0),
            (5.0, 10.0),
        ];
        assert!(is_point_in_polygon(5.0, 3.0, &tri));
        assert!(!is_point_in_polygon(0.0, 10.0, &tri));
        assert!(!is_point_in_polygon(10.0, 10.0, &tri));
    }

    #[test]
    fn test_point_in_polygon_concave_l_shape() {
        // L-shaped polygon
        let l_shape = vec![
            (0.0, 0.0),
            (5.0, 0.0),
            (5.0, 5.0),
            (10.0, 5.0),
            (10.0, 10.0),
            (0.0, 10.0),
        ];
        assert!(is_point_in_polygon(2.0, 2.0, &l_shape));   // inside lower part
        assert!(is_point_in_polygon(7.0, 7.0, &l_shape));   // inside upper right
        assert!(!is_point_in_polygon(7.0, 2.0, &l_shape));  // in the concave notch
    }

    #[test]
    fn test_point_in_polygon_degenerate() {
        // Less than 3 vertices
        assert!(!is_point_in_polygon(0.0, 0.0, &[]));
        assert!(!is_point_in_polygon(0.0, 0.0, &[(1.0, 1.0)]));
        assert!(!is_point_in_polygon(0.0, 0.0, &[(0.0, 0.0), (1.0, 1.0)]));
    }

    #[test]
    fn test_bbox_bottom_center() {
        let (cx, by) = bbox_bottom_center(100.0, 50.0, 200.0, 300.0);
        assert!((cx - 150.0).abs() < f64::EPSILON);
        assert!((by - 300.0).abs() < f64::EPSILON);
    }
}
