//! Link-based face enrollment (public session + admin send-link).

use axum::{
    extract::{Path, State},
    response::Json,
};
use chrono::{Duration, Utc};
use rusqlite::params;
use uuid::Uuid;

use crate::api::error::ApiError;
use crate::api::handlers::face;
use crate::api::handlers::rest;
use crate::api::state::AppState;
use crate::db;

const TOKEN_TTL_HOURS: i64 = 48;

pub async fn send_face_enrollment_link(
    State(state): State<AppState>,
    Path(person_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (email, name) = db::with_db(&state.db, |conn| {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT COALESCE(email, ''), name FROM employees WHERE id = ?1",
                params![&person_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        Ok::<_, rusqlite::Error>(row)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?
    .ok_or_else(|| ApiError::not_found("Person", Some(&person_id)))?;

    let email = email.trim();
    if email.is_empty() {
        return Err(ApiError::bad_request(
            "This person has no email address. Add an email before sending a face enrollment link.",
        ));
    }

    let token = Uuid::new_v4().to_string();
    let expires = Utc::now() + Duration::hours(TOKEN_TTL_HOURS);
    let expires_at = expires.to_rfc3339();
    let now = Utc::now().to_rfc3339();

    db::with_db(&state.db, |conn| {
        conn.execute(
            "UPDATE employees SET enrollmentToken = ?1, enrollmentTokenExpiresAt = ?2, faceEnrollmentStatus = 'link_sent', updatedAt = ?3 WHERE id = ?4",
            params![&token, &expires_at, &now, &person_id],
        )
        .map_err(|e| ApiError::service_unavailable(e.to_string()))?;
        rest::enqueue_employee_sync_update(conn, &person_id).map_err(|e| ApiError::service_unavailable(e.to_string()))?;
        Ok::<(), ApiError>(())
    })?;

    tracing::info!(
        person_id = %person_id,
        person_name = %name,
        to_email = %email,
        expires_at = %expires_at,
        "Face enrollment link issued (email delivery not configured; copy link from client)"
    );

    rest::audit_log(&state, "person", "send_enrollment_link", Some(&person_id), "auditLogs.descPersonEnrollmentLinkSent", &serde_json::json!({"_i18n": {"name": name}})).ok();

    Ok(Json(serde_json::json!({
        "token": token,
        "expiresAt": expires_at,
        "emailSent": false,
        "message": "Copy the enrollment link and send it to the employee. Email delivery is not configured on this device."
    })))
}

pub async fn get_face_enrollment_session(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ApiError::bad_request("Invalid enrollment token"));
    }

    let row = db::with_db(&state.db, |conn| {
        let row: Option<(String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT id, name, faceEnrollmentStatus, enrollmentTokenExpiresAt FROM employees WHERE enrollmentToken = ?1",
                params![token],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        Ok::<_, rusqlite::Error>(row)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    let Some((person_id, name, stored_status, exp)) = row else {
        return Ok(Json(serde_json::json!({
            "valid": false,
            "code": "INVALID_TOKEN",
            "message": "This enrollment link is invalid or has already been used."
        })));
    };

    let expired = if stored_status.as_str() == "link_sent" {
        exp.as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s.trim()).ok())
            .map(|dt| Utc::now() > dt.with_timezone(&Utc))
            .unwrap_or(false)
    } else {
        false
    };

    Ok(Json(serde_json::json!({
        "valid": true,
        "employeeName": name,
        "personId": person_id,
        "expired": expired,
        "expiresAt": exp,
        "alreadyEnrolled": false
    })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceEnrollmentSubmitBody {
    pub front_image_base64: String,
    pub right_image_base64: Option<String>,
    pub left_image_base64: Option<String>,
}

pub async fn submit_face_enrollment(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<FaceEnrollmentSubmitBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ApiError::bad_request("Invalid enrollment token"));
    }

    let row = db::with_db(&state.db, |conn| {
        let row: Option<(String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT id, name, faceEnrollmentStatus, enrollmentTokenExpiresAt FROM employees WHERE enrollmentToken = ?1",
                params![token],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        Ok::<_, rusqlite::Error>(row)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    let Some((person_id, name, stored_status, exp)) = row else {
        return Err(ApiError::bad_request(
            "This enrollment link is invalid or has already been used.",
        ));
    };

    if stored_status.as_str() != "link_sent" {
        return Err(ApiError::bad_request(
            "This enrollment link is no longer valid.",
        ));
    }

    let expired = exp
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s.trim()).ok())
        .map(|dt| Utc::now() > dt.with_timezone(&Utc))
        .unwrap_or(true);

    if expired {
        return Err(ApiError::bad_request(
            "This enrollment link has expired. Ask your administrator to send a new link.",
        ));
    }

    let _side_meta = serde_json::json!({
        "rightLen": body.right_image_base64.as_deref().map(|s| s.len()).unwrap_or(0),
        "leftLen": body.left_image_base64.as_deref().map(|s| s.len()).unwrap_or(0),
    });
    tracing::debug!(person_id = %person_id, meta = %_side_meta, "Face enrollment submit (front used for AI; side captures optional)");

    face::register_person_face_from_image(
        &state,
        person_id.as_str(),
        &body.front_image_base64,
        None,
    )
    .await?;

    let now = Utc::now().to_rfc3339();
    db::with_db(&state.db, |conn| {
        conn.execute(
            "UPDATE employees SET faceEnrollmentStatus = 'enrolled', enrollmentToken = NULL, enrollmentTokenExpiresAt = NULL, updatedAt = ?1 WHERE id = ?2",
            params![&now, &person_id],
        )
        .map_err(|e| ApiError::service_unavailable(e.to_string()))?;
        rest::enqueue_employee_sync_update(conn, &person_id).map_err(|e| ApiError::service_unavailable(e.to_string()))?;
        Ok::<(), ApiError>(())
    })?;

    tracing::info!(person_id = %person_id, person_name = %name, "Face enrollment completed via public link");

    rest::audit_log(&state, "person", "face_registered", Some(&person_id), "auditLogs.descPersonFaceRegistered", &serde_json::json!({"_i18n": {"name": name}})).ok();

    Ok(Json(serde_json::json!({
        "ok": true,
        "personId": person_id,
        "message": "Face enrollment completed successfully."
    })))
}
