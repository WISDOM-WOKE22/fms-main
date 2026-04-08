//! Sync with cloud: push pending_sync queue, pull changes with LWW.
//! License key is the primary binding between desktop and organization; Basic auth is fallback.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::params;

use crate::api::license::raw_stored_state;
use crate::api::state::AppState;
use crate::db;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub pending_count: u32,
    pub last_sync_cursor: Option<String>,
    pub sync_enabled: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunResponse {
    pub pushed: u32,
    pub pulled: u32,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPendingItem {
    pub id: String,
    pub entity: String,
    pub entity_id: String,
    pub action: String,
    pub created_at: String,
    pub payload: serde_json::Value,
}

/// GET /api/v1/sync/status — pending count and last cursor.
/// Sync is enabled when cloud URL and license key are set (primary), or URL + Basic auth (fallback).
pub async fn sync_status(State(state): State<AppState>) -> Result<Json<SyncStatusResponse>, (StatusCode, Json<serde_json::Value>)> {
    let config = state.config.as_ref();
    let has_url = !config.main_backend_url.trim().is_empty();
    let has_license = !config.license_key.trim().is_empty()
        || raw_stored_state(&state).map(|s| !s.license_key_full.trim().is_empty()).unwrap_or(false);
    let has_basic = !config.email.is_empty() && !config.password.is_empty();
    let sync_enabled = has_url && (has_license || has_basic);

    let (pending_count, last_sync_cursor) = db::with_db(&state.db, |conn| {
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_sync WHERE sync_status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let cursor: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'sync_cursor'",
                [],
                |row| row.get(0),
            )
            .ok();
        (pending as u32, cursor)
    });

    Ok(Json(SyncStatusResponse {
        pending_count,
        last_sync_cursor,
        sync_enabled,
    }))
}

/// GET /api/v1/sync/pending — inspect pending sync queue payload.
pub async fn sync_pending(State(state): State<AppState>) -> Result<Json<Vec<SyncPendingItem>>, (StatusCode, Json<serde_json::Value>)> {
    let items = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, action, payload, created_at FROM pending_sync WHERE sync_status = 'pending' ORDER BY created_at ASC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |row| {
            let payload_raw: String = row.get(4)?;
            let payload = serde_json::from_str::<serde_json::Value>(&payload_raw)
                .unwrap_or_else(|_| serde_json::json!({ "raw": payload_raw }));
            Ok(SyncPendingItem {
                id: row.get(0)?,
                entity: row.get(1)?,
                entity_id: row.get(2)?,
                action: row.get(3)?,
                payload,
                created_at: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok::<Vec<SyncPendingItem>, rusqlite::Error>(out)
    })
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
    })?;
    Ok(Json(items))
}

/// POST /api/v1/sync/run — push pending changes then pull from cloud.
/// Uses license key (primary) or Basic auth to bind to the organization.
/// Ensures local DB migrations are applied before syncing.
pub async fn sync_run(State(state): State<AppState>) -> Result<Json<SyncRunResponse>, (StatusCode, Json<serde_json::Value>)> {
    if let Err(e) = db::ensure_migrations(&state.db) {
        return Ok(Json(SyncRunResponse {
            pushed: 0,
            pulled: 0,
            errors: vec![format!("Local DB migration failed: {}", e)],
        }));
    }
    let config = state.config.as_ref();
    let base = config.main_backend_url.trim().trim_end_matches('/');
    let license_key = raw_stored_state(&state)
        .ok()
        .and_then(|s| {
            let k = s.license_key_full.trim();
            if k.is_empty() { None } else { Some(k.to_string()) }
        })
        .or_else(|| {
            let k = config.license_key.trim();
            if k.is_empty() { None } else { Some(k.to_string()) }
        });
    let has_basic = !config.email.is_empty() && !config.password.is_empty();
    if base.is_empty() {
        return Ok(Json(SyncRunResponse {
            pushed: 0,
            pulled: 0,
            errors: vec!["Sync disabled: cloud URL not configured".into()],
        }));
    }
    if license_key.is_none() && !has_basic {
        return Ok(Json(SyncRunResponse {
            pushed: 0,
            pulled: 0,
            errors: vec!["Sync disabled: configure license key or cloud credentials".into()],
        }));
    }

    let auth_header = if has_basic {
        let auth = format!("{}:{}", config.email, config.password);
        format!("Basic {}", BASE64.encode(auth.as_bytes()))
    } else {
        String::new()
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })?;

    let mut errors = Vec::new();
    let pushed = push_pending(&state, base, &auth_header, license_key.as_deref(), &client, &mut errors).await;
    let pulled = pull_changes(&state, base, &auth_header, license_key.as_deref(), &client, &mut errors).await;

    Ok(Json(SyncRunResponse {
        pushed,
        pulled,
        errors,
    }))
}

