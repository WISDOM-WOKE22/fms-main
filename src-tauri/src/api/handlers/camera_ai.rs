//! Always-on AI camera orchestration — reads RTSP frames directly via the
//! Python AI service's `/grab-frame` endpoint, then sends to `/recognize/json`.
//! Completely independent from the FFmpeg/HLS stream tester.

use axum::{
    extract::{Path, State},
    response::Json,
};
use rusqlite::params;
use tokio_util::sync::CancellationToken;

use crate::api::error::ApiError;
use crate::api::state::{AiCameraSession, AppState, TrackEvent};
use crate::db;

const DEFAULT_SAMPLING_MS: u64 = 1000; // 1 FPS default
const AI_REQUEST_TIMEOUT_SECS: u64 = 10; // must be > Python's _OPEN_TIMEOUT (6s)

// Self-healing constants
/// Time window of continuous failures before declaring fatal (seconds).
const FATAL_FAILURE_WINDOW_SECS: u64 = 150; // ~2.5 minutes
/// Initial backoff after a grab/recognize error.
const BACKOFF_INITIAL_MS: u64 = 1000;
/// Maximum backoff cap.
const BACKOFF_MAX_MS: u64 = 15_000;
/// After this many consecutive grab failures, release the RTSP capture and retry.
const RELEASE_AFTER_GRAB_FAILURES: u32 = 5;
const TRACK_LOG_COOLDOWN_SECS: u64 = 12;

// ─── POST /api/v1/ai/cameras/start-all ──────────────────────────────

