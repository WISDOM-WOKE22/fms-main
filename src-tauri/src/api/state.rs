//! Shared application state for the API server.

use crate::db::DbPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub struct AppConfig {
    pub email: String,
    pub password: String,
    pub license_key: String,
    pub main_backend_url: String,
    pub license_public_key_pem: String,
    pub license_issuer: String,
    pub company_name: String,
    pub company_image: String,
    pub super_admin_name: String,
    pub local_ai_url: String,
    /// Environment name (e.g. "development", "production"). Loaded from FMS_ENV.
    pub app_env: String,
    /// Whether to allow local dev-key fallback when cloud is unreachable. Loaded from FMS_ALLOW_DEV_LICENSE_FALLBACK.
    pub allow_dev_license_fallback: bool,
    /// When true, license keys are verified against the cloud backend.
    /// When false, keys are matched locally against FMS_LICENSE_KEY only.
    /// Loaded from FMS_LICENSE_KEY_VERIFICATION_ENABLED (default: true).
    pub license_key_verification_enabled: bool,
}

/// Returns `true` only when BOTH conditions hold:
///   1. `allow_dev_license_fallback` is explicitly `true`
///   2. `app_env` is NOT "production" (case-insensitive)
pub fn is_dev_fallback_enabled(config: &AppConfig) -> bool {
    config.allow_dev_license_fallback
        && !config.app_env.trim().eq_ignore_ascii_case("production")
}

// ─── Stream session state ───────────────────────────────────────────

/// Status of a camera stream session.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamStatus {
    Starting,
    Online,
    Reconnecting,
    Offline,
    Error,
}

/// An active camera stream session managed by the stream manager.
pub struct StreamSession {
    /// RTSP source URL (never exposed to API responses).
    pub rtsp_url: String,
    /// Masked RTSP URL (credentials hidden) — safe to return.
    pub rtsp_url_masked: String,
    /// Current status.
    pub status: StreamStatus,
    /// Human-readable error message (if status == Error).
    pub error_message: Option<String>,
    /// Directory containing HLS output files.
    pub hls_dir: std::path::PathBuf,
    /// Handle to the background task managing ffmpeg.
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
    /// Cancellation token to signal the manager task to stop.
    pub cancel_token: tokio_util::sync::CancellationToken,
    /// When the session was created.
    pub created_at: std::time::Instant,
    /// Last time a viewer fetched an HLS file (for idle timeout).
    pub last_viewer_at: std::time::Instant,
    /// Number of reconnect attempts so far.
    pub reconnect_count: u32,
    // ─── AI recognition worker state ────────────────────────────────
    /// Zone this stream belongs to (for access-log scoping).
    pub zone_id: String,
    /// Stable camera identifier.
    pub camera_id: String,
    /// Whether AI recognition is enabled for this stream.
    pub ai_enabled: bool,
    /// Handle to the AI worker task (None if not running).
    pub ai_task_handle: Option<tokio::task::JoinHandle<()>>,
    /// Cancel token for the AI worker only (independent from stream cancel).
    pub ai_cancel_token: Option<tokio_util::sync::CancellationToken>,
    /// Total frames sent to AI.
    pub ai_frames_processed: u64,
    /// Total recognized events.
    pub ai_recognized_count: u64,
    /// Last time AI processed a frame (ISO string).
    pub ai_last_at: Option<String>,
    /// AI worker error message (None if healthy).
    pub ai_error: Option<String>,
    /// Latest AI recognition results JSON (for overlay rendering in UI).
    pub ai_latest_results: Option<serde_json::Value>,
    /// Track manager stats from Python service.
    pub ai_track_stats: Option<serde_json::Value>,
    /// Last recognition latency in ms.
    pub ai_latency_ms: Option<u64>,
    /// Number of cached track results in last frame.
    pub ai_cached_count: Option<u64>,
}

/// Shared map of stream sessions (streamId → session data).
pub type StreamSessions = Arc<Mutex<HashMap<String, StreamSession>>>;

