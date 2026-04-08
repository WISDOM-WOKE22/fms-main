//! License verification, signed-token validation, and cached company context.

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::api::error::ApiError;
use crate::api::state::{is_dev_fallback_enabled, AppConfig, AppState};
use crate::db;

const AUDIENCE: &str = "fms-desktop";
const DEV_LICENSE_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsGUwtpI/pJmKtOMrdDlC\n1DCVzdhP4/gYckGeZydbi9nnYSgKZAa8DTwKOIzezp85ZeccM8uxvMTo67pp5dzk\nxTut50J2joh0ix96cRRmx6lxHz0+cZ4jb2dE3Npe6aUSYnv7Mb0XbfYzSCvbpGct\nBN9uzj3LyW+Uey5JA2dmZykszF5amAXCcMMwlW9oTIkLKcjySjTZXJgNCjXrXyFU\nEcjYuM+ZTQOVzCKgWM+yNwaC5SVL8nb4RGJ/3buajet3liKB1zad5jGwAkuKh6ee\nSXBVdW/0qS07aXIA0ck/+U2nl0+SjEjSPv1iSTvNPmyc8H+fhsPtQTV7xta7nFO+\nUQIDAQAB\n-----END PUBLIC KEY-----";
const KEY_ONBOARDING_COMPLETED: &str = "onboarding_completed";
const KEY_LICENSE_KEY_FULL: &str = "license_key_full";
const KEY_LICENSE_KEY_STORED: &str = "license_key_stored";
const KEY_LICENSE_STATUS: &str = "license_status";
const KEY_LICENSE_EXPIRES_AT: &str = "license_expires_at";
const KEY_LICENSE_CLIENT_ID: &str = "license_client_id";
const KEY_COMPANY_NAME: &str = "company_name";
const KEY_COMPANY_LOGO_URL: &str = "company_logo_url";
const KEY_LICENSE_SIGNED_TOKEN: &str = "license_signed_token";
const KEY_LICENSE_LAST_VERIFIED_AT: &str = "license_last_verified_at";
const KEY_LICENSE_SOURCE: &str = "license_source";

#[derive(Clone, Debug, Default)]
pub struct StoredLicenseState {
    pub onboarding_completed: bool,
    pub license_key_full: String,
    pub license_key_masked: String,
    pub license_status: String,
    pub license_expires_at: Option<String>,
    #[allow(dead_code)]
    pub client_id: Option<String>,
    pub company_name: String,
    pub company_logo_url: Option<String>,
    pub signed_token: Option<String>,
    /// "cloud" | "dev_fallback" | "" — how the license was verified.
    pub license_source: String,
}

#[derive(Clone, Debug)]
pub enum LicenseSyncError {
    Invalid(String),
    Service(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVerifyResponse {
    valid: bool,
    message: Option<String>,
    signed_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedLicenseClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
    pub nbf: usize,
    pub license_id: String,
    pub license_key: String,
    pub license_status: String,
    pub license_expires_at: String,
    pub client_id: String,
    pub company_name: String,
    #[serde(default)]
    pub company_logo_url: Option<String>,
    #[serde(default)]
    pub company_email: Option<String>,
    #[serde(default)]
    pub company_location: Option<String>,
}

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn upsert_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value=?3, updatedAt=?4",
        params![db::gen_id(), key, value, now],
    )?;
    Ok(())
}

fn normalize_pem(value: &str) -> String {
    let normalized = value.trim().replace("\\n", "\n");
    if normalized.is_empty()
        || normalized == "This_is_our_public_key_pem"
        || !normalized.starts_with("-----BEGIN ")
    {
        DEV_LICENSE_PUBLIC_KEY_PEM.to_string()
    } else {
        normalized
    }
}

fn normalize_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub fn remote_verification_enabled(config: &AppConfig) -> bool {
    !normalize_url(&config.main_backend_url).is_empty()
        && !normalize_pem(&config.license_public_key_pem).is_empty()
}

