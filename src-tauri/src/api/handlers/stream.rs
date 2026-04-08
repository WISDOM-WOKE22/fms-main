//! RTSP → HLS live stream manager via FFmpeg.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{Json, Response},
};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::api::error::ApiError;
use crate::api::rtsp;
use crate::api::state::{AppState, StreamSession, StreamStatus, TrackEvent};

const MAX_STREAMS: usize = 4;
const IDLE_TIMEOUT_SECS: u64 = 120;
const MAX_BACKOFF_SECS: u64 = 30;
const MAX_RECONNECTS: u32 = 20;

// ─── POST /api/v1/streams/start ─────────────────────────────────────

pub async fn stream_start(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cfg = super::rest::parse_dvr_config_from_json(&body);
    let rtsp_url = rtsp::build_rtsp_url(&cfg)
        .map_err(|e| ApiError::bad_request(e.message))?;
    let rtsp_url_masked = rtsp::mask_rtsp_url(&rtsp_url);

    let ffmpeg = ffmpeg_bin();
    if ffmpeg.is_empty() || !is_ffmpeg_available_at(&ffmpeg).await {
        return Err(ApiError::service_unavailable(
            "ffmpeg is not installed or not in PATH. Install ffmpeg to enable live camera streaming.",
        ));
    }

    {
        let sessions = state.streams.lock().await;
        if sessions.len() >= MAX_STREAMS {
            return Err(ApiError::conflict(format!(
                "Maximum of {} concurrent streams reached. Stop an existing stream first.", MAX_STREAMS
            )));
        }
    }

    let stream_id = Uuid::new_v4().to_string();
    let hls_dir = hls_base_dir().join(&stream_id);
    tokio::fs::create_dir_all(&hls_dir).await.map_err(|e| {
        tracing::error!("Failed to create HLS dir {:?}: {}", hls_dir, e);
        ApiError::service_unavailable("Failed to create stream output directory")
    })?;

    let cancel = CancellationToken::new();
    let now = std::time::Instant::now();

    // Extract optional zone/camera metadata from the start request
    let zone_id = body.get("zoneId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let camera_id = body.get("cameraId").and_then(|v| v.as_str()).unwrap_or("").to_string();

    {
        let mut sessions = state.streams.lock().await;
        sessions.insert(stream_id.clone(), StreamSession {
            rtsp_url: rtsp_url.clone(),
            rtsp_url_masked: rtsp_url_masked.clone(),
            status: StreamStatus::Starting,
            error_message: None,
            hls_dir: hls_dir.clone(),
            task_handle: None,
            cancel_token: cancel.clone(),
            created_at: now,
            last_viewer_at: now,
            reconnect_count: 0,
            zone_id,
            camera_id,
            ai_enabled: false,
            ai_task_handle: None,
            ai_cancel_token: None,
            ai_frames_processed: 0,
            ai_recognized_count: 0,
            ai_last_at: None,
            ai_error: None,
            ai_latest_results: None,
            ai_track_stats: None,
            ai_latency_ms: None,
            ai_cached_count: None,
        });
    }

    let s_streams = state.streams.clone();
    let s_id = stream_id.clone();
    let s_url = rtsp_url;
    let s_dir = hls_dir;
    let s_cancel = cancel;
    let s_ffmpeg = ffmpeg;

    let handle = tokio::spawn(async move {
        stream_manager_loop(s_streams, s_id, s_url, s_dir, s_cancel, s_ffmpeg).await;
    });

    {
        let mut sessions = state.streams.lock().await;
        if let Some(session) = sessions.get_mut(&stream_id) {
            session.task_handle = Some(handle);
        }
    }

    Ok(Json(serde_json::json!({
        "streamId": stream_id,
        "playbackUrl": format!("/api/v1/streams/hls/{}/index.m3u8", stream_id),
        "status": "starting",
        "rtspUrlMasked": rtsp_url_masked,
    })))
}

// ─── GET /api/v1/streams/:id/status ─────────────────────────────────

pub async fn stream_status(
    State(state): State<AppState>,
    Path(stream_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let sessions = state.streams.lock().await;
    let session = sessions.get(&stream_id)
        .ok_or_else(|| ApiError::not_found("Stream", Some(&stream_id)))?;

    Ok(Json(serde_json::json!({
        "streamId": stream_id,
        "status": session.status,
        "errorMessage": session.error_message,
        "rtspUrlMasked": session.rtsp_url_masked,
        "reconnectCount": session.reconnect_count,
        "playbackUrl": format!("/api/v1/streams/hls/{}/index.m3u8", stream_id),
        "uptimeSeconds": session.created_at.elapsed().as_secs(),
        "zoneId": session.zone_id,
        "cameraId": session.camera_id,
        "aiEnabled": session.ai_enabled,
        "aiRunning": session.ai_enabled && session.ai_task_handle.as_ref().map(|h| !h.is_finished()).unwrap_or(false),
        "aiError": session.ai_error,
        "aiFramesProcessed": session.ai_frames_processed,
        "aiRecognizedCount": session.ai_recognized_count,
        "aiLastAt": session.ai_last_at,
        "aiResults": session.ai_latest_results,
        "aiTrackStats": session.ai_track_stats,
        "aiLatencyMs": session.ai_latency_ms,
        "aiCachedCount": session.ai_cached_count,
    })))
}

// ─── POST /api/v1/streams/:id/stop ──────────────────────────────────

pub async fn stream_stop(
    State(state): State<AppState>,
    Path(stream_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let session = {
        let mut sessions = state.streams.lock().await;
        sessions.remove(&stream_id)
    };
    let Some(session) = session else {
        return Err(ApiError::not_found("Stream", Some(&stream_id)));
    };
    session.cancel_token.cancel();
    if let Some(ai_cancel) = &session.ai_cancel_token { ai_cancel.cancel(); }
    if let Some(handle) = session.ai_task_handle { handle.abort(); }
    if let Some(handle) = session.task_handle { handle.abort(); }
    cleanup_hls_dir(&session.hls_dir).await;
    tracing::info!("Stream {} stopped and cleaned up", stream_id);
    Ok(StatusCode::NO_CONTENT)
}

// ─── GET /api/v1/streams/hls/:id/:filename ──────────────────────────

pub async fn serve_hls(
    State(state): State<AppState>,
    Path((stream_id, filename)): Path<(String, String)>,
) -> Result<Response<Body>, ApiError> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(ApiError::bad_request("Invalid filename"));
    }
    {
        let mut sessions = state.streams.lock().await;
        if let Some(session) = sessions.get_mut(&stream_id) {
            session.last_viewer_at = std::time::Instant::now();
        } else {
            return Err(ApiError::not_found("Stream", Some(&stream_id)));
        }
    }
    let file_path = hls_base_dir().join(&stream_id).join(&filename);
    let content = tokio::fs::read(&file_path).await.map_err(|_| {
        ApiError::not_found("HLS file", Some(&filename))
    })?;
    let ct = if filename.ends_with(".m3u8") { "application/vnd.apple.mpegurl" }
             else if filename.ends_with(".ts") { "video/mp2t" }
             else { "application/octet-stream" };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, ct)
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(content))
        .unwrap())
}

