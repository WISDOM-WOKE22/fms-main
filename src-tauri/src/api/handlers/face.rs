//! Local face registration and recognition endpoints for desktop.

use axum::{
    extract::{Path, State},
    response::Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::multipart;
use rusqlite::params;

use crate::api::error::ApiError;
use crate::api::handlers::rest;
use crate::api::state::AppState;
use crate::db;

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024; // 2 MB
const AI_TIMEOUT_SECS: u64 = 15;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRegisterBody {
    pub image_base64: String,
    pub quality_score: Option<f64>,
}

async fn verify_with_local_ai(
    ai_base: &str,
    person_id: &str,
    person_name: &str,
    payload_b64: &str,
    decoded: &[u8],
) -> Result<(), ApiError> {
    let base = ai_base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(ApiError::service_unavailable(
            "Local AI service URL is not configured (FMS_LOCAL_AI_URL).",
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::service_unavailable(format!("AI client init failed: {}", e)))?;

    let json_url = format!("{}/register/json", base);
    let json_res = client
        .post(&json_url)
        .json(&serde_json::json!({
            "personId": person_id,
            "name": person_name,
            "imageBase64": payload_b64,
        }))
        .send()
        .await;

    let accepted_json = match json_res {
        Ok(resp) => {
            let status_ok = resp.status().is_success();
            let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
            status_ok
                && body
                    .get("status")
                    .and_then(|s| s.as_str())
                    .map(|s| s.eq_ignore_ascii_case("registered") || s.eq_ignore_ascii_case("ok"))
                    .unwrap_or(false)
        }
        Err(_) => false,
    };
    if accepted_json {
        return Ok(());
    }

    // Fallback multipart contract
    let multipart_url = format!("{}/register", base);
    let part = multipart::Part::bytes(decoded.to_vec())
        .file_name("face.jpg")
        .mime_str("image/jpeg")
        .map_err(|e| ApiError::service_unavailable(format!("AI multipart build failed: {}", e)))?;
    let form = multipart::Form::new()
        .text("name", person_name.to_string())
        .part("file", part);
    let resp = client
        .post(&multipart_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            ApiError::service_unavailable(format!(
                "Local AI service is unreachable. Ensure Python AI server is running at {}. {}",
                base, e
            ))
        })?;
    let status_ok = resp.status().is_success();
    let body: serde_json::Value = resp
        .json()
        .await
        .unwrap_or(serde_json::json!({ "status": "unknown" }));
    let accepted = status_ok
        && body
            .get("status")
            .and_then(|s| s.as_str())
            .map(|s| s.eq_ignore_ascii_case("registered") || s.eq_ignore_ascii_case("ok"))
            .unwrap_or(false);
    if accepted {
        Ok(())
    } else {
        Err(ApiError::service_unavailable(format!(
            "Local AI registration rejected frame: {}",
            body.get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown")
        )))
    }
}

/// Register or update the primary face template for a person (shared by `/face` and public enrollment).
pub(crate) async fn register_person_face_from_image(
    state: &AppState,
    person_id: &str,
    image_raw: &str,
    quality_score: Option<f64>,
) -> Result<serde_json::Value, ApiError> {
    let image_raw = image_raw.trim();
    if image_raw.is_empty() {
        return Err(ApiError::bad_request("imageBase64 is required"));
    }

    let payload_b64 = image_raw
        .split_once(',')
        .map(|(_, b64)| b64)
        .unwrap_or(image_raw);
    let decoded = BASE64
        .decode(payload_b64.as_bytes())
        .map_err(|_| ApiError::bad_request("Invalid base64 image payload"))?;
    if decoded.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::bad_request("Face image is too large. Max size is 2MB."));
    }

    let person_name = db::with_db(&state.db, |conn| {
        let row: Option<String> = conn
            .query_row(
                "SELECT name FROM employees WHERE id = ?1",
                params![person_id],
                |row| row.get(0),
            )
            .ok();
        row
    })
    .ok_or_else(|| ApiError::not_found("Person", Some(person_id)))?;

    verify_with_local_ai(
        state.config.local_ai_url.as_str(),
        person_id,
        person_name.as_str(),
        payload_b64,
        decoded.as_slice(),
    )
    .await?;

    db::with_db(&state.db, |conn| {
        if person_name.trim().is_empty() {
            return Err(ApiError::not_found("Person", Some(person_id)));
        }

        let id = db::gen_id();
        let now = chrono::Utc::now().to_rfc3339();
        let quality = quality_score.unwrap_or(0.0).clamp(0.0, 1.0);
        conn.execute(
            "INSERT INTO person_faces (id, personId, imageBase64, qualityScore, createdAt, updatedAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(personId) DO UPDATE SET imageBase64 = excluded.imageBase64, qualityScore = excluded.qualityScore, updatedAt = excluded.updatedAt",
            params![&id, person_id, image_raw, quality, &now, &now],
        )
        .map_err(|e| ApiError::service_unavailable(e.to_string()))?;

        Ok(serde_json::json!({
            "personId": person_id,
            "registered": true,
            "qualityScore": quality,
            "updatedAt": now,
            "aiProvider": "python-local"
        }))
    })
}

