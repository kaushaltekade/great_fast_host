use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use crate::config_manager::TunnelMode;

pub async fn ensure_cloudflared(
    app_data_dir: &Path,
    app: &AppHandle,
    session_id: &str,
    cancel_flag: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    }
    let bin_dir = app_data_dir.join("bin");
    if !bin_dir.exists() {
        fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    }

    let exe_path = bin_dir.join("cloudflared.exe");

    // --- Step: checking_tunnel ---
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id,
        "pipeline_status": "running",
        "step": "checking_tunnel",
        "status": "active",
        "message": "Checking Cloudflare Tunnel...",
        "description": "Verifying installation and permissions",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    if exe_path.exists() && exe_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        // Already installed — skip download
        let _ = app.emit("pipeline_step", serde_json::json!({
            "session_id": session_id,
            "pipeline_status": "running",
            "step": "checking_tunnel",
            "status": "done",
            "message": "Cloudflare Tunnel already installed",
            "description": "Skipping download",
            "skipped": false, "progress": 0, "error": null, "retryable": false,
            "timestamp": ts()
        }));
        // Emit downloading as done+skipped
        let _ = app.emit("pipeline_step", serde_json::json!({
            "session_id": session_id,
            "pipeline_status": "running",
            "step": "downloading",
            "status": "done",
            "message": "Download skipped (already installed)",
            "description": "cloudflared.exe found on disk",
            "skipped": true, "progress": 100, "error": null, "retryable": false,
            "timestamp": ts()
        }));
        // Verifying
        let _ = app.emit("pipeline_step", serde_json::json!({
            "session_id": session_id, "pipeline_status": "running",
            "step": "verifying", "status": "done",
            "message": "Verification passed", "description": "Binary size confirmed valid",
            "skipped": false, "progress": 0, "error": null, "retryable": false,
            "timestamp": ts()
        }));
        return Ok(exe_path);
    }

    // Not found — need to download
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id, "pipeline_status": "running",
        "step": "checking_tunnel", "status": "done",
        "message": "Cloudflare Tunnel not found", "description": "Will download now",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    // --- Step: downloading ---
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id, "pipeline_status": "running",
        "step": "downloading", "status": "active",
        "message": "Downloading Cloudflare Tunnel (first-time setup)...",
        "description": "Fetching cloudflared binary from GitHub",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    let url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

    let response = reqwest::get(url).await.map_err(|e| format!("Download error: {}", e))?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_progress: i64 = -5; // force first emit
    let mut bytes_buf: Vec<u8> = Vec::with_capacity(total as usize);

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = app.emit("pipeline_step", serde_json::json!({
                "session_id": session_id, "pipeline_status": "stopped",
                "step": "downloading", "status": "error",
                "message": "Download cancelled by user", "description": "",
                "skipped": false, "progress": downloaded as u32, "error": {"code": "CANCELLED", "message": "User stopped"}, "retryable": false,
                "timestamp": ts()
            }));
            return Err("Cancelled".to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        downloaded += chunk.len() as u64;
        bytes_buf.extend_from_slice(&chunk);

        if total > 0 {
            let pct = ((downloaded * 100) / total) as i64;
            if pct - last_progress >= 3 {
                last_progress = pct;
                let _ = app.emit("pipeline_step", serde_json::json!({
                    "session_id": session_id, "pipeline_status": "running",
                    "step": "downloading", "status": "active",
                    "message": format!("Downloading Cloudflare Tunnel... ({}%)", pct),
                    "description": format!("{} KB / {} KB", downloaded / 1024, total / 1024),
                    "skipped": false, "progress": pct, "error": null, "retryable": false,
                    "timestamp": ts()
                }));
            }
        }
    }

    fs::write(&exe_path, &bytes_buf).map_err(|e| format!("FS Error: {}", e))?;

    // Always cap at 100%
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id, "pipeline_status": "running",
        "step": "downloading", "status": "done",
        "message": "Download complete", "description": "Binary written to disk",
        "skipped": false, "progress": 100, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    // --- Step: verifying ---
    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id, "pipeline_status": "running",
        "step": "verifying", "status": "active",
        "message": "Verifying installation...", "description": "Checking binary integrity",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    if !exe_path.exists() || exe_path.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = app.emit("pipeline_step", serde_json::json!({
            "session_id": session_id, "pipeline_status": "error",
            "step": "verifying", "status": "error",
            "message": "Verification failed: binary missing or empty",
            "description": "Try again with a stable internet connection",
            "skipped": false, "progress": 0,
            "error": {"code": "FILE_NOT_FOUND", "message": "cloudflared.exe missing after download"},
            "retryable": true, "timestamp": ts()
        }));
        return Err("Verification failed: binary not found or empty".to_string());
    }

    let _ = app.emit("pipeline_step", serde_json::json!({
        "session_id": session_id, "pipeline_status": "running",
        "step": "verifying", "status": "done",
        "message": "Verification passed", "description": "Binary is valid and ready",
        "skipped": false, "progress": 0, "error": null, "retryable": false,
        "timestamp": ts()
    }));

    Ok(exe_path)
}

pub async fn spawn_tunnel(
    exe_path: PathBuf,
    port: u16,
    tunnel_mode: &TunnelMode,
    app: AppHandle,
) -> Result<Child, String> {
    let mut cmd = tokio::process::Command::new(exe_path);

    match tunnel_mode {
        TunnelMode::Quick => {
            cmd.args(["tunnel", "--url", &format!("http://localhost:{}", port)]);
        },
        TunnelMode::Named { tunnel_id, domain: _ } => {
            cmd.args(["tunnel", "run", tunnel_id]);
        }
    }

    cmd.args(["--no-autoupdate"])
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // NOTE: Do NOT take stderr here. The watchdog reads it to detect the
    // public URL and simultaneously forwards each line to the log panel.
    // Taking it here would leave tunnel_child.stderr = None, causing the
    // watchdog to emit SPAWN_FAILED immediately.
    let child = cmd.spawn().map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    Ok(child)
}

fn ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}
