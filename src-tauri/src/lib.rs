mod api;
mod db;

use std::net::SocketAddr;
use tauri::Manager;
use std::sync::Arc;
use std::time::Duration;
use crate::api::ApiState;
use crate::api::state::AppConfig;
use crate::db::DbPool;
use serde::Deserialize;

/// Port the in-process API server is bound to (set at startup).
pub struct ApiPort(u16);

#[tauri::command]
fn get_api_port(state: tauri::State<ApiPort>) -> u16 {
    state.0
}

/// Seed demo data into the local desktop database only. Data is NOT synced to the cloud.
#[tauri::command]
fn seed_demo_data(pool: tauri::State<DbPool>) -> Result<db::DemoSeedResult, String> {
    db::with_db(&pool, |conn| db::seed_demo_data(conn)).map_err(|e| e.to_string())
}

fn find_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind for free port")
        .local_addr()
        .expect("local_addr")
        .port()
}

/// Initialize console logging so all backend activity is visible in the terminal.
fn init_console_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,fms_main=info,fms_main_lib=info,tower_http=info".into()),
        )
        .with_target(true)
        .with_thread_ids(false)
        .with_writer(std::io::stderr)
        .try_init();
}

#[derive(Debug, Deserialize, Default)]
struct BuildConfig {
    #[serde(default)]
    #[serde(rename = "FMS_EMAIL")]
    fms_email: String,
    #[serde(default)]
    #[serde(rename = "FMS_PASSWORD")]
    fms_password: String,
    #[serde(default)]
    #[serde(rename = "FMS_LICENSE_KEY")]
    fms_license_key: String,
    #[serde(default)]
    #[serde(rename = "FMS_MAIN_BACKEND_URL")]
    fms_main_backend_url: String,
    #[serde(default)]
    #[serde(rename = "FMS_LICENSE_PUBLIC_KEY_PEM")]
    fms_license_public_key_pem: String,
    #[serde(default)]
    #[serde(rename = "FMS_LICENSE_ISSUER")]
    fms_license_issuer: String,
    #[serde(default)]
    #[serde(rename = "FMS_COMPANY_NAME")]
    fms_company_name: String,
    #[serde(default)]
    #[serde(rename = "FMS_COMPANY_IMAGE")]
    fms_company_image: String,
    #[serde(default)]
    #[serde(rename = "FMS_SUPER_ADMIN_NAME")]
    fms_super_admin_name: String,
    #[serde(default)]
    #[serde(rename = "FMS_LOCAL_AI_URL")]
    fms_local_ai_url: String,
    #[serde(default)]
    #[serde(rename = "FMS_ENV")]
    fms_env: String,
    #[serde(default)]
    #[serde(rename = "FMS_ALLOW_DEV_LICENSE_FALLBACK")]
    fms_allow_dev_license_fallback: String,
    #[serde(default)]
    #[serde(rename = "FMS_LICENSE_KEY_VERIFICATION_ENABLED")]
    fms_license_key_verification_enabled: String,
}