// ─── GET /api/v1/streams/check-ffmpeg ───────────────────────────────

pub async fn check_ffmpeg() -> Json<serde_json::Value> {
    let bin = ffmpeg_bin();
    let available = !bin.is_empty() && is_ffmpeg_available_at(&bin).await;
    Json(serde_json::json!({ "available": available, "path": bin }))
}

// ─── Background stream manager ──────────────────────────────────────

async fn stream_manager_loop(
    streams: crate::api::state::StreamSessions,
    stream_id: String,
    rtsp_url: String,
    hls_dir: PathBuf,
    cancel: CancellationToken,
    ffmpeg_path: String,
) {
    let mut reconnect_count: u32 = 0;

    loop {
        if cancel.is_cancelled() { break; }

        // Update status
        {
            let mut sessions = streams.lock().await;
            if let Some(s) = sessions.get_mut(&stream_id) {
                s.status = if reconnect_count == 0 { StreamStatus::Starting } else { StreamStatus::Reconnecting };
                s.reconnect_count = reconnect_count;
                s.error_message = if reconnect_count > 0 { Some(format!("Reconnect attempt #{}...", reconnect_count)) } else { None };
            } else { break; }
        }

        let playlist_path = hls_dir.join("index.m3u8");
        // Remove stale playlist from previous attempt
        let _ = tokio::fs::remove_file(&playlist_path).await;

        tracing::info!("[stream:{}] Starting ffmpeg (attempt {}) | bin={}", stream_id, reconnect_count + 1, ffmpeg_path);

        let child_result = tokio::process::Command::new(&ffmpeg_path)
            .args([
                "-loglevel", "warning",
                "-rtsp_transport", "tcp",
                "-fflags", "+nobuffer+discardcorrupt",
                "-flags", "low_delay",
                "-analyzeduration", "1000000",
                "-probesize", "1000000",
                "-timeout", "5000000",        // socket I/O timeout: 5s (microseconds)
                "-i", &rtsp_url,
                "-c:v", "copy",               // copy video codec — no re-encoding = fast + low CPU
                "-c:a", "aac",
                "-b:a", "64k",
                "-ac", "1",
                "-f", "hls",
                "-hls_time", "1",
                "-hls_list_size", "5",
                "-hls_flags", "delete_segments+append_list+omit_endlist",
                "-hls_segment_filename",
                &hls_dir.join("seg_%05d.ts").to_string_lossy(),
                &playlist_path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn();

        let mut child = match child_result {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("[stream:{}] Failed to spawn ffmpeg: {}", stream_id, e);
                set_error(&streams, &stream_id, format!("Failed to start ffmpeg: {}", e)).await;
                break;
            }
        };

        // Wait up to 12s for playlist OR ffmpeg to exit (whichever first)
        let online = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                break;
            }
            result = wait_for_playlist_or_exit(&playlist_path, &mut child) => result,
        };

        match online {
            WaitResult::PlaylistReady => {
                // Stream is producing output
                {
                    let mut sessions = streams.lock().await;
                    if let Some(s) = sessions.get_mut(&stream_id) {
                        s.status = StreamStatus::Online;
                        s.error_message = None;
                    }
                }
                tracing::info!("[stream:{}] Stream is ONLINE", stream_id);
                reconnect_count = 0;
            }
            WaitResult::FfmpegExited(code, stderr) => {
                tracing::warn!("[stream:{}] ffmpeg exited before playlist (code {:?}): {}", stream_id, code, stderr);
                // This means ffmpeg couldn't connect or decode — go to reconnect
                if !should_reconnect(&streams, &stream_id, &cancel, &mut reconnect_count, &stderr).await {
                    return;
                }
                continue; // Skip the inner wait loop, restart ffmpeg
            }
            WaitResult::Timeout => {
                tracing::warn!("[stream:{}] Timeout waiting for playlist — killing ffmpeg", stream_id);
                let stderr = read_stderr(&mut child).await;
                let _ = child.kill().await;
                let _ = child.wait().await;
                tracing::warn!("[stream:{}] stderr: {}", stream_id, stderr);
                if !should_reconnect(&streams, &stream_id, &cancel, &mut reconnect_count, &stderr).await {
                    return;
                }
                continue;
            }
        }

        // ── Online: monitor ffmpeg ──────────────────────────────────
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    return;
                }
                exit_status = child.wait() => {
                    let code = exit_status.map(|s| s.code()).ok().flatten();
                    let stderr = read_stderr(&mut child).await;
                    tracing::warn!("[stream:{}] ffmpeg exited (code {:?}): {}", stream_id, code, stderr);

                    if !streams.lock().await.contains_key(&stream_id) || cancel.is_cancelled() { return; }

                    if !should_reconnect(&streams, &stream_id, &cancel, &mut reconnect_count, &stderr).await {
                        return;
                    }
                    break; // Restart ffmpeg
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                    // Idle timeout check
                    let idle = {
                        let sessions = streams.lock().await;
                        sessions.get(&stream_id)
                            .map(|s| s.last_viewer_at.elapsed().as_secs() > IDLE_TIMEOUT_SECS)
                            .unwrap_or(true)
                    };
                    if idle {
                        tracing::info!("[stream:{}] Idle timeout — stopping", stream_id);
                        let _ = child.kill().await;
                        let mut sessions = streams.lock().await;
                        if let Some(removed) = sessions.remove(&stream_id) {
                            let dir = removed.hls_dir.clone();
                            tokio::spawn(async move { cleanup_hls_dir(&dir).await; });
                        }
                        return;
                    }
                }
            }
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

