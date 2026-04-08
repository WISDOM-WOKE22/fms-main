//! RTSP URL builder with vendor-specific rules and validation.
//!
//! Supported vendors:
//! - **Hikvision**: `rtsp://{user}:{pass}@{ip}:{port}/Streaming/Channels/{ch}0{stream}`
//! - **Dahua**: `rtsp://{user}:{pass}@{ip}:{port}/cam/realmonitor?channel={ch}&subtype={sub}`
//! - **Generic**: raw `rtsp` field or `rtsp://{user}:{pass}@{ip}:{port}/{path}`

use serde::{Deserialize, Serialize};

/// Camera vendor identifier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CameraVendor {
    Hikvision,
    Dahua,
    Generic,
}

impl Default for CameraVendor {
    fn default() -> Self {
        Self::Generic
    }
}

/// Stream quality type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamType {
    Main,
    Sub,
}

impl Default for StreamType {
    fn default() -> Self {
        Self::Main
    }
}

/// DVR camera configuration used to build an RTSP URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DvrCameraConfig {
    pub vendor: Option<CameraVendor>,
    pub dvr_ip: Option<String>,
    pub rtsp_port: Option<u16>,
    pub channel_id: Option<u32>,
    pub stream_type: Option<StreamType>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub rtsp_path: Option<String>,
    /// Legacy raw RTSP URL (used as-is when provided with generic vendor).
    pub rtsp: Option<String>,
}

/// Typed validation/build errors.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtspBuildError {
    pub error_code: String,
    pub message: String,
}

impl RtspBuildError {
    fn missing(field: &str) -> Self {
        Self {
            error_code: format!("MISSING_{}", field.to_uppercase()),
            message: format!("{} is required", field),
        }
    }
    fn invalid(field: &str, reason: &str) -> Self {
        Self {
            error_code: format!("INVALID_{}", field.to_uppercase()),
            message: format!("{}: {}", field, reason),
        }
    }
}

/// Build an RTSP URL from the given DVR camera configuration.
///
/// Returns `Ok(url)` or `Err(build_error)`.
pub fn build_rtsp_url(cfg: &DvrCameraConfig) -> Result<String, RtspBuildError> {
    let vendor = cfg.vendor.clone().unwrap_or_default();

    match vendor {
        CameraVendor::Generic => build_generic(cfg),
        CameraVendor::Hikvision => build_hikvision(cfg),
        CameraVendor::Dahua => build_dahua(cfg),
    }
}

fn build_generic(cfg: &DvrCameraConfig) -> Result<String, RtspBuildError> {
    // If a raw rtsp URL is provided, use it directly.
    if let Some(ref raw) = cfg.rtsp {
        let raw = raw.trim();
        if !raw.is_empty() {
            return Ok(raw.to_string());
        }
    }
    // Otherwise build from parts.
    let ip = require_field(&cfg.dvr_ip, "dvrIp")?;
    let port = cfg.rtsp_port.unwrap_or(554);
    let path = cfg
        .rtsp_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("stream1");
    let auth = build_auth_segment(&cfg.username, &cfg.password);
    Ok(format!("rtsp://{}{}:{}/{}", auth, ip, port, path.trim_start_matches('/')))
}

fn build_hikvision(cfg: &DvrCameraConfig) -> Result<String, RtspBuildError> {
    let ip = require_field(&cfg.dvr_ip, "dvrIp")?;
    let port = cfg.rtsp_port.unwrap_or(554);
    let channel = cfg.channel_id.unwrap_or(1);
    if channel == 0 {
        return Err(RtspBuildError::invalid("channelId", "must be >= 1"));
    }
    let stream = match cfg.stream_type.as_ref().unwrap_or(&StreamType::Main) {
        StreamType::Main => 1,
        StreamType::Sub => 2,
    };
    // Hikvision format: /Streaming/Channels/{channel}0{stream}
    // e.g. channel 1 main = 101, channel 1 sub = 102, channel 2 main = 201
    let ch_code = format!("{}0{}", channel, stream);
    let auth = build_auth_segment(&cfg.username, &cfg.password);
    Ok(format!(
        "rtsp://{}{}:{}/Streaming/Channels/{}",
        auth, ip, port, ch_code
    ))
}