pub async fn register_person_face(
    State(state): State<AppState>,
    Path(person_id): Path<String>,
    Json(body): Json<FaceRegisterBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let resp = register_person_face_from_image(
        &state,
        person_id.as_str(),
        &body.image_base64,
        body.quality_score,
    )
    .await?;
    let person_name: String = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT name FROM employees WHERE id = ?1", params![person_id], |r| r.get(0))
    }).unwrap_or_default();
    rest::audit_log(&state, "person", "face_registered", Some(&person_id), "auditLogs.descPersonFaceRegistered", &serde_json::json!({"_i18n": {"name": person_name}})).ok();
    Ok(Json(resp))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRecognizeBody {
    pub image_base64: String,
    pub threshold: Option<f64>,
    pub max_faces: Option<u32>,
    // Optional zone-aware metadata (forward to AI service and used for access logging)
    pub zone_id: Option<String>,
    pub camera_id: Option<String>,
    pub action: Option<String>,
    pub request_id: Option<String>,
}

pub async fn recognize_face(
    State(state): State<AppState>,
    Json(body): Json<FaceRecognizeBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let image_raw = body.image_base64.trim();
    if image_raw.is_empty() {
        return Err(ApiError::bad_request("imageBase64 is required"));
    }
    let payload_b64 = image_raw
        .split_once(',')
        .map(|(_, b64)| b64)
        .unwrap_or(image_raw);
    let decoded = BASE64
        .decode(payload_b64.as_bytes())
        .map_err(|_| ApiError::bad_request("Invalid base64 image payload"))?;
    if decoded.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::bad_request("Face image is too large. Max size is 2MB."));
    }

    let base = state.config.local_ai_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(ApiError::service_unavailable(
            "Local AI service URL is not configured (FMS_LOCAL_AI_URL).",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::service_unavailable(format!("AI client init failed: {}", e)))?;
    let url = format!("{}/recognize/json", base);
    let threshold = body.threshold.unwrap_or(0.5).clamp(0.1, 0.95);
    let max_faces = body.max_faces.unwrap_or(20).clamp(1, 20);

    // Build request with optional zone metadata
    let mut ai_body = serde_json::json!({
        "imageBase64": payload_b64,
        "threshold": threshold,
        "maxFaces": max_faces,
    });
    if let Some(ref z) = body.zone_id {
        ai_body["zoneId"] = serde_json::json!(z);
    }
    if let Some(ref c) = body.camera_id {
        ai_body["cameraId"] = serde_json::json!(c);
    }
    if let Some(ref a) = body.action {
        ai_body["action"] = serde_json::json!(a);
    }
    if let Some(ref r) = body.request_id {
        ai_body["requestId"] = serde_json::json!(r);
    }

    let resp = client
        .post(&url)
        .json(&ai_body)
        .send()
        .await
        .map_err(|e| {
            ApiError::service_unavailable(format!(
                "Local AI service is unreachable. Ensure Python AI server is running at {}. {}",
                base, e
            ))
        })?;
    let body_json: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));

    // Best-effort audit + access logging. Never breaks the recognition response.
    let zone_id = body.zone_id.as_deref().unwrap_or("");
    let camera_id = body.camera_id.as_deref().unwrap_or("");
    let action = body.action.as_deref().unwrap_or("");
    let created_at = chrono::Utc::now().to_rfc3339();
    let raw = serde_json::to_string(&body_json).unwrap_or_else(|_| "{}".to_string());

    let log_result: Result<(), rusqlite::Error> = db::with_db(&state.db, |conn| {
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");
        let res = (|| -> rusqlite::Result<()> {
            if let Some(results) = body_json.get("results").and_then(|v| v.as_array()) {
                for item in results {
                    let event_id = db::gen_id();
                    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                    let person_id = item.get("personId").and_then(|v| v.as_str());
                    let person_name = item.get("name").and_then(|v| v.as_str());
                    let score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let should_log = item.get("shouldLog").and_then(|v| v.as_bool()).unwrap_or(false);
                    let track_id = item.get("trackId").and_then(|v| v.as_i64()).unwrap_or(-1);
                    let track_cached = item.get("trackCached").and_then(|v| v.as_bool()).unwrap_or(false);

                    conn.execute(
                        "INSERT INTO face_recognition_events (id, personId, personName, status, score, threshold, provider, rawResultJson, createdAt, zoneId, cameraId)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'python-local', ?7, ?8, ?9, ?10)",
                        params![event_id, person_id, person_name, status, score, threshold, raw, created_at, zone_id, camera_id],
                    )?;

                    // Access log entry for recognized persons (zone-aware activity logging)
                    // Skip logging for cached tracks — already logged on first identification
                    if should_log && status == "recognized" && !track_cached {
                        if let Some(pid) = person_id {
                            let log_id = db::gen_id();
                            let log_action = if action.is_empty() { "recognition" } else { action };
                            let _ = conn.execute(
                                "INSERT INTO access_logs (id, personId, personName, action, zoneId, cameraId, confidence, provider, createdAt)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ai-recognition', ?8)",
                                params![log_id, pid, person_name.unwrap_or(""), log_action, zone_id, camera_id, score, created_at],
                            );
                            if track_id >= 0 {
                                tracing::debug!("Logged recognition event: track_id={}, person={}", track_id, person_name.unwrap_or("?"));
                            }
                        }
                    }
                }
            } else {
                let event_id = db::gen_id();
                let status = body_json.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                let person_id = body_json.get("personId").and_then(|v| v.as_str());
                let person_name = body_json.get("name").and_then(|v| v.as_str());
                let score = body_json.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                conn.execute(
                    "INSERT INTO face_recognition_events (id, personId, personName, status, score, threshold, provider, rawResultJson, createdAt, zoneId, cameraId)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'python-local', ?7, ?8, ?9, ?10)",
                    params![event_id, person_id, person_name, status, score, threshold, raw, created_at, zone_id, camera_id],
                )?;
            }
            Ok(())
        })();
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        res
    });
    if let Err(e) = log_result {
        tracing::warn!("Failed to log recognition event (non-fatal): {}", e);
    }

    Ok(Json(body_json))
}