enum WaitResult {
    PlaylistReady,
    FfmpegExited(Option<i32>, String),
    Timeout,
}

/// Wait for the HLS playlist file to appear, or for ffmpeg to exit, or timeout (12s).
async fn wait_for_playlist_or_exit(
    playlist: &std::path::Path,
    child: &mut tokio::process::Child,
) -> WaitResult {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);

    loop {
        // Check playlist exists and has content
        if let Ok(meta) = tokio::fs::metadata(playlist).await {
            if meta.len() > 10 {
                return WaitResult::PlaylistReady;
            }
        }

        tokio::select! {
            biased;
            status = child.wait() => {
                let code = status.map(|s| s.code()).ok().flatten();
                let stderr = read_stderr(child).await;
                return WaitResult::FfmpegExited(code, stderr);
            }
            _ = tokio::time::sleep_until(deadline) => {
                return WaitResult::Timeout;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                // Check again
            }
        }
    }
}

/// Handle reconnect logic. Returns false if we should give up.
async fn should_reconnect(
    streams: &crate::api::state::StreamSessions,
    stream_id: &str,
    cancel: &CancellationToken,
    reconnect_count: &mut u32,
    stderr_hint: &str,
) -> bool {
    if cancel.is_cancelled() { return false; }
    if !streams.lock().await.contains_key(stream_id) { return false; }

    if *reconnect_count >= MAX_RECONNECTS {
        let msg = format!("Stream failed after {} attempts. {}", MAX_RECONNECTS, truncate(stderr_hint, 200));
        set_error(streams, stream_id, msg).await;
        return false;
    }

    *reconnect_count += 1;
    let backoff = std::cmp::min(1u64 << (*reconnect_count).min(5), MAX_BACKOFF_SECS);

    {
        let mut sessions = streams.lock().await;
        if let Some(s) = sessions.get_mut(stream_id) {
            s.status = StreamStatus::Reconnecting;
            s.reconnect_count = *reconnect_count;
            s.error_message = Some(format!("Reconnecting in {}s... {}", backoff, truncate(stderr_hint, 100)));
        }
    }

    tracing::info!("[stream:{}] Backoff {}s before reconnect #{}", stream_id, backoff, reconnect_count);

    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff)) => true,
        _ = cancel.cancelled() => false,
    }
}