async fn push_pending(
    state: &AppState,
    base: &str,
    auth_header: &str,
    license_key: Option<&str>,
    client: &reqwest::Client,
    errors: &mut Vec<String>,
) -> u32 {
    let pool = Arc::clone(&state.db);
    let base = base.to_string();
    let auth = auth_header.to_string();
    let license_key = license_key.map(String::from);

    #[derive(Clone)]
    struct PendingRow {
        pending_id: String,
        entity: String,
        entity_id: String,
        action: String,
        created_at: String,
        data: serde_json::Value,
    }

    #[derive(Clone)]
    struct ChangeItem {
        pending_id: Option<String>,
        entity: String,
        entity_id: String,
        action: String,
        updated_at: String,
        data: serde_json::Value,
    }

    fn entity_rank(entity: &str) -> i32 {
        match entity {
            "zones" => 0,
            "schedules" => 1,
            "person_types" => 2,
            "admins" => 3,
            "employees" => 4,           // people
            "employee_activities" => 5,  // person activities
            "access_logs" => 6,
            "audit_logs" => 7,
            "report_recipients" => 8,
            "app_settings" => 9,
            _ => 999,
        }
    }

    fn sort_changes(mut items: Vec<ChangeItem>) -> Vec<ChangeItem> {
        items.sort_by(|a, b| {
            let a_delete = a.action.to_lowercase() == "delete";
            let b_delete = b.action.to_lowercase() == "delete";
            let ra = entity_rank(a.entity.as_str());
            let rb = entity_rank(b.entity.as_str());
            match (a_delete, b_delete) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                (false, false) => ra.cmp(&rb),
                (true, true) => rb.cmp(&ra), // deletes in reverse dependency order
            }
        });
        items
    }

    fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
        v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
    }

    // Build batch from pending_sync, then expand dependencies for people rows.
    let (batch, pending_index): (Vec<serde_json::Value>, HashMap<(String, String), Vec<String>>) = db::with_db(&pool, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, entity_type, entity_id, action, payload, created_at FROM pending_sync WHERE sync_status = 'pending' ORDER BY created_at ASC LIMIT 100",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .ok()?;
        let mut pending_rows: Vec<PendingRow> = Vec::new();
        let mut pending_index: HashMap<(String, String), Vec<String>> = HashMap::new();
        for row in rows {
            let (pending_id, entity, entity_id, action, payload, created_at) = row.ok()?;
            let data: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::json!({}));
            pending_index
                .entry((entity.clone(), entity_id.clone()))
                .or_default()
                .push(pending_id.clone());
            pending_rows.push(PendingRow {
                pending_id,
                entity,
                entity_id,
                action,
                created_at,
                data,
            });
        }

        let mut changes: Vec<ChangeItem> = pending_rows
            .iter()
            .map(|r| {
                let updated_at = str_field(&r.data, "updatedAt").unwrap_or_else(|| r.created_at.clone());
                ChangeItem {
                    pending_id: Some(r.pending_id.clone()),
                    entity: r.entity.clone(),
                    entity_id: r.entity_id.clone(),
                    action: r.action.clone(),
                    updated_at,
                    data: r.data.clone(),
                }
            })
            .collect();

        // Expand dependencies for people rows (employees entity).
        // This fixes "Zone not found; sync zones first" when zones/schedules were created before sync was enabled
        // (so they are missing from pending_sync) but are referenced by people changes.
        let mut needed_zone_ids: HashSet<String> = HashSet::new();
        let mut needed_schedule_ids: HashSet<String> = HashSet::new();
        let mut needed_person_type_ids: HashSet<String> = HashSet::new();
        for c in &changes {
            if c.entity != "employees" {
                continue;
            }
            // zoneIds (preferred), fallback zoneId
            if let Some(arr) = c.data.get("zoneIds").and_then(|v| v.as_array()) {
                for z in arr.iter().filter_map(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    needed_zone_ids.insert(z.to_string());
                }
            } else if let Some(z) = c.data.get("zoneId").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                needed_zone_ids.insert(z.to_string());
            }
            if let Some(s) = c.data.get("scheduleId").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                needed_schedule_ids.insert(s.to_string());
            } else if let Some(s) = c.data.get("shiftId").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                needed_schedule_ids.insert(s.to_string());
            }
            if let Some(pt) = c.data.get("personTypeId").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                needed_person_type_ids.insert(pt.to_string());
            }
        }

        // Helper: do we already have a change for (entity,id)?
        let mut has_change: HashSet<(String, String)> = changes
            .iter()
            .map(|c| (c.entity.clone(), c.entity_id.clone()))
            .collect();

        // Load and add zones
        for zid in needed_zone_ids {
            if has_change.contains(&(String::from("zones"), zid.clone())) {
                continue;
            }
            let row: Result<(String, String, String, String, String, Option<String>), rusqlite::Error> = conn.query_row(
                "SELECT id, name, status, createdBy, dateCreated, cameraIds FROM zones WHERE id = ?1",
                params![&zid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            );
            if let Ok((id, name, status, created_by, date_created, camera_ids)) = row {
                let updated_at: Option<String> = conn.query_row("SELECT updatedAt FROM zones WHERE id = ?1", params![&id], |r| r.get(0)).ok();
                let updated_at = updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                let zones_val: serde_json::Value = camera_ids
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .unwrap_or(serde_json::json!([]));
                changes.push(ChangeItem {
                    pending_id: None,
                    entity: "zones".to_string(),
                    entity_id: id.clone(),
                    action: "update".to_string(),
                    updated_at: updated_at.clone(),
                    data: serde_json::json!({
                        "id": id,
                        "name": name,
                        "status": status,
                        "createdBy": created_by,
                        "dateCreated": date_created,
                        "zones": zones_val,
                        "updatedAt": updated_at,
                    }),
                });
                has_change.insert((String::from("zones"), zid.clone()));
            }
        }

        // Load and add schedules
        for sid in needed_schedule_ids {
            if has_change.contains(&(String::from("schedules"), sid.clone())) {
                continue;
            }
            let row: Result<(String, String, Option<String>, String, String, String, Option<String>, Option<String>), rusqlite::Error> = conn.query_row(
                "SELECT id, name, description, breakTime, status, createdBy, personTypeId, workingDays FROM schedules WHERE id = ?1",
                params![&sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            );
            if let Ok((id, name, description, break_time, status, created_by, person_type_id, working_days_raw)) = row {
                let updated_at: Option<String> = conn.query_row("SELECT updatedAt FROM schedules WHERE id = ?1", params![&id], |r| r.get(0)).ok();
                let updated_at = updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                let working_days: serde_json::Value = working_days_raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(serde_json::Value::Null);
                changes.push(ChangeItem {
                    pending_id: None,
                    entity: "schedules".to_string(),
                    entity_id: id.clone(),
                    action: "update".to_string(),
                    updated_at: updated_at.clone(),
                    data: serde_json::json!({
                        "id": id,
                        "name": name,
                        "description": description,
                        "breakTime": break_time,
                        "status": status,
                        "createdBy": created_by,
                        "personTypeId": person_type_id,
                        "workingDays": working_days,
                        "updatedAt": updated_at,
                    }),
                });
                if let Some(ptid) = person_type_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    needed_person_type_ids.insert(ptid.to_string());
                }
                has_change.insert((String::from("schedules"), sid.clone()));
            }
        }

        // Load and add person types (if referenced)
        for ptid in needed_person_type_ids {
            if has_change.contains(&(String::from("person_types"), ptid.clone())) {
                continue;
            }
            let row: Result<(String, String, Option<String>, String), rusqlite::Error> = conn.query_row(
                "SELECT id, name, description, status FROM person_types WHERE id = ?1",
                params![&ptid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            );
            if let Ok((id, name, description, status)) = row {
                let updated_at: Option<String> = conn.query_row("SELECT updated_at FROM person_types WHERE id = ?1", params![&id], |r| r.get(0)).ok();
                let updated_at = updated_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                changes.push(ChangeItem {
                    pending_id: None,
                    entity: "person_types".to_string(),
                    entity_id: id.clone(),
                    action: "update".to_string(),
                    updated_at: updated_at.clone(),
                    data: serde_json::json!({
                        "id": id,
                        "name": name,
                        "description": description,
                        "status": status,
                        "updatedAt": updated_at,
                    }),
                });
                has_change.insert((String::from("person_types"), ptid.clone()));
            }
        }

        let changes = sort_changes(changes);
        let batch: Vec<serde_json::Value> = changes
            .into_iter()
            .map(|c| {
                serde_json::json!({
                    "entity": c.entity,
                    "id": c.entity_id,
                    "action": c.action,
                    "updatedAt": c.updated_at,
                    "data": c.data,
                })
            })
            .collect();

        Some((batch, pending_index))
    })
    .unwrap_or_default();

    if batch.is_empty() {
        return 0;
    }

    let url = format!("{}/api/v1/sync/push", base);
    let body = serde_json::json!({ "changes": batch });
    let mut req = client.post(&url).header("Content-Type", "application/json").json(&body);
    if !auth.is_empty() {
        req = req.header("Authorization", &auth);
    }
    if let Some(ref key) = license_key {
        if !key.is_empty() {
            req = req.header("x-license-key", key.as_str());
        }
    }
    let res = req.send().await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            let body_val: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
            let results: Vec<serde_json::Value> = body_val
                .get("results")
                .and_then(|r: &serde_json::Value| r.as_array())
                .cloned()
                .unwrap_or_default();
            db::with_db(&pool, |conn| {
                for result in results.iter() {
                    let entity = result.get("entity").and_then(|v| v.as_str()).unwrap_or("");
                    let id = result.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let status_str = result.get("status").and_then(|s: &serde_json::Value| s.as_str()).unwrap_or("");
                    let status = if status_str == "applied" { "synced" } else { "pending" };
                    if let Some(pending_ids) = pending_index.get(&(entity.to_string(), id.to_string())) {
                        for pid in pending_ids {
                            let _ = conn.execute(
                                "UPDATE pending_sync SET sync_status = ?1 WHERE id = ?2",
                                params![status, pid],
                            );
                        }
                    }
                }
                Ok::<(), rusqlite::Error>(())
            });
            results
                .iter()
                .filter(|r: &&serde_json::Value| r.get("status").and_then(|s: &serde_json::Value| s.as_str()) == Some("applied"))
                .count() as u32
        }
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            errors.push(format!("Push failed: {} {}", status, text));
            0
        }
        Err(e) => {
            errors.push(format!("Push request failed: {}", e));
            0
        }
    }
}