pub async fn start_all(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cameras = resolve_cameras(&state).await;
    let mut started = 0u32;
    let mut already = 0u32;
    let mut failed = 0u32;
    let mut per_camera: Vec<serde_json::Value> = Vec::new();

    let sampling_ms: u64 = std::env::var("FMS_AI_SAMPLE_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_SAMPLING_MS);

    for cam in &cameras {
        {
            let sessions = state.ai_cameras.lock().await;
            if let Some(existing) = sessions.get(&cam.camera_id) {
                if existing.enabled {
                    already += 1;
                    continue;
                }
            }
        }
        // Preflight: release stale capture and test camera before starting worker
        let ai_base = state.config.local_ai_url.trim().trim_end_matches('/').to_string();
        let preflight_ok = if !ai_base.is_empty() {
            preflight_camera(&ai_base, &cam.rtsp_url).await
        } else {
            true // no AI service URL configured — skip preflight
        };

        if !preflight_ok {
            let reason = format!("Preflight frame-test failed for {}", cam.rtsp_url_masked);
            tracing::warn!("[ai-cam:{}][preflight] {}", cam.camera_id, reason);
            per_camera.push(serde_json::json!({
                "cameraId": cam.camera_id,
                "status": "failed",
                "reason": reason,
            }));
            failed += 1;
            continue;
        }

        let cancel = CancellationToken::new();
        let session = AiCameraSession {
            camera_id: cam.camera_id.clone(),
            zone_id: cam.zone_id.clone(),
            rtsp_url: cam.rtsp_url.clone(),
            rtsp_url_masked: cam.rtsp_url_masked.clone(),
            enabled: true,
            task_handle: None,
            cancel_token: Some(cancel.clone()),
            frames_processed: 0,
            recognized_count: 0,
            last_at: None,
            error: None,
            started_at: Some(std::time::Instant::now()),
            sampling_interval_ms: sampling_ms,
            worker_status: crate::api::state::AiWorkerStatus::Running,
            failure_since: None,
            latest_results: None,
        };
        {
            let mut sessions = state.ai_cameras.lock().await;
            sessions.insert(cam.camera_id.clone(), session);
        }

        let ai_cameras = state.ai_cameras.clone();
        let config = state.config.clone();
        let semaphore = state.ai_semaphore.clone();
        let track_events = state.track_events.clone();
        let db_pool = state.db.clone();
        let cid = cam.camera_id.clone();
        let zid = cam.zone_id.clone();
        let url = cam.rtsp_url.clone();

        let handle = tokio::spawn(async move {
            ai_camera_worker(ai_cameras, config, semaphore, track_events, db_pool, cid, zid, url, sampling_ms, cancel).await;
        });

        {
            let mut sessions = state.ai_cameras.lock().await;
            if let Some(s) = sessions.get_mut(&cam.camera_id) {
                s.task_handle = Some(handle);
            }
        }
        per_camera.push(serde_json::json!({
            "cameraId": cam.camera_id,
            "status": "started",
        }));
        started += 1;
    }

    tracing::info!("AI cameras: started={}, failed={}, already_running={}, total_configured={}", started, failed, already, cameras.len());

    Ok(Json(serde_json::json!({
        "started": started,
        "alreadyRunning": already,
        "totalConfigured": cameras.len(),
        "failed": failed,
        "cameras": per_camera,
    })))
}

// ─── POST /api/v1/ai/cameras/stop-all ───────────────────────────────

pub async fn stop_all(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut sessions = state.ai_cameras.lock().await;
    let count = sessions.len() as u32;
    for (_, session) in sessions.iter_mut() {
        session.enabled = false;
        if let Some(cancel) = session.cancel_token.take() { cancel.cancel(); }
        if let Some(handle) = session.task_handle.take() { handle.abort(); }
    }
    sessions.clear();
    drop(sessions);

    // Tell Python to release all pooled RTSP captures
    let base = state.config.local_ai_url.trim().trim_end_matches('/').to_string();
    if !base.is_empty() {
        let _ = reqwest::Client::new()
            .post(format!("{}/release-rtsp", base))
            .json(&serde_json::json!({"rtspUrl": ""}))
            .send()
            .await;
    }

    tracing::info!("AI cameras: all {} stopped", count);
    Ok(Json(serde_json::json!({ "stopped": count })))
}

// ─── GET /api/v1/ai/cameras/status ──────────────────────────────────

pub async fn status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sessions = state.ai_cameras.lock().await;
    let mut cameras = Vec::new();
    let mut total_frames = 0u64;
    let mut total_recognized = 0u64;

    for (id, s) in sessions.iter() {
        let running = s.enabled && s.task_handle.as_ref().map(|h| !h.is_finished()).unwrap_or(false);
        let uptime = s.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        total_frames += s.frames_processed;
        total_recognized += s.recognized_count;
        let status_str = match &s.worker_status {
            crate::api::state::AiWorkerStatus::Running => "running",
            crate::api::state::AiWorkerStatus::Degraded => "degraded",
            crate::api::state::AiWorkerStatus::Fatal => "fatal",
        };
        cameras.push(serde_json::json!({
            "cameraId": id,
            "zoneId": s.zone_id,
            "rtspUrlMasked": s.rtsp_url_masked,
            "enabled": s.enabled,
            "running": running,
            "workerStatus": status_str,
            "framesProcessed": s.frames_processed,
            "recognizedCount": s.recognized_count,
            "lastAt": s.last_at,
            "error": s.error,
            "uptimeSeconds": uptime,
            "samplingIntervalMs": s.sampling_interval_ms,
            "latestResults": s.latest_results,
        }));
    }

    Ok(Json(serde_json::json!({
        "cameras": cameras,
        "totalCameras": cameras.len(),
        "totalFrames": total_frames,
        "totalRecognized": total_recognized,
    })))
}

// ─── POST /api/v1/ai/cameras/:id/toggle ─────────────────────────────