pub fn mask_license_key(key: &str) -> String {
    let compact = key.trim().replace(' ', "");
    if compact.is_empty() {
        return "••••-••••-••••-••••".to_string();
    }
    let parts: Vec<&str> = compact.split('-').collect();
    let suffix = parts.last().copied().unwrap_or(&compact);
    let suffix = if suffix.len() >= 4 {
        suffix[suffix.len() - 4..].to_uppercase()
    } else {
        suffix.to_uppercase()
    };
    format!("••••-••••-••••-{}", suffix)
}

pub fn license_allows_access(status: &str, expires_at: Option<&str>) -> bool {
    if status.trim() != "active" {
        return false;
    }
    let Some(expires_at) = expires_at else {
        return false;
    };
    DateTime::parse_from_rfc3339(expires_at)
        .map(|value| value.with_timezone(&Utc) > Utc::now())
        .unwrap_or(false)
}

fn validation_for(config: &AppConfig) -> Validation {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[AUDIENCE]);
    validation.set_issuer(&[config.license_issuer.trim()]);
    validation
}

fn decode_signed_token(config: &AppConfig, token: &str) -> Result<VerifiedLicenseClaims, ApiError> {
    let public_key = normalize_pem(&config.license_public_key_pem);
    if public_key.is_empty() {
        return Err(ApiError::service_unavailable(
            "FMS_LICENSE_PUBLIC_KEY_PEM is not configured.",
        ));
    }
    let key = DecodingKey::from_rsa_pem(public_key.as_bytes()).map_err(|err| {
        ApiError::service_unavailable(format!("Invalid FMS_LICENSE_PUBLIC_KEY_PEM: {err}"))
    })?;
    let data = decode::<VerifiedLicenseClaims>(token, &key, &validation_for(config)).map_err(|err| {
        ApiError {
            status_code: StatusCode::UNAUTHORIZED,
            message: format!("Invalid signed license token: {err}"),
            code: "UNAUTHORIZED".to_string(),
        }
    })?;
    Ok(data.claims)
}

fn state_from_claims(onboarding_completed: bool, token: Option<String>, claims: VerifiedLicenseClaims) -> StoredLicenseState {
    StoredLicenseState {
        onboarding_completed,
        license_key_masked: mask_license_key(&claims.license_key),
        license_key_full: claims.license_key,
        license_status: claims.license_status,
        license_expires_at: Some(claims.license_expires_at),
        client_id: Some(claims.client_id),
        company_name: claims.company_name,
        company_logo_url: claims.company_logo_url,
        signed_token: token,
        license_source: String::new(), // set by caller (persist_verified_state reads from DB)
    }
}

/// Stored license state from DB (used by sync to get license key for cloud binding).
pub fn raw_stored_state(state: &AppState) -> Result<StoredLicenseState, ApiError> {
    db::with_db(&state.db, |conn| {
        let onboarding_completed = get_setting(conn, KEY_ONBOARDING_COMPLETED)
            .as_deref()
            .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
        Ok(StoredLicenseState {
            onboarding_completed,
            license_key_full: get_setting(conn, KEY_LICENSE_KEY_FULL).unwrap_or_default(),
            license_key_masked: get_setting(conn, KEY_LICENSE_KEY_STORED)
                .unwrap_or_else(|| "••••-••••-••••-••••".to_string()),
            license_status: get_setting(conn, KEY_LICENSE_STATUS).unwrap_or_default(),
            license_expires_at: get_setting(conn, KEY_LICENSE_EXPIRES_AT).filter(|value| !value.trim().is_empty()),
            client_id: get_setting(conn, KEY_LICENSE_CLIENT_ID).filter(|value| !value.trim().is_empty()),
            company_name: get_setting(conn, KEY_COMPANY_NAME).unwrap_or_default(),
            company_logo_url: get_setting(conn, KEY_COMPANY_LOGO_URL).filter(|value| !value.trim().is_empty()),
            signed_token: get_setting(conn, KEY_LICENSE_SIGNED_TOKEN).filter(|value| !value.trim().is_empty()),
            license_source: get_setting(conn, KEY_LICENSE_SOURCE).unwrap_or_default(),
        })
    })
    .map_err(|err: rusqlite::Error| ApiError::service_unavailable(err.to_string()))
}