/// Max pull rounds per sync run to avoid runaway loops when backend keeps returning full pages.
const PULL_MAX_ROUNDS: u32 = 50;

async fn pull_changes(
    state: &AppState,
    base: &str,
    auth_header: &str,
    license_key: Option<&str>,
    client: &reqwest::Client,
    errors: &mut Vec<String>,
) -> u32 {
    let pool = Arc::clone(&state.db);
    let mut since: String = db::with_db(&pool, |conn| {
        conn.query_row("SELECT value FROM app_settings WHERE key = 'sync_cursor'", [], |row| row.get::<_, String>(0))
            .unwrap_or_default()
    });

    let mut total_applied = 0u32;
    for _ in 0..PULL_MAX_ROUNDS {
        let url = format!("{}/api/v1/sync/changes?since={}&limit=500", base, urlencoding::encode(&since));

        let mut req = client.get(&url);
        if !auth_header.is_empty() {
            req = req.header("Authorization", auth_header);
        }
        if let Some(key) = license_key {
            if !key.is_empty() {
                req = req.header("x-license-key", key);
            }
        }
        let resp = req.send().await;

        let (changes, has_more): (Vec<serde_json::Value>, bool) = match resp {
            Ok(r) if r.status().is_success() => {
                let body: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                let changes: Vec<serde_json::Value> = body
                    .get("changes")
                    .and_then(|c: &serde_json::Value| c.as_array())
                    .cloned()
                    .unwrap_or_default();
                let has_more = body.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false);
                (changes, has_more)
            }
            Ok(r) => {
                errors.push(format!("Pull failed: {} {}", r.status(), r.text().await.unwrap_or_default()));
                return total_applied;
            }
            Err(e) => {
                errors.push(format!("Pull request failed: {}", e));
                return total_applied;
            }
        };

        let mut new_cursor: Option<String> = None;
        for change in &changes {
            let entity = change.get("entity").and_then(|e: &serde_json::Value| e.as_str()).unwrap_or("");
            let id = change.get("id").and_then(|i: &serde_json::Value| i.as_str()).unwrap_or("");
            let updated_at = change.get("updatedAt").and_then(|u: &serde_json::Value| u.as_str()).unwrap_or("");
            let data = change.get("data").cloned().unwrap_or(serde_json::json!({}));

            let ok = db::with_db(&pool, |conn| apply_change(conn, entity, id, updated_at, &data));
            if ok {
                total_applied += 1;
            }
            let cur_ref: &str = new_cursor.as_deref().unwrap_or("");
            if !updated_at.is_empty() && updated_at > cur_ref {
                new_cursor = Some(updated_at.to_string());
            }
        }

        if let Some(c) = new_cursor.clone() {
            since = c.clone();
            db::with_db(&pool, |conn| {
                let exists: bool = conn
                    .query_row("SELECT 1 FROM app_settings WHERE key = 'sync_cursor'", [], |_| Ok(true))
                    .unwrap_or(false);
                if exists {
                    conn.execute("UPDATE app_settings SET value = ?1, updatedAt = ?2 WHERE key = 'sync_cursor'", params![c, chrono::Utc::now().to_rfc3339()])?;
                } else {
                    conn.execute(
                        "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, 'sync_cursor', ?2, ?3)",
                        params![db::gen_id(), c, chrono::Utc::now().to_rfc3339()],
                    )?;
                }
                Ok::<(), rusqlite::Error>(())
            });
        }

        if !has_more {
            break;
        }
    }

    total_applied
}

