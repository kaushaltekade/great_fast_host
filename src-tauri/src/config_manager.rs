use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode")]
pub enum HostingType {
    Demo,
    Website { folder: String },
    Custom,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode")]
pub enum TunnelMode {
    Quick,
    Named { tunnel_id: String, domain: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub version: u32,
    pub hosting_type: HostingType,
    pub tunnel_mode: TunnelMode,
    pub port: u16,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            hosting_type: HostingType::Demo,
            tunnel_mode: TunnelMode::Quick,
            port: 8080,
        }
    }
}

pub fn get_config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("config.json")
}

pub fn load_config(app_data_dir: &Path) -> AppConfig {
    let path = get_config_path(app_data_dir);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str(&content) {
            return config;
        }
    }
    AppConfig::default()
}

pub fn save_config(app_data_dir: &Path, config: &AppConfig) -> Result<(), String> {
    let path = get_config_path(app_data_dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let content = serde_json::to_string_pretty(config).map_err(|e| format!("Config serialization error: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Config write error: {}", e))
}