fn build_dahua(cfg: &DvrCameraConfig) -> Result<String, RtspBuildError> {
    let ip = require_field(&cfg.dvr_ip, "dvrIp")?;
    let port = cfg.rtsp_port.unwrap_or(554);
    let channel = cfg.channel_id.unwrap_or(1);
    if channel == 0 {
        return Err(RtspBuildError::invalid("channelId", "must be >= 1"));
    }
    let subtype = match cfg.stream_type.as_ref().unwrap_or(&StreamType::Main) {
        StreamType::Main => 0,
        StreamType::Sub => 1,
    };
    let auth = build_auth_segment(&cfg.username, &cfg.password);
    Ok(format!(
        "rtsp://{}{}:{}/cam/realmonitor?channel={}&subtype={}",
        auth, ip, port, channel, subtype
    ))
}

fn require_field(val: &Option<String>, name: &str) -> Result<String, RtspBuildError> {
    val.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| RtspBuildError::missing(name))
}

fn build_auth_segment(username: &Option<String>, password: &Option<String>) -> String {
    match (
        username.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        password.as_deref().filter(|s| !s.is_empty()),
    ) {
        (Some(u), Some(p)) => format!("{}:{}@", u, p),
        (Some(u), None) => format!("{}@", u),
        _ => String::new(),
    }
}

/// Mask credentials in an RTSP URL for safe logging/display.
///
/// Replaces `rtsp://user:pass@...` with `rtsp://user:****@...`
pub fn mask_rtsp_url(url: &str) -> String {
    if !url.starts_with("rtsp://") {
        return url.to_string();
    }
    let after_scheme = &url[7..]; // skip "rtsp://"
    if let Some(at_pos) = after_scheme.find('@') {
        let auth_part = &after_scheme[..at_pos];
        let rest = &after_scheme[at_pos..]; // includes '@'
        if let Some(colon) = auth_part.find(':') {
            let user = &auth_part[..colon];
            format!("rtsp://{}:****{}", user, rest)
        } else {
            // no password, just username
            url.to_string()
        }
    } else {
        url.to_string()
    }
}

/// Result of a camera connection test.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub rtsp_url_masked: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// Which test path produced this result: "python-frame-test" or "tcp-rtsp-fallback".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics_source: Option<String>,
    /// Target host:port that was tested (useful for firewall/policy troubleshooting).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics_target: Option<String>,
}

/// Test camera connection using the Python AI service's actual frame-read path.
/// This is authoritative: if Python can grab a frame, the AI worker will work too.
/// Falls back to TCP+RTSP OPTIONS if the Python service is unavailable.
pub async fn test_camera_connection(cfg: &DvrCameraConfig, ai_base_url: Option<&str>) -> ConnectionTestResult {
    let rtsp_url = match build_rtsp_url(cfg) {
        Ok(url) => url,
        Err(e) => {
            return ConnectionTestResult {
                ok: false,
                latency_ms: None,
                rtsp_url_masked: String::new(),
                error_code: Some(e.error_code),
                error_message: Some(e.message),
                diagnostics_source: None,
                diagnostics_target: None,
            };
        }
    };

    let masked = mask_rtsp_url(&rtsp_url);

    // Primary path: use Python AI service for a real frame-read test
    if let Some(base) = ai_base_url {
        let base = base.trim().trim_end_matches('/');
        if !base.is_empty() {
            match test_via_python(base, &rtsp_url, &masked).await {
                Some(result) => return result,
                None => {
                    tracing::warn!("[test-connection] Python AI service unavailable, falling back to TCP+RTSP test");
                }
            }
        }
    }

    // Fallback: TCP + RTSP OPTIONS check
    test_via_tcp_rtsp(&rtsp_url, &masked).await
}