pub async fn toggle(
    State(state): State<AppState>,
    Path(camera_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut sessions = state.ai_cameras.lock().await;

    if enabled {
        if let Some(existing) = sessions.get(&camera_id) {
            if existing.enabled {
                return Ok(Json(serde_json::json!({ "cameraId": camera_id, "enabled": true, "running": true })));
            }
        }

        // Resolve this specific camera
        drop(sessions);
        let cameras = resolve_cameras(&state).await;
        let cam = cameras.iter().find(|c| c.camera_id == camera_id)
            .ok_or_else(|| ApiError::not_found("Camera", Some(&camera_id)))?;

        let sampling_ms: u64 = std::env::var("FMS_AI_SAMPLE_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_SAMPLING_MS);

        let cancel = CancellationToken::new();
        let session = AiCameraSession {
            camera_id: cam.camera_id.clone(),
            zone_id: cam.zone_id.clone(),
            rtsp_url: cam.rtsp_url.clone(),
            rtsp_url_masked: cam.rtsp_url_masked.clone(),
            enabled: true,
            task_handle: None,
            cancel_token: Some(cancel.clone()),
            frames_processed: 0,
            recognized_count: 0,
            last_at: None,
            error: None,
            started_at: Some(std::time::Instant::now()),
            sampling_interval_ms: sampling_ms,
            worker_status: crate::api::state::AiWorkerStatus::Running,
            failure_since: None,
            latest_results: None,
        };

        let ai_cameras = state.ai_cameras.clone();
        let config = state.config.clone();
        let semaphore = state.ai_semaphore.clone();
        let track_events = state.track_events.clone();
        let db_pool = state.db.clone();
        let cid = cam.camera_id.clone();
        let zid = cam.zone_id.clone();
        let url = cam.rtsp_url.clone();

        let handle = tokio::spawn(async move {
            ai_camera_worker(ai_cameras, config, semaphore, track_events, db_pool, cid, zid, url, sampling_ms, cancel).await;
        });

        let mut sessions = state.ai_cameras.lock().await;
        let mut sess = session;
        sess.task_handle = Some(handle);
        sessions.insert(camera_id.clone(), sess);

        Ok(Json(serde_json::json!({ "cameraId": camera_id, "enabled": true, "running": true })))
    } else {
        if let Some(session) = sessions.get_mut(&camera_id) {
            session.enabled = false;
            if let Some(cancel) = session.cancel_token.take() { cancel.cancel(); }
            if let Some(handle) = session.task_handle.take() { handle.abort(); }
        }
        sessions.remove(&camera_id);
        Ok(Json(serde_json::json!({ "cameraId": camera_id, "enabled": false, "running": false })))
    }
}

// ─── AI camera worker loop ──────────────────────────────────────────

/// Classify an error string as potentially fatal (config/auth) vs transient (network).
fn is_fatal_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("401") || lower.contains("403") || lower.contains("unauthorized")
        || lower.contains("forbidden") || lower.contains("invalid credentials")
        || lower.contains("not configured")
}

/// Compute bounded exponential backoff: 1s, 2s, 4s, 8s, 15s max.
fn backoff_ms(consecutive: u32) -> u64 {
    let exp = BACKOFF_INITIAL_MS.saturating_mul(1u64.wrapping_shl(consecutive.min(4)));
    exp.min(BACKOFF_MAX_MS)
}

async fn ai_camera_worker(
    ai_cameras: crate::api::state::AiCameraSessions,
    config: std::sync::Arc<crate::api::state::AppConfig>,
    semaphore: crate::api::state::AiSemaphore,
    track_events: crate::api::state::TrackEventMap,
    db_pool: crate::db::DbPool,
    camera_id: String,
    zone_id: String,
    rtsp_url: String,
    sampling_ms: u64,
    cancel: CancellationToken,
) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_REQUEST_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_fatal(&ai_cameras, &camera_id, format!("HTTP client init: {}", e)).await;
            return;
        }
    };

    let base = config.local_ai_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        set_fatal(&ai_cameras, &camera_id, "AI URL not configured".to_string()).await;
        return;
    }

    let grab_url = format!("{}/grab-frame", base);
    let recognize_url = format!("{}/recognize/json", base);
    let release_url = format!("{}/release-rtsp", base);
    let health_url = format!("{}/health", base);
    let mut consecutive_errors: u32 = 0;
    let mut grab_failures: u32 = 0;

    tracing::info!("[ai-cam:{}][startup] Worker started (zone={}, interval={}ms)", camera_id, zone_id, sampling_ms);

    // Wait for AI service to be ready (it loads models on startup which takes time)
    {
        let mut ready = false;
        for attempt in 1..=20 {
            if cancel.is_cancelled() { return; }
            match client.get(&health_url).send().await {
                Ok(resp) if resp.status().is_success() => { ready = true; break; }
                _ => {}
            }
            tracing::info!("[ai-cam:{}][startup] Waiting for AI service (attempt {}/20)...", camera_id, attempt);
            update_error(&ai_cameras, &camera_id, format!("Waiting for AI service (attempt {}/20)...", attempt)).await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {},
                _ = cancel.cancelled() => return,
            }
        }
        if !ready {
            set_fatal(&ai_cameras, &camera_id, "AI service not available after 60s".to_string()).await;
            return;
        }
        // Clear the waiting message
        {
            let mut sessions = ai_cameras.lock().await;
            if let Some(s) = sessions.get_mut(&camera_id) {
                s.error = None;
                s.worker_status = crate::api::state::AiWorkerStatus::Running;
                s.failure_since = None;
            }
        }
    }

    loop {
        if cancel.is_cancelled() { break; }

        // Check if we've been failing continuously past the fatal window
        {
            let sessions = ai_cameras.lock().await;
            if let Some(s) = sessions.get(&camera_id) {
                if let Some(since) = s.failure_since {
                    if since.elapsed().as_secs() > FATAL_FAILURE_WINDOW_SECS {
                        drop(sessions);
                        set_fatal(
                            &ai_cameras,
                            &camera_id,
                            format!("Continuous failures for >{}s — stopping worker", FATAL_FAILURE_WINDOW_SECS),
                        ).await;
                        tracing::error!("[ai-cam:{}][fatal] Stopped after >{}s of continuous failures", camera_id, FATAL_FAILURE_WINDOW_SECS);
                        break;
                    }
                }
            }
        }

        // Acquire semaphore permit (global concurrency limit)
        let _permit = tokio::select! {
            p = semaphore.acquire() => match p {
                Ok(p) => p,
                Err(_) => break, // Semaphore closed
            },
            _ = cancel.cancelled() => break,
        };

        // Step 1: Grab frame from RTSP via Python AI service
        let grab_resp = client.post(&grab_url)
            .json(&serde_json::json!({ "rtspUrl": rtsp_url, "asBase64": true }))
            .send()
            .await;

        let frame_b64 = match grab_resp {
            Ok(resp) => {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                    let err = body.get("error").and_then(|v| v.as_str()).unwrap_or("grab failed").to_string();

                    // Fatal config/auth errors → stop immediately
                    if is_fatal_error(&err) {
                        set_fatal(&ai_cameras, &camera_id, format!("Fatal: {}", err)).await;
                        tracing::error!("[ai-cam:{}][grab-frame] Fatal error: {}", camera_id, err);
                        break;
                    }

                    consecutive_errors += 1;
                    grab_failures += 1;
                    record_degraded(&ai_cameras, &camera_id, &err).await;
                    tracing::warn!("[ai-cam:{}][grab-frame] Transient error (#{}/grab#{}): {}", camera_id, consecutive_errors, grab_failures, err);

                    // After several grab failures, release the stale capture and retry fresh
                    if grab_failures % RELEASE_AFTER_GRAB_FAILURES == 0 {
                        tracing::info!("[ai-cam:{}][recovery] Releasing RTSP capture after {} grab failures", camera_id, grab_failures);
                        let _ = client.post(&release_url)
                            .json(&serde_json::json!({ "rtspUrl": rtsp_url }))
                            .send()
                            .await;
                    }

                    let wait = backoff_ms(consecutive_errors);
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => continue,
                        _ = cancel.cancelled() => break,
                    }
                }
                // Reset grab failure counter on successful grab response
                grab_failures = 0;
                match body.get("imageBase64").and_then(|v| v.as_str()) {
                    Some(b) => b.to_string(),
                    None => {
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_millis(sampling_ms)) => continue,
                            _ = cancel.cancelled() => break,
                        }
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                grab_failures += 1;
                let err_msg = format!("Grab error: {}", e);

                if is_fatal_error(&err_msg) {
                    set_fatal(&ai_cameras, &camera_id, err_msg.clone()).await;
                    tracing::error!("[ai-cam:{}][grab-frame] Fatal: {}", camera_id, err_msg);
                    break;
                }

                record_degraded(&ai_cameras, &camera_id, &err_msg).await;
                tracing::warn!("[ai-cam:{}][grab-frame] Network error (#{}/grab#{}): {}", camera_id, consecutive_errors, grab_failures, e);

                if grab_failures % RELEASE_AFTER_GRAB_FAILURES == 0 {
                    tracing::info!("[ai-cam:{}][recovery] Releasing RTSP capture after {} grab failures", camera_id, grab_failures);
                    let _ = client.post(&release_url)
                        .json(&serde_json::json!({ "rtspUrl": rtsp_url }))
                        .send()
                        .await;
                }

                let wait = backoff_ms(consecutive_errors);
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => continue,
                    _ = cancel.cancelled() => break,
                }
            }
        };

        // Step 2: Send to recognition
        let payload = serde_json::json!({
            "imageBase64": frame_b64,
            "threshold": 0.5,
            "maxFaces": 5,
            "zoneId": zone_id,
            "cameraId": camera_id,
            "action": "ai-monitor",
        });

        match client.post(&recognize_url).json(&payload).send().await {
            Ok(resp) => {
                // Full success — clear all error state
                consecutive_errors = 0;
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                let recognized = body.get("countRecognized").and_then(|v| v.as_u64()).unwrap_or(0);
                let results_for_ui = body.get("results").cloned();
                let now = chrono::Utc::now().to_rfc3339();
                let mut sessions = ai_cameras.lock().await;
                if let Some(s) = sessions.get_mut(&camera_id) {
                    s.frames_processed += 1;
                    s.recognized_count += recognized;
                    s.last_at = Some(now.clone());
                    s.error = None;
                    s.worker_status = crate::api::state::AiWorkerStatus::Running;
                    s.failure_since = None;
                    if results_for_ui.is_some() {
                        s.latest_results = results_for_ui;
                    }
                }
                drop(sessions);

                // ── Track event deduplication + zone logic ──
                if let Some(results_arr) = body.get("results").and_then(|v| v.as_array()) {
                    // Load zone polygon for this camera (if configured)
                    let zone_polygon: Vec<(f64, f64)> = if !zone_id.is_empty() {
                        db::with_db(&db_pool, |conn| {
                            let poly_json: Option<String> = conn.query_row(
                                "SELECT zonePolygon FROM zones WHERE id = ?1",
                                rusqlite::params![&zone_id],
                                |r| r.get(0),
                            ).ok().flatten();
                            if let Some(json_str) = poly_json {
                                if let Ok(coords) = serde_json::from_str::<Vec<Vec<f64>>>(&json_str) {
                                    return coords.into_iter()
                                        .filter(|c| c.len() >= 2)
                                        .map(|c| (c[0], c[1]))
                                        .collect();
                                }
                            }
                            Vec::new()
                        })
                    } else {
                        Vec::new()
                    };

                    let mut events = track_events.lock().await;
                    let cam_tracks = events.entry(camera_id.clone()).or_default();

                    // Purge stale tracks (>30s not seen)
                    let stale_cutoff = std::time::Instant::now() - std::time::Duration::from_secs(30);
                    cam_tracks.retain(|_, ev| ev.last_seen > stale_cutoff);

                    for item in results_arr {
                        let track_id = item.get("trackId").and_then(|v| v.as_i64()).unwrap_or(-1);
                        if track_id < 0 { continue; }

                        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let person_id = item.get("personId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let person_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
                        let score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);

                        // Check zone containment via bottom-center of person bbox
                        let in_zone = if !zone_polygon.is_empty() {
                            if let Some(pbbox) = item.get("personBbox").and_then(|v| v.as_array()) {
                                if pbbox.len() >= 4 {
                                    let bbox = [
                                        pbbox[0].as_f64().unwrap_or(0.0),
                                        pbbox[1].as_f64().unwrap_or(0.0),
                                        pbbox[2].as_f64().unwrap_or(0.0),
                                        pbbox[3].as_f64().unwrap_or(0.0),
                                    ];
                                    let (cx, by) = crate::api::state::bbox_bottom_center(&bbox);
                                    crate::api::state::point_in_polygon(cx, by, &zone_polygon)
                                } else { true } // no bbox → assume in zone
                            } else { true }
                        } else { true }; // no polygon configured → always "in zone"

                        let now_instant = std::time::Instant::now();
                        let prev = cam_tracks.get(&track_id).cloned();
                        let mut event_action: Option<&'static str> = None;
                        let mut from_zone = String::new();
                        let mut to_zone = String::new();

                        let recognized = status == "recognized" && !person_id.is_empty();
                        if recognized {
                            match prev.as_ref() {
                                None => {
                                    if in_zone {
                                        event_action = Some("zone-entry");
                                        to_zone = zone_id.clone();
                                    }
                                }
                                Some(existing) => {
                                    let cooldown_ok = existing
                                        .last_logged_at
                                        .map(|t| t.elapsed().as_secs() >= TRACK_LOG_COOLDOWN_SECS)
                                        .unwrap_or(true);

                                    if in_zone && !existing.zone_entered {
                                        if !existing.zone_id.is_empty() && existing.zone_id != zone_id {
                                            event_action = Some("zone-transition");
                                            from_zone = existing.zone_id.clone();
                                            to_zone = zone_id.clone();
                                        } else {
                                            event_action = Some("zone-entry");
                                            to_zone = zone_id.clone();
                                        }
                                    } else if !in_zone && existing.zone_entered {
                                        event_action = Some("zone-exit");
                                        from_zone = existing.zone_id.clone();
                                    }

                                    if !cooldown_ok {
                                        event_action = None;
                                    }
                                }
                            }
                        }

                        // Update track state
                        cam_tracks.insert(track_id, TrackEvent {
                            track_id,
                            identity: person_name.clone(),
                            person_id: person_id.clone(),
                            zone_entered: in_zone,
                            zone_id: if in_zone { zone_id.clone() } else { String::new() },
                            confidence: score,
                            last_seen: now_instant,
                            last_logged_at: prev.as_ref().and_then(|p| p.last_logged_at),
                        });

                        // Write access_log only on deduplicated movement events
                        if let Some(action) = event_action {
                            let log_zone = zone_id.clone();
                            let log_cam = camera_id.clone();
                            let log_now = now.clone();
                            let metadata = serde_json::json!({
                                "trackId": track_id,
                                "fromZoneId": from_zone,
                                "toZoneId": to_zone,
                                "cameraId": log_cam,
                                "confidence": score,
                            });
                            let _ = db::with_db(&db_pool, |conn| {
                                let log_id = db::gen_id();
                                conn.execute(
                                    "INSERT INTO access_logs (id, personId, personName, employeeId, action, zoneId, cameraId, confidence, provider, createdAt, metadata, updatedAt)
                                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ai-tracking', ?9, ?10, ?11)",
                                    rusqlite::params![log_id, person_id, person_name, person_id, action, log_zone, log_cam, score, log_now, metadata.to_string(), log_now],
                                ).ok()
                            });
                            if let Some(ev) = cam_tracks.get_mut(&track_id) {
                                ev.last_logged_at = Some(now_instant);
                            }
                            tracing::info!(
                                "[ai-cam:{}][track] Track {} '{}' {} (from='{}', to='{}')",
                                log_cam, track_id, person_name, action, from_zone, to_zone
                            );
                        }
                    }
                }

                if recognized > 0 {
                    tracing::debug!("[ai-cam:{}][recognize] Recognized {} face(s)", camera_id, recognized);
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                let err_msg = format!("Recognize error: {}", e);
                record_degraded(&ai_cameras, &camera_id, &err_msg).await;
                tracing::warn!("[ai-cam:{}][recognize] Error (#{}): {}", camera_id, consecutive_errors, e);

                let wait = backoff_ms(consecutive_errors);
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => continue,
                    _ = cancel.cancelled() => break,
                }
            }
        }

        // Drop permit before sleeping
        drop(_permit);

        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(sampling_ms)) => {},
            _ = cancel.cancelled() => break,
        }
    }

    tracing::info!("[ai-cam:{}][shutdown] Worker stopped", camera_id);
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Mark a worker as fatally stopped.
async fn set_fatal(sessions: &crate::api::state::AiCameraSessions, id: &str, msg: String) {
    let mut s = sessions.lock().await;
    if let Some(session) = s.get_mut(id) {
        session.error = Some(msg);
        session.enabled = false;
        session.worker_status = crate::api::state::AiWorkerStatus::Fatal;
    }
}

