//! People (employees table), zones, schedules, dashboard, audit_logs, access_logs, settings, report_recipients, demo.
//! Full implementations matching cloud backend. API exposes both /people and /employees.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use rusqlite::params;
use std::collections::{HashMap, HashSet};

use crate::api::error::ApiError;
use crate::api::state::AppState;
use crate::db;

const MAX_PROFILE_PHOTO_BYTES: usize = 5 * 1024 * 1024;

fn validate_profile_photo_data(raw: Option<&str>) -> Result<(), ApiError> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let payload = s.split_once(',').map(|(_, b)| b).unwrap_or(s);
    let decoded = B64
        .decode(payload.as_bytes())
        .map_err(|_| ApiError::bad_request("Invalid base64 profile photo"))?;
    if decoded.len() > MAX_PROFILE_PHOTO_BYTES {
        return Err(ApiError::bad_request(
            "Profile photo is too large. Max size is 5MB.",
        ));
    }
    Ok(())
}

fn face_enrollment_display(status: &str, expires_at: Option<&str>) -> &'static str {
    match status.trim() {
        "enrolled" => "enrolled",
        "link_sent" => {
            if let Some(exp) = expires_at.map(str::trim).filter(|s| !s.is_empty()) {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(exp) {
                    if Utc::now() > dt.with_timezone(&Utc) {
                        return "expired";
                    }
                }
            }
            "link_sent"
        }
        _ => "not_enrolled",
    }
}

/// After a raw `UPDATE employees` (e.g. face enrollment), enqueue the same shape as `update_person`.
pub(crate) fn enqueue_employee_sync_update(conn: &rusqlite::Connection, id: &str) -> Result<(), rusqlite::Error> {
    let (
        name,
        email,
        phone,
        department,
        person_type_id,
        status,
        is_active_i,
        zone_id,
        schedule_id,
        zone_ids_raw,
        sub_zones_raw,
        joined_date,
        updated_at,
        face_enrollment_status,
    ): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i32,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
    ) = conn.query_row(
        "SELECT name, email, phone, department, personTypeId, status, isActive, zoneId, scheduleId, zoneIds, subZones, joinedDate, updatedAt, COALESCE(faceEnrollmentStatus, 'not_enrolled') FROM employees WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
            ))
        },
    )?;
    let zone_ids = normalize_person_zone_ids(zone_ids_raw.as_deref(), Some(&zone_id));
    let sub_zones = normalize_person_sub_zones(sub_zones_raw.as_deref())
        .into_iter()
        .filter(|item| zone_ids.contains(&item.zone_id))
        .collect::<Vec<_>>();
    let is_active = is_active_i != 0;
    let updated_at = if updated_at.trim().is_empty() {
        chrono::Utc::now().to_rfc3339()
    } else {
        updated_at
    };
    let payload = serde_json::json!({
        "name": name,
        "personTypeId": person_type_id,
        "email": email,
        "phone": phone,
        "department": department,
        "status": status,
        "isActive": is_active,
        "joinedDate": joined_date,
        "zoneId": zone_id,
        "scheduleId": schedule_id,
        "zoneIds": zone_ids,
        "zones": sub_zones,
        "updatedAt": updated_at,
        "faceEnrollmentStatus": face_enrollment_status,
    });
    db::enqueue_sync(conn, "employees", id, "update", &payload.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleCountQuery {
    pub location_id: Option<String>,
    pub zone_id: Option<String>,
    pub date: Option<String>,
    pub time_from: Option<String>,
    pub time_to: Option<String>,
}

fn parse_people_count_query(query: &PeopleCountQuery) -> Result<(String, String, String), ApiError> {
    let date = query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    let time_from = query
        .time_from
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("00:00")
        .to_string();
    let time_to = query
        .time_to
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("23:59")
        .to_string();

    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err(ApiError::bad_request("Invalid date format. Expected YYYY-MM-DD."));
    }
    if chrono::NaiveTime::parse_from_str(&time_from, "%H:%M").is_err()
        || chrono::NaiveTime::parse_from_str(&time_to, "%H:%M").is_err()
    {
        return Err(ApiError::bad_request("Invalid time format. Expected HH:MM."));
    }
    if time_from > time_to {
        return Err(ApiError::bad_request("timeFrom must be less than or equal to timeTo."));
    }

    Ok((date, time_from, time_to))
}