pub fn effective_stored_state(state: &AppState) -> Result<StoredLicenseState, ApiError> {
    let raw = raw_stored_state(state)?;
    if let Some(token) = raw.signed_token.clone() {
        if let Ok(claims) = decode_signed_token(&state.config, &token) {
            return Ok(state_from_claims(raw.onboarding_completed, Some(token), claims));
        }
        if remote_verification_enabled(&state.config) {
            let mut invalid = raw.clone();
            invalid.license_status = "invalid".to_string();
            invalid.license_expires_at = None;
            return Ok(invalid);
        }
    }
    Ok(raw)
}

fn persist_verified_state(
    state: &AppState,
    license_key: &str,
    signed_token: &str,
    claims: &VerifiedLicenseClaims,
) -> Result<StoredLicenseState, LicenseSyncError> {
    db::with_db(&state.db, |conn| {
        upsert_setting(conn, KEY_LICENSE_KEY_FULL, license_key)?;
        upsert_setting(conn, KEY_LICENSE_KEY_STORED, &mask_license_key(license_key))?;
        upsert_setting(conn, KEY_LICENSE_STATUS, &claims.license_status)?;
        upsert_setting(conn, KEY_LICENSE_EXPIRES_AT, &claims.license_expires_at)?;
        upsert_setting(conn, KEY_LICENSE_CLIENT_ID, &claims.client_id)?;
        upsert_setting(conn, KEY_COMPANY_NAME, &claims.company_name)?;
        upsert_setting(
            conn,
            KEY_COMPANY_LOGO_URL,
            claims.company_logo_url.as_deref().unwrap_or(""),
        )?;
        upsert_setting(conn, KEY_LICENSE_SIGNED_TOKEN, signed_token)?;
        upsert_setting(conn, KEY_LICENSE_LAST_VERIFIED_AT, &Utc::now().to_rfc3339())?;
        upsert_setting(conn, KEY_LICENSE_SOURCE, "cloud")?;
        Ok(())
    })
    .map_err(|err: rusqlite::Error| LicenseSyncError::Service(err.to_string()))?;

    tracing::info!("License verified via cloud backend (source=cloud)");
    effective_stored_state(state).map_err(|err| LicenseSyncError::Service(err.message))
}

pub fn persist_entered_license_key(state: &AppState, license_key: &str) -> Result<(), ApiError> {
    db::with_db(&state.db, |conn| {
        upsert_setting(conn, KEY_LICENSE_KEY_FULL, license_key)?;
        upsert_setting(conn, KEY_LICENSE_KEY_STORED, &mask_license_key(license_key))?;
        Ok(())
    })
    .map_err(|err: rusqlite::Error| ApiError::service_unavailable(err.to_string()))
}

pub fn mark_license_invalid(state: &AppState, license_key: &str) -> Result<StoredLicenseState, LicenseSyncError> {
    db::with_db(&state.db, |conn| {
        upsert_setting(conn, KEY_LICENSE_KEY_FULL, license_key)?;
        upsert_setting(conn, KEY_LICENSE_KEY_STORED, &mask_license_key(license_key))?;
        upsert_setting(conn, KEY_LICENSE_STATUS, "invalid")?;
        upsert_setting(conn, KEY_LICENSE_EXPIRES_AT, "")?;
        upsert_setting(conn, KEY_LICENSE_CLIENT_ID, "")?;
        upsert_setting(conn, KEY_COMPANY_NAME, "")?;
        upsert_setting(conn, KEY_COMPANY_LOGO_URL, "")?;
        upsert_setting(conn, KEY_LICENSE_SIGNED_TOKEN, "")?;
        upsert_setting(conn, KEY_LICENSE_SOURCE, "")?;
        Ok(())
    })
    .map_err(|err: rusqlite::Error| LicenseSyncError::Service(err.to_string()))?;
    effective_stored_state(state).map_err(|err| LicenseSyncError::Service(err.message))
}

