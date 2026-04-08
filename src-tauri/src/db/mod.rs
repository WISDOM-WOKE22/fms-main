//! SQLite database layer: connection, init, versioned migrations.
//! Schema matches Prisma/Python (camelCase columns where used there).
//! Migrations run on every app start and are applied in order.

use rusqlite::{Connection, params};
use serde_json::{json, Value as JsonValue};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub type DbPool = Arc<Mutex<Connection>>;

const APP_NAME: &str = "com.wisdom.fms-main";
const CURRENT_SCHEMA_VERSION: i32 = 16;

/// Platform-specific app data directory (writable, not inside bundle).
pub fn app_data_dir() -> std::io::Result<std::path::PathBuf> {
    let base = if cfg!(target_os = "macos") {
        dirs::data_dir().unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap_or_default())
    } else {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".local/share"))
    };
    let path = base.join(APP_NAME);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn default_db_path() -> std::io::Result<std::path::PathBuf> {
    Ok(app_data_dir()?.join("fms.db"))
}

/// Open or create DB, ensure migration tracking table exists, then run all pending migrations.
pub fn init(db_path: &Path) -> Result<DbPool, rusqlite::Error> {
    let parent = db_path.parent().unwrap_or(Path::new("."));
    let _ = std::fs::create_dir_all(parent);
    tracing::info!("Opening database at {}", db_path.display());
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    ensure_schema_version_table(&conn)?;
    run_pending_migrations(&conn)?;
    tracing::info!("Database ready");
    Ok(Arc::new(Mutex::new(conn)))
}

/// Create schema_version table if missing (for existing DBs created before versioned migrations).
fn ensure_schema_version_table(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY);",
    )?;
    let has_version: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_version LIMIT 1)",
        [],
        |row| row.get(0),
    )?;
    if !has_version {
        conn.execute("INSERT INTO schema_version (version) VALUES (0)", [])?;
    }
    Ok(())
}

fn get_schema_version(conn: &Connection) -> Result<i32, rusqlite::Error> {
    conn.query_row("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1", [], |r| r.get(0))
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM schema_version", [])?;
    conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![version])?;
    Ok(())
}

/// Run any pending schema migrations. Call before sync so local schema and tables are up to date.
pub fn ensure_migrations(pool: &DbPool) -> Result<(), rusqlite::Error> {
    let conn = pool.lock().expect("db pool");
    run_pending_migrations(&conn)
}

/// Run any migration whose number is greater than the current stored version.
fn run_pending_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    let mut current = get_schema_version(conn).unwrap_or(0);
    tracing::info!("Schema version: {}", current);
    while current < CURRENT_SCHEMA_VERSION {
        let next = current + 1;
        tracing::info!("Running migration {}", next);
        let tx = conn.unchecked_transaction()?;
        run_migration(&tx, next)?;
        set_schema_version(&tx, next)?;
        tx.commit()?;
        current = next;
        tracing::info!("Migration {} complete", next);
    }
    Ok(())
}

fn run_migration(conn: &rusqlite::Transaction, version: i32) -> Result<(), rusqlite::Error> {
    match version {
        1 => migration_001_initial_schema(conn),
        2 => migration_002_add_admin_password_hash(conn),
        3 => migration_003_add_employee_zone_assignment_columns(conn),
        4 => migration_004_sync_support(conn),
        5 => migration_005_person_types(conn),
        6 => migration_006_backfill_access_logs_sync(conn),
        7 => migration_007_shifts_person_type_id(conn),
        8 => migration_008_rename_shifts_to_schedules(conn),
        9 => migration_009_person_face_templates(conn),
        10 => migration_010_face_recognition_events(conn),
        11 => migration_011_drop_fk_face_recognition_events(conn),
        12 => migration_012_recognition_zone_columns(conn),
        13 => migration_013_zone_polygon_and_track_columns(conn),
        14 => migration_014_face_enrollment_profile_photo(conn),
        15 => migration_015_schedule_working_days(conn),
        16 => migration_016_access_logs_tracking_indexes(conn),
        _ => Ok(()),
    }
}

/// Migration 1: Initial schema (all core tables).
fn migration_001_initial_schema(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    #[allow(clippy::needless_raw_string_hashes)]
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS admins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            permissions TEXT NOT NULL,
            password_hash TEXT,
            createdAt TEXT,
            lastLoginAt TEXT
        );
        CREATE TABLE IF NOT EXISTS zones (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            cameraIds TEXT NOT NULL,
            createdBy TEXT NOT NULL,
            dateCreated TEXT
        );
        CREATE TABLE IF NOT EXISTS shifts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            breakTime TEXT NOT NULL,
            status TEXT NOT NULL,
            createdBy TEXT NOT NULL,
            createdAt TEXT
        );
        CREATE TABLE IF NOT EXISTS employees (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            department TEXT,
            status TEXT NOT NULL,
            isActive INTEGER NOT NULL DEFAULT 1,
            joinedDate TEXT NOT NULL,
            zoneId TEXT NOT NULL REFERENCES zones(id),
            shiftId TEXT NOT NULL REFERENCES shifts(id)
        );
        CREATE TABLE IF NOT EXISTS employee_activities (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            zoneId TEXT,
            employeeId TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS access_logs (
            id TEXT PRIMARY KEY,
            employeeId TEXT,
            zoneId TEXT,
            action TEXT NOT NULL,
            timestamp TEXT,
            metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            actorId TEXT,
            actorType TEXT,
            actorName TEXT,
            action TEXT NOT NULL,
            resource TEXT NOT NULL,
            resourceId TEXT,
            description TEXT,
            changes TEXT,
            timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL,
            updatedAt TEXT
        );
        CREATE TABLE IF NOT EXISTS report_recipients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            status TEXT NOT NULL,
            addedById TEXT,
            addedByName TEXT,
            createdAt TEXT
        );
        CREATE TABLE IF NOT EXISTS cameras (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );
        "#,
    )?;
    seed_demo_on_install(conn)?;
    Ok(())
}

