//! Auth, config, health, ping handlers.

use axum::{
    extract::State,
    http::HeaderMap,
    response::Json,
};
use chrono::Utc;
use rusqlite::params;
use serde::Serialize;

use crate::api::error::ApiError;
use crate::api::license::{effective_stored_state, license_allows_access, refresh_cached_license_if_possible};
use crate::api::password;
use crate::api::state::{AppState, AppConfig};
use crate::db;

#[derive(serde::Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LoginSuccess {
    pub success: bool,
    pub admin: serde_json::Value,
}

#[derive(Serialize)]
#[allow(dead_code)]
pub struct LoginError {
    pub success: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResponse {
    pub company_name: String,
    pub company_logo_url: Option<String>,
    pub onboarding_completed: bool,
    pub license_key_masked: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub database: String,
    pub timestamp: String,
}

const PERMISSION_KEYS: [&str; 8] = [
    "dashboard", "employees", "accessLogs", "auditLogs", "zones", "schedules", "admins", "reports",
];

fn env_super_admin_payload(email: &str, config: &AppConfig) -> serde_json::Value {
    let name = if !config.super_admin_name.is_empty() {
        &config.super_admin_name
    } else if !config.company_name.is_empty() {
        &config.company_name
    } else {
        "Super Admin"
    };
    
    serde_json::json!({
        "id": "env-super-admin",
        "name": name,
        "email": email,
        "role": "super_admin",
        "status": "active",
        "permissions": PERMISSION_KEYS,
        "createdAt": Utc::now().to_rfc3339(),
        "lastLoginAt": Utc::now().to_rfc3339(),
    })
}

pub async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let email = body.email.trim().to_lowercase();
    let password_str = body.password.as_str();
    if email.is_empty() || password_str.is_empty() {
        return Err(ApiError::bad_request("Email and password are required."));
    }
    // Skip license gate when cloud verification is disabled (offline / dev mode).
    if state.config.license_key_verification_enabled {
        let license_state = effective_stored_state(&state)?;
        if !license_allows_access(&license_state.license_status, license_state.license_expires_at.as_deref()) {
            return Err(ApiError::forbidden(
                "A valid verified license is required to access the application.",
            ));
        }
    }

    let env_email = state.config.email.trim().to_lowercase();
    let env_password = &state.config.password;

    if !env_email.is_empty() && !env_password.is_empty() && email == env_email {
        if password_str != env_password {
            return Err(ApiError::unauthorized("Invalid email or password."));
        }
        return Ok(Json(serde_json::json!({
            "success": true,
            "admin": env_super_admin_payload(&email, &state.config)
        })));
    }

    let admin = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, email, role, status, permissions, password_hash, createdAt, lastLoginAt FROM admins WHERE email = ?1",
        )?;
        let mut rows = stmt.query(params![email])?;
        if let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let email: String = row.get(2)?;
            let role: String = row.get(3)?;
            let status: String = row.get(4)?;
            let permissions: String = row.get(5)?;
            let password_hash: Option<String> = row.get(6)?;
            let created_at: Option<String> = row.get(7)?;
            let last_login: Option<String> = row.get(8)?;
            let perms: Vec<String> = serde_json::from_str(&permissions).unwrap_or_default();
            Ok(Some((
                id,
                name,
                email,
                role,
                status,
                perms,
                password_hash,
                created_at,
                last_login,
            )))
        } else {
            Ok(None)
        }
    })
    .map_err(|e: rusqlite::Error| {
        tracing::error!("Database error in login: {}", e);
        ApiError::service_unavailable(e.to_string())
    })?;

    let admin = match admin {
        Some(a) => a,
        None => return Err(ApiError::unauthorized("Invalid email or password.")),
    };
    if admin.3 != "active" {
        return Err(ApiError::forbidden("Account is inactive."));
    }
    let hash = admin.6.unwrap_or_default();
    if hash.trim().is_empty() {
        // Admin exists but has no password (e.g. created before password was set in onboarding).
        // Allow login if FMS_EMAIL/FMS_PASSWORD match, then persist password for next time.
        if env_email.is_empty() || env_password.is_empty() || email != env_email || password_str != env_password {
            return Err(ApiError::forbidden(
                "This account has no password set. Please ask an administrator to set your password.",
            ));
        }
        if let Ok(new_hash) = password::hash_password(password_str) {
            let admin_id = admin.0.clone();
            let now = Utc::now().to_rfc3339();
            let _ = db::with_db(&state.db, |conn| {
                conn.execute(
                    "UPDATE admins SET password_hash = ?1, lastLoginAt = ?2 WHERE id = ?3",
                    params![new_hash, now, admin_id],
                )
            });
        }
        let payload = serde_json::json!({
            "id": admin.0,
            "name": admin.1,
            "email": admin.2,
            "role": admin.3,
            "status": admin.4,
            "permissions": admin.5,
            "createdAt": admin.7,
            "lastLoginAt": Utc::now().to_rfc3339(),
        });
        return Ok(Json(serde_json::json!({ "success": true, "admin": payload })));
    }
    if !password::verify_password(password_str, &hash) {
        return Err(ApiError::unauthorized("Invalid email or password."));
    }
    let payload = serde_json::json!({
        "id": admin.0,
        "name": admin.1,
        "email": admin.2,
        "role": admin.3,
        "status": admin.4,
        "permissions": admin.5,
        "createdAt": admin.7,
        "lastLoginAt": admin.8,
    });
    Ok(Json(serde_json::json!({ "success": true, "admin": payload })))
}