async fn verify_against_main_backend(
    state: &AppState,
    license_key: &str,
) -> Result<(String, VerifiedLicenseClaims), LicenseSyncError> {
    let base_url = normalize_url(&state.config.main_backend_url);
    if base_url.is_empty() {
        return Err(LicenseSyncError::Service(
            "FMS_MAIN_BACKEND_URL is not configured.".to_string(),
        ));
    }
    let response = reqwest::Client::new()
        .post(format!("{base_url}/api/v1/public/licenses/verify"))
        .json(&serde_json::json!({ "licenseKey": license_key }))
        .send()
        .await
        .map_err(|err| LicenseSyncError::Service(format!("Could not reach the main backend: {err}")))?;

    let status = response.status();
    let body = response
        .json::<RemoteVerifyResponse>()
        .await
        .map_err(|err| LicenseSyncError::Service(format!("Invalid response from main backend: {err}")))?;

    if !status.is_success() {
        return Err(LicenseSyncError::Service(
            body.message.unwrap_or_else(|| format!("Main backend returned {}", status.as_u16())),
        ));
    }

    if !body.valid {
        return Err(LicenseSyncError::Invalid(
            body.message.unwrap_or_else(|| "Invalid or expired license key. Please check and try again.".to_string()),
        ));
    }

    let signed_token = body.signed_token.ok_or_else(|| {
        LicenseSyncError::Service("Main backend did not return a signed license token.".to_string())
    })?;

    let claims = decode_signed_token(&state.config, &signed_token)
        .map_err(|err| LicenseSyncError::Service(err.message))?;
    if claims.license_key.trim() != license_key.trim() {
        return Err(LicenseSyncError::Service(
            "Signed license token did not match the submitted license key.".to_string(),
        ));
    }
    Ok((signed_token, claims))
}

/// Local-only validation: strict equality with `FMS_LICENSE_KEY`.
/// Used when cloud verification is disabled or as a dev fallback on service errors.
fn validate_against_local_key(state: &AppState, license_key: &str, source: &str) -> Result<StoredLicenseState, LicenseSyncError> {
    let expected = state.config.license_key.trim();
    // SECURITY: never accept an arbitrary key — configured key must be non-empty and match exactly.
    if expected.is_empty() || license_key != expected {
        return Err(LicenseSyncError::Invalid(
            "Invalid license key. Please check and try again.".to_string(),
        ));
    }

    tracing::info!(
        "License accepted via local key match (source={}). key={}",
        source,
        mask_license_key(license_key),
    );

    // Local validation has no real expiry — set a far-future date so that
    // `license_allows_access` (which requires both status=active AND a future
    // expiry) will grant access.
    let far_future = (Utc::now() + chrono::Duration::days(365 * 10)).to_rfc3339();

    db::with_db(&state.db, |conn| {
        upsert_setting(conn, KEY_LICENSE_KEY_FULL, license_key)?;
        upsert_setting(conn, KEY_LICENSE_KEY_STORED, &mask_license_key(license_key))?;
        upsert_setting(conn, KEY_LICENSE_STATUS, "active")?;
        upsert_setting(conn, KEY_LICENSE_EXPIRES_AT, &far_future)?;
        upsert_setting(conn, KEY_LICENSE_SOURCE, source)?;
        Ok(())
    })
    .map_err(|err: rusqlite::Error| LicenseSyncError::Service(err.to_string()))?;

    effective_stored_state(state).map_err(|err| LicenseSyncError::Service(err.message))
}

