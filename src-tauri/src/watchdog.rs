use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{Duration, timeout};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::AppState;

pub async fn supervise(
    app: AppHandle,
    mut stderr: tokio::process::ChildStderr,
    session_id: String,
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

    let re = regex::Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").unwrap();
    let mut reader = BufReader::new(&mut stderr).lines();

    // 15 second timeout waiting for the URL (per user requirements)
    let url_result = timeout(Duration::from_secs(15), async {
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app.emit("log", serde_json::json!({ "text": &line, "log_type": "info" }));
            if let Some(caps) = re.captures(&line) {
                let url = caps.get(0).unwrap().as_str().to_string();
                return Some(url);
            }
        }
        None
    }).await;

    match url_result {
        Ok(Some(url)) => {
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
            let mut reader2 = BufReader::new(&mut stderr).lines();
            while let Ok(Some(line)) = reader2.next_line().await {
                let _ = app.emit("log", serde_json::json!({ "text": &line, "log_type": "info" }));
            }
        }
        Ok(None) | Err(_) => {
            // Stream ended or timed out
            emit_err(&app, &session_id, "connecting", "TIMEOUT", "Timed out waiting for public URL (15s).", true);
            
            // Auto kill tracking if we timeout
            let state = app.state::<AppState>();
            if let Ok(mut handle) = state.tunnel_child.try_lock() {
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