/// Migration 2: Add password_hash to admins if missing (for DBs created before this column existed).
fn migration_002_add_admin_password_hash(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('admins') WHERE name = 'password_hash'",
        [],
        |row| row.get(0),
    )?;
    if count == 0 {
        conn.execute("ALTER TABLE admins ADD COLUMN password_hash TEXT", [])?;
    }
    Ok(())
}

/// Migration 4: Sync support — pending_sync queue, updatedAt on synced tables, sync cursor in app_settings.
fn migration_004_sync_support(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS pending_sync (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_sync_status ON pending_sync(sync_status);
        CREATE INDEX IF NOT EXISTS idx_pending_sync_created ON pending_sync(created_at);
        "#,
    )?;

    let add_col = |table: &str, col: &str, default: &str| -> Result<(), rusqlite::Error> {
        let count: i32 = conn.query_row(
            &format!(
                "SELECT COUNT(1) FROM pragma_table_info('{}') WHERE name = ?1",
                table
            ),
            [col],
            |row| row.get(0),
        )?;
        if count == 0 {
            conn.execute(
                &format!("ALTER TABLE {} ADD COLUMN {} {}", table, col, default),
                [],
            )?;
        }
        Ok(())
    };

    add_col("zones", "updatedAt", "TEXT")?;
    add_col("shifts", "updatedAt", "TEXT")?;
    add_col("employees", "updatedAt", "TEXT")?;
    add_col("employee_activities", "updatedAt", "TEXT")?;
    add_col("report_recipients", "updatedAt", "TEXT")?;
    add_col("admins", "updatedAt", "TEXT")?;
    add_col("admins", "createdAt", "TEXT")?;

    Ok(())
}

/// Migration 5: Person types (IFMS People module) and employees.personTypeId.
fn migration_005_person_types(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS person_types (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT,
            updated_at TEXT
        );
        "#,
    )?;
    let count: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('employees') WHERE name = 'personTypeId'",
        [],
        |row| row.get(0),
    )?;
    if count == 0 {
        conn.execute("ALTER TABLE employees ADD COLUMN personTypeId TEXT", [])?;
    }
    Ok(())
}

/// Migration 6: Backfill pending_sync with existing access_logs so they sync to cloud.
fn migration_006_backfill_access_logs_sync(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let mut select = conn.prepare(
        "SELECT id, employeeId, zoneId, action, timestamp, metadata FROM access_logs",
    )?;
    let rows = select.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut insert = conn.prepare(
        "INSERT INTO pending_sync (id, entity_type, entity_id, action, payload, created_at, sync_status, retry_count) VALUES (?1, 'access_logs', ?2, 'create', ?3, ?4, 'pending', 0)",
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    for row in rows {
        let (id, employee_id, zone_id, action, timestamp, metadata): (
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
        ) = row?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM pending_sync WHERE entity_type = 'access_logs' AND entity_id = ?1",
                params![&id],
                |r| r.get::<_, i32>(0),
            )
            .map(|_| true)
            .unwrap_or(false);
        if exists {
            continue;
        }
        let payload = json!({
            "employeeId": employee_id,
            "zoneId": zone_id,
            "action": action,
            "timestamp": timestamp.as_deref().unwrap_or(&now),
            "metadata": metadata.map(JsonValue::String).unwrap_or(JsonValue::Null),
        });
        let created_at = timestamp.as_deref().unwrap_or(&now);
        let pending_id = gen_id();
        insert.execute(params![
            pending_id,
            id,
            payload.to_string(),
            created_at,
        ])?;
    }
    Ok(())
}

/// Migration 7: Add personTypeId to shifts (for schedule table person type column).
fn migration_007_shifts_person_type_id(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('shifts') WHERE name = 'personTypeId'",
        [],
        |row| row.get(0),
    )?;
    if count == 0 {
        conn.execute("ALTER TABLE shifts ADD COLUMN personTypeId TEXT", [])?;
    }
    Ok(())
}

/// Migration 8: Rename shifts -> schedules, employees.shiftId -> scheduleId.
fn migration_008_rename_shifts_to_schedules(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shifts'")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if !tables.is_empty() {
        conn.execute("ALTER TABLE shifts RENAME TO schedules", [])?;
    }
    let has_shift_id: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('employees') WHERE name = 'shiftId'",
        [],
        |row| row.get(0),
    )?;
    if has_shift_id != 0 {
        conn.execute("ALTER TABLE employees RENAME COLUMN shiftId TO scheduleId", [])?;
    }
    Ok(())
}