pub async fn face_ai_health(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let base = state.config.local_ai_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "service": "fms-local-ai",
            "model": "insightface+mediapipe",
            "error": "Local AI service URL is not configured (FMS_LOCAL_AI_URL)."
        })));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::service_unavailable(format!("AI client init failed: {}", e)))?;
    let url = format!("{}/health", base);
    let resp = match client.get(&url).send().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "service": "fms-local-ai",
                "model": "insightface+mediapipe",
                "error": format!(
                    "Local AI service is unreachable. Ensure Python AI server is running at {}. {}",
                    base, e
                )
            })));
        }
    };
    let body_json: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    // Pass through all fields from the AI service (includes yolo/timing diagnostics)
    let mut out = body_json.clone();
    if out.get("ok").is_none() {
        out["ok"] = serde_json::json!(true);
    }
    Ok(Json(out))
}

pub async fn system_stats(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let base = state.config.local_ai_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Ok(Json(serde_json::json!({ "error": "AI service not configured" })));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| ApiError::service_unavailable(format!("Client init: {}", e)))?;
    let resp = match client.get(format!("{}/system-stats", base)).send().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(Json(serde_json::json!({ "error": format!("AI unreachable: {}", e) })));
        }
    };
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    Ok(Json(body))
}

pub async fn system_info(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let base = state.config.local_ai_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Ok(Json(serde_json::json!({ "error": "AI service not configured" })));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(AI_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::service_unavailable(format!("Client init: {}", e)))?;
    let resp = match client.get(format!("{}/system-info", base)).send().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(Json(serde_json::json!({ "error": format!("AI service unreachable: {}", e) })));
        }
    };
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    Ok(Json(body))
}

pub async fn get_person_face_status(
    State(state): State<AppState>,
    Path(person_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let status = db::with_db(&state.db, |conn| {
        let row: Option<(String, f64)> = conn
            .query_row(
                "SELECT updatedAt, qualityScore FROM person_faces WHERE personId = ?1",
                params![&person_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let out = match row {
            Some((updated_at, quality_score)) => serde_json::json!({
                "personId": person_id,
                "registered": true,
                "qualityScore": quality_score,
                "updatedAt": updated_at
            }),
            None => serde_json::json!({
                "personId": person_id,
                "registered": false,
                "qualityScore": 0.0,
                "updatedAt": serde_json::Value::Null
            }),
        };
        Ok::<serde_json::Value, ApiError>(out)
    })?;

    Ok(Json(status))
}