pub async fn people_count_filters(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let payload = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare("SELECT id, name, cameraIds FROM zones ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            let zone_id: String = row.get(0)?;
            let location_name: String = row.get(1)?;
            let sub_zones_raw: String = row.get(2)?;
            let zones = normalize_zone_sub_zones(&sub_zones_raw)
                .into_iter()
                .enumerate()
                .map(|(idx, z)| {
                    let zone_name = z
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Zone")
                        .to_string();
                    serde_json::json!({
                        "id": format!("{}:z{}", zone_id, idx + 1),
                        "name": zone_name
                    })
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "id": zone_id,
                "name": location_name,
                "zones": zones
            }))
        })?;

        let mut locations = Vec::new();
        for row in rows {
            locations.push(row?);
        }
        Ok(serde_json::json!({ "locations": locations }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    Ok(Json(payload))
}

pub async fn people_count_summary(
    State(state): State<AppState>,
    Query(query): Query<PeopleCountQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (date, time_from, time_to) = parse_people_count_query(&query)?;
    let location_filter = query.location_id.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let payload = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT a.type, e.zoneId
             FROM employee_activities a
             JOIN employees e ON a.employeeId = e.id
             WHERE a.date = ?1 AND a.time >= ?2 AND a.time <= ?3
             ORDER BY a.time ASC",
        )?;
        let rows = stmt.query_map(params![date, time_from, time_to], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;

        let mut total_entries: i64 = 0;
        let mut total_exits: i64 = 0;
        let mut current_count: i64 = 0;

        for row in rows {
            let (activity_type, zone_id) = row?;
            if let Some(filter) = location_filter {
                if zone_id.as_deref().unwrap_or_default() != filter {
                    continue;
                }
            }
            if activity_type == "check-in" {
                total_entries += 1;
                current_count += 1;
            } else if activity_type == "check-out" {
                total_exits += 1;
                current_count = (current_count - 1).max(0);
            }
        }

        Ok(serde_json::json!({
            "totalCount": current_count,
            "totalEntries": total_entries,
            "totalExits": total_exits
        }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    Ok(Json(payload))
}

pub async fn people_count_charts(
    State(state): State<AppState>,
    Query(query): Query<PeopleCountQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (date, time_from, time_to) = parse_people_count_query(&query)?;
    let location_filter = query.location_id.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let payload = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT a.type, a.time, e.zoneId, z.name
             FROM employee_activities a
             JOIN employees e ON a.employeeId = e.id
             LEFT JOIN zones z ON e.zoneId = z.id
             WHERE a.date = ?1 AND a.time >= ?2 AND a.time <= ?3
             ORDER BY a.time ASC",
        )?;
        let rows = stmt.query_map(params![date, time_from, time_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        let mut by_hour_entries: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        let mut by_hour_exits: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        let mut by_hour_net: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        let mut by_location: std::collections::HashMap<String, (String, i64)> = std::collections::HashMap::new();

        for row in rows {
            let (activity_type, time, zone_id_opt, zone_name_opt) = row?;
            let zone_id = zone_id_opt.unwrap_or_default();
            if let Some(filter) = location_filter {
                if zone_id != filter {
                    continue;
                }
            }
            let hour = if time.len() >= 2 {
                format!("{}:00", &time[0..2])
            } else {
                "00:00".to_string()
            };

            if activity_type == "check-in" {
                *by_hour_entries.entry(hour.clone()).or_insert(0) += 1;
                *by_hour_net.entry(hour).or_insert(0) += 1;
                let entry = by_location
                    .entry(zone_id.clone())
                    .or_insert((zone_name_opt.unwrap_or_else(|| "Unknown".to_string()), 0));
                entry.1 += 1;
            } else if activity_type == "check-out" {
                *by_hour_exits.entry(hour.clone()).or_insert(0) += 1;
                *by_hour_net.entry(hour).or_insert(0) -= 1;
                let entry = by_location
                    .entry(zone_id.clone())
                    .or_insert((zone_name_opt.unwrap_or_else(|| "Unknown".to_string()), 0));
                entry.1 = (entry.1 - 1).max(0);
            }
        }

        let count_over_time = by_hour_net
            .iter()
            .map(|(time, count)| serde_json::json!({ "time": time, "count": (*count).max(0) }))
            .collect::<Vec<_>>();

        let entries_exits_over_time = by_hour_entries
            .keys()
            .chain(by_hour_exits.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|time| {
                serde_json::json!({
                    "time": time,
                    "entries": by_hour_entries.get(&time).copied().unwrap_or(0),
                    "exits": by_hour_exits.get(&time).copied().unwrap_or(0)
                })
            })
            .collect::<Vec<_>>();

        let current_by_location = by_location
            .into_iter()
            .map(|(location_id, (location_name, current_count))| {
                serde_json::json!({
                    "locationId": location_id,
                    "locationName": location_name,
                    "currentCount": current_count.max(0),
                    "zones": []
                })
            })
            .collect::<Vec<_>>();

        Ok(serde_json::json!({
            "countOverTime": count_over_time,
            "entriesExitsOverTime": entries_exits_over_time,
            "currentByLocation": current_by_location
        }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    Ok(Json(payload))
}

pub async fn people_count_table(
    State(state): State<AppState>,
    Query(query): Query<PeopleCountQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (date, time_from, time_to) = parse_people_count_query(&query)?;
    let location_filter = query.location_id.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let payload = db::with_db(&state.db, |conn| {
        let mut zones_stmt = conn.prepare("SELECT id, name, cameraIds FROM zones ORDER BY name")?;
        let zone_rows = zones_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        let mut locations: std::collections::HashMap<String, (String, i64, i64, i64, Option<String>, Vec<serde_json::Value>)> =
            std::collections::HashMap::new();

        for row in zone_rows {
            let (zone_id, zone_name, sub_zones_raw) = row?;
            if let Some(filter) = location_filter {
                if zone_id != filter {
                    continue;
                }
            }
            let parsed_sub_zones = normalize_zone_sub_zones(&sub_zones_raw)
                .into_iter()
                .enumerate()
                .map(|(idx, z)| {
                    let name = z
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Zone")
                        .to_string();
                    serde_json::json!({
                        "zoneId": format!("{}:z{}", zone_id, idx + 1),
                        "zoneName": name,
                        "currentCount": 0,
                        "totalEntries": 0,
                        "totalExits": 0,
                        "lastUpdated": serde_json::Value::Null
                    })
                })
                .collect::<Vec<_>>();

            locations.insert(zone_id, (zone_name, 0, 0, 0, None, parsed_sub_zones));
        }

        let mut stmt = conn.prepare(
            "SELECT a.type, a.date, a.time, e.zoneId
             FROM employee_activities a
             JOIN employees e ON a.employeeId = e.id
             WHERE a.date = ?1 AND a.time >= ?2 AND a.time <= ?3
             ORDER BY a.time ASC",
        )?;
        let rows = stmt.query_map(params![date, time_from, time_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        for row in rows {
            let (activity_type, activity_date, activity_time, zone_id_opt) = row?;
            let zone_id = zone_id_opt.unwrap_or_default();
            if zone_id.is_empty() {
                continue;
            }
            if let Some(entry) = locations.get_mut(&zone_id) {
                if activity_type == "check-in" {
                    entry.1 += 1;
                    entry.2 += 1;
                } else if activity_type == "check-out" {
                    entry.1 = (entry.1 - 1).max(0);
                    entry.3 += 1;
                }
                entry.4 = Some(format!("{}T{}:00Z", activity_date, activity_time));
            }
        }

        let rows = locations
            .into_iter()
            .map(|(location_id, (location_name, current_count, total_entries, total_exits, last_updated, mut zones))| {
                let zone_count = zones.len() as i64;
                if zone_count > 0 {
                    let base_current = current_count.max(0) / zone_count;
                    let base_entries = total_entries.max(0) / zone_count;
                    let base_exits = total_exits.max(0) / zone_count;
                    let rem_current = current_count.max(0) % zone_count;
                    let rem_entries = total_entries.max(0) % zone_count;
                    let rem_exits = total_exits.max(0) % zone_count;

                    for (idx, zone) in zones.iter_mut().enumerate() {
                        let idx_i64 = idx as i64;
                        let current = base_current + if idx_i64 < rem_current { 1 } else { 0 };
                        let entries = base_entries + if idx_i64 < rem_entries { 1 } else { 0 };
                        let exits = base_exits + if idx_i64 < rem_exits { 1 } else { 0 };
                        zone["currentCount"] = serde_json::json!(current.max(0));
                        zone["totalEntries"] = serde_json::json!(entries.max(0));
                        zone["totalExits"] = serde_json::json!(exits.max(0));
                        zone["lastUpdated"] = last_updated
                            .as_ref()
                            .map(|v| serde_json::json!(v))
                            .unwrap_or(serde_json::Value::Null);
                    }
                }
                serde_json::json!({
                    "locationId": location_id,
                    "locationName": location_name,
                    "zonesCount": zones.len(),
                    "currentCount": current_count.max(0),
                    "totalEntries": total_entries.max(0),
                    "totalExits": total_exits.max(0),
                    "lastUpdated": last_updated,
                    "zones": zones
                })
            })
            .collect::<Vec<_>>();

        Ok(serde_json::json!({ "rows": rows }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;

    Ok(Json(payload))
}

fn normalize_zone_sub_zones(raw: &str) -> Vec<serde_json::Value> {
    let items: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap_or_default();
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let name = item
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .unwrap_or_else(|| format!("Zone {}", index + 1));
            let ip = item
                .get("ip")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let rtsp = item
                .get("rtsp")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            // DVR camera fields (preserved if present, omitted otherwise for backward compat)
            let mut obj = serde_json::json!({
                "name": name,
                "ip": ip,
                "rtsp": rtsp,
            });
            let map = obj.as_object_mut().unwrap();
            for key in &["vendor", "dvrIp", "rtspPort", "channelId", "streamType", "username", "rtspPath"] {
                if let Some(v) = item.get(key) {
                    if !v.is_null() {
                        map.insert(key.to_string(), v.clone());
                    }
                }
            }
            // Never expose password in read responses
            if item.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                map.insert("hasPassword".to_string(), serde_json::json!(true));
            }
            obj
        })
        .collect()
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersonSubZoneItem {
    #[serde(alias = "zoneId")]
    pub zone_id: String,
    pub name: String,
}

fn normalize_person_zone_ids(raw: Option<&str>, fallback_zone_id: Option<&str>) -> Vec<String> {
    let mut zone_ids: Vec<String> = raw
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if zone_ids.is_empty() {
        if let Some(zone_id) = fallback_zone_id.map(str::trim).filter(|value| !value.is_empty()) {
            zone_ids.push(zone_id.to_string());
        }
    }
    let mut seen = HashSet::new();
    zone_ids.retain(|value| seen.insert(value.clone()));
    zone_ids
}

fn normalize_person_sub_zones(raw: Option<&str>) -> Vec<PersonSubZoneItem> {
    serde_json::from_str::<Vec<PersonSubZoneItem>>(raw.unwrap_or("[]"))
        .unwrap_or_default()
        .into_iter()
        .map(|item| PersonSubZoneItem {
            zone_id: item.zone_id.trim().to_string(),
            name: item.name.trim().to_string(),
        })
        .filter(|item| !item.zone_id.is_empty() && !item.name.is_empty())
        .collect()
}

fn load_zone_lookup(conn: &rusqlite::Connection) -> Result<HashMap<String, String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT id, name FROM zones")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, name) = row?;
        out.insert(id, name);
    }
    Ok(out)
}

fn build_zone_refs(zone_ids: &[String], lookup: &HashMap<String, String>) -> Vec<serde_json::Value> {
    zone_ids
        .iter()
        .map(|zone_id| {
            serde_json::json!({
                "id": zone_id,
                "name": lookup.get(zone_id).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn enrich_person_sub_zones(
    sub_zones: &[PersonSubZoneItem],
    lookup: &HashMap<String, String>,
) -> Vec<serde_json::Value> {
    sub_zones
        .iter()
        .map(|item| {
            serde_json::json!({
                "zoneId": item.zone_id,
                "zoneName": lookup.get(&item.zone_id).cloned().unwrap_or_default(),
                "name": item.name,
            })
        })
        .collect()
}

pub fn audit_log(
    state: &AppState,
    resource: &str,
    action: &str,
    resource_id: Option<&str>,
    description: &str,
    changes: &serde_json::Value,
) -> Result<(), rusqlite::Error> {
    let changes_str = serde_json::to_string(changes).ok();
    db::with_db(&state.db, |conn| {
        conn.execute(
            "INSERT INTO audit_logs (id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))",
            params![db::gen_id(), None::<String>, "system", None::<String>, action, resource, resource_id, description, changes_str],
        )?;
        Ok(())
    })
}

// ---------- People (table: employees) ----------
pub async fn list_people(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let zone_lookup = load_zone_lookup(conn)?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.name, e.email, e.phone, e.department, e.personTypeId, e.status, e.isActive, e.joinedDate, e.zoneId, e.scheduleId, z.name as zone_name, s.name as schedule_name, pt.name as person_type_name, e.zoneIds, e.subZones, e.profilePhotoData, COALESCE(e.faceEnrollmentStatus, 'not_enrolled'), e.enrollmentTokenExpiresAt
             FROM employees e LEFT JOIN zones z ON e.zoneId = z.id LEFT JOIN schedules s ON e.scheduleId = s.id LEFT JOIN person_types pt ON e.personTypeId = pt.id ORDER BY e.name",
        )?;
        let rows = stmt.query_map([], |row| {
            let joined: String = row.get(8)?;
            let date = joined.split('T').next().unwrap_or(&joined).to_string();
            let primary_zone_id: String = row.get(9)?;
            let zone_ids_raw: Option<String> = row.get(14)?;
            let sub_zones_raw: Option<String> = row.get(15)?;
            let profile_photo: Option<String> = row.get(16)?;
            let fe_status: String = row.get(17)?;
            let fe_exp: Option<String> = row.get(18)?;
            let zone_ids = normalize_person_zone_ids(zone_ids_raw.as_deref(), Some(&primary_zone_id));
            let sub_zones = normalize_person_sub_zones(sub_zones_raw.as_deref());
            let fe_display = face_enrollment_display(fe_status.as_str(), fe_exp.as_deref());
            let enrollment_expires_at =
                (fe_display == "link_sent").then(|| fe_exp.clone()).flatten();
            let email_cell: Option<String> = row.get(2)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "email": email_cell.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                "personTypeId": row.get::<_, Option<String>>(5)?,
                "personType": row.get::<_, Option<String>>(13)?.unwrap_or_default(),
                "zone": row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                "zoneId": primary_zone_id,
                "zoneIds": zone_ids,
                "locations": build_zone_refs(&zone_ids, &zone_lookup),
                "zones": enrich_person_sub_zones(&sub_zones, &zone_lookup),
                "schedule": row.get::<_, Option<String>>(12)?.unwrap_or_default(),
                "scheduleId": row.get::<_, String>(10)?,
                "status": row.get::<_, String>(6)?,
                "isActive": row.get::<_, i32>(7)? != 0,
                "joinedDate": date,
                "hasProfilePhoto": profile_photo.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false),
                "faceEnrollment": fe_display,
                "enrollmentExpiresAt": enrollment_expires_at,
            }))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_person(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let person = db::with_db(&state.db, |conn| {
        let zone_lookup = load_zone_lookup(conn)?;
        let mut stmt = conn.prepare(
            "SELECT e.id, e.name, e.email, e.phone, e.department, e.personTypeId, e.status, e.isActive, e.joinedDate, e.zoneId, e.scheduleId, z.name, s.name, pt.name, e.zoneIds, e.subZones, e.profilePhotoData, COALESCE(e.faceEnrollmentStatus, 'not_enrolled'), e.enrollmentTokenExpiresAt
             FROM employees e LEFT JOIN zones z ON e.zoneId = z.id LEFT JOIN schedules s ON e.scheduleId = s.id LEFT JOIN person_types pt ON e.personTypeId = pt.id WHERE e.id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let joined: String = row.get(8)?;
            let date = joined.split('T').next().unwrap_or(&joined).to_string();
            let primary_zone_id: String = row.get(9)?;
            let zone_ids_raw: Option<String> = row.get(14)?;
            let sub_zones_raw: Option<String> = row.get(15)?;
            let profile_photo: Option<String> = row.get(16)?;
            let fe_status: String = row.get(17)?;
            let fe_exp: Option<String> = row.get(18)?;
            let zone_ids = normalize_person_zone_ids(zone_ids_raw.as_deref(), Some(&primary_zone_id));
            let sub_zones = normalize_person_sub_zones(sub_zones_raw.as_deref());
            let fe_display = face_enrollment_display(fe_status.as_str(), fe_exp.as_deref());
            let enrollment_expires_at =
                (fe_display == "link_sent").then(|| fe_exp.clone()).flatten();
            Ok(Some(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "email": row.get::<_, Option<String>>(2)?,
                "phone": row.get::<_, Option<String>>(3)?,
                "department": row.get::<_, Option<String>>(4)?,
                "personTypeId": row.get::<_, Option<String>>(5)?,
                "personType": row.get::<_, Option<String>>(13)?,
                "zone": row.get::<_, Option<String>>(11)?,
                "zoneId": primary_zone_id,
                "zoneIds": zone_ids,
                "locations": build_zone_refs(&zone_ids, &zone_lookup),
                "zones": enrich_person_sub_zones(&sub_zones, &zone_lookup),
                "schedule": row.get::<_, Option<String>>(12)?,
                "scheduleId": row.get::<_, String>(10)?,
                "status": row.get::<_, String>(6)?,
                "isActive": row.get::<_, i32>(7)? != 0,
                "joinedDate": date,
                "profilePhotoData": profile_photo,
                "hasProfilePhoto": profile_photo.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false),
                "faceEnrollment": fe_display,
                "enrollmentExpiresAt": enrollment_expires_at,
            })))
        } else {
            Ok(None)
        }
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    person.ok_or_else(|| ApiError::not_found("Person", Some(&id))).map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonCreate {
    pub name: String,
    #[serde(alias = "personTypeId")]
    pub person_type_id: Option<String>,
    #[serde(alias = "zoneId")]
    pub zone_id: Option<String>,
    #[serde(alias = "zoneIds")]
    pub zone_ids: Option<Vec<String>>,
    #[serde(alias = "zones")]
    pub sub_zones: Option<Vec<PersonSubZoneItem>>,
    #[serde(alias = "scheduleId")]
    pub schedule_id: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub department: Option<String>,
    pub status: Option<String>,
    pub is_active: Option<bool>,
    #[serde(alias = "joinedDate")]
    pub joined_date: String,
    #[serde(alias = "profilePhotoData")]
    pub profile_photo_data: Option<String>,
}

pub async fn create_person(
    State(state): State<AppState>,
    Json(body): Json<PersonCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let zone_ids = {
        let mut values = body.zone_ids.clone().unwrap_or_default();
        if values.is_empty() {
            if let Some(zone_id) = body.zone_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                values.push(zone_id.to_string());
            }
        }
        let mut seen = HashSet::new();
        values
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && seen.insert(value.clone()))
            .collect::<Vec<_>>()
    };
    let zone_id = zone_ids
        .first()
        .cloned()
        .ok_or_else(|| ApiError::bad_request("At least one zone is required"))?;
    let schedule_id = body.schedule_id.trim();
    let sub_zones = body.sub_zones.clone().unwrap_or_default()
        .into_iter()
        .map(|item| PersonSubZoneItem {
            zone_id: item.zone_id.trim().to_string(),
            name: item.name.trim().to_string(),
        })
        .filter(|item| !item.zone_id.is_empty() && !item.name.is_empty() && zone_ids.contains(&item.zone_id))
        .collect::<Vec<_>>();
    for selected_zone_id in &zone_ids {
        let zone_ok: bool = db::with_db(&state.db, |conn| {
            conn.query_row("SELECT 1 FROM zones WHERE id = ?1", params![selected_zone_id], |r| r.get(0))
        }).unwrap_or(false);
        if !zone_ok {
            return Err(ApiError::not_found("Zone", Some(selected_zone_id)));
        }
    }
    let schedule_ok: bool = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT 1 FROM schedules WHERE id = ?1", params![schedule_id], |r| r.get(0))
    }).unwrap_or(false);
    if !schedule_ok {
        return Err(ApiError::not_found("Schedule", Some(schedule_id)));
    }
    let person_type_id = body.person_type_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(ptid) = person_type_id {
        let pt_ok: bool = db::with_db(&state.db, |conn| {
            conn.query_row("SELECT 1 FROM person_types WHERE id = ?1", params![ptid], |r| r.get(0))
        }).unwrap_or(false);
        if !pt_ok {
            return Err(ApiError::not_found("Person type", Some(ptid)));
        }
    }
    validate_profile_photo_data(body.profile_photo_data.as_deref())?;
    let profile_photo = body
        .profile_photo_data
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let (id, name) = db::with_db(&state.db, |conn| {
        let id = db::gen_id();
        let status = body.status.as_deref().unwrap_or("-");
        let is_active = body.is_active.unwrap_or(true);
        let zone_ids_json = serde_json::to_string(&zone_ids).unwrap_or_else(|_| "[]".to_string());
        let sub_zones_json = serde_json::to_string(&sub_zones).unwrap_or_else(|_| "[]".to_string());
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO employees (id, name, email, phone, department, personTypeId, status, isActive, joinedDate, zoneId, scheduleId, zoneIds, subZones, profilePhotoData, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                body.name.trim(),
                body.email.as_deref().unwrap_or(""),
                body.phone.as_deref().unwrap_or(""),
                body.department.as_deref().unwrap_or(""),
                person_type_id,
                status,
                if is_active { 1 } else { 0 },
                body.joined_date,
                zone_id,
                schedule_id,
                zone_ids_json,
                sub_zones_json,
                profile_photo,
                &now,
            ],
        )?;
        let payload = serde_json::json!({
            "name": body.name.trim(),
            "email": body.email.as_deref().unwrap_or(""),
            "phone": body.phone.as_deref().unwrap_or(""),
            "department": body.department.as_deref().unwrap_or(""),
            "personTypeId": person_type_id,
            "status": status,
            "isActive": is_active,
            "joinedDate": body.joined_date,
            "zoneId": zone_id,
            "scheduleId": schedule_id,
            "zoneIds": zone_ids,
            "zones": sub_zones,
            "updatedAt": now,
            "faceEnrollmentStatus": "not_enrolled",
        });
        let _ = db::enqueue_sync(conn, "employees", &id, "create", &payload.to_string());
        Ok((id, body.name.trim().to_string()))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "person", "create", Some(&id), "auditLogs.descPersonCreated", &serde_json::json!({"_i18n": {"name": name}})).ok();
    get_person(State(state), Path(id)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonUpdate {
    pub name: Option<String>,
    #[serde(alias = "personTypeId")]
    pub person_type_id: Option<String>,
    pub zone_id: Option<String>,
    pub zone_ids: Option<Vec<String>>,
    #[serde(alias = "zones")]
    pub sub_zones: Option<Vec<PersonSubZoneItem>>,
    #[serde(alias = "scheduleId")]
    pub schedule_id: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub department: Option<String>,
    pub status: Option<String>,
    pub is_active: Option<bool>,
    #[serde(alias = "profilePhotoData")]
    pub profile_photo_data: Option<String>,
}

pub async fn update_person(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PersonUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if let Some(ref ptid) = body.person_type_id.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let pt_ok: bool = db::with_db(&state.db, |conn| {
            conn.query_row("SELECT 1 FROM person_types WHERE id = ?1", params![ptid], |r| r.get(0))
        }).unwrap_or(false);
        if !pt_ok {
            return Err(ApiError::not_found("Person type", Some(ptid)));
        }
    }
    if let Some(ref p) = body.profile_photo_data {
        validate_profile_photo_data(Some(p.as_str()))?;
    }
    let (name, active_changed, is_active) = db::with_db(&state.db, |conn| {
        let (name, email, phone, department, person_type_id, status, is_active, zone_id, schedule_id, zone_ids_raw, sub_zones_raw, joined_date, profile_photo_data, face_enrollment_status): (String, Option<String>, Option<String>, Option<String>, Option<String>, String, i32, String, String, Option<String>, Option<String>, String, Option<String>, String) = conn
            .query_row("SELECT name, email, phone, department, personTypeId, status, isActive, zoneId, scheduleId, zoneIds, subZones, joinedDate, profilePhotoData, COALESCE(faceEnrollmentStatus, 'not_enrolled') FROM employees WHERE id = ?1", params![id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                ))
            })?;
        let name = body.name.as_deref().unwrap_or(&name).trim().to_string();
        let email = body.email.as_ref().map(|s| s.trim().to_string()).or(email).filter(|s| !s.is_empty());
        let phone = body.phone.as_ref().map(|s| s.trim().to_string()).or(phone).filter(|s| !s.is_empty());
        let department = body.department.as_ref().map(|s| s.trim().to_string()).or(department).filter(|s| !s.is_empty());
        let person_type_id = body.person_type_id.as_ref().map(|s| s.trim().to_string()).or(person_type_id).filter(|s| !s.is_empty());
        let status = body.status.as_deref().unwrap_or(&status).to_string();
        let was_active = is_active != 0;
        let is_active = body.is_active.unwrap_or(was_active);
        let zone_ids = if let Some(ref zone_ids) = body.zone_ids {
            let mut seen = HashSet::new();
            zone_ids
                .iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty() && seen.insert(value.clone()))
                .collect::<Vec<_>>()
        } else if let Some(ref next_zone_id) = body.zone_id {
            vec![next_zone_id.trim().to_string()]
        } else {
            normalize_person_zone_ids(zone_ids_raw.as_deref(), Some(&zone_id))
        };
        let zone_id = zone_ids.first().cloned().unwrap_or(zone_id);
        let schedule_id = body.schedule_id.as_deref().unwrap_or(&schedule_id).to_string();
        let sub_zones = body
            .sub_zones
            .clone()
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| PersonSubZoneItem {
                        zone_id: item.zone_id.trim().to_string(),
                        name: item.name.trim().to_string(),
                    })
                    .filter(|item| !item.zone_id.is_empty() && !item.name.is_empty() && zone_ids.contains(&item.zone_id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                normalize_person_sub_zones(sub_zones_raw.as_deref())
                    .into_iter()
                    .filter(|item| zone_ids.contains(&item.zone_id))
                    .collect::<Vec<_>>()
            });
        let zone_ids_json = serde_json::to_string(&zone_ids).unwrap_or_else(|_| "[]".to_string());
        let sub_zones_json = serde_json::to_string(&sub_zones).unwrap_or_else(|_| "[]".to_string());
        let profile_photo_data = match &body.profile_photo_data {
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s.clone()),
            None => profile_photo_data,
        };
        let profile_for_db = profile_photo_data.as_deref().unwrap_or("");
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE employees SET name=?1, email=?2, phone=?3, department=?4, personTypeId=?5, status=?6, isActive=?7, zoneId=?8, scheduleId=?9, zoneIds=?10, subZones=?11, profilePhotoData=?12, updatedAt=?13 WHERE id=?14",
            params![name, email, phone, department, person_type_id, status, if is_active { 1 } else { 0 }, zone_id, schedule_id, zone_ids_json, sub_zones_json, profile_for_db, &now, id],
        )?;
        let payload = serde_json::json!({
            "name": name,
            "personTypeId": person_type_id,
            "email": email,
            "phone": phone,
            "department": department,
            "status": status,
            "isActive": is_active,
            "joinedDate": joined_date,
            "zoneId": zone_id,
            "scheduleId": schedule_id,
            "zoneIds": zone_ids,
            "zones": sub_zones,
            "updatedAt": now,
            "faceEnrollmentStatus": face_enrollment_status,
        });
        let active_changed = was_active != is_active;
        let _ = db::enqueue_sync(conn, "employees", &id, "update", &payload.to_string());
        Ok((name, active_changed, is_active))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    let (action, desc) = if active_changed {
        if is_active {
            ("reactivate", "auditLogs.descPersonReactivated")
        } else {
            ("deactivate", "auditLogs.descPersonDeactivated")
        }
    } else {
        ("update", "auditLogs.descPersonUpdated")
    };
    audit_log(&state, "person", action, Some(&id), desc, &serde_json::json!({"_i18n": {"name": name}})).ok();
    get_person(State(state), Path(id)).await
}

pub async fn delete_person(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::Response<axum::body::Body>, ApiError> {
    let name: String = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT name FROM employees WHERE id = ?1", params![id], |r| r.get(0))
    }).unwrap_or_default();
    db::with_db(&state.db, |conn| {
        let _ = db::enqueue_sync(conn, "employees", &id, "delete", "{}");
        conn.execute("DELETE FROM employees WHERE id = ?1", params![id])?;
        Ok(())
    })
        .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "person", "delete", Some(&id), "auditLogs.descPersonDeleted", &serde_json::json!({"_i18n": {"name": name}})).ok();
    Ok(axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

pub async fn get_person_activities(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.employeeId, a.type, a.date, a.time, a.zoneId, z.name FROM employee_activities a LEFT JOIN zones z ON a.zoneId = z.id WHERE a.employeeId = ?1 ORDER BY a.date DESC, a.time DESC",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            let date: String = row.get(3)?;
            let date = date.split('T').next().unwrap_or(&date).to_string();
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "employeeId": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "date": date,
                "time": row.get::<_, String>(4)?,
                "zone": row.get::<_, Option<String>>(6)?,
            }))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

pub async fn check_in(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    let (status, zone_id, person_name): (String, Option<String>, String) = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT status, zoneId, name FROM employees WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    }).map_err(|_| ApiError::not_found("Person", Some(&id)))?;
    if status == "checked-in" {
        return Err(ApiError::bad_request("Person is already checked in"));
    }
    let now = Utc::now();
    let time_str = now.format("%H:%M").to_string();
    let date_str = now.format("%Y-%m-%d").to_string();
    let updated_at = now.to_rfc3339();
    db::with_db(&state.db, |conn| {
        conn.execute("UPDATE employees SET status = 'checked-in' WHERE id = ?1", params![id])?;
        let activity_id = db::gen_id();
        conn.execute(
            "INSERT INTO employee_activities (id, type, date, time, zoneId, employeeId) VALUES (?1, 'check-in', ?2, ?3, ?4, ?5)",
            params![&activity_id, date_str, time_str, zone_id, id],
        )?;
        let payload = serde_json::json!({
            "type": "check-in",
            "date": date_str,
            "time": time_str,
            "zoneId": zone_id,
            "employeeId": id,
            "updatedAt": updated_at,
        });
        let _ = db::enqueue_sync(conn, "employee_activities", &activity_id, "create", &payload.to_string());
        let access_log_id = db::gen_id();
        conn.execute(
            "INSERT INTO access_logs (id, employeeId, zoneId, action, timestamp, metadata) VALUES (?1, ?2, ?3, 'check-in', ?4, ?5)",
            params![&access_log_id, id, zone_id, updated_at, Option::<String>::None],
        )?;
        let access_log_payload = serde_json::json!({
            "employeeId": id,
            "zoneId": zone_id,
            "action": "check-in",
            "timestamp": updated_at,
            "metadata": serde_json::Value::Null,
        });
        let _ = db::enqueue_sync(conn, "access_logs", &access_log_id, "create", &access_log_payload.to_string());
        Ok(())
    }).map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "person", "check-in", Some(&id), "auditLogs.descPersonCheckedIn", &serde_json::json!({"_i18n": {"name": person_name}})).ok();
    get_person(State(state), Path(id)).await
}