fn hls_base_dir() -> PathBuf {
    crate::db::app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("streams")
}

async fn is_ffmpeg_available_at(bin: &str) -> bool {
    tokio::process::Command::new(bin)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

fn ffmpeg_bin() -> String {
    if let Ok(p) = std::env::var("FFMPEG_BIN") {
        if !p.is_empty() && std::path::Path::new(&p).exists() { return p; }
    }
    // Bundled sidecar
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
            let sidecar = dir.join(name);
            if sidecar.exists() { return sidecar.to_string_lossy().to_string(); }
        }
    }
    // System paths
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
    } else if cfg!(target_os = "linux") {
        &["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
    } else { &[] };
    for p in candidates { if std::path::Path::new(p).exists() { return p.to_string(); } }
    "ffmpeg".to_string()
}

async fn set_error(streams: &crate::api::state::StreamSessions, id: &str, msg: String) {
    let mut sessions = streams.lock().await;
    if let Some(s) = sessions.get_mut(id) {
        s.status = StreamStatus::Error;
        s.error_message = Some(msg);
    }
}

async fn read_stderr(child: &mut tokio::process::Child) -> String {
    if let Some(mut stderr) = child.stderr.take() {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        let text = String::from_utf8_lossy(&buf);
        truncate(&text, 500).to_string()
    } else {
        String::new()
    }
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max { s } else { &s[s.len() - max..] }
}