/// Record a transient error and move to degraded state; track failure window.
async fn record_degraded(sessions: &crate::api::state::AiCameraSessions, id: &str, msg: &str) {
    let mut s = sessions.lock().await;
    if let Some(session) = s.get_mut(id) {
        session.error = Some(msg.to_string());
        if session.worker_status != crate::api::state::AiWorkerStatus::Degraded {
            session.worker_status = crate::api::state::AiWorkerStatus::Degraded;
        }
        if session.failure_since.is_none() {
            session.failure_since = Some(std::time::Instant::now());
        }
    }
}

/// Update error message without changing status.
async fn update_error(sessions: &crate::api::state::AiCameraSessions, id: &str, msg: String) {
    let mut s = sessions.lock().await;
    if let Some(session) = s.get_mut(id) {
        session.error = Some(msg);
    }
}

/// Preflight a camera: release stale capture, then test with a real frame grab.
/// Returns true if the camera is reachable and can produce a frame.
async fn preflight_camera(ai_base: &str, rtsp_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Release any stale capture
    let _ = client
        .post(format!("{}/release-rtsp", ai_base))
        .json(&serde_json::json!({ "rtspUrl": rtsp_url }))
        .send()
        .await;

    // Test with a real frame grab
    match client
        .post(format!("{}/test-camera", ai_base))
        .json(&serde_json::json!({ "rtspUrl": rtsp_url, "asBase64": false }))
        .send()
        .await
    {
        Ok(resp) => {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
        }
        Err(_) => {
            // Python service not reachable — let the worker handle it (health wait loop)
            true
        }
    }
}