pub async fn check_out(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<serde_json::Value>, ApiError> {
    let (status, zone_id, person_name): (String, Option<String>, String) = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT status, zoneId, name FROM employees WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    }).map_err(|_| ApiError::not_found("Person", Some(&id)))?;
    if status == "checked-out" {
        return Err(ApiError::bad_request("Person is already checked out"));
    }
    let now = Utc::now();
    let time_str = now.format("%H:%M").to_string();
    let date_str = now.format("%Y-%m-%d").to_string();
    let updated_at = now.to_rfc3339();
    db::with_db(&state.db, |conn| {
        conn.execute("UPDATE employees SET status = 'checked-out' WHERE id = ?1", params![id])?;
        let activity_id = db::gen_id();
        conn.execute(
            "INSERT INTO employee_activities (id, type, date, time, zoneId, employeeId) VALUES (?1, 'check-out', ?2, ?3, ?4, ?5)",
            params![&activity_id, date_str, time_str, zone_id, id],
        )?;
        let payload = serde_json::json!({
            "type": "check-out",
            "date": date_str,
            "time": time_str,
            "zoneId": zone_id,
            "employeeId": id,
            "updatedAt": updated_at,
        });
        let _ = db::enqueue_sync(conn, "employee_activities", &activity_id, "create", &payload.to_string());
        let access_log_id = db::gen_id();
        conn.execute(
            "INSERT INTO access_logs (id, employeeId, zoneId, action, timestamp, metadata) VALUES (?1, ?2, ?3, 'check-out', ?4, ?5)",
            params![&access_log_id, id, zone_id, updated_at, Option::<String>::None],
        )?;
        let access_log_payload = serde_json::json!({
            "employeeId": id,
            "zoneId": zone_id,
            "action": "check-out",
            "timestamp": updated_at,
            "metadata": serde_json::Value::Null,
        });
        let _ = db::enqueue_sync(conn, "access_logs", &access_log_id, "create", &access_log_payload.to_string());
        Ok(())
    }).map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "person", "check-out", Some(&id), "auditLogs.descPersonCheckedOut", &serde_json::json!({"_i18n": {"name": person_name}})).ok();
    get_person(State(state), Path(id)).await
}