#[allow(dead_code)]
fn get_actor_headers(headers: &HeaderMap) -> (Option<String>, Option<String>, String) {
    let actor_id = headers
        .get("x-actor-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let actor_name = headers
        .get("x-actor-name")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let actor_type = headers
        .get("x-actor-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| if s.trim() == "admin" { "admin" } else { "system" })
        .unwrap_or("system")
        .to_string();
    (actor_id, actor_name, actor_type)
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.config.license_key_verification_enabled {
        let license_state = effective_stored_state(&state)?;
        if !license_allows_access(&license_state.license_status, license_state.license_expires_at.as_deref()) {
            return Err(ApiError::forbidden(
                "A valid verified license is required to access the application.",
            ));
        }
    }
    let email = headers
        .get("x-user-email")
        .or_else(|| headers.get("X-User-Email"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let email = match email {
        Some(e) => e,
        None => return Err(ApiError::unauthorized("X-User-Email required")),
    };

    let env_email = state.config.email.trim().to_lowercase();
    if !env_email.is_empty() && email == env_email {
        return Ok(Json(env_super_admin_payload(&email, &state.config)));
    }

    let admin = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, email, role, status, permissions, createdAt, lastLoginAt FROM admins WHERE email = ?1",
        )?;
        let mut rows = stmt.query(params![email])?;
        if let Some(row) = rows.next()? {
            let perms: String = row.get(5)?;
            let perms: Vec<String> = serde_json::from_str(&perms).unwrap_or_default();
            Ok(Some(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "email": row.get::<_, String>(2)?,
                "role": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "permissions": perms,
                "createdAt": row.get::<_, Option<String>>(6)?,
                "lastLoginAt": row.get::<_, Option<String>>(7)?,
            })))
        } else {
            Ok(None)
        }
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    match admin {
        Some(a) => Ok(Json(a)),
        None => Err(ApiError::not_found("Admin", None)),
    }
}

pub async fn get_config(State(state): State<AppState>) -> Result<Json<ConfigResponse>, ApiError> {
    let license_state = refresh_cached_license_if_possible(&state)
        .await
        .map_err(|err| ApiError::service_unavailable(match err {
            crate::api::license::LicenseSyncError::Invalid(message)
            | crate::api::license::LicenseSyncError::Service(message) => message,
        }))?;
    let onboarding_completed = license_state.onboarding_completed
        && license_allows_access(&license_state.license_status, license_state.license_expires_at.as_deref());
    let company_name = if !license_state.company_name.trim().is_empty() {
        license_state.company_name
    } else {
        state.config.company_name.clone()
    };
    let company_logo_url = license_state.company_logo_url.or_else(|| {
        if state.config.company_image.is_empty() {
            None
        } else {
            Some(state.config.company_image.clone())
        }
    });

    Ok(Json(ConfigResponse {
        company_name,
        company_logo_url,
        onboarding_completed,
        license_key_masked: license_state.license_key_masked,
    }))
}

pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    let ok = db::with_db(&state.db, |conn| conn.query_row("SELECT 1", [], |_| Ok(())));
    if ok.is_err() {
        return Err(ApiError::service_unavailable("database disconnected"));
    }
    Ok(Json(HealthResponse {
        status: "ok".to_string(),
        database: "connected".to_string(),
        timestamp: Utc::now().to_rfc3339(),
    }))
}