/// Migration 9: Local person face template store (desktop-only AI registration persistence).
fn migration_009_person_face_templates(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS person_faces (
            id TEXT PRIMARY KEY,
            personId TEXT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
            imageBase64 TEXT NOT NULL,
            qualityScore REAL NOT NULL DEFAULT 0.0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_person_faces_personId ON person_faces(personId);
        "#,
    )?;
    Ok(())
}

/// Migration 10: Persist face recognition results for audit/troubleshooting.
fn migration_010_face_recognition_events(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS face_recognition_events (
            id TEXT PRIMARY KEY,
            personId TEXT REFERENCES employees(id) ON DELETE SET NULL,
            personName TEXT,
            status TEXT NOT NULL,
            score REAL NOT NULL DEFAULT 0.0,
            threshold REAL NOT NULL DEFAULT 0.5,
            provider TEXT NOT NULL DEFAULT 'python-local',
            rawResultJson TEXT NOT NULL,
            createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_createdAt ON face_recognition_events(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_personId ON face_recognition_events(personId);
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_status ON face_recognition_events(status);
        "#,
    )?;
    Ok(())
}

/// Migration 11: Recreate face_recognition_events WITHOUT the FK on personId.
/// Recognition events are an audit log — they must never fail to write because a
/// recognised personId was deleted from employees or is out-of-sync.
fn migration_011_drop_fk_face_recognition_events(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    // SQLite cannot ALTER TABLE to drop a FK, so we recreate the table.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS face_recognition_events_new (
            id TEXT PRIMARY KEY,
            personId TEXT,
            personName TEXT,
            status TEXT NOT NULL,
            score REAL NOT NULL DEFAULT 0.0,
            threshold REAL NOT NULL DEFAULT 0.5,
            provider TEXT NOT NULL DEFAULT 'python-local',
            rawResultJson TEXT NOT NULL,
            createdAt TEXT NOT NULL
        );
        INSERT OR IGNORE INTO face_recognition_events_new
            SELECT id, personId, personName, status, score, threshold, provider, rawResultJson, createdAt
            FROM face_recognition_events;
        DROP TABLE face_recognition_events;
        ALTER TABLE face_recognition_events_new RENAME TO face_recognition_events;
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_createdAt ON face_recognition_events(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_personId ON face_recognition_events(personId);
        CREATE INDEX IF NOT EXISTS idx_face_recognition_events_status ON face_recognition_events(status);
        "#,
    )?;
    Ok(())
}

/// Migration 12: Add zone/camera columns to recognition events; create access_logs
/// table for zone-aware activity logging from face recognition pipeline.
fn migration_012_recognition_zone_columns(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    // Add zone/camera columns to existing recognition events table
    let cols: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('face_recognition_events')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.contains("zoneId") {
        conn.execute_batch("ALTER TABLE face_recognition_events ADD COLUMN zoneId TEXT DEFAULT ''")?;
    }
    if !cols.contains("cameraId") {
        conn.execute_batch("ALTER TABLE face_recognition_events ADD COLUMN cameraId TEXT DEFAULT ''")?;
    }

    // Extend existing access_logs table (created in migration 1 with different columns)
    // with columns needed by the face recognition pipeline.
    let al_cols: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('access_logs')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if !al_cols.contains("personId") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN personId TEXT")?;
    }
    if !al_cols.contains("personName") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN personName TEXT")?;
    }
    if !al_cols.contains("cameraId") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN cameraId TEXT DEFAULT ''")?;
    }
    if !al_cols.contains("confidence") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN confidence REAL DEFAULT 0.0")?;
    }
    if !al_cols.contains("provider") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN provider TEXT DEFAULT 'ai-recognition'")?;
    }
    if !al_cols.contains("createdAt") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN createdAt TEXT")?;
    }
    // Safe indexes: only on columns guaranteed to exist
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_access_logs_createdAt ON access_logs(createdAt DESC)")?;
    Ok(())
}

/// Migration 13: Add zonePolygon column to zones for point-in-polygon zone checks,
/// and trackId column to face_recognition_events for stateful tracking.
fn migration_013_zone_polygon_and_track_columns(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    // zones.zonePolygon: JSON array of [x,y] coordinate pairs defining the zone boundary
    let zone_cols: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('zones')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if !zone_cols.contains("zonePolygon") {
        conn.execute_batch("ALTER TABLE zones ADD COLUMN zonePolygon TEXT")?;
    }

    // face_recognition_events: add trackId for ByteTrack correlation
    let fre_cols: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('face_recognition_events')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if !fre_cols.contains("trackId") {
        conn.execute_batch("ALTER TABLE face_recognition_events ADD COLUMN trackId INTEGER DEFAULT -1")?;
    }

    Ok(())
}