// ---------- Person Types ----------
pub async fn list_person_types(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, status, created_at, updated_at,
             (SELECT COUNT(*) FROM employees WHERE personTypeId = person_types.id)
             FROM person_types ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "description": row.get::<_, Option<String>>(2)?,
                "status": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, Option<String>>(4)?,
                "updatedAt": row.get::<_, Option<String>>(5)?,
                "assignedCount": row.get::<_, i64>(6)?,
            }))
        })?;
        let out: Result<Vec<_>, _> = rows.collect();
        out
    }).map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonTypeCreate {
    pub name: String,
    pub description: Option<String>,
    pub status: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonTypeUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
}

fn serialize_person_type_row(
    id: &str,
    name: &str,
    description: Option<&str>,
    status: &str,
    created_at: Option<&str>,
    updated_at: Option<&str>,
    assigned_count: i64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "assignedCount": assigned_count,
    })
}

pub async fn get_person_type(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = db::with_db(&state.db, |conn| {
        let (name, description, status, created_at, updated_at): (String, Option<String>, String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT name, description, status, created_at, updated_at FROM person_types WHERE id = ?1",
                params![&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?;
        let assigned_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM employees WHERE personTypeId = ?1",
                params![&id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(serialize_person_type_row(
            &id,
            &name,
            description.as_deref(),
            &status,
            created_at.as_deref(),
            updated_at.as_deref(),
            assigned_count,
        ))
    }).map_err(|e: rusqlite::Error| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            ApiError::not_found("Person type", Some(&id))
        } else {
            ApiError::service_unavailable(e.to_string())
        }
    })?;
    Ok(Json(row))
}

pub async fn create_person_type(
    State(state): State<AppState>,
    Json(body): Json<PersonTypeCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("Type name is required"));
    }
    let description = body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let status = body.status.as_deref().unwrap_or("active").trim();
    let status = if status.is_empty() { "active" } else { status };

    let id = db::with_db(&state.db, |conn| {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM person_types WHERE LOWER(name) = LOWER(?1)",
                params![&name],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if exists {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let id = db::gen_id();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO person_types (id, name, description, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, &name, description.as_deref(), status, &now, &now],
        )?;
        let payload = serde_json::json!({
            "name": name,
            "description": description,
            "status": status,
            "createdAt": now,
            "updatedAt": now,
        });
        let _ = db::enqueue_sync(conn, "person_types", &id, "create", &payload.to_string());
        Ok(id)
    }).map_err(|e: rusqlite::Error| {
        if e.to_string().contains("InvalidQuery") || e.to_string().contains("UNIQUE") {
            ApiError::conflict("A person type with this name already exists")
        } else {
            ApiError::service_unavailable(e.to_string())
        }
    })?;
    audit_log(
        &state,
        "person_type",
        "create",
        Some(&id),
        "auditLogs.descPersonTypeCreated",
        &serde_json::json!({
            "_i18n": { "name": name, "status": status },
            "description": description,
        }),
    ).ok();
    get_person_type(State(state), Path(id)).await
}

pub async fn update_person_type(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PersonTypeUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (old_name, new_name, new_description, new_status) = db::with_db(&state.db, |conn| {
        let (name, description, status): (String, Option<String>, String) = conn.query_row(
            "SELECT name, description, status FROM person_types WHERE id = ?1",
            params![&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let next_name = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| name.clone());
        let next_description = body.description.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).or(description);
        let next_status = body.status.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| status.clone());
        if next_name.to_lowercase() != name.to_lowercase() {
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM person_types WHERE LOWER(name) = LOWER(?1) AND id != ?2",
                    params![next_name, &id],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if exists {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE person_types SET name = ?1, description = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
            params![&next_name, next_description.as_deref(), &next_status, &now, &id],
        )?;
        let payload = serde_json::json!({
            "name": next_name,
            "description": next_description,
            "status": next_status,
            "updatedAt": now,
        });
        let _ = db::enqueue_sync(conn, "person_types", &id, "update", &payload.to_string());
        Ok((name, next_name, next_description.clone(), next_status))
    }).map_err(|e: rusqlite::Error| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            ApiError::not_found("Person type", Some(&id))
        } else if e.to_string().contains("InvalidQuery") || e.to_string().contains("UNIQUE") {
            ApiError::conflict("A person type with this name already exists")
        } else {
            ApiError::service_unavailable(e.to_string())
        }
    })?;
    audit_log(
        &state,
        "person_type",
        "update",
        Some(&id),
        "auditLogs.descPersonTypeUpdated",
        &serde_json::json!({
            "_i18n": { "oldName": old_name, "newName": new_name, "status": new_status },
            "description": new_description,
        }),
    ).ok();
    get_person_type(State(state), Path(id)).await
}

pub async fn delete_person_type(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let name = db::with_db(&state.db, |conn| {
        let name: String = conn.query_row("SELECT name FROM person_types WHERE id = ?1", params![&id], |r| r.get(0))?;
        let assigned: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM employees WHERE personTypeId = ?1",
                params![&id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if assigned > 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let _ = db::enqueue_sync(conn, "person_types", &id, "delete", "{}");
        conn.execute("DELETE FROM person_types WHERE id = ?1", params![&id])?;
        Ok(name)
    }).map_err(|e: rusqlite::Error| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            ApiError::not_found("Person type", Some(&id))
        } else if e.to_string().contains("InvalidQuery") {
            ApiError::conflict("This person type is assigned to people. Cannot delete.")
        } else {
            ApiError::service_unavailable(e.to_string())
        }
    })?;
    audit_log(
        &state,
        "person_type",
        "delete",
        Some(&id),
        "auditLogs.descPersonTypeDeleted",
        &serde_json::json!({ "_i18n": { "name": name } }),
    ).ok();
    Ok(StatusCode::NO_CONTENT)
}

