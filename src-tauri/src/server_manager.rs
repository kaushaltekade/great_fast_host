use axum::{response::Html, routing::get, Router};
use std::path::PathBuf;
use tokio::sync::oneshot;
use tower_http::services::{ServeDir, ServeFile};

use crate::config_manager::HostingType;

pub async fn start_server(port: u16, hosting_type: &HostingType) -> Result<oneshot::Sender<()>, String> {
    let app = match hosting_type {
        HostingType::Demo => {
            Router::new().route("/", get(|| async {
                Html(
                    "<html><body style='background:#1a1d24;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;'><div style='text-align:center;'><h1>🌐 Great Fast Host</h1><p style='color:#10b981;font-size:1.2rem;font-weight:bold;'>Demo Service is running successfully!</p></div></body></html>"
                )
            }))
        },
        HostingType::Website { folder } => {
            let path = PathBuf::from(folder);
            if !path.exists() {
                return Err(format!("Folder does not exist at {}", path.display()));
            }
            let index_path = path.join("index.html");
            if !index_path.exists() {
                return Err(format!("index.html not found in {}", path.display()));
            }
            
            // SPA routing: ServeDir automatically falls back to ServeFile for index.html
            Router::new().fallback_service(
                ServeDir::new(&path).not_found_service(ServeFile::new(index_path))
            )
        },
        HostingType::Custom => {
            return Err("Internal server is not used in Custom App Mode.".to_string());
        }
    };

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        // Run axum server until shutdown signal is received
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    Ok(shutdown_tx)
}