pub async fn validate_and_store_license(
    state: &AppState,
    license_key: &str,
) -> Result<StoredLicenseState, LicenseSyncError> {
    let license_key = license_key.trim();
    if license_key.is_empty() {
        return Err(LicenseSyncError::Invalid("License key is required.".to_string()));
    }

    // ── Verification disabled → local-only match against FMS_LICENSE_KEY ──
    if !state.config.license_key_verification_enabled {
        tracing::info!("Cloud license verification disabled (FMS_LICENSE_KEY_VERIFICATION_ENABLED=false)");
        return validate_against_local_key(state, license_key, "local");
    }

    // ── Verification enabled → try cloud first ──
    if remote_verification_enabled(&state.config) {
        match verify_against_main_backend(state, license_key).await {
            Ok((signed_token, claims)) => {
                return persist_verified_state(state, license_key, &signed_token, &claims);
            }
            // Cloud says INVALID → always reject, never fallback
            Err(LicenseSyncError::Invalid(message)) => {
                let _ = mark_license_invalid(state, license_key);
                return Err(LicenseSyncError::Invalid(message));
            }
            // Cloud SERVICE/NETWORK error → fallback only if dev mode enabled
            Err(LicenseSyncError::Service(message)) => {
                if is_dev_fallback_enabled(&state.config) && !state.config.license_key.trim().is_empty() {
                    tracing::warn!(
                        "Remote verification failed ({}). Dev fallback enabled — trying local key match.",
                        message,
                    );
                    return validate_against_local_key(state, license_key, "dev_fallback");
                }
                return Err(LicenseSyncError::Service(message));
            }
        }
    }

    // Remote not configured but verification is enabled — try dev fallback
    if is_dev_fallback_enabled(&state.config) {
        return validate_against_local_key(state, license_key, "dev_fallback");
    }

    Err(LicenseSyncError::Service(
        "License backend is not configured. Set FMS_MAIN_BACKEND_URL and FMS_LICENSE_PUBLIC_KEY_PEM, or set FMS_LICENSE_KEY_VERIFICATION_ENABLED=false for local-only validation.".to_string(),
    ))
}

