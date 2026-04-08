//! API error types and JSON responses matching Python backend.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug)]
pub struct ApiError {
    pub status_code: StatusCode,
    pub message: String,
    pub code: String,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status_code: StatusCode::BAD_REQUEST,
            message: message.into(),
            code: "BAD_REQUEST".to_string(),
        }
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status_code: StatusCode::UNAUTHORIZED,
            message: message.into(),
            code: "UNAUTHORIZED".to_string(),
        }
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status_code: StatusCode::FORBIDDEN,
            message: message.into(),
            code: "FORBIDDEN".to_string(),
        }
    }
    pub fn not_found(resource: &str, id: Option<&str>) -> Self {
        let message = id
            .map(|i| format!("{resource} with id '{i}' not found"))
            .unwrap_or_else(|| format!("{resource} not found"));
        Self {
            status_code: StatusCode::NOT_FOUND,
            message,
            code: "NOT_FOUND".to_string(),
        }
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status_code: StatusCode::CONFLICT,
            message: message.into(),
            code: "CONFLICT".to_string(),
        }
    }
    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status_code: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
            code: "SERVICE_UNAVAILABLE".to_string(),
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
    code: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status_code,
            Json(ErrorBody {
                error: self.message,
                code: self.code,
            }),
        )
            .into_response()
    }
}