// ─── POST /api/v1/streams/:id/ai/toggle ─────────────────────────────

pub async fn stream_ai_toggle(
    State(state): State<AppState>,
    Path(stream_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut sessions = state.streams.lock().await;
    let session = sessions.get_mut(&stream_id)
        .ok_or_else(|| ApiError::not_found("Stream", Some(&stream_id)))?;

    if enabled && !session.ai_enabled {
        // Start AI worker
        let ai_cancel = CancellationToken::new();
        session.ai_enabled = true;
        session.ai_error = None;
        session.ai_cancel_token = Some(ai_cancel.clone());

        let streams = state.streams.clone();
        let config = state.config.clone();
        let track_events = state.track_events.clone();
        let db_pool = state.db.clone();
        let sid = stream_id.clone();
        let hls_dir = session.hls_dir.clone();
        let zone_id = session.zone_id.clone();
        let camera_id = session.camera_id.clone();

        let handle = tokio::spawn(async move {
            ai_recognition_loop(streams, config, track_events, db_pool, sid, hls_dir, zone_id, camera_id, ai_cancel).await;
        });
        session.ai_task_handle = Some(handle);

    } else if !enabled && session.ai_enabled {
        // Stop AI worker
        session.ai_enabled = false;
        if let Some(cancel) = session.ai_cancel_token.take() { cancel.cancel(); }
        if let Some(handle) = session.ai_task_handle.take() { handle.abort(); }
        session.ai_error = None;
    }

    let ai_running = session.ai_enabled && session.ai_task_handle.as_ref().map(|h| !h.is_finished()).unwrap_or(false);

    Ok(Json(serde_json::json!({
        "streamId": stream_id,
        "aiEnabled": session.ai_enabled,
        "aiRunning": ai_running,
    })))
}

// ─── AI recognition background loop ─────────────────────────────────

const AI_FRAME_INTERVAL_MS: u64 = 500; // ~2 FPS default
const AI_REQUEST_TIMEOUT_SECS: u64 = 10;
const AI_MAX_CONSECUTIVE_ERRORS: u32 = 10;
const AI_ERROR_BACKOFF_MS: u64 = 3000;
const TRACK_LOG_COOLDOWN_SECS: u64 = 12;

/// Samples HLS .ts segments, decodes a frame, sends to the recognize endpoint.
async fn ai_recognition_loop(
    streams: crate::api::state::StreamSessions,
    config: std::sync::Arc<crate::api::state::AppConfig>,
    track_events: crate::api::state::TrackEventMap,
    db_pool: crate::db::DbPool,
    stream_id: String,
    hls_dir: PathBuf,
    zone_id: String,
    camera_id: String,
    cancel: CancellationToken,
) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_REQUEST_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            set_ai_error(&streams, &stream_id, format!("AI client init: {}", e)).await;
            return;
        }
    };

    let base_url = config.local_ai_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        set_ai_error(&streams, &stream_id, "Local AI URL not configured".to_string()).await;
        return;
    }

    let recognize_url = format!("{}/recognize/json", base_url);
    let health_url = format!("{}/health", base_url);
    let mut consecutive_errors: u32 = 0;
    // Track the last processed segment by name AND modification time to avoid
    // re-processing stale segments and to correctly detect new ones.
    let mut last_seg_name: Option<String> = None;
    let mut last_seg_mtime: Option<std::time::SystemTime> = None;

    tracing::info!("[stream:{}] AI recognition loop started (zone={}, camera={})", stream_id, zone_id, camera_id);

    // Wait for AI service to be ready
    for attempt in 1..=20 {
        if cancel.is_cancelled() { return; }
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => {
                if attempt == 20 {
                    set_ai_error(&streams, &stream_id, "AI service not available".to_string()).await;
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {},
                    _ = cancel.cancelled() => return,
                }
            }
        }
    }

    loop {
        if cancel.is_cancelled() { break; }

        // Check stream is still alive
        {
            let sessions = streams.lock().await;
            match sessions.get(&stream_id) {
                Some(s) if s.status == StreamStatus::Online => {}
                Some(_) => {
                    // Stream not online yet — wait and retry
                    drop(sessions);
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => continue,
                        _ = cancel.cancelled() => break,
                    }
                }
                None => break,
            }
        }

        // Find the newest .ts segment (by modification time, no exclusion)
        let (segment_path, seg_mtime) = match find_newest_segment(&hls_dir).await {
            Some(pair) => pair,
            None => {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(AI_FRAME_INTERVAL_MS)) => continue,
                    _ = cancel.cancelled() => break,
                }
            }
        };

        let seg_name = segment_path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();

        // Skip if we already processed this exact segment (same name AND same mtime)
        let already_processed = last_seg_name.as_deref() == Some(&seg_name)
            && last_seg_mtime == Some(seg_mtime);
        if already_processed {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(AI_FRAME_INTERVAL_MS)) => continue,
                _ = cancel.cancelled() => break,
            }
        }
        last_seg_name = Some(seg_name);
        last_seg_mtime = Some(seg_mtime);

        // Extract a frame from the .ts segment using ffmpeg
        let frame_b64 = match extract_frame_from_ts(&segment_path).await {
            Some(b) => b,
            None => {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(AI_FRAME_INTERVAL_MS)) => continue,
                    _ = cancel.cancelled() => break,
                }
            }
        };

        // Send to AI recognize endpoint
        let payload = serde_json::json!({
            "imageBase64": frame_b64,
            "threshold": 0.5,
            "maxFaces": 5,
            "zoneId": zone_id,
            "cameraId": camera_id,
            "action": "rtsp-stream-recognition",
        });

        match client.post(&recognize_url).json(&payload).send().await {
            Ok(resp) => {
                consecutive_errors = 0;
                let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
                let recognized = body.get("countRecognized").and_then(|v| v.as_u64()).unwrap_or(0);
                let now = chrono::Utc::now().to_rfc3339();

                // Store results array for UI overlay rendering
                let results_for_ui = body.get("results").cloned();
                let track_stats = body.get("trackStats").cloned();
                let latency_ms = body.get("latencyMs").and_then(|v| v.as_u64());
                let cached_count = body.get("countCached").and_then(|v| v.as_u64());

                let mut sessions = streams.lock().await;
                if let Some(s) = sessions.get_mut(&stream_id) {
                    s.ai_frames_processed += 1;
                    s.ai_recognized_count += recognized;
                    s.ai_last_at = Some(now.clone());
                    s.ai_error = None;
                    if results_for_ui.is_some() {
                        s.ai_latest_results = results_for_ui;
                    }
                    s.ai_track_stats = track_stats.clone();
                    s.ai_latency_ms = latency_ms;
                    s.ai_cached_count = cached_count;
                }
                drop(sessions);

                // ── Track event deduplication + zone logic ──
                if let Some(results_arr) = body.get("results").and_then(|v| v.as_array()) {
                    // Load zone polygon (if configured)
                    let zone_polygon: Vec<(f64, f64)> = if !zone_id.is_empty() {
                        crate::db::with_db(&db_pool, |conn| {
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

                    // Purge stale tracks (>30s)
                    let stale_cutoff = std::time::Instant::now() - std::time::Duration::from_secs(30);
                    cam_tracks.retain(|_, ev| ev.last_seen > stale_cutoff);

                    for item in results_arr {
                        let track_id = item.get("trackId").and_then(|v| v.as_i64()).unwrap_or(-1);
                        if track_id < 0 { continue; }

                        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let person_id = item.get("personId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let person_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string();
                        let score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);

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
                                } else { true }
                            } else { true }
                        } else { true };

                        let now_instant = std::time::Instant::now();
                        let prev = cam_tracks.get(&track_id).cloned();
                        let mut event_action: Option<&'static str> = None;
                        let mut from_zone = String::new();
                        let mut to_zone = String::new();

                        let recognized_ok = status == "recognized" && !person_id.is_empty();
                        if recognized_ok {
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
                            let _ = crate::db::with_db(&db_pool, |conn| {
                                let log_id = crate::db::gen_id();
                                conn.execute(
                                    "INSERT INTO access_logs (id, personId, personName, action, zoneId, cameraId, confidence, provider, createdAt, metadata)
                                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ai-tracking', ?8, ?9)",
                                    rusqlite::params![log_id, person_id, person_name, action, log_zone, log_cam, score, log_now, metadata.to_string()],
                                ).ok()
                            });
                            if let Some(ev) = cam_tracks.get_mut(&track_id) {
                                ev.last_logged_at = Some(now_instant);
                            }
                            tracing::info!(
                                "[stream:{}][track] Track {} '{}' {} (from='{}', to='{}')",
                                stream_id, track_id, person_name, action, from_zone, to_zone
                            );
                        }
                    }
                }

                if recognized > 0 {
                    tracing::debug!("[stream:{}][recognize] {} face(s), latency={}ms, cached={}",
                        stream_id, recognized,
                        latency_ms.unwrap_or(0), cached_count.unwrap_or(0));
                }
                let _ = (track_stats, latency_ms, cached_count); // used above in debug
            }
            Err(e) => {
                consecutive_errors += 1;
                let msg = format!("AI request failed: {}", e);
                tracing::warn!("[stream:{}] {}", stream_id, msg);

                if consecutive_errors >= AI_MAX_CONSECUTIVE_ERRORS {
                    set_ai_error(&streams, &stream_id, format!("AI stopped after {} consecutive errors: {}", AI_MAX_CONSECUTIVE_ERRORS, e)).await;
                    break;
                }

                {
                    let mut sessions = streams.lock().await;
                    if let Some(s) = sessions.get_mut(&stream_id) {
                        s.ai_error = Some(msg);
                    }
                }

                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(AI_ERROR_BACKOFF_MS)) => continue,
                    _ = cancel.cancelled() => break,
                }
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(AI_FRAME_INTERVAL_MS)) => {},
            _ = cancel.cancelled() => break,
        }
    }

    tracing::info!("[stream:{}] AI recognition loop ended", stream_id);
}