/// Camera descriptor resolved from DB.
struct CameraDescriptor {
    camera_id: String,
    zone_id: String,
    rtsp_url: String,
    rtsp_url_masked: String,
}

/// Resolve all configured cameras from zones + check-in/out + onboarding settings.
async fn resolve_cameras(state: &AppState) -> Vec<CameraDescriptor> {
    let mut result = Vec::new();

    // 1. Zone cameras (each zone has sub-cameras with RTSP)
    let zone_cameras: Vec<(String, String, String)> = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, cameraIds FROM zones WHERE status = 'active'"
        ).ok()?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        }).ok()?;
        Some(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
    }).unwrap_or_default();

    for (zone_id, zone_name, cameras_json) in &zone_cameras {
        let cameras: Vec<serde_json::Value> = serde_json::from_str(cameras_json).unwrap_or_default();
        for (idx, cam) in cameras.iter().enumerate() {
            let rtsp = cam.get("rtsp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if rtsp.is_empty() { continue; }
            let cam_name = cam.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let camera_id = format!("zone:{}:{}", zone_id, idx);
            let masked = crate::api::rtsp::mask_rtsp_url(&rtsp);
            result.push(CameraDescriptor { camera_id, zone_id: zone_id.clone(), rtsp_url: rtsp, rtsp_url_masked: masked });
            let _ = (zone_name, cam_name); // used for logging context
        }
    }

    // 2. Check-in/out cameras from app_settings
    let cio_json: Option<String> = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT value FROM app_settings WHERE key = 'check_in_out_cameras'", [], |r| r.get(0)).ok().flatten()
    });
    if let Some(json_str) = cio_json {
        let cams: Vec<serde_json::Value> = serde_json::from_str(&json_str).unwrap_or_default();
        for cam in &cams {
            let id = cam.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let rtsp = cam.get("rtspIp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() || rtsp.is_empty() { continue; }
            let mut url = rtsp.clone();
            if !url.starts_with("rtsp://") { url = format!("rtsp://{}", url); }
            let masked = crate::api::rtsp::mask_rtsp_url(&url);
            result.push(CameraDescriptor { camera_id: format!("cio:{}", id), zone_id: String::new(), rtsp_url: url, rtsp_url_masked: masked });
        }
    }

    // 3. Onboarding camera from app_settings
    let ob_json: Option<String> = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT value FROM app_settings WHERE key = 'onboarding_camera'", [], |r| r.get(0)).ok().flatten()
    });
    if let Some(json_str) = ob_json {
        if let Ok(cam) = serde_json::from_str::<serde_json::Value>(&json_str) {
            let rtsp = cam.get("rtspIp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !rtsp.is_empty() {
                let mut url = rtsp.clone();
                if !url.starts_with("rtsp://") { url = format!("rtsp://{}", url); }
                let masked = crate::api::rtsp::mask_rtsp_url(&url);
                result.push(CameraDescriptor { camera_id: "onboarding".to_string(), zone_id: String::new(), rtsp_url: url, rtsp_url_masked: masked });
            }
        }
    }

    result
}