fn load_config(app: &tauri::App) -> AppConfig {
    let mut config = AppConfig::default();
    config.license_issuer = "fms-main-backend".to_string();
    config.license_key_verification_enabled = true; // default: cloud verification on
    use tauri::path::BaseDirectory;

    // 1. Load from bundled resource (production): try both path variants.
    // Keep reading even after a match so .env/system env can override bundled defaults.
    let candidates = ["resources/config.json", "config.json"];
    for path_str in &candidates {
        if let Ok(config_path) = app.path().resolve(path_str, BaseDirectory::Resource) {
            if config_path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(build_config) = serde_json::from_str::<BuildConfig>(&content) {
                        tracing::info!("Loaded config from resource: {}", path_str);
                        config.email = build_config.fms_email.trim().to_lowercase();
                        config.password = build_config.fms_password;
                        config.license_key = build_config.fms_license_key.trim().to_string();
                        config.main_backend_url = build_config.fms_main_backend_url.trim().to_string();
                        config.license_public_key_pem = build_config.fms_license_public_key_pem.trim().to_string();
                        if !build_config.fms_license_issuer.trim().is_empty() {
                            config.license_issuer = build_config.fms_license_issuer.trim().to_string();
                        }
                        config.company_name = build_config.fms_company_name.trim().to_string();
                        config.company_image = build_config.fms_company_image.trim().to_string();
                        config.super_admin_name = build_config.fms_super_admin_name.trim().to_string();
                        config.local_ai_url = build_config.fms_local_ai_url.trim().to_string();
                        if !build_config.fms_env.trim().is_empty() {
                            config.app_env = build_config.fms_env.trim().to_string();
                        }
                        config.allow_dev_license_fallback = matches!(
                            build_config.fms_allow_dev_license_fallback.trim().to_ascii_lowercase().as_str(),
                            "true" | "1" | "yes"
                        );
                        // Only override if explicitly set in config (empty = keep default true)
                        let vstr = build_config.fms_license_key_verification_enabled.trim().to_ascii_lowercase();
                        if !vstr.is_empty() {
                            config.license_key_verification_enabled = matches!(vstr.as_str(), "true" | "1" | "yes");
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback: .env or system environment (dev and release)
    let _ = dotenvy::dotenv();
    // Bundled app: also try .env next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let env_path = exe_dir.join(".env");
            if env_path.is_file() {
                let _ = dotenvy::from_path(&env_path);
            }
        }
    }
    if let Ok(v) = std::env::var("FMS_EMAIL") {
        config.email = v.trim().to_lowercase();
    }
    if let Ok(v) = std::env::var("FMS_PASSWORD") {
        config.password = v;
    }
    if let Ok(v) = std::env::var("FMS_LICENSE_KEY") {
        config.license_key = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_MAIN_BACKEND_URL") {
        config.main_backend_url = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_LICENSE_PUBLIC_KEY_PEM") {
        config.license_public_key_pem = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_LICENSE_ISSUER") {
        if !v.trim().is_empty() {
            config.license_issuer = v.trim().to_string();
        }
    }
    if let Ok(v) = std::env::var("FMS_COMPANY_NAME") {
        config.company_name = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_COMPANY_IMAGE") {
        config.company_image = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_SUPER_ADMIN_NAME") {
        config.super_admin_name = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_LOCAL_AI_URL") {
        config.local_ai_url = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_ENV") {
        config.app_env = v.trim().to_string();
    }
    if let Ok(v) = std::env::var("FMS_ALLOW_DEV_LICENSE_FALLBACK") {
        config.allow_dev_license_fallback = matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes"
        );
    }
    if let Ok(v) = std::env::var("FMS_LICENSE_KEY_VERIFICATION_ENABLED") {
        config.license_key_verification_enabled = matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes"
        );
    }
    if config.local_ai_url.trim().is_empty() {
        config.local_ai_url = "http://127.0.0.1:8000".to_string();
    }
    // Default app_env to "development" when not set
    if config.app_env.trim().is_empty() {
        config.app_env = "development".to_string();
    }

    if config.email.is_empty() {
        tracing::error!("CRITICAL: No FMS_EMAIL configured. Set in .env or bundle resources/config.json.");
    }

    config
}