/// Profile photo (optional) and link-based face enrollment (token, status).
fn migration_014_face_enrollment_profile_photo(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let add_col = |col: &str, def: &str| -> Result<(), rusqlite::Error> {
        let count: i32 = conn.query_row(
            "SELECT COUNT(1) FROM pragma_table_info('employees') WHERE name = ?1",
            [col],
            |row| row.get(0),
        )?;
        if count == 0 {
            conn.execute(
                &format!("ALTER TABLE employees ADD COLUMN {} {}", col, def),
                [],
            )?;
        }
        Ok(())
    };
    add_col("profilePhotoData", "TEXT")?;
    add_col("faceEnrollmentStatus", "TEXT NOT NULL DEFAULT 'not_enrolled'")?;
    add_col("enrollmentToken", "TEXT")?;
    add_col("enrollmentTokenExpiresAt", "TEXT")?;
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_enrollment_token ON employees(enrollmentToken) WHERE enrollmentToken IS NOT NULL",
        [],
    );
    Ok(())
}

/// Migration 15: Add workingDays column to schedules for day-of-week configuration.
fn migration_015_schedule_working_days(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let count: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('schedules') WHERE name = 'workingDays'",
        [],
        |row| row.get(0),
    )?;
    if count == 0 {
        conn.execute("ALTER TABLE schedules ADD COLUMN workingDays TEXT", [])?;
    }
    Ok(())
}

/// Migration 16: Add composite indexes for the AI-tracking movement pipeline.
/// Speeds up the unified People Log query that filters on provider + action.
fn migration_016_access_logs_tracking_indexes(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_access_logs_provider_action ON access_logs(provider, action, createdAt DESC);
         CREATE INDEX IF NOT EXISTS idx_access_logs_personId ON access_logs(personId);"
    )?;
    // Ensure employeeId column exists (backfill from personId for tracking rows)
    let al_cols: std::collections::HashSet<String> = conn
        .prepare("SELECT name FROM pragma_table_info('access_logs')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if !al_cols.contains("updatedAt") {
        conn.execute_batch("ALTER TABLE access_logs ADD COLUMN updatedAt TEXT")?;
    }
    // Backfill employeeId from personId where missing
    conn.execute_batch(
        "UPDATE access_logs SET employeeId = personId WHERE employeeId IS NULL AND personId IS NOT NULL AND personId != ''"
    )?;
    Ok(())
}

fn migration_003_add_employee_zone_assignment_columns(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let zone_ids_exists: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('employees') WHERE name = 'zoneIds'",
        [],
        |row| row.get(0),
    )?;
    if zone_ids_exists == 0 {
        conn.execute("ALTER TABLE employees ADD COLUMN zoneIds TEXT NOT NULL DEFAULT '[]'", [])?;
    }

    let sub_zones_exists: i32 = conn.query_row(
        "SELECT COUNT(1) FROM pragma_table_info('employees') WHERE name = 'subZones'",
        [],
        |row| row.get(0),
    )?;
    if sub_zones_exists == 0 {
        conn.execute("ALTER TABLE employees ADD COLUMN subZones TEXT NOT NULL DEFAULT '[]'", [])?;
    }

    let mut stmt = conn.prepare("SELECT id, zoneId, zoneIds FROM employees")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;

    for row in rows {
        let (id, zone_id, zone_ids) = row?;
        let should_backfill = zone_ids
            .as_deref()
            .map(str::trim)
            .map(|value| value.is_empty() || value == "[]")
            .unwrap_or(true);
        if should_backfill {
            let payload = serde_json::to_string(&vec![zone_id]).unwrap_or_else(|_| "[]".to_string());
            conn.execute("UPDATE employees SET zoneIds = ?1 WHERE id = ?2", params![payload, id])?;
        }
    }

    Ok(())
}

fn seed_demo_on_install(conn: &rusqlite::Transaction) -> Result<(), rusqlite::Error> {
    let count: i32 = conn.query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    for (action, desc, changes) in [
        ("install", "Desktop application installed. Database initialized.", r#"{"event":"install","message":"Application installed and database created."}"#),
        ("started", "Application started after installation.", r#"{"event":"started","message":"Application started after installation."}"#),
    ] {
        conn.execute(
            "INSERT INTO audit_logs (id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp) VALUES (?1, NULL, 'system', 'FMS', ?2, 'system', NULL, ?3, ?4, ?5)",
            params![gen_id(), action, desc, changes, now],
        )?;
    }
    Ok(())
}

/// Generate a short CUID-like id (24 hex chars, same as Python).
pub fn gen_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..24].to_string()
}

/// Enqueue a change for sync to cloud. Call after create/update/delete of synced entities.
pub fn enqueue_sync(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload: &str,
) -> Result<(), rusqlite::Error> {
    let id = gen_id();
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO pending_sync (id, entity_type, entity_id, action, payload, created_at, sync_status, retry_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0)",
        params![id, entity_type, entity_id, action, payload, created_at],
    )?;
    Ok(())
}

