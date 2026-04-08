//! Admins CRUD.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use rusqlite::params;

use crate::api::error::ApiError;
use crate::api::password;
use crate::api::state::AppState;
use crate::db;

pub async fn list_admins(State(state): State<AppState>) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, email, role, status, permissions, createdAt, lastLoginAt FROM admins ORDER BY createdAt DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let perms: String = row.get(5)?;
            let perms: Vec<String> = serde_json::from_str(&perms).unwrap_or_default();
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "email": row.get::<_, String>(2)?,
                "role": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "permissions": perms,
                "createdAt": row.get::<_, Option<String>>(6)?,
                "lastLoginAt": row.get::<_, Option<String>>(7)?,
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

pub async fn get_admin(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let admin = db::with_db(&state.db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, email, role, status, permissions, createdAt, lastLoginAt FROM admins WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
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
    admin.ok_or_else(|| ApiError::not_found("Admin", Some(&id))).map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCreate {
    pub name: String,
    pub email: String,
    pub password: String,
    pub role: String,
    pub status: Option<String>,
    pub permissions: Vec<String>,
}

pub async fn create_admin(
    State(state): State<AppState>,
    Json(body): Json<AdminCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let email = body.email.trim().to_lowercase();
    let name = body.name.trim();
    let password_hash = password::hash_password(&body.password).map_err(|_| ApiError::bad_request("Invalid password"))?;
    let permissions = serde_json::to_string(&body.permissions).unwrap();
    let status = body.status.as_deref().unwrap_or("active");

    let id = db::with_db(&state.db, |conn| {
        let exists: bool = conn
            .query_row("SELECT 1 FROM admins WHERE email = ?1", params![email], |row| row.get(0))
            .unwrap_or(false);
        if exists {
            return Err(rusqlite::Error::InvalidQuery); // conflict
        }
        let id = db::gen_id();
        conn.execute(
            "INSERT INTO admins (id, name, email, role, status, permissions, password_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, email, body.role, status, permissions, password_hash],
        )?;
        let payload = serde_json::json!({
            "name": name,
            "email": email,
            "role": body.role,
            "status": status,
            "permissions": body.permissions
        });
        let _ = db::enqueue_sync(conn, "admins", &id, "create", &payload.to_string());
        Ok(id)
    })
    .map_err(|_| ApiError::conflict("An admin with this email already exists"))?;

    audit_log(&state, None, "admin", "create", Some(&id), "auditLogs.descAdminCreated", &serde_json::json!({ "_i18n": { "name": name } })).ok();
    get_admin(State(state), Path(id)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdate {
    pub name: Option<String>,
    pub email: Option<String>,
    pub role: Option<String>,
    pub status: Option<String>,
    pub permissions: Option<Vec<String>>,
}

pub async fn update_admin(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AdminUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let name = db::with_db(&state.db, |conn| {
        if let Some(ref email) = body.email {
            let count: i32 = conn.query_row(
                "SELECT COUNT(1) FROM admins WHERE email = ?1 AND id != ?2",
                params![email.trim().to_lowercase(), id],
                |row| row.get(0),
            )?;
            if count > 0 {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let (name, email, role, status, permissions): (String, String, String, String, String) = conn
            .query_row("SELECT name, email, role, status, permissions FROM admins WHERE id = ?1", params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
        let name = body.name.as_deref().unwrap_or(&name).trim().to_string();
        let email = body.email.as_ref().map(|s| s.trim().to_lowercase()).unwrap_or(email);
        let role = body.role.as_deref().unwrap_or(&role).to_string();
        let status = body.status.as_deref().unwrap_or(&status).to_string();
        let permissions = body
            .permissions
            .as_ref()
            .map(|p| serde_json::to_string(p).unwrap())
            .unwrap_or(permissions);
        conn.execute(
            "UPDATE admins SET name=?1, email=?2, role=?3, status=?4, permissions=?5 WHERE id=?6",
            params![name, email, role, status, permissions, id],
        )?;
        let perms: Vec<String> = serde_json::from_str(&permissions).unwrap_or_default();
        let payload = serde_json::json!({
            "name": name,
            "email": email,
            "role": role,
            "status": status,
            "permissions": perms
        });
        let _ = db::enqueue_sync(conn, "admins", &id, "update", &payload.to_string());
        Ok(name)
    });
    let name = name.map_err(|_| ApiError::conflict("An admin with this email already exists"))?;
    audit_log(&state, None, "admin", "update", Some(&id), "auditLogs.descAdminUpdated", &serde_json::json!({ "_i18n": { "name": name } })).ok();
    get_admin(State(state), Path(id)).await
}

pub async fn delete_admin(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::Response<axum::body::Body>, ApiError> {
    let name: String = db::with_db(&state.db, |conn| {
        conn.query_row("SELECT name FROM admins WHERE id = ?1", params![id], |row| row.get(0))
    })
    .map_err(|_| ApiError::not_found("Admin", Some(&id)))?;
    db::with_db(&state.db, |conn| {
        let _ = db::enqueue_sync(conn, "admins", &id, "delete", "{}");
        conn.execute("DELETE FROM admins WHERE id = ?1", params![id])
    })
        .map_err(|e: rusqlite::Error| ApiError::service_unavailable(e.to_string()))?;
    audit_log(&state, None, "admin", "delete", Some(&id), "auditLogs.descAdminDeleted", &serde_json::json!({ "_i18n": { "name": name } })).ok();
    Ok(axum::http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(axum::body::Body::empty())
        .unwrap())
}

fn audit_log(
    state: &AppState,
    _actor_id: Option<&str>,
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
