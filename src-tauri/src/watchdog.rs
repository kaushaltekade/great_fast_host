use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{Duration, timeout};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::AppState;

pub async fn supervise(
    app: AppHandle,
    mut stderr: tokio::process::ChildStderr,
    session_id: String,
    tunnel_mode: crate::config_manager::TunnelMode,
) {
    let sid = session_id.clone();
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": sid,
        "pipeline_status": "running",
        "step": "connecting",
        "status": "active",
        "message": "Connecting to Cloudflare network...",
        "description": "Waiting for public URL to be assigned",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    let mut reader = BufReader::new(&mut stderr).lines();

    let url_result = match tunnel_mode {
        crate::config_manager::TunnelMode::Quick => {
            let re = regex::Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").unwrap();
            timeout(Duration::from_secs(15), async {
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit("log", serde_json::json!({ "text": &line, "log_type": "info" }));
                    if let Some(caps) = re.captures(&line) {
                        return Some(caps.get(0).unwrap().as_str().to_string());
                    }
                }
                None
            }).await.unwrap_or(None)
        },
        crate::config_manager::TunnelMode::Named { domain, .. } => {
            // For named tunnels, we look for a successful connection message
            // or just assume live if it starts successfully and doesn't exit immediately.
            // However, to be safe, let's wait for a "Connected" or "Registered" message.
            let re_connected = regex::Regex::new(r"Connected to [A-Z]{3}").unwrap();
            let re_registered = regex::Regex::new(r"Registered tunnel connection").unwrap();
            
            timeout(Duration::from_secs(15), async {
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app.emit("log", serde_json::json!({ "text": &line, "log_type": "info" }));
                    if re_connected.is_match(&line) || re_registered.is_match(&line) {
                        let url = if domain.starts_with("http") { domain.clone() } else { format!("https://{}", domain) };
                        return Some(url);
                    }
                }
                None
            }).await.unwrap_or(None)
        }
    };

    match url_result {
        Some(url) => {
            let _ = app.emit("pipeline_step", serde_json::json!({
                "session_id": session_id,
                "pipeline_status": "running",
                "step": "connecting",
                "status": "done",
                "message": "Connected to Cloudflare network",
                "description": "Public URL assigned",
                "skipped": false, "progress": 0, "error": null, "retryable": false,
                "timestamp": ts()
            }));
            let _ = app.emit("pipeline_step", serde_json::json!({
                "session_id": session_id,
                "pipeline_status": "completed",
                "step": "live",
                "status": "done",
                "message": "Your app is live! 🎉",
                "description": url,
                "skipped": false, "progress": 0, "error": null, "retryable": false,
                "timestamp": ts()
            }));
            let _ = app.emit("tunnel_url", serde_json::json!({ "url": url }));
            
            // Continue feeding logs forever
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit("log", serde_json::json!({ "text": &line, "log_type": "info" }));
            }
        }
        None => {
            // Stream ended or timed out
            emit_err(&app, &session_id, "connecting", "TIMEOUT", "Timed out waiting for public URL (15s).", true);

            // Auto kill tracking if we timeout
            let tunnel_child = {
                let state = app.state::<AppState>();
                state.tunnel_child.clone()
            };
            let lock_result = tunnel_child.try_lock();
            if let Ok(mut handle) = lock_result {
                if let Some(mut child) = handle.take() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
    }
}

fn ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn emit_err(app: &AppHandle, session_id: &str, step: &str, code: &str, msg: &str, retryable: bool) {
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id,
        "pipeline_status": "error",
        "step": step,
        "status": "error",
        "message": msg,
        "description": "",
        "skipped": false, "progress": 0,
        "error": { "code": code, "message": msg },
        "retryable": retryable,
        "timestamp": ts()
    }));
}