fn start_local_ai_service(app: &tauri::App, config: &mut crate::api::state::AppConfig) {
    if !config.local_ai_url.contains("127.0.0.1") && !config.local_ai_url.contains("localhost") {
        return; // Remote AI, do not auto-start
    }

    let configured_port = config
        .local_ai_url
        .split(':')
        .last()
        .unwrap_or("8000")
        .trim_matches('/')
        .parse::<u16>()
        .unwrap_or(8000);
    let chosen_port = match std::net::TcpListener::bind(("127.0.0.1", configured_port)) {
        Ok(listener) => {
            drop(listener);
            configured_port
        }
        Err(_) => {
            let fallback_listener =
                std::net::TcpListener::bind(("127.0.0.1", 0)).expect("allocate local ai port");
            let fallback_port = fallback_listener
                .local_addr()
                .map(|a| a.port())
                .unwrap_or(8000);
            drop(fallback_listener);
            tracing::warn!(
                "Configured local AI port {} is busy; switching to random free port {}",
                configured_port,
                fallback_port
            );
            fallback_port
        }
    };
    let port = chosen_port.to_string();
    config.local_ai_url = format!("http://127.0.0.1:{}", chosen_port);

    let res_dir = app.path().resolve("resources/ai-python", tauri::path::BaseDirectory::Resource);
    let dev_dir = std::env::current_dir().map(|cwd| cwd.join("src-tauri").join("resources").join("ai-python"));

    let mut target_dir = None;
    if let Ok(p) = res_dir {
        if p.exists() {
            target_dir = Some(p);
        }
    }
    if target_dir.is_none() {
        if let Ok(p) = dev_dir {
            if p.exists() {
                target_dir = Some(p);
            }
        }
    }
    if target_dir.is_none() {
        let alt = std::env::current_dir().unwrap_or_default().join("resources/ai-python");
        if alt.exists() {
            target_dir = Some(alt);
        }
    }

    let Some(ai_dir) = target_dir else {
        tracing::warn!("Could not locate ai-python directory to auto-start service");
        return;
    };

    tracing::info!("Preparing local AI service from {:?}", ai_dir);

    // Run the entire setup (venv creation, pip install, uvicorn start) in a background thread
    // so the app is not blocked during dependency installation.
    std::thread::spawn(move || {
        // Keep venv outside source tree to avoid dev-watch rebuild loops.
        let venv_dir = crate::db::app_data_dir()
            .map(|p| p.join("ai-python-venv"))
            .unwrap_or_else(|_| ai_dir.join(".venv"));
        let venv_python = venv_dir.join("bin").join("python");
        let venv_python_win = venv_dir.join("Scripts").join("python.exe");
        let venv_pip = venv_dir.join("bin").join("pip");
        let venv_pip_win = venv_dir.join("Scripts").join("pip.exe");

        /// Apply Windows-specific flags to prevent console window creation.
        /// On Windows, spawning a console app (Python) from a GUI app without
        /// these flags creates a visible console window and can cause invalid
        /// stdio handles that crash/hang the child process.
        #[allow(unused_variables)]
        fn configure_cmd_for_platform(cmd: &mut std::process::Command) {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
        }

        // Step 1: Create .venv if it doesn't exist
        if !venv_python.exists() && !venv_python_win.exists() {
            tracing::info!("Creating Python virtual environment at {:?}", venv_dir);
            let venv_target = venv_dir.to_string_lossy().to_string();
            let attempts: Vec<(&str, Vec<String>)> = vec![
                (
                    "python3",
                    vec!["-m".to_string(), "venv".to_string(), venv_target.clone()],
                ),
                (
                    "python",
                    vec!["-m".to_string(), "venv".to_string(), venv_target.clone()],
                ),
                (
                    "py",
                    vec![
                        "-3".to_string(),
                        "-m".to_string(),
                        "venv".to_string(),
                        venv_target.clone(),
                    ],
                ),
                (
                    "py",
                    vec!["-m".to_string(), "venv".to_string(), venv_target.clone()],
                ),
            ];

            let mut created = false;
            for (bin, args) in attempts {
                let rendered = format!("{} {}", bin, args.join(" "));
                let mut cmd = std::process::Command::new(bin);
                cmd.args(args.iter().map(String::as_str))
                    .current_dir(&ai_dir)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped());
                configure_cmd_for_platform(&mut cmd);
                match cmd.output()
                {
                    Ok(output) if output.status.success() => {
                        tracing::info!("Virtual environment created successfully using {}", rendered);
                        created = true;
                        break;
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        tracing::warn!("Venv creation attempt failed ({}): {}", rendered, stderr);
                    }
                    Err(e) => {
                        tracing::warn!("Venv creation launcher unavailable ({}): {}", rendered, e);
                    }
                }
            }

            if !created && !venv_python.exists() && !venv_python_win.exists() {
                tracing::error!(
                    "Failed to create Python virtual environment. Tried python3/python/py launchers."
                );
                return;
            }
        }

        let py_bin = if venv_python.exists() {
            venv_python.to_string_lossy().to_string()
        } else if venv_python_win.exists() {
            venv_python_win.to_string_lossy().to_string()
        } else {
            tracing::error!("No python binary found in venv after creation attempt");
            return;
        };

        let pip_bin = if venv_pip.exists() {
            venv_pip.to_string_lossy().to_string()
        } else if venv_pip_win.exists() {
            venv_pip_win.to_string_lossy().to_string()
        } else {
            // Fallback: use python -m pip
            py_bin.clone()
        };

        // Step 2: Install dependencies from requirements.txt
        let requirements = ai_dir.join("requirements.txt");
        if requirements.exists() {
            let stamp_file = venv_dir.join(".deps-installed");
            let req_mtime = std::fs::metadata(&requirements)
                .ok()
                .and_then(|m| m.modified().ok());
            let stamp_mtime = std::fs::metadata(&stamp_file)
                .ok()
                .and_then(|m| m.modified().ok());
            let deps_need_install = match (req_mtime, stamp_mtime) {
                (Some(req), Some(stamp)) => req > stamp,
                _ => true,
            };

            if deps_need_install {
                tracing::info!("Installing AI service dependencies from requirements.txt...");
                let install_result = if pip_bin == py_bin {
                    // Use python -m pip
                    let mut cmd = std::process::Command::new(&py_bin);
                    cmd.args(["-m", "pip", "install", "-r", requirements.to_string_lossy().as_ref(), "--quiet"])
                        .current_dir(&ai_dir)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::piped());
                    configure_cmd_for_platform(&mut cmd);
                    cmd.output()
                } else {
                    let mut cmd = std::process::Command::new(&pip_bin);
                    cmd.args(["install", "-r", requirements.to_string_lossy().as_ref(), "--quiet"])
                        .current_dir(&ai_dir)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::piped());
                    configure_cmd_for_platform(&mut cmd);
                    cmd.output()
                };
                match install_result {
                    Ok(output) if output.status.success() => {
                        let _ = std::fs::write(&stamp_file, b"ok");
                        tracing::info!("AI service dependencies installed successfully");
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        tracing::error!("pip install failed: {}", stderr);
                        return;
                    }
                    Err(e) => {
                        tracing::error!("Failed to run pip install: {}", e);
                        return;
                    }
                }
            } else {
                tracing::info!("AI dependencies already installed, skipping pip install");
            }
        }

        // Step 3: Start uvicorn
        // Tell the AI service to store faces.db in the app-data directory,
        // NOT inside the source tree.  Writing inside src-tauri/ triggers
        // the Tauri dev file-watcher which rebuilds + restarts the app.
        let ai_data_dir = crate::db::app_data_dir()
            .map(|p| p.join("ai-data"))
            .unwrap_or_else(|_| ai_dir.clone());
        let _ = std::fs::create_dir_all(&ai_data_dir);

        // Write AI service logs to a file for debugging (especially on Windows
        // where there's no visible console output).
        let log_path = ai_data_dir.join("ai-service.log");
        let stderr_cfg = std::fs::File::create(&log_path)
            .map(std::process::Stdio::from)
            .unwrap_or_else(|_| std::process::Stdio::null());

        tracing::info!("Starting local AI service on port {} using {} (data dir: {:?}, log: {:?})", port, py_bin, ai_data_dir, log_path);
        let mut cmd = std::process::Command::new(&py_bin);
        cmd.current_dir(&ai_dir)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("FMS_AI_DATA_DIR", ai_data_dir.to_string_lossy().as_ref())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(stderr_cfg)
            .arg("-m")
            .arg("uvicorn")
            .arg("ai_service:app")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(&port);
        configure_cmd_for_platform(&mut cmd);

        match cmd.spawn() {
            Ok(mut child) => {
                tracing::info!("AI service started (pid: {})", child.id());
                let port_num = port.parse::<u16>().unwrap_or(0);
                let mut ai_ready = false;
                if port_num != 0 {
                    for attempt in 1..=40 {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                tracing::error!(
                                    "AI service exited before becoming healthy (status: {}). Check {:?} for details",
                                    status,
                                    log_path
                                );
                                break;
                            }
                            Ok(None) => {}
                            Err(e) => {
                                tracing::error!("Could not query AI service process status: {}", e);
                                break;
                            }
                        }

                        let healthy = (|| -> bool {
                            use std::io::{Read, Write};
                            use std::net::TcpStream;
                            let mut stream = match TcpStream::connect(("127.0.0.1", port_num)) {
                                Ok(s) => s,
                                Err(_) => return false,
                            };
                            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));
                            let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(1500)));
                            if stream
                                .write_all(
                                    b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                                )
                                .is_err()
                            {
                                return false;
                            }
                            let mut buf = String::new();
                            if stream.read_to_string(&mut buf).is_err() {
                                return false;
                            }
                            buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
                        })();

                        if healthy {
                            ai_ready = true;
                            tracing::info!("AI service health check passed on attempt {}", attempt);
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                    }
                }

                if !ai_ready {
                    tracing::error!(
                        "AI service did not become healthy within startup window. Check {:?} for details",
                        log_path
                    );
                }
                let _ = child.wait();
                tracing::warn!("AI service process exited — check {:?} for details", log_path);
            }
            Err(e) => {
                tracing::error!("Failed to start AI service: {}", e);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_console_logging();
    tracing::info!("FMS backend starting with strict hard-coded config support");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Load configuration (Strictly prioritize hard-coded JSON)
            let mut config = load_config(app);
            
            // Auto-start Python AI service if pointing to localhost
            start_local_ai_service(app, &mut config);

            // Database: init and run migrations on every start
            let db_path = db::default_db_path().expect("FMS app data dir");
            tracing::info!("DB path: {}", db_path.display());
            let pool = db::init(&db_path).expect("DB init and migrations");
            tracing::info!("Database initialized and migrations complete");
            
            let state = ApiState::new(Arc::clone(&pool), config);
            app.manage(Arc::clone(&pool));

            // Use a dynamic port
            let port = find_free_port();
            let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().expect("addr");
            app.manage(ApiPort(port));

            let (tx, rx) = std::sync::mpsc::channel();
            tracing::info!("Spawning API server thread on {}", addr);
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                let on_listening = Some(Box::new(move || {
                    let _ = tx.send(());
                }) as Box<dyn FnOnce() + Send>);
                rt.block_on(async move {
                    if let Err(e) = api::run(state, addr, on_listening).await {
                        tracing::error!("FMS API server error: {}", e);
                    }
                });
            });

            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(()) => tracing::info!("API server ready at http://{}", addr),
                Err(_) => tracing::error!("API server did not become ready within 5s"),
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_port, seed_demo_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