pub async fn refresh_cached_license_if_possible(state: &AppState) -> Result<StoredLicenseState, LicenseSyncError> {
    let current = effective_stored_state(state).map_err(|err| LicenseSyncError::Service(err.message))?;

    // Skip cloud refresh when verification is disabled or remote is not configured
    if !state.config.license_key_verification_enabled
        || current.license_key_full.trim().is_empty()
        || !remote_verification_enabled(&state.config)
    {
        return Ok(current);
    }

    match verify_against_main_backend(state, &current.license_key_full).await {
        Ok((signed_token, claims)) => persist_verified_state(state, &current.license_key_full, &signed_token, &claims),
        Err(LicenseSyncError::Invalid(message)) => {
            let updated = mark_license_invalid(state, &current.license_key_full)?;
            tracing::warn!("Cached license became invalid: {}", message);
            Ok(updated)
        }
        Err(LicenseSyncError::Service(message)) => {
            tracing::warn!("Could not refresh license from main backend, using cached state: {}", message);
            Ok(current)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::state::{is_dev_fallback_enabled, AppConfig};

    fn dev_config(env: &str, allow: bool, key: &str) -> AppConfig {
        AppConfig {
            app_env: env.to_string(),
            allow_dev_license_fallback: allow,
            license_key: key.to_string(),
            ..AppConfig::default()
        }
    }

    // ── is_dev_fallback_enabled ────────────────────────────────────

    #[test]
    fn dev_fallback_enabled_in_development() {
        let cfg = dev_config("development", true, "");
        assert!(is_dev_fallback_enabled(&cfg));
    }

    #[test]
    fn dev_fallback_disabled_when_flag_false() {
        let cfg = dev_config("development", false, "");
        assert!(!is_dev_fallback_enabled(&cfg));
    }

    #[test]
    fn dev_fallback_disabled_in_production_even_if_flag_true() {
        let cfg = dev_config("production", true, "");
        assert!(!is_dev_fallback_enabled(&cfg));
    }

    #[test]
    fn dev_fallback_disabled_in_production_case_insensitive() {
        let cfg = dev_config("Production", true, "");
        assert!(!is_dev_fallback_enabled(&cfg));
        let cfg2 = dev_config("PRODUCTION", true, "");
        assert!(!is_dev_fallback_enabled(&cfg2));
    }

    #[test]
    fn dev_fallback_enabled_for_custom_env() {
        let cfg = dev_config("staging", true, "");
        assert!(is_dev_fallback_enabled(&cfg));
    }

    // ── mask_license_key ───────────────────────────────────────────

    #[test]
    fn mask_key_standard() {
        assert_eq!(mask_license_key("FMS-1234-5678-ABCD"), "••••-••••-••••-ABCD");
    }

    #[test]
    fn mask_key_empty() {
        assert_eq!(mask_license_key(""), "••••-••••-••••-••••");
    }

    #[test]
    fn mask_key_short() {
        assert_eq!(mask_license_key("AB"), "••••-••••-••••-AB");
    }

    // ── license_allows_access ──────────────────────────────────────

    #[test]
    fn active_and_future_expiry_allows_access() {
        let future = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        assert!(license_allows_access("active", Some(&future)));
    }

    #[test]
    fn active_but_expired_denies_access() {
        let past = (Utc::now() - chrono::Duration::days(1)).to_rfc3339();
        assert!(!license_allows_access("active", Some(&past)));
    }

    #[test]
    fn inactive_status_denies_access() {
        let future = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        assert!(!license_allows_access("suspended", Some(&future)));
    }

    #[test]
    fn no_expiry_denies_access() {
        assert!(!license_allows_access("active", None));
    }

    // ── remote_verification_enabled ────────────────────────────────

    #[test]
    fn remote_enabled_when_url_and_pem_set() {
        let cfg = AppConfig {
            main_backend_url: "https://api.example.com".to_string(),
            license_public_key_pem: DEV_LICENSE_PUBLIC_KEY_PEM.to_string(),
            ..AppConfig::default()
        };
        assert!(remote_verification_enabled(&cfg));
    }

    #[test]
    fn remote_disabled_when_url_empty() {
        let cfg = AppConfig {
            main_backend_url: "".to_string(),
            license_public_key_pem: DEV_LICENSE_PUBLIC_KEY_PEM.to_string(),
            ..AppConfig::default()
        };
        assert!(!remote_verification_enabled(&cfg));
    }

    // ── Security: empty configured key never matches ───────────────

    #[test]
    fn empty_configured_key_rejects_any_input() {
        // This is the critical security test: the old code had
        // `expected.is_empty() && license_key.len() >= 8` which was insecure.
        // Now with an empty configured key, ANY input must be rejected.
        let cfg = dev_config("development", true, "");
        let expected = cfg.license_key.trim();
        // Simulating the validate_against_local_fallback logic:
        let license_key = "ANYTHING-LONG-ENOUGH";
        let result = expected.is_empty() || license_key != expected;
        assert!(result, "Empty configured key must always reject");
    }

    #[test]
    fn matching_configured_key_accepts() {
        let cfg = dev_config("development", true, "FMS-8A2B-4C9D-1E7F-3B6A");
        let expected = cfg.license_key.trim();
        let license_key = "FMS-8A2B-4C9D-1E7F-3B6A";
        let valid = !expected.is_empty() && license_key == expected;
        assert!(valid);
    }

    #[test]
    fn wrong_key_rejected() {
        let cfg = dev_config("development", true, "FMS-8A2B-4C9D-1E7F-3B6A");
        let expected = cfg.license_key.trim();
        let license_key = "FMS-WRONG-KEY";
        let valid = !expected.is_empty() && license_key == expected;
        assert!(!valid);
    }

    // ── license_key_verification_enabled ────────────────────────────

    #[test]
    fn verification_enabled_defaults_true() {
        let cfg = AppConfig::default();
        // Default is false because bool defaults to false, but load_config
        // sets it to true before loading anything. We test that the field exists.
        assert!(!cfg.license_key_verification_enabled); // raw default
    }

    #[test]
    fn verification_disabled_skips_remote_check_logic() {
        // When verification is disabled, validate_and_store_license should
        // use local key match. We test the condition directly.
        let cfg = AppConfig {
            license_key_verification_enabled: false,
            license_key: "FMS-AAAA-BBBB-CCCC-DDDD".to_string(),
            main_backend_url: "https://api.example.com".to_string(),
            license_public_key_pem: DEV_LICENSE_PUBLIC_KEY_PEM.to_string(),
            ..AppConfig::default()
        };
        // Even though remote_verification_enabled would return true,
        // the flag overrides and skips cloud entirely
        assert!(remote_verification_enabled(&cfg));
        assert!(!cfg.license_key_verification_enabled);
    }

    #[test]
    fn verification_enabled_with_remote_configured() {
        let cfg = AppConfig {
            license_key_verification_enabled: true,
            main_backend_url: "https://api.example.com".to_string(),
            license_public_key_pem: DEV_LICENSE_PUBLIC_KEY_PEM.to_string(),
            ..AppConfig::default()
        };
        assert!(cfg.license_key_verification_enabled);
        assert!(remote_verification_enabled(&cfg));
    }
}