// ─── Always-on AI camera session (independent from stream tester) ────

/// Worker health status for AI camera sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiWorkerStatus {
    /// Worker is processing frames normally.
    Running,
    /// Worker is experiencing transient errors but still retrying.
    Degraded,
    /// Worker has stopped due to unrecoverable errors.
    Fatal,
}

impl Default for AiWorkerStatus {
    fn default() -> Self {
        Self::Running
    }
}

/// An always-on AI camera worker that reads RTSP frames directly (no FFmpeg).
pub struct AiCameraSession {
    pub camera_id: String,
    pub zone_id: String,
    pub rtsp_url: String,
    pub rtsp_url_masked: String,
    pub enabled: bool,
    pub task_handle: Option<tokio::task::JoinHandle<()>>,
    pub cancel_token: Option<tokio_util::sync::CancellationToken>,
    pub frames_processed: u64,
    pub recognized_count: u64,
    pub last_at: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<std::time::Instant>,
    pub sampling_interval_ms: u64,
    /// Health status: running / degraded / fatal.
    pub worker_status: AiWorkerStatus,
    /// When continuous failures started (for time-window based fatal detection).
    pub failure_since: Option<std::time::Instant>,
    /// Latest AI recognition results JSON (for overlay rendering in UI).
    pub latest_results: Option<serde_json::Value>,
}

/// Shared map of AI camera sessions (cameraId → session).
pub type AiCameraSessions = Arc<Mutex<HashMap<String, AiCameraSession>>>;

/// Global AI concurrency semaphore (limits in-flight recognition requests).
pub type AiSemaphore = Arc<tokio::sync::Semaphore>;

// ─── Track event deduplication ──────────────────────────────────────

/// A tracking event for a specific person/track crossing into a zone.
#[derive(Debug, Clone)]
pub struct TrackEvent {
    /// ByteTrack track ID from Python.
    pub track_id: i64,
    /// Last known identity (person name or "Unknown").
    pub identity: String,
    /// Person ID from faces.db (empty if unknown).
    pub person_id: String,
    /// Whether this track has already been logged as entering the zone.
    pub zone_entered: bool,
    /// Last zone where this track was seen (empty when outside/no-zone).
    pub zone_id: String,
    /// Last confidence score.
    pub confidence: f64,
    /// When this track was last seen.
    pub last_seen: std::time::Instant,
    /// Last time we wrote an access-log event for this track.
    pub last_logged_at: Option<std::time::Instant>,
}

/// Per-camera track event map: camera_id → (track_id → TrackEvent).
pub type TrackEventMap = Arc<Mutex<HashMap<String, HashMap<i64, TrackEvent>>>>;

/// Check if a point (px, py) is inside a polygon using ray-casting algorithm.
/// `polygon` is a list of (x, y) vertices.
pub fn point_in_polygon(px: f64, py: f64, polygon: &[(f64, f64)]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        if ((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Compute the bottom-center of a bounding box [x1, y1, x2, y2].
pub fn bbox_bottom_center(bbox: &[f64; 4]) -> (f64, f64) {
    let cx = (bbox[0] + bbox[2]) / 2.0;
    let by = bbox[3]; // bottom y
    (cx, by)
}

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub config: Arc<AppConfig>,
    pub streams: StreamSessions,
    pub ai_cameras: AiCameraSessions,
    pub ai_semaphore: AiSemaphore,
    /// Per-camera track event state for deduplication.
    pub track_events: TrackEventMap,
}

impl AppState {
    pub fn new(db: DbPool, config: AppConfig) -> Self {
        let max_inflight = std::env::var("FMS_AI_MAX_INFLIGHT")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(3);
        Self {
            db,
            config: Arc::new(config),
            streams: Arc::new(Mutex::new(HashMap::new())),
            ai_cameras: Arc::new(Mutex::new(HashMap::new())),
            ai_semaphore: Arc::new(tokio::sync::Semaphore::new(max_inflight)),
            track_events: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
