//! In-process HTTP API (replaces Python FastAPI sidecar).
//! Same routes and JSON contract as the Python backend.

mod error;
mod handlers;
mod license;
mod password;
pub mod rtsp;
pub mod state;
mod sync;

use axum::{
    response::{IntoResponse, Json},
    routing::{delete, get, post},
    Router,
};
use axum::http::StatusCode;
use std::net::SocketAddr;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use state::AppState;

/// Returns JSON 404 for unknown routes so the frontend always gets JSON.
async fn fallback_404() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "Not found",
            "code": "NOT_FOUND"
        })),
    )
}

#[allow(unused_imports)]
pub use error::ApiError;
pub use state::AppState as ApiState;

/// Build the API router and run the server on the given address.
/// Call this from a spawned thread so it doesn't block Tauri.
/// If `on_listening` is provided, it is called once the server has bound to the address (so the app can wait for readiness).
pub async fn run(
    state: AppState,
    addr: SocketAddr,
    on_listening: Option<Box<dyn FnOnce() + Send>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // When allow_credentials is true, browsers disallow wildcard (*) for headers/origin.
    // Use credentials false so we can allow all origins/headers for the local Tauri API.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_credentials(false);

    let app = Router::new()
        .route("/api/v1/ping", get(handlers::auth::ping))
        .route("/api/v1/auth/login", post(handlers::auth::login))
        .route("/api/v1/auth/me", get(handlers::auth::me))
        .route("/api/v1/config", get(handlers::auth::get_config))
        .route("/api/v1/health", get(handlers::auth::health))
        .route("/api/v1/onboarding/create-super-admin", post(handlers::onboarding::create_super_admin))
        .route("/api/v1/onboarding/complete", post(handlers::onboarding::complete_onboarding))
        .route("/api/v1/license", get(handlers::onboarding::get_license))
        .route("/api/v1/license/validate", post(handlers::onboarding::validate_license))
        .route("/api/v1/admins", get(handlers::admins::list_admins).post(handlers::admins::create_admin))
        .route("/api/v1/admins/:id", get(handlers::admins::get_admin).patch(handlers::admins::update_admin).delete(handlers::admins::delete_admin))
        .route("/api/v1/people", get(handlers::rest::list_people).post(handlers::rest::create_person))
        .route("/api/v1/people/:id", get(handlers::rest::get_person).patch(handlers::rest::update_person).delete(handlers::rest::delete_person))
        .route("/api/v1/people/:id/activities", get(handlers::rest::get_person_activities))
        .route("/api/v1/people/:id/check-in", post(handlers::rest::check_in))
        .route("/api/v1/people/:id/check-out", post(handlers::rest::check_out))
        .route("/api/v1/employees", get(handlers::rest::list_people).post(handlers::rest::create_person))
        .route("/api/v1/employees/:id", get(handlers::rest::get_person).patch(handlers::rest::update_person).delete(handlers::rest::delete_person))
        .route("/api/v1/employees/:id/activities", get(handlers::rest::get_person_activities))
        .route("/api/v1/employees/:id/check-in", post(handlers::rest::check_in))
        .route("/api/v1/employees/:id/check-out", post(handlers::rest::check_out))
        .route("/api/v1/employees/:id/face", get(handlers::face::get_person_face_status).post(handlers::face::register_person_face))
        .route("/api/v1/employees/:id/face-enrollment/send", post(handlers::face_enrollment::send_face_enrollment_link))
        .route("/api/v1/people/:id/face-enrollment/send", post(handlers::face_enrollment::send_face_enrollment_link))
        .route("/api/v1/public/face-enrollment/:token", get(handlers::face_enrollment::get_face_enrollment_session))
        .route("/api/v1/public/face-enrollment/:token/submit", post(handlers::face_enrollment::submit_face_enrollment))
        .route("/api/v1/people/:id/face", get(handlers::face::get_person_face_status).post(handlers::face::register_person_face))
        .route("/api/v1/face/recognize", post(handlers::face::recognize_face))
        .route("/api/v1/face/health", get(handlers::face::face_ai_health))
        .route("/api/v1/system-info", get(handlers::face::system_info))
        .route("/api/v1/system-stats", get(handlers::face::system_stats))
        .route("/api/v1/person-types", get(handlers::rest::list_person_types).post(handlers::rest::create_person_type))
        .route("/api/v1/person-types/:id", get(handlers::rest::get_person_type).patch(handlers::rest::update_person_type).delete(handlers::rest::delete_person_type))
        .route("/api/v1/zones", get(handlers::rest::list_zones).post(handlers::rest::create_zone))
        .route("/api/v1/zones/cameras/test-connection", post(handlers::rest::test_camera_connection))
        .route("/api/v1/zones/cameras/build-url", post(handlers::rest::build_camera_rtsp_url))
        // HLS camera streaming
        .route("/api/v1/streams/start", post(handlers::stream::stream_start))
        .route("/api/v1/streams/check-ffmpeg", get(handlers::stream::check_ffmpeg))
        .route("/api/v1/streams/:id/status", get(handlers::stream::stream_status))
        .route("/api/v1/streams/:id/stop", post(handlers::stream::stream_stop))
        .route("/api/v1/streams/:id/ai/toggle", post(handlers::stream::stream_ai_toggle))
        .route("/api/v1/streams/hls/:id/:filename", get(handlers::stream::serve_hls))
        // Always-on AI camera orchestration (independent from stream tester)
        .route("/api/v1/ai/cameras/start-all", post(handlers::camera_ai::start_all))
        .route("/api/v1/ai/cameras/stop-all", post(handlers::camera_ai::stop_all))
        .route("/api/v1/ai/cameras/status", get(handlers::camera_ai::status))
        .route("/api/v1/ai/cameras/:id/toggle", post(handlers::camera_ai::toggle))
        .route("/api/v1/zones/:id", get(handlers::rest::get_zone).patch(handlers::rest::update_zone).delete(handlers::rest::delete_zone))
        .route("/api/v1/schedules", get(handlers::rest::list_schedules).post(handlers::rest::create_schedule))
        .route("/api/v1/schedules/:id", get(handlers::rest::get_schedule).patch(handlers::rest::update_schedule).delete(handlers::rest::delete_schedule))
        .route("/api/v1/dashboard/stats", get(handlers::rest::dashboard_stats))
        .route("/api/v1/people-count/filters", get(handlers::rest::people_count_filters))
        .route("/api/v1/people-count/summary", get(handlers::rest::people_count_summary))
        .route("/api/v1/people-count/charts", get(handlers::rest::people_count_charts))
        .route("/api/v1/people-count/table", get(handlers::rest::people_count_table))
        .route("/api/v1/audit-logs", get(handlers::rest::list_audit_logs))
        .route("/api/v1/audit-logs/:id", get(handlers::rest::get_audit_log))
        .route("/api/v1/access-logs", get(handlers::rest::list_access_logs))
        .route("/api/v1/settings/time-config", get(handlers::rest::get_time_config).patch(handlers::rest::update_time_config))
        .route("/api/v1/settings/cameras", get(handlers::rest::get_cameras).patch(handlers::rest::update_cameras))
        .route("/api/v1/report-recipients", get(handlers::rest::list_report_recipients).post(handlers::rest::create_report_recipient))
        .route("/api/v1/report-recipients/:id", get(handlers::rest::get_report_recipient).patch(handlers::rest::update_report_recipient).delete(handlers::rest::delete_report_recipient))
        .route("/api/v1/demo/ingest-access-log", post(handlers::rest::demo_ingest_access_log))
        .route("/api/v1/sync/status", get(sync::sync_status))
        .route("/api/v1/sync/pending", get(sync::sync_pending))
        .route("/api/v1/sync/run", post(sync::sync_run))
        .fallback(fallback_404)
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("FMS API listening on {}", addr);
    if let Some(cb) = on_listening {
        cb();
    }
    axum::serve(listener, app).await?;
    Ok(())
}
