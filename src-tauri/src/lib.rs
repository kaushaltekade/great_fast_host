pub mod config_manager;
pub mod server_manager;
pub mod tunnel_manager;
pub mod watchdog;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::sync::oneshot;
pub struct AppState {
    pub tunnel_child: Arc<Mutex<Option<tokio::process::Child>>>,
    pub server_shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

/// Emit a structured pipeline event to the frontend.
pub fn emit_step(app: &AppHandle, session_id: &str, step: &str, status: &str, message: &str, description: &str, pipeline_status: &str) {
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id,
        "pipeline_status": pipeline_status,
        "step": step,
        "status": status,
        "message": message,
        "description": description,
        "skipped": false,
        "progress": 0,
        "error": null,
        "retryable": false,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
    }));
}

pub fn emit_error(app: &AppHandle, session_id: &str, step: &str, error_code: &str, error_msg: &str, retryable: bool) {
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id,
        "pipeline_status": "error",
        "step": step,
        "status": "error",
        "message": error_msg,
        "description": "",
        "skipped": false,
        "progress": 0,
        "error": { "code": error_code, "message": error_msg },
        "retryable": retryable,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
    }));
}

#[tauri::command]
async fn get_config(app: AppHandle) -> Result<config_manager::AppConfig, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(config_manager::load_config(&app_dir))
}

#[tauri::command]
async fn save_config(app: AppHandle, config: config_manager::AppConfig) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    config_manager::save_config(&app_dir, &config)
}

#[tauri::command]
async fn start_tunnel(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // --- Step: initializing ---
    emit_step(&app, &session_id, "initializing", "active", "Initializing system...", "Preparing runtime environment", "running");

    let config = config_manager::load_config(&app_dir);

    emit_step(&app, &session_id, "initializing", "done", "System initialized", "Runtime environment ready", "running");

    // --- Step: config_loaded ---
    emit_step(&app, &session_id, "config_loaded", "active", "Loading configuration...", "Reading saved settings", "running");
    emit_step(&app, &session_id, "config_loaded", "done", "Configuration loaded", "Settings applied successfully", "running");

    // Check if duplicate start
    {
        let handle = state.tunnel_child.lock().await;
        if handle.is_some() {
            return Err("Tunnel already running".to_string());
        }
    }

    // Stop any existing server just in case
    {
        let mut guard = state.server_shutdown_tx.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));

    // --- Step: checking_tunnel + downloading + verifying ---
    let exe_path = match tunnel_manager::ensure_cloudflared(&app_dir, &app, &session_id, cancel_flag.clone()).await {
        Ok(p) => p,
        Err(e) => {
            emit_error(&app, &session_id, "checking_tunnel", "UNKNOWN", &e, true);
            return Err(e);
        }
    };

    if cancel_flag.load(Ordering::Relaxed) {
        emit_step(&app, &session_id, "initializing", "done", "Stopped", "Session cancelled by user", "stopped");
        return Ok(());
    }

    // --- Step: starting_tunnel (local server) ---
    emit_step(&app, &session_id, "starting_tunnel", "active", "Starting local server...", "Binding to local port", "running");

    if matches!(config.hosting_type, config_manager::HostingType::Demo | config_manager::HostingType::Website { .. }) {
        match server_manager::start_server(config.port, &config.hosting_type).await {
            Ok(tx) => {
                let mut guard = state.server_shutdown_tx.lock().await;
                *guard = Some(tx);
            },
            Err(e) => {
                emit_error(&app, &session_id, "starting_tunnel", "SPAWN_FAILED", &format!("Server Error: {}", e), false);
                return Err(e);
            }
        }
    }

    emit_step(&app, &session_id, "starting_tunnel", "done", "Local server running", &format!("Listening on port {}", config.port), "running");

    // --- Spawn tunnel process ---
    let mut tunnel_child = match tunnel_manager::spawn_tunnel(exe_path.clone(), config.port, &config.tunnel_mode, app.clone()).await {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &session_id, "starting_tunnel", "SPAWN_FAILED", &e, true);
            return Err(e);
        }
    };

    let stderr = tunnel_child.stderr.take().ok_or("Failed to capture tunnel stderr".to_string())?;

    {
        let mut guard = state.tunnel_child.lock().await;
        *guard = Some(tunnel_child);
    }

    let sid = session_id.clone();
    tokio::spawn(async move {
        watchdog::supervise(app, stderr, sid).await;
    });

    Ok(())
}

#[tauri::command]
async fn stop_tunnel(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    emit_step(&app, &session_id, "global", "active", "Stopping services...", "Safely terminating background processes", "running");

    // 1. Terminate Tunnel
    {
        let mut handle = state.tunnel_child.lock().await;
        if let Some(mut child) = handle.take() {
            let _ = child.kill().await;
            let _ = child.wait().await; // REQUIRED to prevent zombie processes
        }
    }

    // 2. Terminate Server
    {
        let mut guard = state.server_shutdown_tx.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id,
        "pipeline_status": "stopped",
        "step": "initializing",
        "status": "done",
        "message": "Hosting stopped",
        "description": "All services shut down cleanly",
        "skipped": false,
        "progress": 0,
        "error": null,
        "retryable": false,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
    }));

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            tunnel_child: Arc::new(Mutex::new(None)),
            server_shutdown_tx: Arc::new(Mutex::new(None)),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Ensure everything cleans up when app is closed natively
                let state = window.app_handle().state::<AppState>();
                let tunnel_child = state.tunnel_child.clone();
                let server_shutdown_tx = state.server_shutdown_tx.clone();
                tauri::async_runtime::block_on(async move {
                    {
                        let mut handle = tunnel_child.lock().await;
                        if let Some(mut child) = handle.take() {
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                        }
                    }
                    {
                        let mut guard = server_shutdown_tx.lock().await;
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(());
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_tunnel,
            stop_tunnel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