/// Find the most recently modified .ts segment file in the HLS directory.
/// Returns the path and its modification time so the caller can detect duplicates.
async fn find_newest_segment(hls_dir: &std::path::Path) -> Option<(PathBuf, std::time::SystemTime)> {
    let mut entries = match tokio::fs::read_dir(hls_dir).await {
        Ok(e) => e,
        Err(_) => return None,
    };
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".ts") { continue; }
        if let Ok(meta) = entry.metadata().await {
            if let Ok(modified) = meta.modified() {
                if best.as_ref().map(|(_, t)| modified > *t).unwrap_or(true) {
                    best = Some((entry.path(), modified));
                }
            }
        }
    }
    best
}

/// Extract a single JPEG frame from a .ts segment using ffmpeg.
async fn extract_frame_from_ts(ts_path: &std::path::Path) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    let ffmpeg = ffmpeg_bin();
    if ffmpeg.is_empty() { return None; }

    let result = tokio::process::Command::new(&ffmpeg)
        .args([
            "-loglevel", "error",
            "-i", &ts_path.to_string_lossy(),
            "-vframes", "1",
            "-q:v", "3",          // good quality for accurate face recognition
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .output()
        .await;

    match result {
        Ok(output) if !output.stdout.is_empty() => {
            Some(B64.encode(&output.stdout))
        }
        _ => None,
    }
}

async fn set_ai_error(streams: &crate::api::state::StreamSessions, id: &str, msg: String) {
    let mut sessions = streams.lock().await;
    if let Some(s) = sessions.get_mut(id) {
        s.ai_error = Some(msg);
        s.ai_enabled = false;
    }
}

async fn cleanup_hls_dir(dir: &std::path::Path) {
    if dir.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(dir).await {
            tracing::warn!("Failed to clean up HLS dir {:?}: {}", dir, e);
        }
    }
}