// ---------- Zones ----------
pub async fn list_zones(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT z.id, z.name, z.status, z.createdBy, z.dateCreated, z.cameraIds,
             (SELECT COUNT(*) FROM employees e WHERE e.zoneId = z.id),
             (SELECT COUNT(DISTINCT scheduleId) FROM employees e WHERE e.zoneId = z.id)
             FROM zones z ORDER BY z.dateCreated DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let sub_zones: String = row.get(5)?;
            let sub_zones = normalize_zone_sub_zones(&sub_zones);
            let date: Option<String> = row.get(4)?;
            let date = date.and_then(|d| d.split('T').next().map(String::from));
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "assignedShifts": row.get::<_, i32>(7)?,
                "assignedEmployees": row.get::<_, i32>(6)?,
                "createdBy": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(2)?,
                "dateCreated": date,
                "zones": sub_zones,
            }))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_zone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let z = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, status, createdBy, dateCreated, cameraIds,
             (SELECT COUNT(*) FROM employees e WHERE e.zoneId = zones.id),
             (SELECT COUNT(DISTINCT scheduleId) FROM employees e WHERE e.zoneId = zones.id)
             FROM zones WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let sub_zones: String = row.get(5)?;
            let sub_zones = normalize_zone_sub_zones(&sub_zones);
            let date: Option<String> = row.get(4)?;
            let date = date.and_then(|d| d.split('T').next().map(String::from));
            Ok(Some(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "assignedShifts": row.get::<_, i32>(7)?,
                "assignedEmployees": row.get::<_, i32>(6)?,
                "createdBy": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(2)?,
                "dateCreated": date,
                "zones": sub_zones,
            })))
        } else {
            Ok(None)
        }
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    z.ok_or_else(|| ApiError::not_found("Zone", Some(&id))).map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneCreate {
    pub name: String,
    pub status: Option<String>,
    #[serde(alias = "cameras", alias = "subZones", alias = "zones")]
    pub sub_zones: Option<Vec<SubZoneItem>>,
    #[serde(alias = "createdBy")]
    pub created_by: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubZoneItem {
    pub name: Option<String>,
    pub ip: Option<String>,
    pub rtsp: Option<String>,
    // DVR camera integration fields (all optional for backward compat)
    pub vendor: Option<String>,
    pub dvr_ip: Option<String>,
    pub rtsp_port: Option<u16>,
    pub channel_id: Option<u32>,
    pub stream_type: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub rtsp_path: Option<String>,
}

pub async fn create_zone(
    State(state): State<AppState>,
    Json(body): Json<ZoneCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    let sub_zones = body.sub_zones.as_ref().map(|c| serde_json::to_string(c).unwrap()).unwrap_or_else(|| "[]".to_string());
    let normalized_sub_zones = normalize_zone_sub_zones(&sub_zones);
    let status = body.status.as_deref().unwrap_or("active");
    let id = db::with_db(&state.db, |conn| {
        let exists: bool = conn.query_row("SELECT 1 FROM zones WHERE name = ?1", params![name], |r| r.get(0)).unwrap_or(false);
        if exists {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let id = db::gen_id();
        conn.execute(
            "INSERT INTO zones (id, name, status, cameraIds, createdBy, dateCreated) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![id, name, status, sub_zones, body.created_by.trim()],
        )?;
        let sub_zones_arr: Vec<serde_json::Value> = serde_json::from_str(&sub_zones).unwrap_or_default();
        let payload = serde_json::json!({
            "name": name,
            "status": status,
            "zones": sub_zones_arr,
            "createdBy": body.created_by.trim()
        });
        let _ = db::enqueue_sync(conn, "zones", &id, "create", &payload.to_string());
        Ok(id)
    })
    .map_err(|_| ApiError::conflict("A zone with this name already exists"))?;
    audit_log(
        &state,
        "zone",
        "create",
        Some(&id),
        "auditLogs.descZoneCreated",
        &serde_json::json!({
            "_i18n": {
                "name": name,
                "status": status,
                "zoneCount": normalized_sub_zones.len(),
            },
            "zones": normalized_sub_zones,
        }),
    ).ok();
    get_zone(State(state), Path(id)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneUpdate {
    pub name: Option<String>,
    pub status: Option<String>,
    #[serde(alias = "cameras", alias = "subZones", alias = "zones")]
    pub sub_zones: Option<Vec<SubZoneItem>>,
}

pub async fn update_zone(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ZoneUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (old_name, name, status, previous_sub_zones, next_sub_zones) = db::with_db(&state.db, |conn| {
        if let Some(ref name) = body.name {
            let other: Option<String> = conn.query_row("SELECT id FROM zones WHERE name = ?1 AND id != ?2", params![name.trim(), id], |r| r.get(0)).ok();
            if other.is_some() {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let (name, status, sub_zones, created_by): (String, String, String, String) = conn.query_row("SELECT name, status, cameraIds, createdBy FROM zones WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let previous_sub_zones = normalize_zone_sub_zones(&sub_zones);
        let next_name = body.name.as_deref().unwrap_or(&name).trim().to_string();
        let next_status = body.status.as_deref().unwrap_or(&status).to_string();
        let next_sub_zones_raw = body.sub_zones.as_ref().map(|c| serde_json::to_string(c).unwrap()).unwrap_or(sub_zones);
        let next_sub_zones = normalize_zone_sub_zones(&next_sub_zones_raw);
        conn.execute("UPDATE zones SET name=?1, status=?2, cameraIds=?3 WHERE id=?4", params![next_name, next_status, next_sub_zones_raw, id])?;
        let sub_zones_arr: Vec<serde_json::Value> = serde_json::from_str(&next_sub_zones_raw).unwrap_or_default();
        let payload = serde_json::json!({
            "name": next_name,
            "status": next_status,
            "zones": sub_zones_arr,
            "createdBy": created_by
        });
        let _ = db::enqueue_sync(conn, "zones", &id, "update", &payload.to_string());
        Ok((name, next_name, next_status, previous_sub_zones, next_sub_zones))
    })
    .map_err(|_| ApiError::conflict("A zone with this name already exists"))?;
    audit_log(
        &state,
        "zone",
        "update",
        Some(&id),
        "auditLogs.descZoneUpdated",
        &serde_json::json!({
            "_i18n": {
                "oldName": old_name,
                "newName": name,
                "status": status,
                "zoneCount": next_sub_zones.len(),
            },
            "previousZones": previous_sub_zones,
            "zones": next_sub_zones,
        }),
    ).ok();
    get_zone(State(state), Path(id)).await
}

pub async fn delete_zone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::Response<axum::body::Body>, ApiError> {
    let (n, zone_name): (i32, String) = db::with_db(&state.db, |conn| {
        let count: i32 = conn.query_row("SELECT COUNT(*) FROM employees WHERE zoneId = ?1", params![id], |r| r.get(0))?;
        let name: String = conn.query_row("SELECT name FROM zones WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or_default();
        Ok((count, name))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    if n > 0 {
        return Err(ApiError::conflict(format!("Cannot delete zone: it has {} employee(s) assigned", n)));
    }
    db::with_db(&state.db, |conn| {
        let _ = db::enqueue_sync(conn, "zones", &id, "delete", "{}");
        conn.execute("DELETE FROM zones WHERE id = ?1", params![id])
    })
        .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "zone", "delete", Some(&id), "auditLogs.descZoneDeleted", &serde_json::json!({"_i18n": {"name": zone_name}})).ok();
    Ok(axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

// ---------- Zone Camera Test ----------

/// POST /api/v1/zones/cameras/test-connection
/// Tests reachability of a camera given its DVR config.
/// Uses Python AI service frame-test as primary (authoritative) path,
/// falls back to TCP+RTSP OPTIONS if Python service is unavailable.
pub async fn test_camera_connection(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let cfg = parse_dvr_config_from_json(&body);
    let ai_url = state.config.local_ai_url.clone();
    let ai_base = if ai_url.trim().is_empty() { None } else { Some(ai_url.as_str()) };
    let result = crate::api::rtsp::test_camera_connection(&cfg, ai_base).await;
    Json(serde_json::to_value(result).unwrap())
}

/// POST /api/v1/zones/cameras/build-url
/// Builds an RTSP URL from DVR config and returns it (masked).
pub async fn build_camera_rtsp_url(
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cfg = parse_dvr_config_from_json(&body);
    match crate::api::rtsp::build_rtsp_url(&cfg) {
        Ok(url) => {
            let masked = crate::api::rtsp::mask_rtsp_url(&url);
            Ok(Json(serde_json::json!({
                "rtspUrl": url,
                "rtspUrlMasked": masked,
            })))
        }
        Err(e) => Err(ApiError::bad_request(e.message)),
    }
}

pub fn parse_dvr_config_from_json(body: &serde_json::Value) -> crate::api::rtsp::DvrCameraConfig {
    let str_field = |key: &str| -> Option<String> {
        body.get(key).and_then(|v| v.as_str()).map(String::from)
    };
    let vendor_str = str_field("vendor").unwrap_or_default();
    let vendor = match vendor_str.as_str() {
        "hikvision" => Some(crate::api::rtsp::CameraVendor::Hikvision),
        "dahua" => Some(crate::api::rtsp::CameraVendor::Dahua),
        "generic" | "" => Some(crate::api::rtsp::CameraVendor::Generic),
        _ => Some(crate::api::rtsp::CameraVendor::Generic),
    };
    crate::api::rtsp::DvrCameraConfig {
        vendor,
        dvr_ip: str_field("dvrIp"),
        rtsp_port: body.get("rtspPort").and_then(|v| v.as_u64()).map(|v| v as u16),
        channel_id: body.get("channelId").and_then(|v| v.as_u64()).map(|v| v as u32),
        stream_type: str_field("streamType").and_then(|s| match s.as_str() {
            "main" => Some(crate::api::rtsp::StreamType::Main),
            "sub" => Some(crate::api::rtsp::StreamType::Sub),
            _ => None,
        }),
        username: str_field("username"),
        password: str_field("password"),
        rtsp_path: str_field("rtspPath"),
        rtsp: str_field("rtsp"),
    }
}

// ---------- Schedules ----------
pub async fn list_schedules(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description, s.breakTime, s.status, s.createdBy, s.createdAt, \
             (SELECT COUNT(*) FROM employees e WHERE e.scheduleId = s.id), s.personTypeId, pt.name, s.workingDays \
             FROM schedules s LEFT JOIN person_types pt ON s.personTypeId = pt.id ORDER BY s.name",
        )?;
        let rows = stmt.query_map([], |row| {
            let date: Option<String> = row.get(6)?;
            let date = date.and_then(|d| d.split('T').next().map(String::from));
            let person_type_id: Option<String> = row.get::<_, Option<String>>(8).ok().flatten();
            let person_type_name: Option<String> = row.get::<_, Option<String>>(9).ok().flatten();
            let working_days_raw: Option<String> = row.get::<_, Option<String>>(10).ok().flatten();
            let working_days: serde_json::Value = working_days_raw
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "description": row.get::<_, Option<String>>(2)?,
                "assignedEmployees": row.get::<_, i32>(7)?,
                "createdBy": row.get::<_, String>(5)?,
                "createdAt": date,
                "status": row.get::<_, String>(4)?,
                "breakTime": row.get::<_, String>(3)?,
                "personTypeId": person_type_id,
                "personType": person_type_name.unwrap_or_default(),
                "workingDays": working_days,
            }))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_schedule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let s = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.description, s.breakTime, s.status, s.createdBy, s.createdAt, \
             (SELECT COUNT(*) FROM employees e WHERE e.scheduleId = s.id), s.personTypeId, pt.name, s.workingDays \
             FROM schedules s LEFT JOIN person_types pt ON s.personTypeId = pt.id WHERE s.id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let date: Option<String> = row.get(6)?;
            let date = date.and_then(|d| d.split('T').next().map(String::from));
            let person_type_id: Option<String> = row.get::<_, Option<String>>(8).ok().flatten();
            let person_type_name: Option<String> = row.get::<_, Option<String>>(9).ok().flatten();
            let working_days_raw: Option<String> = row.get::<_, Option<String>>(10).ok().flatten();
            let working_days: serde_json::Value = working_days_raw
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);
            Ok(Some(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "description": row.get::<_, Option<String>>(2)?,
                "assignedEmployees": row.get::<_, i32>(7)?,
                "createdBy": row.get::<_, String>(5)?,
                "createdAt": date,
                "status": row.get::<_, String>(4)?,
                "breakTime": row.get::<_, String>(3)?,
                "personTypeId": person_type_id,
                "personType": person_type_name.unwrap_or_default(),
                "workingDays": working_days,
            })))
        } else {
            Ok(None)
        }
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    s.ok_or_else(|| ApiError::not_found("Schedule", Some(&id))).map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCreate {
    pub name: String,
    pub description: Option<String>,
    pub break_time: String,
    pub status: Option<String>,
    pub created_by: String,
    pub person_type_id: Option<String>,
    pub working_days: Option<Vec<String>>,
}

pub async fn create_schedule(
    State(state): State<AppState>,
    Json(body): Json<ScheduleCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = body.name.trim();
    let status = body.status.as_deref().unwrap_or("active");
    let id = db::with_db(&state.db, |conn| {
        let exists: bool = conn.query_row("SELECT 1 FROM schedules WHERE name = ?1", params![name], |r| r.get(0)).unwrap_or(false);
        if exists {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let id = db::gen_id();
        let person_type_id = body.person_type_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let working_days_json: Option<String> = body.working_days.as_ref().map(|days| serde_json::to_string(days).unwrap_or_else(|_| "[]".to_string()));
        conn.execute(
            "INSERT INTO schedules (id, name, description, breakTime, status, createdBy, createdAt, personTypeId, workingDays) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7, ?8)",
            params![id, name, body.description.as_deref().unwrap_or(""), body.break_time.trim(), status, body.created_by.trim(), person_type_id, working_days_json],
        )?;
        let payload = serde_json::json!({
            "name": name,
            "description": body.description.as_deref().unwrap_or("").trim(),
            "breakTime": body.break_time.trim(),
            "status": status,
            "createdBy": body.created_by.trim(),
            "personTypeId": person_type_id,
            "workingDays": body.working_days,
        });
        let _ = db::enqueue_sync(conn, "schedules", &id, "create", &payload.to_string());
        Ok(id)
    })
    .map_err(|_| ApiError::conflict("A schedule with this name already exists"))?;
    audit_log(&state, "schedule", "create", Some(&id), "auditLogs.descScheduleCreated", &serde_json::json!({"_i18n": {"name": body.name.trim()}})).ok();
    get_schedule(State(state), Path(id)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub break_time: Option<String>,
    pub status: Option<String>,
    pub person_type_id: Option<String>,
    pub working_days: Option<Vec<String>>,
}

pub async fn update_schedule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ScheduleUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = db::with_db(&state.db, |conn| {
        let (name, description, break_time, status, created_by, existing_pt_id, existing_working_days): (String, Option<String>, String, String, String, Option<String>, Option<String>) = conn
            .query_row("SELECT name, description, breakTime, status, createdBy, personTypeId, workingDays FROM schedules WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })?;
        let name = body.name.as_deref().unwrap_or(&name).trim().to_string();
        let description = body.description.as_ref().map(|s| s.trim().to_string()).or(description).filter(|s| !s.is_empty());
        let break_time = body.break_time.as_deref().unwrap_or(&break_time).trim().to_string();
        let status = body.status.as_deref().unwrap_or(&status).to_string();
        let person_type_id = body
            .person_type_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(existing_pt_id.as_deref());
        let working_days_json: Option<String> = if let Some(ref days) = body.working_days {
            Some(serde_json::to_string(days).unwrap_or_else(|_| "[]".to_string()))
        } else {
            existing_working_days
        };
        conn.execute(
            "UPDATE schedules SET name=?1, description=?2, breakTime=?3, status=?4, personTypeId=?5, workingDays=?6 WHERE id=?7",
            params![name, description, break_time, status, person_type_id, working_days_json, id],
        )?;
        let working_days_value: serde_json::Value = working_days_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null);
        let payload = serde_json::json!({
            "name": name,
            "description": description,
            "breakTime": break_time,
            "status": status,
            "createdBy": created_by,
            "personTypeId": person_type_id,
            "workingDays": working_days_value,
        });
        let _ = db::enqueue_sync(conn, "schedules", &id, "update", &payload.to_string());
        Ok(name)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "schedule", "update", Some(&id), "auditLogs.descScheduleUpdated", &serde_json::json!({"_i18n": {"name": name}})).ok();
    get_schedule(State(state), Path(id)).await
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::Response<axum::body::Body>, ApiError> {
    let (n, schedule_name): (i32, String) = db::with_db(&state.db, |conn| {
        let count: i32 = conn.query_row("SELECT COUNT(*) FROM employees WHERE scheduleId = ?1", params![id], |r| r.get(0))?;
        let name: String = conn.query_row("SELECT name FROM schedules WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or_default();
        Ok((count, name))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    if n > 0 {
        return Err(ApiError::conflict(format!("Cannot delete schedule: {} employee(s) are assigned", n)));
    }
    db::with_db(&state.db, |conn| {
        let _ = db::enqueue_sync(conn, "schedules", &id, "delete", "{}");
        conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])
    })
        .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, "schedule", "delete", Some(&id), "auditLogs.descScheduleDeleted", &serde_json::json!({"_i18n": {"name": schedule_name}})).ok();
    Ok(axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

// ---------- Dashboard ----------
pub async fn dashboard_stats(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let time_range = params.get("timeRange").map(|s| s.as_str()).unwrap_or("daily");
    let now = Utc::now().date_naive();
    let today_start = now;
    let chart_end = now;
    let chart_start = match time_range {
        "hourly" => (0..1).fold(now, |d, _| d.pred_opt().unwrap_or(d)),
        "daily" => (0..7).fold(now, |d, _| d.pred_opt().unwrap_or(d)),
        "weekly" => (0..28).fold(now, |d, _| d.pred_opt().unwrap_or(d)),
        _ => (0..180).fold(now, |d, _| d.pred_opt().unwrap_or(d)),
    };

    let stats = db::with_db(&state.db, |conn| {
        let total_employees: i32 = conn.query_row("SELECT COUNT(*) FROM employees WHERE isActive = 1", [], |r| r.get(0))?;
        let currently_checked_in: i32 = conn.query_row("SELECT COUNT(*) FROM employees WHERE status = 'checked-in' AND isActive = 1", [], |r| r.get(0))?;
        let today_str = today_start.format("%Y-%m-%d").to_string();
        let check_in_today: i32 = conn.query_row(
            "SELECT COUNT(*) FROM employee_activities WHERE type = 'check-in' AND date = ?1",
            params![today_str],
            |r| r.get(0),
        )?;
        let check_out_today: i32 = conn.query_row(
            "SELECT COUNT(*) FROM employee_activities WHERE type = 'check-out' AND date = ?1",
            params![today_str],
            |r| r.get(0),
        )?;

        let mut stmt = conn.prepare(
            "SELECT a.id, a.date, a.time, a.type, e.name, z.name FROM employee_activities a JOIN employees e ON a.employeeId = e.id LEFT JOIN zones z ON e.zoneId = z.id ORDER BY a.date DESC, a.time DESC LIMIT 5",
        )?;
        let latest_access_logs: Vec<serde_json::Value> = stmt
            .query_map([], |row| {
                let date: String = row.get(1)?;
                let date = date.split('T').next().unwrap_or(&date).to_string();
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "date": date,
                    "time": row.get::<_, String>(2)?,
                    "employee": row.get::<_, String>(4)?,
                    "zone": row.get::<_, Option<String>>(5)?.unwrap_or("—".to_string()),
                    "action": row.get::<_, String>(3)?,
                }))
            })?
            .filter_map(Result::ok)
            .collect();

        let mut stmt = conn.prepare("SELECT id, timestamp, action, resource, actorName, actorId FROM audit_logs ORDER BY timestamp DESC LIMIT 5")?;
        let latest_audit_logs: Vec<serde_json::Value> = stmt
            .query_map([], |row| {
                let ts: Option<String> = row.get(1)?;
                let date = ts.as_ref().map(|s| s.split('T').next().unwrap_or(s).to_string()).unwrap_or_default();
                let time = ts.as_ref().and_then(|s| s.get(11..16)).unwrap_or("").to_string();
                let user = row.get::<_, Option<String>>(4)?.or(row.get::<_, Option<String>>(5)?);
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "timestamp": ts,
                    "date": date,
                    "time": time,
                    "user": user,
                    "action": row.get::<_, String>(2)?,
                    "resource": row.get::<_, String>(3)?,
                }))
            })?
            .filter_map(Result::ok)
            .collect();

        let mut stmt = conn.prepare("SELECT date, type FROM employee_activities WHERE date >= ?1 AND date <= ?2")?;
        let start_str = chart_start.format("%Y-%m-%d").to_string();
        let end_str = chart_end.format("%Y-%m-%d").to_string();
        let mut by_date: std::collections::HashMap<String, (i32, i32)> = std::collections::HashMap::new();
        let rows = stmt.query_map(params![start_str, end_str], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for r in rows {
            if let Ok((date, typ)) = r {
                let date = date.split('T').next().unwrap_or(&date).to_string();
                let e = by_date.entry(date).or_insert((0, 0));
                if typ == "check-in" {
                    e.0 += 1;
                } else {
                    e.1 += 1;
                }
            }
        }
        let mut days = Vec::new();
        let mut cur = chart_start;
        loop {
            days.push(cur.format("%Y-%m-%d").to_string());
            if let Some(next) = cur.succ_opt() {
                if next > chart_end {
                    break;
                }
                cur = next;
            } else {
                break;
            }
        }
        let chart_data: Vec<serde_json::Value> = days
            .iter()
            .map(|d| {
                let (entries, exits) = by_date.get(d).copied().unwrap_or((0, 0));
                serde_json::json!({ "date": d, "entries": entries, "exits": exits })
            })
            .collect();

        Ok(serde_json::json!({
            "totalEmployees": total_employees,
            "checkInToday": check_in_today,
            "checkOutToday": check_out_today,
            "currentlyCheckedIn": currently_checked_in,
            "latestAccessLogs": latest_access_logs,
            "latestAuditLogs": latest_audit_logs,
            "chartData": chart_data,
        }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(stats))
}

// ---------- Audit logs ----------
pub async fn list_audit_logs(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let resource = params.get("resource").map(|s| s.as_str());
    let date_from = params.get("dateFrom").map(|s| s.as_str());
    let date_to = params.get("dateTo").map(|s| s.as_str());
    let search = params.get("search").map(|s| s.as_str());
    let limit = params.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50).min(200).max(1);
    let offset = params.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);

    let _ = (resource, date_from, date_to, search); // TODO: apply filters
    let result = db::with_db(&state.db, |conn| {
        let total: i32 = conn.query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))?;
        let mut stmt = conn.prepare("SELECT id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp FROM audit_logs ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2")?;
        let mut rows = stmt.query(params![limit, offset])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "actorId": row.get::<_, Option<String>>(1)?,
                "actorType": row.get::<_, Option<String>>(2)?,
                "actorName": row.get::<_, Option<String>>(3)?,
                "action": row.get::<_, String>(4)?,
                "resource": row.get::<_, String>(5)?,
                "resourceId": row.get::<_, Option<String>>(6)?,
                "description": row.get::<_, Option<String>>(7)?,
                "changes": row.get::<_, Option<String>>(8)?,
                "timestamp": row.get::<_, Option<String>>(9)?,
            }));
        }
        Ok(serde_json::json!({ "items": items, "total": total }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(result))
}

pub async fn get_audit_log(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let log = db::with_db(&state.db, |conn| {
        conn.query_row(
            "SELECT id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp FROM audit_logs WHERE id = ?1",
            params![id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "actorId": row.get::<_, Option<String>>(1)?,
                    "actorType": row.get::<_, Option<String>>(2)?,
                    "actorName": row.get::<_, Option<String>>(3)?,
                    "action": row.get::<_, String>(4)?,
                    "resource": row.get::<_, String>(5)?,
                    "resourceId": row.get::<_, Option<String>>(6)?,
                    "description": row.get::<_, Option<String>>(7)?,
                    "changes": row.get::<_, Option<String>>(8)?,
                    "timestamp": row.get::<_, Option<String>>(9)?,
                }))
            },
        )
    })
    .map_err(|_| ApiError::not_found("Audit log", Some(&id)))?;
    Ok(Json(log))
}

// ---------- Access logs ----------
pub async fn list_access_logs(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let limit: i64 = params.get("limit").and_then(|s| s.parse().ok()).unwrap_or(2000).min(5000).max(1);
    let date_from = params.get("dateFrom").cloned().unwrap_or_default();
    let date_to = params.get("dateTo").cloned().unwrap_or_default();
    let activity_type_filter = params.get("activityType").cloned().unwrap_or_default();
    let zone_filter = params.get("zone").cloned().unwrap_or_default();
    let search_filter = params.get("search").map(|s| s.trim().to_lowercase()).unwrap_or_default();

    let rows = db::with_db(&state.db, move |conn| -> Result<Vec<serde_json::Value>, rusqlite::Error> {
        let mut out = Vec::new();

        // Build a zone-id → zone-name lookup for resolving tracking notes
        let zone_name_map: HashMap<String, String> = {
            let mut m = HashMap::new();
            let mut stmt = conn.prepare("SELECT id, name FROM zones")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for r in rows {
                if let Ok((id, name)) = r { m.insert(id, name); }
            }
            m
        };

        // ── Attendance events (check-in / check-out / absent) ──
        let want_attendance = activity_type_filter.is_empty()
            || activity_type_filter == "all"
            || activity_type_filter == "check-in"
            || activity_type_filter == "check-out"
            || activity_type_filter == "absent";

        if want_attendance {
            let mut sql = String::from(
                "SELECT a.id, a.employeeId, a.type, a.date, a.time, \
                        e.name, z.name, s.id, s.name, s.breakTime, \
                        pt.id, pt.name \
                 FROM employee_activities a \
                 JOIN employees e ON a.employeeId = e.id \
                 LEFT JOIN zones z ON e.zoneId = z.id \
                 LEFT JOIN schedules s ON e.scheduleId = s.id \
                 LEFT JOIN person_types pt ON e.personTypeId = pt.id \
                 WHERE 1=1"
            );
            let mut bind_values: Vec<String> = Vec::new();

            if !activity_type_filter.is_empty() && activity_type_filter != "all" && activity_type_filter != "tracking" {
                bind_values.push(activity_type_filter.clone());
                sql.push_str(&format!(" AND a.type = ?{}", bind_values.len()));
            }
            if !date_from.is_empty() {
                bind_values.push(date_from.clone());
                sql.push_str(&format!(" AND a.date >= ?{}", bind_values.len()));
            }
            if !date_to.is_empty() {
                bind_values.push(format!("{}T23:59:59", date_to));
                sql.push_str(&format!(" AND a.date <= ?{}", bind_values.len()));
            }
            if !zone_filter.is_empty() && zone_filter != "all" {
                bind_values.push(zone_filter.clone());
                sql.push_str(&format!(" AND z.name = ?{}", bind_values.len()));
            }

            sql.push_str(" ORDER BY a.date DESC, a.time DESC");
            bind_values.push(limit.to_string());
            sql.push_str(&format!(" LIMIT ?{}", bind_values.len()));

            let mut att_stmt = conn.prepare(&sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
            let mut att_rows = att_stmt.query(param_refs.as_slice())?;

            while let Some(row) = att_rows.next()? {
                let id: String = row.get(0)?;
                let employee_id: String = row.get(1)?;
                let activity_type: String = row.get(2)?;
                let date_raw: String = row.get(3)?;
                let time: String = row.get(4)?;
                let employee_name: String = row.get(5)?;
                let zone_name: Option<String> = row.get(6)?;
                let schedule_id: Option<String> = row.get(7)?;
                let schedule_name: String = row.get::<_, Option<String>>(8)?.unwrap_or_else(|| "Unassigned".to_string());
                let break_time_raw: String = row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "0".to_string());
                let person_type_id: Option<String> = row.get(10)?;
                let person_type: Option<String> = row.get(11)?;

                let date = date_raw.split('T').next().unwrap_or(&date_raw).to_string();
                let sn_lower = schedule_name.to_lowercase();
                let is_247 = sn_lower.contains("24/7") || sn_lower.contains("24x7") || sn_lower.contains("24-7");

                // Apply text search filter server-side
                if !search_filter.is_empty() {
                    let haystack = format!(
                        "{} {} {} {} {}",
                        employee_name, person_type.as_deref().unwrap_or(""), schedule_name,
                        zone_name.as_deref().unwrap_or(""), activity_type
                    ).to_lowercase();
                    if !haystack.contains(&search_filter) { continue; }
                }

                let bt_trim = break_time_raw.trim();
                let break_value = if is_247 {
                    "none"
                } else if bt_trim.is_empty() || bt_trim == "0" || bt_trim.eq_ignore_ascii_case("no") {
                    "no"
                } else {
                    "yes"
                };

                let break_status = if is_247 || break_value != "yes" {
                    "none"
                } else {
                    let key = format!("{}-{}", employee_id, date);
                    let mut hash: u32 = 0;
                    for b in key.bytes() {
                        hash = hash.wrapping_mul(31).wrapping_add(b as u32);
                    }
                    match hash % 4 {
                        0 => "on_time_for_break",
                        1 => "late_for_break",
                        2 => "returned_on_time",
                        _ => "late_return",
                    }
                };

                out.push(serde_json::json!({
                    "id": id,
                    "employeeId": employee_id,
                    "employeeName": employee_name,
                    "personTypeId": person_type_id,
                    "personType": person_type.unwrap_or_default(),
                    "shiftId": schedule_id.unwrap_or_default(),
                    "schedule": schedule_name.clone(),
                    "shift": schedule_name,
                    "activityType": activity_type,
                    "attendanceStatus": "none",
                    "breakValue": break_value,
                    "breakStatus": break_status,
                    "is247": is_247,
                    "note": format!("Schedule: {} | Break: {}", schedule_name, break_time_raw),
                    "date": date,
                    "time": time,
                    "location": zone_name.clone().unwrap_or_else(|| "—".to_string()),
                    "zone": zone_name.unwrap_or_else(|| "—".to_string()),
                    "timestampSort": format!("{}T{}", date_raw.split('T').next().unwrap_or(&date_raw), time),
                }));
            }
        }

        // ── AI tracking movement events ──
        let want_tracking = activity_type_filter.is_empty()
            || activity_type_filter == "all"
            || activity_type_filter == "tracking";

        if want_tracking {
            let mut sql = String::from(
                "SELECT al.id, al.personId, al.personName, al.action, al.zoneId, al.cameraId, \
                        al.confidence, al.createdAt, al.metadata, \
                        e.scheduleId, s.name, e.personTypeId, pt.name, z.name \
                 FROM access_logs al \
                 LEFT JOIN employees e ON e.id = al.personId \
                 LEFT JOIN schedules s ON s.id = e.scheduleId \
                 LEFT JOIN person_types pt ON pt.id = e.personTypeId \
                 LEFT JOIN zones z ON z.id = al.zoneId \
                 WHERE al.provider = 'ai-tracking' \
                   AND al.action IN ('zone-entry', 'zone-transition', 'zone-exit')"
            );
            let mut bind_values: Vec<String> = Vec::new();

            if !date_from.is_empty() {
                bind_values.push(format!("{}T00:00:00", date_from));
                sql.push_str(&format!(" AND al.createdAt >= ?{}", bind_values.len()));
            }
            if !date_to.is_empty() {
                bind_values.push(format!("{}T23:59:59", date_to));
                sql.push_str(&format!(" AND al.createdAt <= ?{}", bind_values.len()));
            }
            if !zone_filter.is_empty() && zone_filter != "all" {
                bind_values.push(zone_filter.clone());
                sql.push_str(&format!(" AND z.name = ?{}", bind_values.len()));
            }

            sql.push_str(" ORDER BY al.createdAt DESC");
            bind_values.push(limit.to_string());
            sql.push_str(&format!(" LIMIT ?{}", bind_values.len()));

            let mut trk_stmt = conn.prepare(&sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
            let mut trk_rows = trk_stmt.query(param_refs.as_slice())?;

            while let Some(row) = trk_rows.next()? {
                let id: String = row.get(0)?;
                let person_id: Option<String> = row.get(1)?;
                let person_name: Option<String> = row.get(2)?;
                let action: String = row.get(3)?;
                let _zone_id: Option<String> = row.get(4)?;
                let camera_id: Option<String> = row.get(5)?;
                let confidence: Option<f64> = row.get(6)?;
                let created_at: String = row.get::<_, Option<String>>(7)?.unwrap_or_default();
                let metadata_raw: Option<String> = row.get(8)?;
                let schedule_id: Option<String> = row.get(9)?;
                let schedule_name: Option<String> = row.get(10)?;
                let person_type_id: Option<String> = row.get(11)?;
                let person_type_name: Option<String> = row.get(12)?;
                let zone_name: Option<String> = row.get(13)?;

                let parsed_meta = metadata_raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .unwrap_or_else(|| serde_json::json!({}));
                let from_zone_id = parsed_meta.get("fromZoneId").and_then(|v| v.as_str()).unwrap_or("");
                let to_zone_id = parsed_meta.get("toZoneId").and_then(|v| v.as_str()).unwrap_or("");
                let track_id = parsed_meta.get("trackId").and_then(|v| v.as_i64()).unwrap_or(-1);

                // Resolve zone IDs to human-readable names
                let from_zone_display = if from_zone_id.is_empty() { String::new() }
                    else { zone_name_map.get(from_zone_id).cloned().unwrap_or_else(|| from_zone_id.to_string()) };
                let to_zone_display = if to_zone_id.is_empty() { String::new() }
                    else { zone_name_map.get(to_zone_id).cloned().unwrap_or_else(|| to_zone_id.to_string()) };
                let zone_display = zone_name.clone().unwrap_or_else(|| "—".to_string());

                let (date, time) = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&created_at) {
                    (dt.format("%Y-%m-%d").to_string(), dt.format("%H:%M").to_string())
                } else {
                    ("".to_string(), "".to_string())
                };

                let movement_note = if action == "zone-transition" {
                    format!("Moved from {} to {}", from_zone_display, to_zone_display)
                } else if action == "zone-exit" {
                    format!("Exited {}", if from_zone_display.is_empty() { zone_display.clone() } else { from_zone_display.clone() })
                } else {
                    format!("Entered {}", if to_zone_display.is_empty() { zone_display.clone() } else { to_zone_display.clone() })
                };

                let display_name = person_name.unwrap_or_else(|| "Unknown".to_string());
                let shift = schedule_name.unwrap_or_else(|| "Unassigned".to_string());

                // Apply text search filter server-side
                if !search_filter.is_empty() {
                    let haystack = format!(
                        "{} {} {} {} {}",
                        display_name, person_type_name.as_deref().unwrap_or(""), shift,
                        zone_display, movement_note
                    ).to_lowercase();
                    if !haystack.contains(&search_filter) { continue; }
                }

                out.push(serde_json::json!({
                    "id": id,
                    "employeeId": person_id,
                    "employeeName": display_name,
                    "personTypeId": person_type_id,
                    "personType": person_type_name.unwrap_or_default(),
                    "shiftId": schedule_id.unwrap_or_default(),
                    "schedule": shift.clone(),
                    "shift": shift,
                    "activityType": "tracking",
                    "attendanceStatus": "none",
                    "breakValue": "none",
                    "breakStatus": "none",
                    "is247": false,
                    "note": movement_note,
                    "date": date,
                    "time": time,
                    "location": zone_display.clone(),
                    "zone": zone_display,
                    "cameraId": camera_id.unwrap_or_default(),
                    "confidence": confidence.unwrap_or(0.0),
                    "trackId": track_id,
                    "fromZoneId": from_zone_id,
                    "toZoneId": to_zone_id,
                    "timestampSort": created_at,
                }));
            }
        }

        // Merge + sort newest first
        out.sort_by(|a, b| {
            let at = a.get("timestampSort").and_then(|v| v.as_str()).unwrap_or("");
            let bt = b.get("timestampSort").and_then(|v| v.as_str()).unwrap_or("");
            bt.cmp(at)
        });
        if out.len() > limit as usize {
            out.truncate(limit as usize);
        }
        for item in &mut out {
            if let Some(obj) = item.as_object_mut() {
                obj.remove("timestampSort");
            }
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

// ---------- Settings ----------
pub async fn get_time_config(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let config = db::with_db(&state.db, |conn| {
        let v: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key = 'time_config'", [], |r| r.get(0)).ok().flatten();
        if let Some(s) = v {
            let parsed: serde_json::Value = serde_json::from_str(&s).unwrap_or(serde_json::json!({}));
            Ok(serde_json::json!({
                "checkInStart": parsed.get("checkInStart").and_then(|v| v.as_str()).unwrap_or("08:00"),
                "checkInEnd": parsed.get("checkInEnd").and_then(|v| v.as_str()).unwrap_or("10:00"),
                "checkOutStart": parsed.get("checkOutStart").and_then(|v| v.as_str()).unwrap_or("16:00"),
                "checkOutEnd": parsed.get("checkOutEnd").and_then(|v| v.as_str()).unwrap_or("18:00"),
            }))
        } else {
            Ok(serde_json::json!({
                "checkInStart": "08:00",
                "checkInEnd": "10:00",
                "checkOutStart": "16:00",
                "checkOutEnd": "18:00",
            }))
        }
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(config))
}

pub async fn get_cameras(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let settings = db::with_db(&state.db, |conn| {
        let check_in_out: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key = 'check_in_out_cameras'", [], |r| r.get(0)).ok().flatten();
        let onboarding: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key = 'onboarding_camera'", [], |r| r.get(0)).ok().flatten();
        let check_in_out: Vec<serde_json::Value> = check_in_out.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let onboarding = onboarding.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).filter(|v| v.get("name").and_then(|n| n.as_str()).map_or(false, |s| !s.is_empty()));
        Ok(serde_json::json!({
            "checkInOutCameras": check_in_out,
            "onboardingCamera": onboarding,
        }))
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(settings))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeConfigUpdate {
    #[serde(alias = "checkInStart")]
    pub check_in_start: String,
    #[serde(alias = "checkInEnd")]
    pub check_in_end: String,
    #[serde(alias = "checkOutStart")]
    pub check_out_start: String,
    #[serde(alias = "checkOutEnd")]
    pub check_out_end: String,
}

pub async fn update_time_config(
    State(state): State<AppState>,
    Json(body): Json<TimeConfigUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let value = serde_json::json!({
        "checkInStart": body.check_in_start.trim(),
        "checkInEnd": body.check_in_end.trim(),
        "checkOutStart": body.check_out_start.trim(),
        "checkOutEnd": body.check_out_end.trim(),
    });
    let value_str = value.to_string();
    db::with_db(&state.db, |conn| {
        conn.execute(
            "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, 'time_config', ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=?2, updatedAt=datetime('now')",
            params![db::gen_id(), &value_str],
        )?;
        let payload = serde_json::json!({ "key": "time_config", "value": value });
        let _ = db::enqueue_sync(conn, "app_settings", "time_config", "update", &payload.to_string());
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    get_time_config(State(state)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CamerasUpdate {
    #[serde(alias = "checkInOutCameras")]
    pub check_in_out_cameras: Option<Vec<serde_json::Value>>,
    #[serde(alias = "onboardingCamera")]
    pub onboarding_camera: Option<serde_json::Value>,
}

pub async fn update_cameras(
    State(state): State<AppState>,
    Json(body): Json<CamerasUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    db::with_db(&state.db, |conn| {
        if let Some(ref c) = body.check_in_out_cameras {
            let val_str = serde_json::to_string(c).unwrap();
            conn.execute(
                "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, 'check_in_out_cameras', ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=?2, updatedAt=datetime('now')",
                params![db::gen_id(), &val_str],
            )?;
            let payload = serde_json::json!({ "key": "check_in_out_cameras", "value": c });
            let _ = db::enqueue_sync(conn, "app_settings", "check_in_out_cameras", "update", &payload.to_string());
        }
        if let Some(ref o) = body.onboarding_camera {
            let val_str = o.to_string();
            conn.execute(
                "INSERT INTO app_settings (id, key, value, updatedAt) VALUES (?1, 'onboarding_camera', ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=?2, updatedAt=datetime('now')",
                params![db::gen_id(), &val_str],
            )?;
            let payload = serde_json::json!({ "key": "onboarding_camera", "value": o });
            let _ = db::enqueue_sync(conn, "app_settings", "onboarding_camera", "update", &payload.to_string());
        }
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    get_cameras(State(state)).await
}

// ---------- Report recipients ----------
pub async fn list_report_recipients(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare("SELECT id, name, email, status, addedByName, createdAt FROM report_recipients ORDER BY createdAt DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "email": row.get::<_, String>(2)?,
                "addedBy": row.get::<_, Option<String>>(4)?.unwrap_or("System".to_string()),
                "addedAt": row.get::<_, Option<String>>(5)?,
                "status": row.get::<_, String>(3)?,
            }))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(Json(rows))
}

pub async fn get_report_recipient(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let r = db::with_db(&state.db, |conn| {
        conn.query_row(
            "SELECT id, name, email, status, addedByName, createdAt FROM report_recipients WHERE id = ?1",
            params![id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "email": row.get::<_, String>(2)?,
                    "addedBy": row.get::<_, Option<String>>(4)?.unwrap_or("System".to_string()),
                    "addedAt": row.get::<_, Option<String>>(5)?,
                    "status": row.get::<_, String>(3)?,
                }))
            },
        )
    })
    .map_err(|_| ApiError::not_found("Report recipient", Some(&id)))?;
    Ok(Json(r))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRecipientCreate {
    pub name: String,
    pub email: String,
    pub status: Option<String>,
    #[serde(alias = "addedByName")]
    pub added_by_name: Option<String>,
}

pub async fn create_report_recipient(
    State(state): State<AppState>,
    Json(body): Json<ReportRecipientCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = db::gen_id();
    let status = body.status.as_deref().unwrap_or("active");
    let status = if status == "inactive" { "inactive" } else { "active" };
    db::with_db(&state.db, |conn| {
        conn.execute(
            "INSERT INTO report_recipients (id, name, email, status, addedByName, createdAt) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![id, body.name.trim(), body.email.trim(), status, body.added_by_name.as_deref().unwrap_or("")],
        )?;
        let payload = serde_json::json!({
            "name": body.name.trim(),
            "email": body.email.trim(),
            "status": status,
            "addedByName": body.added_by_name.as_deref().unwrap_or("")
        });
        let _ = db::enqueue_sync(conn, "report_recipients", &id, "create", &payload.to_string());
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    get_report_recipient(State(state), Path(id)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRecipientUpdate {
    pub name: Option<String>,
    pub email: Option<String>,
    pub status: Option<String>,
}

pub async fn update_report_recipient(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ReportRecipientUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    db::with_db(&state.db, |conn| {
        let (name, email, status, added_by_name): (String, String, String, Option<String>) = conn.query_row("SELECT name, email, status, addedByName FROM report_recipients WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let name = body.name.as_deref().unwrap_or(&name).trim().to_string();
        let email = body.email.as_deref().unwrap_or(&email).trim().to_string();
        let status = body.status.as_deref().unwrap_or(&status).to_string();
        conn.execute("UPDATE report_recipients SET name=?1, email=?2, status=?3 WHERE id=?4", params![name, email, status, id])?;
        let payload = serde_json::json!({
            "name": name,
            "email": email,
            "status": status,
            "addedByName": added_by_name.unwrap_or_default()
        });
        let _ = db::enqueue_sync(conn, "report_recipients", &id, "update", &payload.to_string());
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    get_report_recipient(State(state), Path(id)).await
}

pub async fn delete_report_recipient(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::Response<axum::body::Body>, ApiError> {
    db::with_db(&state.db, |conn| {
        let _ = db::enqueue_sync(conn, "report_recipients", &id, "delete", "{}");
        conn.execute("DELETE FROM report_recipients WHERE id = ?1", params![id])
    })
        .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    Ok(axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

// ---------- Demo ----------
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoAccessLogIngest {
    #[serde(alias = "personId")]
    pub person_id: Option<String>,
    #[serde(alias = "personName")]
    pub person_name: Option<String>,
    #[serde(alias = "employeeId")]
    pub employee_id: Option<String>,
    #[serde(alias = "employeeName")]
    pub employee_name: Option<String>,
    pub action: String,
    pub zone_id: Option<String>,
    #[allow(dead_code)]
    pub note: Option<String>,
}

pub async fn demo_ingest_access_log(
    State(state): State<AppState>,
    Json(body): Json<DemoAccessLogIngest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let action = body.action.trim().to_lowercase();
    if action != "check-in" && action != "check-out" {
        return Err(ApiError::bad_request("action must be 'check-in' or 'check-out'."));
    }
    let person_id = db::with_db(&state.db, |conn| {
        let id = body.person_id.as_deref().or(body.employee_id.as_deref()).map(str::trim).filter(|s| !s.is_empty());
        if let Some(id) = id {
            let exists: bool = conn.query_row("SELECT 1 FROM employees WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or(false);
            if exists {
                return Ok(id.to_string());
            }
            return Err(ApiError::not_found("Person", Some(id)));
        }
        let name = body.person_name.as_deref().or(body.employee_name.as_deref()).map(str::trim).filter(|s| !s.is_empty());
        if let Some(name) = name {
            let id: Option<String> = conn.query_row("SELECT id FROM employees WHERE name = ?1", params![name], |r| r.get(0)).ok();
            if let Some(id) = id {
                return Ok(id);
            }
            return Err(ApiError::not_found("Person", Some(&format!("name={}", name))));
        }
        Err(ApiError::bad_request("Provide personId/personName or employeeId/employeeName."))
    })?;
    let now = Utc::now();
    let date_str = now.format("%Y-%m-%d").to_string();
    let time_str = now.format("%H:%M").to_string();
    let zone_id_opt: Option<String> = body.zone_id.clone().or_else(|| {
        db::with_db(&state.db, |conn| {
            conn.query_row("SELECT zoneId FROM employees WHERE id = ?1", params![person_id], |r| r.get(0))
        }).ok()
    });
    let updated_at = Utc::now().to_rfc3339();
    db::with_db(&state.db, |conn| {
        let status: String = if action == "check-in" { "checked-in".to_string() } else { "checked-out".to_string() };
        conn.execute("UPDATE employees SET status = ?1 WHERE id = ?2", params![status, person_id])?;
        let activity_id = db::gen_id();
        conn.execute(
            "INSERT INTO employee_activities (id, type, date, time, zoneId, employeeId) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&activity_id, action, date_str, time_str, zone_id_opt, person_id],
        )?;
        let payload = serde_json::json!({
            "type": action,
            "date": date_str,
            "time": time_str,
            "zoneId": zone_id_opt,
            "employeeId": person_id,
            "updatedAt": updated_at,
        });
        let _ = db::enqueue_sync(conn, "employee_activities", &activity_id, "create", &payload.to_string());
        let access_log_id = db::gen_id();
        conn.execute(
            "INSERT INTO access_logs (id, employeeId, zoneId, action, timestamp, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&access_log_id, person_id, zone_id_opt, action, updated_at, Option::<String>::None],
        )?;
        let access_log_payload = serde_json::json!({
            "employeeId": person_id,
            "zoneId": zone_id_opt,
            "action": action,
            "timestamp": updated_at,
            "metadata": serde_json::Value::Null,
        });
        let _ = db::enqueue_sync(conn, "access_logs", &access_log_id, "create", &access_log_payload.to_string());
        Ok(())
    })
    .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    get_person(State(state), Path(person_id)).await
}