/// Run a function with a DB connection (for use from async via spawn_blocking).
/// Recovers from mutex poison so a previous panic doesn't take down the API.
pub fn with_db<F, R>(pool: &DbPool, f: F) -> R
where
    F: FnOnce(&Connection) -> R,
{
    let guard = pool.lock().unwrap_or_else(|e| e.into_inner());
    f(&guard)
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo data seed (desktop-only; does NOT enqueue sync so data stays local)
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_ZONE_NAMES: &[&str] = &[
    "Main Building",
    "North Wing",
    "South Wing",
    "Warehouse A",
    "Reception & Lobby",
];
const DEMO_SHIFTS: &[(&str, &str, &str)] = &[
    ("Morning Shift", "06:00-14:00", "Yes | 09:30-10:00 (30 min)"),
    ("Day Shift", "08:00-16:00", "Yes | 12:00-13:00 (60 min)"),
    ("Afternoon Shift", "12:00-20:00", "Yes | 16:00-16:45 (45 min)"),
    ("Night Shift", "20:00-04:00", "No"),
    ("24/7 Coverage", "00:00-23:59", "Yes | Flexible (30 min)"),
];
const DEMO_FIRST: &[&str] = &[
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
    "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Charles", "Karen",
];
const DEMO_LAST: &[&str] = &[
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
];
const DEMO_DEPARTMENTS: &[&str] = &["Operations", "Security", "Facilities", "HR", "IT", "Reception", "Maintenance"];
const ADMIN_PERMISSIONS_ALL: &[&str] = &[
    "dashboard",
    "employees",
    "accessLogs",
    "auditLogs",
    "zones",
    "shifts",
    "admins",
    "reports",
];
const DEMO_ADMINS: &[(&str, &str, &str, &str, &[&str])] = &[
    (
        "Alex Morgan",
        "alex.morgan@company.com",
        "super_admin",
        "active",
        ADMIN_PERMISSIONS_ALL,
    ),
    (
        "Jordan Lee",
        "jordan.lee@company.com",
        "sub_admin",
        "active",
        &["dashboard", "employees", "zones", "shifts", "reports"],
    ),
    (
        "Samira Hassan",
        "samira.hassan@company.com",
        "sub_admin",
        "active",
        &["dashboard", "employees", "accessLogs", "auditLogs"],
    ),
    (
        "Chris Park",
        "chris.park@company.com",
        "sub_admin",
        "inactive",
        &["dashboard", "reports"],
    ),
];
const DEMO_REPORT_RECIPIENTS: &[(&str, &str, &str, &str)] = &[
    ("Finance Team", "finance@company.com", "active", "Alex Morgan"),
    ("HR Operations", "hr-ops@company.com", "active", "Jordan Lee"),
    ("Operations Lead", "ops.lead@company.com", "active", "Alex Morgan"),
    ("Compliance", "compliance@company.com", "inactive", "Samira Hassan"),
    (
        "Executive Summary",
        "exec-reports@company.com",
        "active",
        "Alex Morgan",
    ),
];

fn demo_sub_zones_for_location(location_name: &str) -> Vec<JsonValue> {
    let names: &[&str] = match location_name {
        "Main Building" => &["Ground Floor", "First Floor", "Second Floor"],
        "North Wing" => &["North Entrance", "North Offices"],
        "South Wing" => &["South Entrance", "South Offices"],
        "Warehouse A" => &["Storage Zone A1", "Storage Zone A2"],
        "Reception & Lobby" => &["Reception Desk", "Main Lobby"],
        _ => &["Zone 1", "Zone 2"],
    };
    names
        .iter()
        .enumerate()
        .map(|(idx, name)| {
            json!({
                "name": name,
                "ip": format!("192.168.10.{}", 10 + idx),
                "rtsp": format!("rtsp://192.168.10.{}/stream{}", 10 + idx, idx + 1)
            })
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct DemoSeedResult {
    pub person_types: u32,
    pub zones: u32,
    pub shifts: u32,
    pub employees: u32,
    pub activities: u32,
}

/// Seed demo data into the local desktop database only. Does NOT call enqueue_sync,
/// so this data stays on the device and is not pushed to the cloud.
pub fn seed_demo_data(conn: &Connection) -> Result<DemoSeedResult, rusqlite::Error> {
    let now = chrono::Utc::now();
    let now_iso = now.to_rfc3339();
    let mut result = DemoSeedResult {
        person_types: 0,
        zones: 0,
        shifts: 0,
        employees: 0,
        activities: 0,
    };

    // 1) Person types (if none)
    let pt_count: i32 = conn.query_row("SELECT COUNT(*) FROM person_types", [], |r| r.get(0))?;
    if pt_count == 0 {
        for name in ["Employee", "Contractor"] {
            conn.execute(
                "INSERT INTO person_types (id, name, description, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)",
                params![gen_id(), name, format!("Default: {}", name), now_iso],
            )?;
            result.person_types += 1;
        }
    }

    // 2) Zones (by name, skip if exists)
    for name in DEMO_ZONE_NAMES {
        let sub_zones_json = serde_json::to_string(&demo_sub_zones_for_location(name))
            .unwrap_or_else(|_| "[]".to_string());
        let exists: i32 = conn.query_row(
            "SELECT COUNT(1) FROM zones WHERE name = ?1",
            [name],
            |r| r.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO zones (id, name, status, cameraIds, createdBy, dateCreated) VALUES (?1, ?2, 'active', '[]', 'seed_demo', ?3)",
                params![gen_id(), name, now_iso],
            )?;
            conn.execute(
                "UPDATE zones SET cameraIds = ?1 WHERE name = ?2",
                params![sub_zones_json, name],
            )?;
            result.zones += 1;
        } else {
            // Keep demo locations refreshed with sub-zones even on existing databases.
            conn.execute(
                "UPDATE zones SET cameraIds = ?1 WHERE name = ?2",
                params![sub_zones_json, name],
            )?;
        }
    }

    let person_type_ids: Vec<String> = conn.prepare("SELECT id FROM person_types ORDER BY name")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let employee_pt_id = person_type_ids.first().map(String::as_str);
    let contractor_pt_id = person_type_ids.get(1).map(String::as_str).or(employee_pt_id);

    // 3) Schedules (upsert by name to keep demo data current)
    for (name, hours, break_time) in DEMO_SHIFTS {
        let person_type_id = match *name {
            "Night Shift" | "24/7 Coverage" => contractor_pt_id,
            _ => employee_pt_id,
        };
        let description = format!("Hours: {} | Seeded demo schedule", hours);
        let exists: i32 = conn.query_row(
            "SELECT COUNT(1) FROM schedules WHERE name = ?1",
            [name],
            |r| r.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO schedules (id, name, description, breakTime, status, createdBy, createdAt, personTypeId) VALUES (?1, ?2, ?3, ?4, 'active', 'seed_demo', ?5, ?6)",
                params![gen_id(), name, description, break_time, now_iso, person_type_id],
            )?;
            result.shifts += 1;
        } else {
            conn.execute(
                "UPDATE schedules SET description = ?1, breakTime = ?2, personTypeId = COALESCE(personTypeId, ?3), status = 'active' WHERE name = ?4",
                params![description, break_time, person_type_id, name],
            )?;
        }
    }

    // 4) Fetch IDs we need
    let zone_ids: Vec<String> = conn.prepare("SELECT id FROM zones ORDER BY id")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let zone_subzone_names: std::collections::HashMap<String, Vec<String>> = conn
        .prepare("SELECT id, cameraIds FROM zones")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(zone_id, raw)| {
            let names = serde_json::from_str::<Vec<JsonValue>>(&raw)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect::<Vec<_>>();
            (zone_id, names)
        })
        .collect();
    let schedule_rows: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, personTypeId FROM schedules ORDER BY name")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    if zone_ids.is_empty() || schedule_rows.is_empty() {
        return Ok(result);
    }
    let default_pt_id = person_type_ids.first().map(String::as_str).unwrap_or("");

    // 5) Employees: add up to 20 (only if we have fewer)
    let current_emp: i32 = conn.query_row("SELECT COUNT(*) FROM employees", [], |r| r.get(0))?;
    const MAX_EMPLOYEES: i32 = 20;
    let to_add = (MAX_EMPLOYEES - current_emp).max(0) as usize;
    for i in 0..to_add {
        let first = DEMO_FIRST[i % DEMO_FIRST.len()];
        let last = DEMO_LAST[i % DEMO_LAST.len()];
        let name = format!("{} {}", first, last);
        let zone_id = &zone_ids[i % zone_ids.len()];
        let chosen_pt = if person_type_ids.is_empty() {
            None
        } else if i % 4 == 0 {
            contractor_pt_id
        } else {
            employee_pt_id
        };
        let matching_schedules: Vec<&(String, Option<String>)> = schedule_rows
            .iter()
            .filter(|(_, pt)| pt.as_deref() == chosen_pt)
            .collect();
        let schedule_ref = if matching_schedules.is_empty() {
            &schedule_rows[i % schedule_rows.len()]
        } else {
            matching_schedules[i % matching_schedules.len()]
        };
        let shift_id = &schedule_ref.0;
        let zone_ids_json = format!("[\"{}\"]", zone_id);
        let sub_zone_name = zone_subzone_names
            .get(zone_id)
            .and_then(|list| if list.is_empty() { None } else { Some(list[i % list.len()].clone()) });
        let sub_zones_json = sub_zone_name
            .map(|sub_name| serde_json::to_string(&vec![json!({ "zoneId": zone_id, "name": sub_name })]).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or_else(|| "[]".to_string());
        let joined = now - chrono::Duration::days((30 + i as i64) * 2);
        let joined_date = joined.format("%Y-%m-%d").to_string();
        let email = format!("{}.{}@demo.example.com", first.to_lowercase(), last.to_lowercase());
        let phone = format!("+1555{:07}", 1000000 + i);
        let dept = DEMO_DEPARTMENTS[i % DEMO_DEPARTMENTS.len()];

        conn.execute(
            "INSERT INTO employees (id, name, email, phone, department, status, isActive, joinedDate, zoneId, scheduleId, personTypeId, zoneIds, subZones) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'checked-out', 1, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                gen_id(),
                name,
                email,
                phone,
                dept,
                joined_date,
                zone_id,
                shift_id,
                if default_pt_id.is_empty() {
                    chosen_pt
                } else {
                    chosen_pt.or(Some(default_pt_id))
                },
                zone_ids_json,
                sub_zones_json,
            ],
        )?;
        result.employees += 1;
    }

    // 5b) Seed admins used by admin screens (upsert by email, preserve password_hash).
    for (idx, (name, email, role, status, permissions)) in DEMO_ADMINS.iter().enumerate() {
        let permissions_json = serde_json::to_string(permissions).unwrap_or_else(|_| "[]".to_string());
        let created_at = (now - chrono::Duration::days((idx as i64 + 1) * 12)).to_rfc3339();
        let last_login_at = (now - chrono::Duration::hours((idx as i64 + 1) * 7)).to_rfc3339();
        let exists: i32 = conn.query_row(
            "SELECT COUNT(1) FROM admins WHERE LOWER(email) = LOWER(?1)",
            params![email],
            |r| r.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO admins (id, name, email, role, status, permissions, createdAt, lastLoginAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![gen_id(), name, email, role, status, permissions_json, created_at, last_login_at],
            )?;
        } else {
            conn.execute(
                "UPDATE admins SET name = ?1, role = ?2, status = ?3, permissions = ?4, createdAt = COALESCE(createdAt, ?5), lastLoginAt = ?6 WHERE LOWER(email) = LOWER(?7)",
                params![name, role, status, permissions_json, created_at, last_login_at, email],
            )?;
        }
    }

    // 5c) Seed report recipients used in Reports screens.
    for (idx, (name, email, status, added_by_name)) in DEMO_REPORT_RECIPIENTS.iter().enumerate() {
        let created_at = (now - chrono::Duration::days((idx as i64 + 1) * 10)).to_rfc3339();
        let exists: i32 = conn.query_row(
            "SELECT COUNT(1) FROM report_recipients WHERE LOWER(email) = LOWER(?1)",
            params![email],
            |r| r.get(0),
        )?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO report_recipients (id, name, email, status, addedByName, createdAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![gen_id(), name, email, status, added_by_name, created_at],
            )?;
        } else {
            conn.execute(
                "UPDATE report_recipients SET name = ?1, status = ?2, addedByName = ?3 WHERE LOWER(email) = LOWER(?4)",
                params![name, status, added_by_name, email],
            )?;
        }
    }

    let mut schedule_name_by_id = std::collections::HashMap::<String, String>::new();
    {
        let mut schedule_stmt = conn.prepare("SELECT id, name FROM schedules")?;
        let rows = schedule_stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, name) = row?;
            schedule_name_by_id.insert(id, name);
        }
    }

    let employees_for_logs: Vec<(String, Option<String>, Option<String>)> = conn
        .prepare("SELECT id, zoneId, scheduleId FROM employees ORDER BY id LIMIT ?1")?
        .query_map(params![MAX_EMPLOYEES], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if employees_for_logs.is_empty() {
        return Ok(result);
    }

    let mut exists_activity = conn.prepare(
        "SELECT COUNT(1) FROM employee_activities WHERE employeeId = ?1 AND date = ?2 AND type = ?3",
    )?;

    let schedule_windows = [
        ("Morning Shift", (5_u32, 50_u32), (14_u32, 0_u32)),
        ("Day Shift", (7_u32, 40_u32), (16_u32, 0_u32)),
        ("Afternoon Shift", (11_u32, 40_u32), (20_u32, 0_u32)),
        ("Night Shift", (19_u32, 40_u32), (4_u32, 0_u32)),
        ("24/7 Coverage", (8_u32, 0_u32), (17_u32, 0_u32)),
    ];

    let mut schedule_window_by_name = std::collections::HashMap::<&str, ((u32, u32), (u32, u32))>::new();
    for (name, in_t, out_t) in schedule_windows {
        schedule_window_by_name.insert(name, (in_t, out_t));
    }

    // 6) People log: last 14 days of check-in/check-out (no enqueue_sync)
    const DAYS_BACK: i64 = 14;
    for day_offset in 0..DAYS_BACK {
        let d = now - chrono::Duration::days(day_offset);
        let date_str = d.format("%Y-%m-%d").to_string();
        for (ei, (emp_id, zone_id, schedule_id)) in employees_for_logs.iter().enumerate() {
            let schedule_name = schedule_id
                .as_deref()
                .and_then(|id| schedule_name_by_id.get(id))
                .map(String::as_str)
                .unwrap_or("Day Shift");
            let ((check_in_h, check_in_m), (check_out_h, check_out_m)) = schedule_window_by_name
                .get(schedule_name)
                .copied()
                .unwrap_or(((7, 40), (16, 0)));

            let in_jitter = ((ei as i64 * 3 + day_offset) % 20) as u32;
            let out_jitter = ((ei as i64 * 5 + day_offset) % 31) as u32;
            let check_in_time = format!("{:02}:{:02}", check_in_h, (check_in_m + in_jitter) % 60);
            let check_out_time = format!("{:02}:{:02}", check_out_h, (check_out_m + out_jitter) % 60);

            let has_check_in: i32 = exists_activity.query_row(
                params![emp_id, date_str, "check-in"],
                |r| r.get(0),
            )?;
            if has_check_in == 0 {
                conn.execute(
                    "INSERT INTO employee_activities (id, type, date, time, zoneId, employeeId) VALUES (?1, 'check-in', ?2, ?3, ?4, ?5)",
                    params![gen_id(), date_str, check_in_time, zone_id.as_deref(), emp_id],
                )?;
                result.activities += 1;
            }

            let has_check_out: i32 = exists_activity.query_row(
                params![emp_id, date_str, "check-out"],
                |r| r.get(0),
            )?;
            if has_check_out == 0 {
                conn.execute(
                    "INSERT INTO employee_activities (id, type, date, time, zoneId, employeeId) VALUES (?1, 'check-out', ?2, ?3, ?4, ?5)",
                    params![gen_id(), date_str, check_out_time, zone_id.as_deref(), emp_id],
                )?;
                result.activities += 1;
            }
        }
    }

    // 7) Lightweight AI tracking events so Access Logs tracking tab is populated.
    let mut has_tracking_stmt = conn.prepare("SELECT COUNT(1) FROM access_logs WHERE provider = 'ai-tracking'")?;
    let existing_tracking: i32 = has_tracking_stmt.query_row([], |r| r.get(0))?;
    if existing_tracking == 0 {
        let mut employee_name_by_id = std::collections::HashMap::<String, String>::new();
        {
            let mut stmt = conn.prepare("SELECT id, name FROM employees")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (id, name) = row?;
                employee_name_by_id.insert(id, name);
            }
        }
        for (idx, (emp_id, zone_id, _)) in employees_for_logs.iter().take(8).enumerate() {
            let zone_id = zone_id.clone().unwrap_or_else(|| zone_ids[idx % zone_ids.len()].clone());
            let to_zone_id = zone_ids[(idx + 1) % zone_ids.len()].clone();
            let created_at = (now - chrono::Duration::minutes((idx as i64 + 1) * 17)).to_rfc3339();
            let person_name = employee_name_by_id
                .get(emp_id)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            let action = if idx % 3 == 0 {
                "zone-entry"
            } else if idx % 3 == 1 {
                "zone-transition"
            } else {
                "zone-exit"
            };
            let metadata = match action {
                "zone-transition" => json!({
                    "trackId": (idx as i64) + 1001,
                    "fromZoneId": zone_id,
                    "toZoneId": to_zone_id,
                    "source": "demo_seed"
                }),
                "zone-exit" => json!({
                    "trackId": (idx as i64) + 1001,
                    "fromZoneId": zone_id,
                    "source": "demo_seed"
                }),
                _ => json!({
                    "trackId": (idx as i64) + 1001,
                    "toZoneId": zone_id,
                    "source": "demo_seed"
                }),
            };
            conn.execute(
                "INSERT INTO access_logs (id, personId, personName, action, zoneId, cameraId, confidence, provider, metadata, createdAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ai-tracking', ?8, ?9)",
                params![
                    gen_id(),
                    emp_id,
                    person_name,
                    action,
                    zone_id,
                    format!("cam-{}", (idx % 4) + 1),
                    0.82_f64 + (idx as f64 * 0.01_f64),
                    metadata.to_string(),
                    created_at
                ],
            )?;
        }
    }

    // 8) Audit log entries covering major modules (skip if already sufficiently populated).
    let existing_audit: i32 = conn.query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))?;
    if existing_audit < 20 {
        let mut admin_ids: Vec<(String, String)> = conn
            .prepare("SELECT id, name FROM admins ORDER BY createdAt DESC, name ASC")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        if admin_ids.is_empty() {
            admin_ids.push((gen_id(), "System".to_string()));
        }
        let employee_ids: Vec<String> = conn
            .prepare("SELECT id FROM employees ORDER BY name LIMIT 5")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let zone_ids_for_audit: Vec<String> = conn
            .prepare("SELECT id FROM zones ORDER BY name LIMIT 5")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let schedule_ids_for_audit: Vec<String> = conn
            .prepare("SELECT id FROM schedules ORDER BY name LIMIT 5")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let recipient_ids: Vec<String> = conn
            .prepare("SELECT id FROM report_recipients ORDER BY createdAt DESC LIMIT 5")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let audit_templates: [(&str, &str, Option<&str>); 12] = [
            ("view", "dashboard", None),
            ("export", "access_logs", None),
            ("view", "audit", None),
            ("update", "employee", employee_ids.first().map(String::as_str)),
            ("create", "zone", zone_ids_for_audit.first().map(String::as_str)),
            ("update", "zone", zone_ids_for_audit.get(1).map(String::as_str)),
            ("create", "schedule", schedule_ids_for_audit.first().map(String::as_str)),
            ("update", "schedule", schedule_ids_for_audit.get(1).map(String::as_str)),
            ("create", "report_recipient", recipient_ids.first().map(String::as_str)),
            ("view", "reports", None),
            ("update", "settings", None),
            ("login", "auth", None),
        ];

        for (idx, (action, resource, resource_id)) in audit_templates.iter().enumerate() {
            let (actor_id, actor_name) = &admin_ids[idx % admin_ids.len()];
            let ts = (now - chrono::Duration::minutes((idx as i64 + 1) * 9)).to_rfc3339();
            let changes = json!({
                "_i18n": {
                    "module": resource,
                    "seeded": true
                }
            })
            .to_string();
            conn.execute(
                "INSERT INTO audit_logs (id, actorId, actorType, actorName, action, resource, resourceId, description, changes, timestamp) VALUES (?1, ?2, 'admin', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    gen_id(),
                    actor_id,
                    actor_name,
                    action,
                    resource,
                    resource_id,
                    format!("seed.demo.{}.{}", resource, action),
                    changes,
                    ts
                ],
            )?;
        }
    }

    Ok(result)
}
