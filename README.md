<div align="center">

<br/>

```
  _____ _      _    _           _
 |  ___| | __ | |__| | ___  ___| |_
 | |_  | |/ / | '_ \ |/ _ \/ __| __|
 |  _| |   <  | | | | | (_) \__ \ |_
 |_|   |_|\_\ |_| |_|_|\___/|___/\__|
```

# **fkhost** — Great Fast Host

**Expose your local server to the internet in seconds. Zero configuration. Zero friction.**

[![Version](https://img.shields.io/badge/version-0.5.1-6366f1?style=for-the-badge&logo=github)](https://github.com/kaushaltekade/great_fast_host)
[![Built with Tauri](https://img.shields.io/badge/Tauri-2.x-ffc131?style=for-the-badge&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-Backend-ce4a27?style=for-the-badge&logo=rust)](https://rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](LICENSE)

<br/>

---

</div>

## ✨ What is fkhost?

**fkhost** is a beautiful, lightning-fast **desktop app** that wraps [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) into a polished one-click experience.

Whether you're demoing a local React app, sharing a static website, or proxying to any running service — fkhost handles the binary download, verification, tunnel spawn, and live URL generation automatically, with a real-time pipeline UI showing every step.

> **This is a native desktop application.** It requires Tauri to run — there is no web version.

<br/>

---

## 🚀 Features

| Feature | Description |
|---|---|
| **One-click tunnel** | Start and stop a Cloudflare tunnel with a single button |
| **8-stage pipeline UI** | Real-time visual pipeline with step icons, spinners, elapsed timers |
| **Auto-download cloudflared** | Fetches & verifies the binary automatically on first run |
| **Quick mode** | Ephemeral `*.trycloudflare.com` URL — no account needed |
| **Custom / Named mode** | Connect your own Cloudflare tunnel ID + custom domain |
| **Static folder hosting** | Built-in file server — just pick a folder, no extra setup |
| **Preset chips** | One-click presets for React (`:5173`), Next.js (`:3000`), Static Folder |
| **Log viewer** | Collapsible real-time log panel with `ALL / INFO / ERR` filtering |
| **Copy & open** | Copy live URL to clipboard or open it directly in the browser |
| **Dark / Light theme** | Smooth theme toggle with glassmorphism design |
| **Graceful shutdown** | Kills tunnel process and file server cleanly on stop or window close |
| **Port validation** | Fails fast with a clear error if the target port is already in use |
| **Inline validation** | Required field and range checks before any process is spawned |

<br/>

---

## 🏗️ Architecture

```
great_fast_host/
├── src/                        # React 19 + TypeScript frontend
│   ├── App.tsx                 # Pipeline state machine · 8-step UI
│   └── App.css                 # Glass-style dark/light theme · animations
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs              # Tauri commands · pipeline event emitter
│   │   ├── config_manager.rs   # Persistent JSON config (AppConfig)
│   │   ├── server_manager.rs   # Built-in static file server (Hyper)
│   │   ├── tunnel_manager.rs   # cloudflared binary management & spawn
│   │   └── watchdog.rs         # Stderr supervisor · live URL parser
│   └── tauri.conf.json         # App metadata · window config
├── index.html
├── vite.config.ts
└── package.json
```

### Data Flow

```
[User clicks ▶ Start Hosting]
        │
        ▼
  Frontend (React) generates session UUID
        │
        ▼
  Tauri invoke: start_tunnel(session_id)
        │
        ├── emit: initializing → done
        ├── emit: config_loaded → done
        ├── tunnel_manager::ensure_cloudflared()
        │       ├── emit: checking_tunnel
        │       ├── emit: downloading  (with % progress)
        │       └── emit: verifying
        ├── server_manager::start_server()   ← Demo / Website modes only
        │       └── emit: starting_tunnel → done
        ├── tunnel_manager::spawn_tunnel()
        └── watchdog::supervise()
                └── parses stderr for public URL
                        └── emit: live → done  (URL in description)
```

<br/>

---

## 🛠️ Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| [Node.js](https://nodejs.org) | ≥ 18 |
| [Rust](https://rustup.rs) | stable (1.75+) |
| [Tauri prerequisites](https://tauri.app/start/prerequisites/) | platform-specific |

### Install & Run (development)

```bash
# 1. Clone
git clone https://github.com/kaushaltekade/great_fast_host
cd great_fast_host

# 2. Install JS dependencies
npm install

# 3. Run Tauri dev (compiles Rust backend + starts Vite)
npm run tauri dev
```

### Production build

```bash
npm run tauri build
# → Installer in src-tauri/target/release/bundle/
```

<br/>

---

## ⚙️ Configuration

Settings are persisted automatically to the OS app data directory via Tauri.

```jsonc
// Example: %APPDATA%\com.greatfasthost.desktop\config.json  (Windows)
{
  "version": 1,
  "hosting_type": { "mode": "Demo" },       // "Demo" | "Website" (+ folder) | "Custom"
  "tunnel_mode":  { "mode": "Quick" },      // "Quick" | "Named" (+ token, domain)
  "port": 8080
}
```

All settings are saved automatically when you click **▶ Start Hosting**.

<br/>

---

## 🎨 UI Highlights

- **Glassmorphism titlebar** — status-aware accent (idle / running / error / live)
- **8-step pipeline sidebar** — nodes animate between pending → spinner → ✓ / ✗
- **Download progress bar** — shown only during cloudflared binary fetch
- **Live URL card** — copy to clipboard or open in browser with one click
- **Collapsible log panel** — timestamp + log-type coloring (INFO / OK / ERR / SYS)
- **Segmented tunnel mode control** — disabled while a session is active
- **Preset chips** — React, Next.js, Static Folder with one-click port config
- **Inline validation toasts** — port range, required fields, checked before start

<br/>

---

## 🧩 Tunnel Modes

### Quick *(default)*
Uses `cloudflared tunnel --url http://localhost:<port>` to generate a random, temporary public URL like `https://abc123.trycloudflare.com`. **No account or setup required.**

### Custom / Named

Connects to your own **Cloudflare tunnel** and routes traffic through a **custom domain** (e.g., `app.yourdomain.com`). Requires a free Cloudflare account and your domain pointed to Cloudflare's nameservers.

**Step-by-step setup:**

**Step 0 — Add your domain to Cloudflare** *(skip if your domain is already on Cloudflare)*

If you bought your domain from Hostinger, Namecheap, GoDaddy, or any other registrar, you first need to point it at Cloudflare:

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site** → enter your domain (e.g. `yourdomain.com`) → click **Continue**.
2. Choose the **Free plan** → click **Continue**.
3. Cloudflare scans your existing DNS. Review the records and click **Continue**.
4. Cloudflare shows you **two nameservers**, e.g.:
   ```
   amelia.ns.cloudflare.com
   bart.ns.cloudflare.com
   ```
5. Log in to your registrar (e.g. [Hostinger hPanel](https://hpanel.hostinger.com)) → find your domain → go to **DNS / Nameservers** → **Change nameservers**.
6. **Replace** the current nameservers with the two Cloudflare ones above → **Save**.
7. Back in Cloudflare, click **Done, check nameservers**. Propagation usually takes **5–30 minutes** (up to 48 h).
8. Once Cloudflare shows the domain as **Active** ✅, you're ready to proceed.

> **Hostinger shortcut:** hPanel → Domains → click your domain → **DNS / Nameservers** tab → select *"Use custom nameservers"* → paste both Cloudflare nameservers → Save.

---

**Step 1 — Create a tunnel**
1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) and sign in.
2. Go to **Networks** → **Tunnels** → click **Add a tunnel**.
3. Select **Cloudflared** as the connector type and click **Next**.
4. Give your tunnel a name (e.g. `my-app`) and click **Save tunnel**.

**Step 2 — Copy your Tunnel Token**
1. On the next screen you'll see an install command — something like:
   ```
   cloudflared service install eyJhbGci...
   ```
2. **Copy the long token string** that starts with `eyJh` — that's your Tunnel Token.
   > You can always find it later under **Networks → Tunnels → your tunnel → Configure → Overview**.

**Step 3 — Add a public hostname (route)**
1. In the tunnel configuration, click the **Routes** tab → **Add a route**.
2. Select **Published application** (public hostname).
3. Fill in:
   - **Subdomain**: e.g. `app`
   - **Domain**: choose your Cloudflare-managed domain (e.g. `yourdomain.com`)
   - **Service → Type**: `HTTP`
   - **Service → URL**: `localhost:8080` *(match the port you use in fkhost)*
4. Click **Save hostname**.

**Step 4 — Connect in fkhost**
1. Switch fkhost to **Named** tunnel mode.
2. Paste your **Tunnel Token** into the Token field.
3. Enter your **custom domain** (e.g. `app.yourdomain.com`) into the Domain field.
4. Click **▶ Start Hosting** — your custom domain will be live in seconds.

<br/>

---

## 🔄 Hosting Types

| Type | What fkhost does |
|---|---|
| **Demo** | Spawns a built-in "Hello World" HTTP server on the chosen port |
| **Website** | Serves a static folder of your choice via a built-in file server |
| **Custom** | Tunnels to an *already-running* local server — nothing extra is spawned |

<br/>

---

## 🤝 Contributing

Pull requests are welcome!

1. Fork and create a branch: `git checkout -b feat/my-feature`
2. Run `npm run tauri dev` and test end-to-end
3. Submit a PR with a clear description of what changed and why

<br/>

---

## 📜 License

MIT © [Kaushal Tekade](https://github.com/kaushaltekade)

<br/>

<div align="center">

**Built using Tauri · Rust · React · TypeScript**

*tunnel hosting, zero friction*

</div>
