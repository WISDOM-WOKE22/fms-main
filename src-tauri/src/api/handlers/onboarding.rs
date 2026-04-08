//! Onboarding and license endpoints.

use axum::extract::State;
use axum::response::Json;
use rusqlite::params;

use crate::api::error::ApiError;
use crate::api::license::{effective_stored_state, persist_entered_license_key, validate_and_store_license, LicenseSyncError};
use crate::api::password;
use crate::api::state::AppState;
use crate::db;

const PERMISSION_KEYS: [&str; 8] = [
    "dashboard", "employees", "accessLogs", "auditLogs", "zones", "schedules", "admins", "reports",
];

pub async fn create_super_admin(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let email = state.config.email.trim().to_lowercase();
    if email.is_empty() {
        return Err(ApiError::service_unavailable(
            "Super admin email is not configured (FMS_EMAIL).",
        ));
    }
    
    let name = if !state.config.super_admin_name.is_empty() {
        &state.config.super_admin_name
    } else if !state.config.company_name.is_empty() {
        &state.config.company_name
    } else {
        "Super Admin"
    };

    // If FMS_PASSWORD is set, hash it so the new admin can log in with email + password
    let password_hash: Option<String> = if !state.config.password.is_empty() {
        password::hash_password(state.config.password.trim()).ok()
    } else {
        None
    };

    let now = chrono::Utc::now().to_rfc3339();

    db::with_db(&state.db, |conn| {
        let exists: bool = conn
            .query_row("SELECT 1 FROM admins WHERE email = ?1", params![email], |row| row.get(0))
            .unwrap_or(false);
        if exists {
            return Ok(());
        }
        let id = db::gen_id();
        let permissions = serde_json::to_string(&PERMISSION_KEYS[..]).unwrap();
        conn.execute(
            "INSERT INTO admins (id, name, email, role, status, permissions, password_hash, createdAt, lastLoginAt) VALUES (?1, ?2, ?3, 'super_admin', 'active', ?4, ?5, ?6, ?7)",
            params![id, name, email, permissions, password_hash, now, now],
        )?;
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingCompleteBody {
    pub license_key: Option<String>,
}

pub async fn complete_onboarding(
    State(state): State<AppState>,
    Json(body): Json<OnboardingCompleteBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key = body.license_key.as_deref().unwrap_or("").trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("License key is required."));
    }
    persist_entered_license_key(&state, key)?;
    let masked = mask_license_key(key);
    db::with_db(&state.db, |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        for (k, v) in [
            ("onboarding_completed", "true"),
            ("license_key_stored", masked.as_str()),
            ("license_key_full", key),
        ] {
            conn.execute(
                "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value=?3, updatedAt=?4",
                params![db::gen_id(), k, v, now],
            )?;
        }
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(serde_json::json!({ "success": true })))
}

fn mask_license_key(key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        return "••••-••••-••••-••••".to_string();
    }
    let binding = key.replace(' ', "");
    let parts: Vec<&str> = binding.split('-').collect();
    if parts.len() >= 4 {
        let last = parts[parts.len() - 1];
        let suffix = last.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>().to_uppercase();
        return format!("••••-••••-••••-{}", suffix);
    }
    if key.len() >= 4 {
        return format!("••••-••••-••••-{}", key[key.len()-4..].to_uppercase());
    }
    "••••-••••-••••-••••".to_string()
}

pub async fn get_license(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let stored = effective_stored_state(&state)?;
    let license_key = if stored.license_key_full.trim().is_empty() {
        state.config.license_key.clone()
    } else {
        stored.license_key_full
    };
    Ok(Json(serde_json::json!({
        "licenseKey": license_key,
        "status": stored.license_status,
        "expiresAt": stored.license_expires_at,
        "licenseSource": stored.license_source,
    })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseValidateRequest {
    #[serde(alias = "license_key")]
    pub license_key: Option<String>,
}

/// Validate license key. Always returns 200 with JSON so the frontend never gets 500 or parse errors.
pub async fn validate_license(
    State(state): State<AppState>,
    Json(body): Json<LicenseValidateRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let key = body
        .license_key
        .as_deref()
        .unwrap_or("")
        .trim();
    if key.is_empty() {
        return Ok(Json(serde_json::json!({
            "valid": false,
            "message": "License key is required."
        })));
    }
    match validate_and_store_license(&state, key).await {
        Ok(stored) => {
            let mut resp = serde_json::json!({ "valid": true });
            if !stored.license_source.is_empty() {
                resp["licenseSource"] = serde_json::Value::String(stored.license_source.clone());
            }
            if stored.license_source == "dev_fallback" {
                resp["message"] = serde_json::Value::String(
                    "License accepted in development mode. This will not work in production.".to_string(),
                );
            }
            Ok(Json(resp))
        }
        Err(LicenseSyncError::Invalid(message)) => Ok(Json(serde_json::json!({
            "valid": false,
            "message": message
        }))),
        Err(LicenseSyncError::Service(message)) => Ok(Json(serde_json::json!({
            "valid": false,
            "message": message
        }))),
    }
}