/// Test via Python AI service: release stale capture, then grab a fresh frame.
async fn test_via_python(ai_base: &str, rtsp_url: &str, masked: &str) -> Option<ConnectionTestResult> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .ok()?;

    // Step 1: Release any stale capture for this URL so the test starts fresh
    let _ = client
        .post(format!("{}/release-rtsp", ai_base))
        .json(&serde_json::json!({ "rtspUrl": rtsp_url }))
        .send()
        .await;

    // Step 2: Call /test-camera — this does a real frame grab
    let start = std::time::Instant::now();
    let resp = match client
        .post(format!("{}/test-camera", ai_base))
        .json(&serde_json::json!({ "rtspUrl": rtsp_url, "asBase64": false }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return None, // Python service unreachable → fall back
    };

    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(_) => return None,
    };

    let latency = body
        .get("latencyMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(start.elapsed().as_millis() as u64);

    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    Some(ConnectionTestResult {
        ok,
        latency_ms: Some(latency),
        rtsp_url_masked: masked.to_string(),
        error_code: if ok { None } else { Some("FRAME_READ_FAILED".to_string()) },
        error_message: if ok {
            None
        } else {
            Some(
                body.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Cannot connect or read frame from camera")
                    .to_string(),
            )
        },
        diagnostics_source: Some("python-frame-test".to_string()),
        diagnostics_target: None,
    })
}

/// Fallback: TCP connect + RTSP OPTIONS handshake.
async fn test_via_tcp_rtsp(rtsp_url: &str, masked: &str) -> ConnectionTestResult {
    let (host, port) = match extract_host_port(rtsp_url) {
        Some(hp) => hp,
        None => {
            return ConnectionTestResult {
                ok: false,
                latency_ms: None,
                rtsp_url_masked: masked.to_string(),
                error_code: Some("INVALID_URL".to_string()),
                error_message: Some("Could not parse host/port from RTSP URL".to_string()),
                diagnostics_source: Some("tcp-rtsp-fallback".to_string()),
                diagnostics_target: None,
            };
        }
    };

    let start = std::time::Instant::now();
    let addr = format!("{}:{}", host, port);
    let timeout = std::time::Duration::from_secs(6);
    let source = Some("tcp-rtsp-fallback".to_string());

    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr)).await {
        Ok(Ok(stream)) => {
            let latency = start.elapsed().as_millis() as u64;
            let rtsp_ok = try_rtsp_options(stream, &host).await;
            if rtsp_ok {
                ConnectionTestResult {
                    ok: true,
                    latency_ms: Some(latency),
                    rtsp_url_masked: masked.to_string(),
                    error_code: None,
                    error_message: None,
                    diagnostics_source: source,
                    diagnostics_target: Some(addr),
                }
            } else {
                ConnectionTestResult {
                    ok: false,
                    latency_ms: Some(latency),
                    rtsp_url_masked: masked.to_string(),
                    error_code: Some("NOT_RTSP".to_string()),
                    error_message: Some("Port is open but does not appear to speak RTSP".to_string()),
                    diagnostics_source: source,
                    diagnostics_target: Some(addr),
                }
            }
        }
        Ok(Err(e)) => {
            let latency = start.elapsed().as_millis() as u64;
            let (code, msg) = classify_connect_error(&e);
            ConnectionTestResult {
                ok: false,
                latency_ms: Some(latency),
                rtsp_url_masked: masked.to_string(),
                error_code: Some(code),
                error_message: Some(msg),
                diagnostics_source: source,
                diagnostics_target: Some(addr),
            }
        }
        Err(_) => ConnectionTestResult {
            ok: false,
            latency_ms: Some(timeout.as_millis() as u64),
            rtsp_url_masked: masked.to_string(),
            error_code: Some("TIMEOUT".to_string()),
            error_message: Some("Connection timed out — camera may be unreachable".to_string()),
            diagnostics_source: source,
            diagnostics_target: Some(addr),
        },
    }
}