fn apply_change(
    conn: &rusqlite::Connection,
    entity: &str,
    id: &str,
    updated_at: &str,
    data: &serde_json::Value,
) -> bool {
    let get_str = |key: &str| -> String {
        data.get(key)
            .or_else(|| data.get(&key.replace('_', "")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    match entity {
        "zones" => {
            let name = get_str("name");
            if name.is_empty() {
                return false;
            }
            let status = get_str("status");
            let status = if status.is_empty() { "active" } else { status.as_str() };
            let sub_zones = data.get("zones").or_else(|| data.get("subZones")).cloned().unwrap_or(serde_json::json!([]));
            let sub_zones_str = sub_zones.to_string();
            let created_by = get_str("createdBy");
            let created_by = if created_by.is_empty() { "System" } else { created_by.as_str() };
            let exists: bool = conn
                .query_row("SELECT 1 FROM zones WHERE id = ?1", params![id], |_| Ok(true))
                .unwrap_or(false);
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM zones WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE zones SET name = ?1, status = ?2, cameraIds = ?3, createdBy = ?4, dateCreated = COALESCE(dateCreated, ?5), updatedAt = ?6 WHERE id = ?7",
                    params![name, status, sub_zones_str, created_by, chrono::Utc::now().to_rfc3339(), updated_at, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO zones (id, name, status, cameraIds, createdBy, dateCreated, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, name, status, sub_zones_str, created_by, chrono::Utc::now().to_rfc3339(), updated_at],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "schedules" => {
            let name = get_str("name");
            if name.is_empty() {
                return false;
            }
            let description = get_str("description");
            let break_time = get_str("breakTime");
            let break_time = if break_time.is_empty() { "0" } else { break_time.as_str() };
            let status = get_str("status");
            let status = if status.is_empty() { "active" } else { status.as_str() };
            let created_by = get_str("createdBy");
            let created_by = if created_by.is_empty() { "System" } else { created_by.as_str() };
            let person_type_id = get_str("personTypeId");
            let person_type_id = if person_type_id.is_empty() {
                None as Option<&str>
            } else {
                Some(person_type_id.as_str())
            };
            let working_days: Option<String> = data.get("workingDays").and_then(|v| {
                if v.is_null() { None } else { Some(v.to_string()) }
            });
            let exists: bool = conn.query_row("SELECT 1 FROM schedules WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM schedules WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE schedules SET name = ?1, description = ?2, breakTime = ?3, status = ?4, createdBy = ?5, createdAt = COALESCE(createdAt, ?6), updatedAt = ?7, personTypeId = ?8, workingDays = ?9 WHERE id = ?10",
                    params![name, description, break_time, status, created_by, chrono::Utc::now().to_rfc3339(), updated_at, person_type_id, working_days, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO schedules (id, name, description, breakTime, status, createdBy, createdAt, updatedAt, personTypeId, workingDays) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![id, name, description, break_time, status, created_by, chrono::Utc::now().to_rfc3339(), updated_at, person_type_id, working_days],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "person_types" => {
            let name = get_str("name");
            if name.is_empty() {
                return false;
            }
            let description = get_str("description");
            let status = get_str("status");
            let status = if status.is_empty() { "active" } else { status.as_str() };
            let exists: bool = conn
                .query_row("SELECT 1 FROM person_types WHERE id = ?1", params![id], |_| Ok(true))
                .unwrap_or(false);
            if exists {
                let local: Option<String> = conn
                    .query_row("SELECT updated_at FROM person_types WHERE id = ?1", params![id], |r| r.get(0))
                    .ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE person_types SET name = ?1, description = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
                    params![name, description, status, updated_at, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO person_types (id, name, description, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, name, description, status, updated_at, updated_at],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "employees" => {
            let name = get_str("name");
            if name.is_empty() {
                return false;
            }
            let zone_id = get_str("zoneId");
            let zone_ids = data.get("zoneIds").and_then(|z| z.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
            let zone_ids_str = if zone_ids.is_empty() {
                if zone_id.is_empty() {
                    return false;
                }
                serde_json::to_string(&vec![zone_id.clone()]).unwrap_or_else(|_| "[]".to_string())
            } else {
                serde_json::to_string(&zone_ids).unwrap_or_else(|_| "[]".to_string())
            };
            let zone_id = zone_ids.first().cloned().unwrap_or(zone_id);
            let schedule_id = {
                let s = get_str("scheduleId");
                if s.is_empty() {
                    get_str("shiftId")
                } else {
                    s
                }
            };
            if schedule_id.is_empty() {
                return false;
            }
            let sub_zones = data.get("zones").or_else(|| data.get("subZones")).cloned().unwrap_or(serde_json::json!([]));
            let sub_zones_str = sub_zones.to_string();
            let email = get_str("email");
            let phone = get_str("phone");
            let department = get_str("department");
            let person_type_id = get_str("personTypeId");
            let person_type_id = if person_type_id.is_empty() { None as Option<&str> } else { Some(person_type_id.as_str()) };
            let status = get_str("status");
            let status = if status.is_empty() { "-" } else { status.as_str() };
            let is_active = data.get("isActive").or(data.get("is_active")).and_then(|v| v.as_bool()).unwrap_or(true);
            let joined_date = get_str("joinedDate");
            if joined_date.is_empty() {
                return false;
            }
            let exists: bool = conn.query_row("SELECT 1 FROM employees WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            let profile_from_payload = data.get("profilePhotoData").and_then(|v| v.as_str()).map(|s| s.to_string());
            let fe_from_payload = data.get("faceEnrollmentStatus").and_then(|v| v.as_str()).map(|s| s.to_string());
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM employees WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                let profile_photo = match profile_from_payload {
                    Some(p) => p,
                    None => conn
                        .query_row(
                            "SELECT COALESCE(profilePhotoData, '') FROM employees WHERE id = ?1",
                            params![id],
                            |r| r.get(0),
                        )
                        .unwrap_or_default(),
                };
                let face_enrollment_status = match fe_from_payload {
                    Some(s) if !s.is_empty() => s,
                    _ => conn
                        .query_row(
                            "SELECT COALESCE(faceEnrollmentStatus, 'not_enrolled') FROM employees WHERE id = ?1",
                            params![id],
                            |r| r.get(0),
                        )
                        .unwrap_or_else(|_| "not_enrolled".to_string()),
                };
                conn.execute(
                    "UPDATE employees SET name = ?1, email = ?2, phone = ?3, department = ?4, personTypeId = ?5, status = ?6, isActive = ?7, joinedDate = ?8, zoneId = ?9, scheduleId = ?10, zoneIds = ?11, subZones = ?12, updatedAt = ?13, profilePhotoData = ?14, faceEnrollmentStatus = ?15 WHERE id = ?16",
                    params![name, email, phone, department, person_type_id, status, is_active as i32, joined_date, zone_id, schedule_id, zone_ids_str, sub_zones_str, updated_at, profile_photo, face_enrollment_status, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                let profile_photo = profile_from_payload.unwrap_or_default();
                let face_enrollment_status = fe_from_payload
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "not_enrolled".to_string());
                conn.execute(
                    "INSERT OR REPLACE INTO employees (id, name, email, phone, department, personTypeId, status, isActive, joinedDate, zoneId, scheduleId, zoneIds, subZones, updatedAt, profilePhotoData, faceEnrollmentStatus) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![id, name, email, phone, department, person_type_id, status, is_active as i32, joined_date, zone_id, schedule_id, zone_ids_str, sub_zones_str, updated_at, profile_photo, face_enrollment_status],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "employee_activities" => {
            let employee_id = get_str("employeeId");
            if employee_id.is_empty() {
                return false;
            }
            let type_ = get_str("type");
            let date = get_str("date");
            let time = get_str("time");
            let zone_id = get_str("zoneId");
            let exists: bool = conn.query_row("SELECT 1 FROM employee_activities WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM employee_activities WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE employee_activities SET type = ?1, date = ?2, time = ?3, zoneId = ?4, employeeId = ?5, updatedAt = ?6 WHERE id = ?7",
                    params![type_, date, time, zone_id, employee_id, updated_at, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO employee_activities (id, type, date, time, zoneId, employeeId, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, type_, date, time, zone_id, employee_id, updated_at],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "report_recipients" => {
            let name = get_str("name");
            let email = get_str("email");
            if name.is_empty() || email.is_empty() {
                return false;
            }
            let status = get_str("status");
            let status = if status.is_empty() { "active" } else { status.as_str() };
            let added_by_id = get_str("addedById");
            let added_by_name = get_str("addedByName");
            let created_at = get_str("createdAt");
            let created_at = if created_at.is_empty() { chrono::Utc::now().to_rfc3339() } else { created_at };
            let exists: bool = conn.query_row("SELECT 1 FROM report_recipients WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM report_recipients WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE report_recipients SET name = ?1, email = ?2, status = ?3, addedById = ?4, addedByName = ?5, createdAt = COALESCE(createdAt, ?6), updatedAt = ?7 WHERE id = ?8",
                    params![name, email, status, added_by_id, added_by_name, created_at, updated_at, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO report_recipients (id, name, email, status, addedById, addedByName, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![id, name, email, status, added_by_id, added_by_name, created_at, updated_at],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        "app_settings" => {
            let key = get_str("key");
            if key.is_empty() {
                return false;
            }
            let value = data.get("value").map(|v| v.to_string()).unwrap_or_else(|| "null".to_string());
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (id, key, value, updatedAt) VALUES (?1, ?2, ?3, ?4)",
                params![id, key, value, updated_at],
            )
            .ok()
            .map(|_| true)
            .unwrap_or(false)
        }
        "audit_logs" => {
            let actor_id = get_str("actorId");
            let actor_type = get_str("actorType");
            let actor_name = get_str("actorName");
            let action = get_str("action");
            let resource = get_str("resource");
            let resource_id = get_str("resourceId");
            let description = get_str("description");
            let changes = data.get("changes").map(|c| c.to_string()).unwrap_or_else(|| "null".to_string());
            let timestamp = get_str("timestamp");
            let timestamp = if timestamp.is_empty() { updated_at } else { timestamp.as_str() };
            let exists: bool = conn.query_row("SELECT 1 FROM audit_logs WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            if exists {
                return false;
            }
            conn.execute(
                "INSERT OR IGNORE INTO audit_logs (id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![id, actor_id, actor_type, actor_name, action, resource, resource_id, description, changes, timestamp],
            )
            .ok()
            .map(|c| c > 0)
            .unwrap_or(false)
        }
        "access_logs" => {
            let employee_id = get_str("employeeId");
            let zone_id = get_str("zoneId");
            let action_val = get_str("action");
            let timestamp = get_str("timestamp");
            let timestamp = if timestamp.is_empty() { updated_at } else { timestamp.as_str() };
            let metadata = data.get("metadata").map(|m| m.to_string()).unwrap_or_else(|| "null".to_string());
            conn.execute(
                "INSERT OR REPLACE INTO access_logs (id, employeeId, zoneId, action, timestamp, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, employee_id, zone_id, action_val, timestamp, metadata],
            )
            .ok()
            .map(|_| true)
            .unwrap_or(false)
        }
        "admins" => {
            let name = get_str("name");
            let email = get_str("email");
            if email.is_empty() {
                return false;
            }
            let role = get_str("role");
            let role = if role.is_empty() { "sub_admin" } else { role.as_str() };
            let status = get_str("status");
            let status = if status.is_empty() { "active" } else { status.as_str() };
            let permissions = data
                .get("permissions")
                .and_then(|p: &serde_json::Value| p.as_array())
                .map(|a: &Vec<serde_json::Value>| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()))
                .unwrap_or_else(|| "[]".to_string());
            let exists: bool = conn.query_row("SELECT 1 FROM admins WHERE id = ?1", params![id], |_| Ok(true)).unwrap_or(false);
            if exists {
                let local: Option<String> = conn.query_row("SELECT updatedAt FROM admins WHERE id = ?1", params![id], |r| r.get(0)).ok();
                if let Some(l) = local {
                    if !l.is_empty() && updated_at < l.as_str() {
                        return false;
                    }
                }
                conn.execute(
                    "UPDATE admins SET name = ?1, email = ?2, role = ?3, status = ?4, permissions = ?5, updatedAt = ?6 WHERE id = ?7",
                    params![name, email, role, status, permissions, updated_at, id],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO admins (id, name, email, role, status, permissions, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, name, email, role, status, permissions, updated_at],
                )
                .ok()
                .map(|_| true)
                .unwrap_or(false)
            }
        }
        _ => false,
    }
}