/// Send a minimal RTSP OPTIONS request and check for an RTSP response.
async fn try_rtsp_options(mut stream: tokio::net::TcpStream, host: &str) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let request = format!("OPTIONS rtsp://{}/ RTSP/1.0\r\nCSeq: 1\r\n\r\n", host);
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }

    let mut buf = [0u8; 512];
    match tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => {
            let response = String::from_utf8_lossy(&buf[..n]);
            response.contains("RTSP/1.0")
        }
        _ => false,
    }
}

fn extract_host_port(url: &str) -> Option<(String, u16)> {
    // rtsp://[user:pass@]host:port/path
    let after_scheme = url.strip_prefix("rtsp://")?;
    let after_auth = if let Some(at) = after_scheme.find('@') {
        &after_scheme[at + 1..]
    } else {
        after_scheme
    };
    let host_port = after_auth.split('/').next()?;
    let host_port = after_auth.split('?').next().unwrap_or(host_port);
    let host_port = host_port.split('/').next()?;

    if let Some(colon) = host_port.rfind(':') {
        let host = &host_port[..colon];
        let port: u16 = host_port[colon + 1..].parse().ok()?;
        Some((host.to_string(), port))
    } else {
        Some((host_port.to_string(), 554))
    }
}

fn classify_connect_error(e: &std::io::Error) -> (String, String) {
    // Windows WSAEACCES (10013): socket access denied by OS/firewall/policy.
    if e.raw_os_error() == Some(10013) {
        return (
            "SOCKET_ACCESS_FORBIDDEN".to_string(),
            "Socket access forbidden by OS/network policy (Windows 10013). Check firewall/endpoint security rules and allow outbound RTSP to the camera IP/port.".to_string(),
        );
    }
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => (
            "CONNECTION_REFUSED".to_string(),
            "Connection refused — RTSP service may not be running on this port".to_string(),
        ),
        std::io::ErrorKind::AddrNotAvailable => (
            "ADDR_NOT_AVAILABLE".to_string(),
            "Address not available — check the IP address".to_string(),
        ),
        std::io::ErrorKind::PermissionDenied => (
            "SOCKET_PERMISSION_DENIED".to_string(),
            "Socket access denied by OS permissions or security policy. Check firewall/endpoint security rules for this app and Python runtime.".to_string(),
        ),
        _ => (
            "CONNECTION_ERROR".to_string(),
            format!("Connection failed: {}", e),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hikvision_main_stream_channel_1() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Hikvision),
            dvr_ip: Some("192.168.1.100".into()),
            rtsp_port: None,
            channel_id: Some(1),
            stream_type: Some(StreamType::Main),
            username: Some("admin".into()),
            password: Some("pass123".into()),
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://admin:pass123@192.168.1.100:554/Streaming/Channels/101");
    }

    #[test]
    fn hikvision_sub_stream_channel_3() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Hikvision),
            dvr_ip: Some("10.0.0.5".into()),
            rtsp_port: Some(8554),
            channel_id: Some(3),
            stream_type: Some(StreamType::Sub),
            username: Some("admin".into()),
            password: Some("secret".into()),
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://admin:secret@10.0.0.5:8554/Streaming/Channels/302");
    }

    #[test]
    fn dahua_main_stream() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Dahua),
            dvr_ip: Some("192.168.1.200".into()),
            rtsp_port: None,
            channel_id: Some(2),
            stream_type: Some(StreamType::Main),
            username: Some("admin".into()),
            password: Some("dahua123".into()),
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://admin:dahua123@192.168.1.200:554/cam/realmonitor?channel=2&subtype=0");
    }

    #[test]
    fn dahua_sub_stream() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Dahua),
            dvr_ip: Some("192.168.1.200".into()),
            rtsp_port: None,
            channel_id: Some(1),
            stream_type: Some(StreamType::Sub),
            username: Some("admin".into()),
            password: Some("dahua123".into()),
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://admin:dahua123@192.168.1.200:554/cam/realmonitor?channel=1&subtype=1");
    }

    #[test]
    fn generic_raw_rtsp_passthrough() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Generic),
            dvr_ip: None,
            rtsp_port: None,
            channel_id: None,
            stream_type: None,
            username: None,
            password: None,
            rtsp_path: None,
            rtsp: Some("rtsp://custom:pass@10.0.0.1:554/live".into()),
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://custom:pass@10.0.0.1:554/live");
    }

    #[test]
    fn generic_from_parts() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Generic),
            dvr_ip: Some("192.168.1.50".into()),
            rtsp_port: Some(554),
            channel_id: None,
            stream_type: None,
            username: Some("user".into()),
            password: Some("pw".into()),
            rtsp_path: Some("live/ch1".into()),
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://user:pw@192.168.1.50:554/live/ch1");
    }

    #[test]
    fn generic_no_auth() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Generic),
            dvr_ip: Some("192.168.1.50".into()),
            rtsp_port: None,
            channel_id: None,
            stream_type: None,
            username: None,
            password: None,
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://192.168.1.50:554/stream1");
    }

    #[test]
    fn missing_dvr_ip_error() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Hikvision),
            dvr_ip: None,
            rtsp_port: None,
            channel_id: Some(1),
            stream_type: None,
            username: None,
            password: None,
            rtsp_path: None,
            rtsp: None,
        };
        let err = build_rtsp_url(&cfg).unwrap_err();
        assert_eq!(err.error_code, "MISSING_DVRIP");
    }

    #[test]
    fn hikvision_channel_zero_error() {
        let cfg = DvrCameraConfig {
            vendor: Some(CameraVendor::Hikvision),
            dvr_ip: Some("192.168.1.1".into()),
            rtsp_port: None,
            channel_id: Some(0),
            stream_type: None,
            username: None,
            password: None,
            rtsp_path: None,
            rtsp: None,
        };
        let err = build_rtsp_url(&cfg).unwrap_err();
        assert_eq!(err.error_code, "INVALID_CHANNELID");
    }

    #[test]
    fn mask_rtsp_url_with_password() {
        let masked = mask_rtsp_url("rtsp://admin:secret123@192.168.1.100:554/stream");
        assert_eq!(masked, "rtsp://admin:****@192.168.1.100:554/stream");
    }

    #[test]
    fn mask_rtsp_url_no_auth() {
        let masked = mask_rtsp_url("rtsp://192.168.1.100:554/stream");
        assert_eq!(masked, "rtsp://192.168.1.100:554/stream");
    }

    #[test]
    fn mask_rtsp_url_user_only() {
        let masked = mask_rtsp_url("rtsp://admin@192.168.1.100:554/stream");
        assert_eq!(masked, "rtsp://admin@192.168.1.100:554/stream");
    }

    #[test]
    fn extract_host_port_with_auth() {
        let (host, port) = extract_host_port("rtsp://admin:pass@192.168.1.100:554/stream").unwrap();
        assert_eq!(host, "192.168.1.100");
        assert_eq!(port, 554);
    }

    #[test]
    fn extract_host_port_no_auth() {
        let (host, port) = extract_host_port("rtsp://10.0.0.1:8554/live").unwrap();
        assert_eq!(host, "10.0.0.1");
        assert_eq!(port, 8554);
    }

    #[test]
    fn extract_host_port_default_port() {
        let (host, port) = extract_host_port("rtsp://192.168.1.1/stream").unwrap();
        assert_eq!(host, "192.168.1.1");
        assert_eq!(port, 554);
    }

    #[test]
    fn defaults_to_generic_when_no_vendor() {
        let cfg = DvrCameraConfig {
            vendor: None,
            dvr_ip: Some("192.168.1.1".into()),
            rtsp_port: None,
            channel_id: None,
            stream_type: None,
            username: None,
            password: None,
            rtsp_path: None,
            rtsp: None,
        };
        let url = build_rtsp_url(&cfg).unwrap();
        assert_eq!(url, "rtsp://192.168.1.1:554/stream1");
    }
}
