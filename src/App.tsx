import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

type PipelineStatus = "idle" | "running" | "error" | "completed" | "stopped";
type StepStatus = "pending" | "active" | "done" | "error" | "skip";

const STEP_ORDER = [
  "initializing",
  "config_loaded",
  "checking_tunnel",
  "downloading",
  "verifying",
  "starting_tunnel",
  "connecting",
  "live",
] as const;
type StepKey = (typeof STEP_ORDER)[number];

interface StepMeta { label: string; desc: string; }
const STEP_META: Record<StepKey, StepMeta> = {
  initializing:    { label: "Initializing",    desc: "Setting up runtime" },
  config_loaded:   { label: "Config",          desc: "Reading saved config" },
  checking_tunnel: { label: "Cloudflared",     desc: "Verifying cloudflared" },
  downloading:     { label: "Download",        desc: "Fetching binary" },
  verifying:       { label: "Verifying",       desc: "Checking file integrity" },
  starting_tunnel: { label: "Spawn",           desc: "Spawning tunnel process" },
  connecting:      { label: "Connecting",      desc: "Waiting for public URL" },
  live:            { label: "Live",            desc: "Tunnel is live" },
};

interface StepState {
  status: StepStatus;
  progress: number;     // 0–100, only for downloading
  elapsed: number;      // seconds
  startTs: number;
  skipped: boolean;
  error: { code: string; message: string } | null;
}

interface PipelineEvent {
  session_id: string;
  pipeline_status: string;
  step: StepKey;
  status: string;
  message: string;
  description: string;
  skipped: boolean;
  progress: number;
  error: { code: string; message: string } | null;
  retryable: boolean;
  timestamp: number;
}

interface LogLine { id: number; ts: string; type: "INFO" | "OK" | "ERR" | "SYS"; text: string; }

type HostingType = 
  | { mode: "Demo" }
  | { mode: "Website", folder: string }
  | { mode: "Custom" };

type TunnelMode = 
  | { mode: "Quick" }
  | { mode: "Named", tunnel_id: string, domain: string };

interface AppConfig {
  version: number;
  hosting_type: HostingType;
  tunnel_mode: TunnelMode;
  port: number;
}

const mkSteps = (): Record<StepKey, StepState> =>
  Object.fromEntries(STEP_ORDER.map((k) => [k, {
    status: "pending" as StepStatus,
    progress: 0, elapsed: 0, startTs: 0, skipped: false, error: null,
  }])) as Record<StepKey, StepState>;

const fmtTime = (secs: number) => {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const nowTs = () => {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}`;
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(mkSteps());
  const [liveUrl, setLiveUrl] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<"ALL" | "INFO" | "ERR">("ALL");
  const [autoScroll, setAutoScroll] = useState(true);
  const [sessionId, setSessionId] = useState("—");
  const [elapsed, setElapsed] = useState(0);
  const [appConfig, setAppConfig] = useState<AppConfig>({
    version: 1,
    hosting_type: { mode: "Demo" },
    tunnel_mode: { mode: "Quick" },
    port: 8080
  });
  const [errorInfo, setErrorInfo] = useState<{ title: string; desc: string; code: string } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [notification, setNotification] = useState<{ type: "info" | "warning" | "error"; msg: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const sessionRef = useRef("");
  const stepIdxRef = useRef(-1);
  const lastProgRef = useRef(-1);
  const isLockedRef = useRef(false);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Window controls
  const appWindow = getCurrentWindow();

  const addLog = useCallback((type: LogLine["type"], text: string) => {
    setLogs((p) => [...p.slice(-499), { id: Date.now() + Math.random(), ts: nowTs(), type, text }]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logsOpen && autoScroll) logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, logsOpen, autoScroll]);

  // Load config & theme on mount
  useEffect(() => {
    invoke<AppConfig>("get_config").then(cfg => {
      setAppConfig(cfg);
    }).catch(() => {});
    
    const t = document.documentElement.getAttribute("data-theme") as "dark" | "light" || "dark";
    setTheme(t);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("fkhost_theme", next);
    
    // Add temporary class for smooth transition across all elements
    document.body.classList.add("theme-transitioning");
    setTimeout(() => document.body.classList.remove("theme-transitioning"), 300);
  };

  // Elapsed timer
  useEffect(() => {
    if (status === "running") {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        // Also update active-step elapsed
        const now = Date.now() / 1000;
        setSteps((prev) => {
          const upd = { ...prev };
          let changed = false;
          for (const k of STEP_ORDER) {
            if (upd[k].status === "active" && upd[k].startTs > 0) {
              upd[k] = { ...upd[k], elapsed: now - upd[k].startTs };
              changed = true;
            }
          }
          return changed ? upd : prev;
        });
      }, 500);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  // Backend event listener
  useEffect(() => {
    const unlistenPipeline = listen<PipelineEvent>("pipeline_step", (e) => {
      const ev = e.payload;
      if (ev.session_id !== sessionRef.current) return;

      const idx = STEP_ORDER.indexOf(ev.step);
      const ps = ev.pipeline_status;
      const isTerminal = ["stopped","error","completed"].includes(ps);

      if (isLockedRef.current && !isTerminal) return;
      if (!isTerminal && idx < stepIdxRef.current) return;

      if (ev.step === "downloading" && ev.status === "active") {
        if (Math.abs(ev.progress - lastProgRef.current) < 2) return;
        lastProgRef.current = ev.progress;
      }

      if (idx >= 0 && !isTerminal) stepIdxRef.current = idx;

      if (isTerminal) {
        const newPs = ps === "completed" ? "completed" : ps === "stopped" ? "stopped" : "error";
        setStatus(newPs);
        if (ps === "completed") isLockedRef.current = true;
        if (ps === "error" && ev.error) {
          setErrorInfo({ title: ev.message, desc: ev.description || "", code: ev.error.code });
        }
      }

      if (ev.step === "live" && ev.status === "done" && ev.description?.startsWith("https://")) {
        setLiveUrl(ev.description);
        addLog("OK", `Tunnel live · ${ev.description}`);
      }

      setSteps((prev) => {
        const now = Date.now() / 1000;
        const cur = prev[ev.step];
        const newSt: StepStatus =
          ev.status === "done"  ? (ev.skipped ? "skip" : "done")
          : ev.status === "error" ? "error"
          : "active";
        return { ...prev, [ev.step]: {
          ...cur,
          status: newSt,
          progress: ev.progress ?? cur.progress,
          skipped: ev.skipped,
          error: ev.error ?? null,
          startTs: ev.status === "active" ? (ev.timestamp || now) : cur.startTs,
          elapsed: ev.status !== "active" ? cur.elapsed : 0,
        }};
      });
    });

    const unlistenLog = listen<{ text: string; log_type: string }>("log", (e) => {
      const t = e.payload.log_type;
      const type: LogLine["type"] = t === "error" ? "ERR" : t === "success" ? "OK" : t === "warning" ? "SYS" : "INFO";
      addLog(type, e.payload.text);
    });

    return () => {
      unlistenPipeline.then((f) => f());
      unlistenLog.then((f) => f());
    };
  }, [addLog]);

  // ── Start / stop ─────────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const sid = crypto.randomUUID();
    sessionRef.current = sid;
    stepIdxRef.current = -1;
    lastProgRef.current = -1;
    isLockedRef.current = false;
    setSteps(mkSteps());
    setLiveUrl("");
    setElapsed(0);
    setErrorInfo(null);
    setSessionId(sid.slice(0, 8) + "…");
    setStatus("running");
    addLog("SYS", `Session ${sid.slice(0, 8)} started`);
    try {
      await invoke("save_config", { config: appConfig });
      await invoke("start_tunnel", { sessionId: sid });
    } catch (e: any) {
      setStatus("error");
      setErrorInfo({ title: String(e), desc: "", code: "INVOKE_ERROR" });
      addLog("ERR", String(e));
    }
  }, [addLog, appConfig]);

  const handleStop = useCallback(async () => {
    try { await invoke("stop_tunnel", { sessionId: sessionRef.current }); } catch (_) {}
    setStatus("stopped");
    addLog("SYS", "Session stopped by user");
  }, [addLog]);

  const handleButton = () => {
    if (status === "running" || status === "completed") {
      handleStop();
    } else {
      // Inline Validation
      if (appConfig.port < 1 || appConfig.port > 65535) {
        setNotification({ type: "error", msg: "Invalid port number. Range: 1-65535." });
        return;
      }
      if (appConfig.hosting_type.mode === "Website" && !appConfig.hosting_type.folder) {
        setNotification({ type: "error", msg: "Please select a static folder to serve." });
        return;
      }
      if (appConfig.tunnel_mode.mode === "Named" && (!appConfig.tunnel_mode.tunnel_id || !appConfig.tunnel_mode.domain)) {
        setNotification({ type: "error", msg: "Tunnel ID and Domain are required for Custom mode." });
        return;
      }

      setNotification(null);
      handleStart();
    }
  };

  const lastTwoLogs = logs.slice(-2);
  const filteredLogs = logs.filter(l => logFilter === "ALL" || (logFilter === "ERR" && l.type === "ERR") || (logFilter === "INFO" && (l.type === "INFO" || l.type === "OK" || l.type === "SYS")));

  return (
    <div className="root">
      
      {notification && (
        <div className={`notify-bar ${notification.type}`}>
          <div className="notify-msg">
            {notification.type === "error" && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
            {notification.type === "info" && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>}
            {notification.msg}
          </div>
          <button className="notify-dismiss" onClick={() => setNotification(null)}>✕</button>
        </div>
      )}

      {/* ── Titlebar ── */}
      <header className={`titlebar status-${status}`} data-tauri-drag-region>
        <div className="tb-main" data-tauri-drag-region>
          <div className="tb-logo" data-tauri-drag-region>FK</div>
          <div className="tb-title" data-tauri-drag-region>
            <span className="tb-status-dot" />
            {status === "running" ? `Hosting :${appConfig.port}` : "fkhost"}
            <span className="tb-version">v0.4.1</span>
          </div>
        </div>
        <div className="tb-right">
          <button className="tb-theme" onClick={toggleTheme} title="Toggle Theme">
            {theme === "dark" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
          <div className="tb-controls">
            <button className="wc wc-min" onClick={() => appWindow.minimize()} title="Minimize">
              <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button className="wc wc-max" onClick={() => appWindow.toggleMaximize()} title="Maximize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none"/></svg>
            </button>
            <button className="wc wc-close" onClick={() => appWindow.close()} title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* ── Body: 2-column ── */}
      <div className="body">

        {/* ── LEFT PANEL ── */}
        <aside className="left-panel">
          {/* Brand */}
          <div className="brand-block">
            <div className="wordmark">fk<strong>host</strong></div>
            <div className="tagline">tunnel hosting, zero friction</div>
          </div>
          <div className="sep" />

          {/* Pipeline */}
          <div className="pipeline-label">PIPELINE</div>
          <div className="step-list">
            {STEP_ORDER.map((key, idx) => (
              <StepRow
                key={key}
                idx={idx}
                meta={STEP_META[key]}
                state={steps[key]}
                isLast={idx === STEP_ORDER.length - 1}
              />
            ))}
          </div>
          <div className="sep" />

          {/* Host type */}
          <div className="host-type-label">CONFIGURATION</div>

          <div className="cfg-group">
            <span className="cfg-label">Tunnel Mode</span>
            <div className="tunnel-seg">
              <button 
                className={appConfig.tunnel_mode.mode === "Quick" ? "active" : ""} 
                onClick={() => setAppConfig(c => ({...c, tunnel_mode: { mode: "Quick" }}))}
                disabled={status === "running"}
              >
                Quick
              </button>
              <button 
                className={appConfig.tunnel_mode.mode === "Named" ? "active" : ""} 
                onClick={() => setAppConfig(c => ({...c, tunnel_mode: { mode: "Named", tunnel_id: "", domain: "" }}))}
                disabled={status === "running"}
              >
                Custom
              </button>
            </div>
            <div className="tunnel-mode-desc">
              {appConfig.tunnel_mode.mode === "Quick" 
                ? "Generate a random ephemeral URL (e.g. *.trycloudflare.com)"
                : "Connect to your own Cloudflare tunnel and custom domain"}
            </div>
          </div>

          {appConfig.tunnel_mode.mode === "Named" && (
            <div className="cfg-sub">
              <input type="text" className="cfg-input mono" placeholder="Tunnel UUID" value={appConfig.tunnel_mode.tunnel_id} onChange={e => setAppConfig(c => ({...c, tunnel_mode: { mode: "Named", tunnel_id: e.target.value, domain: (c.tunnel_mode as any).domain }}))} disabled={status === "running"} />
              <input type="text" className="cfg-input mono" placeholder="example.com" value={appConfig.tunnel_mode.domain} onChange={e => setAppConfig(c => ({...c, tunnel_mode: { mode: "Named", tunnel_id: (c.tunnel_mode as any).tunnel_id, domain: e.target.value }}))} disabled={status === "running"} />
            </div>
          )}

          <div className="cfg-group">
            <span className="cfg-label">Target Port</span>
            <input type="number" className="cfg-input mono" value={appConfig.port} onChange={e => setAppConfig(c => ({...c, port: parseInt(e.target.value) || 8080}))} disabled={status === "running"} />
          </div>

          <div className="cfg-group">
            <span className="cfg-label">Hosting Presets</span>
            <div className="preset-chips">
              <button className={`preset-chip ${appConfig.port === 5173 && appConfig.hosting_type.mode === "Custom" ? "active" : ""}`} onClick={() => setAppConfig(c => ({...c, port: 5173, hosting_type: { mode: "Custom" }}))} disabled={status === "running"}>
                <svg className="preset-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                React
              </button>
              <button className={`preset-chip ${appConfig.port === 3000 && appConfig.hosting_type.mode === "Custom" ? "active" : ""}`} onClick={() => setAppConfig(c => ({...c, port: 3000, hosting_type: { mode: "Custom" }}))} disabled={status === "running"}>
                <svg className="preset-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/></svg>
                Next.js
              </button>
              <button className={`preset-chip ${appConfig.hosting_type.mode === "Website" ? "active" : ""}`} onClick={async () => {
                const selected = await openDialog({ directory: true });
                if (selected) {
                  setAppConfig(c => ({...c, hosting_type: { mode: "Website", folder: selected as string }, port: 8000 }));
                }
              }} disabled={status === "running"}>
                <svg className="preset-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                Static Folder
              </button>
            </div>
            {appConfig.hosting_type.mode === "Website" && (
               <div className="cfg-subtext">Serving: {appConfig.hosting_type.folder}</div>
            )}
          </div>
        </aside>

        {/* ── RIGHT PANEL ── */}
        <main className="right-panel">
          {/* Session bar */}
          <div className="session-bar">
            <div className="session-info">
              <span className="session-label">SESSION</span>
              <span className="session-id">{sessionId}</span>
            </div>
            {status === "running" && (
              <div className="elapsed-timer">{fmtTime(elapsed)}</div>
            )}
          </div>

          {/* Action area */}
          <div className="action-area">

            {/* Error card */}
            {status === "error" && errorInfo && (
              <div className="error-card">
                <div className="error-card-title">{errorInfo.title.length > 72 ? errorInfo.title.slice(0, 69) + "…" : errorInfo.title}</div>
                {errorInfo.desc && <div className="error-card-desc">{errorInfo.desc}</div>}
                <div className="error-code-badge">{errorInfo.code}</div>
              </div>
            )}

            {/* Live card */}
            {status === "completed" && liveUrl && (
              <div className="live-card">
                <div className="live-url-wrap">
                  <div className="live-url-label">LIVE URL</div>
                  <div className="live-url">{liveUrl}</div>
                </div>
                <div className="live-card-actions">
                  <button className={`copy-btn ${copied ? "copied" : ""}`} onClick={() => {
                    navigator.clipboard.writeText(liveUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}>
                    {copied ? "Copied!" : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                          <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" stroke="currentColor" strokeWidth="1.2"/>
                        </svg>
                        Copy URL
                      </>
                    )}
                  </button>
                  <button className="copy-btn secondary" onClick={() => window.open(liveUrl, "_blank")}>
                    Open link
                  </button>
                </div>
              </div>
            )}

            {/* Main button */}
            <ActionButton
              status={status}
              onClick={handleButton}
              activeStep={Object.entries(steps).find(([, s]) => s.status === 'active')?.[0]}
            />

            {/* Sub-text */}
            <div className="action-subtext">
              {status === "idle" || status === "stopped"
                ? "Ready to start — 0 active sessions"
                : status === "running"
                ? <ConnectingDots />
                : status === "completed"
                ? `Live at ${liveUrl}`
                : "Click Retry to try again"}
            </div>
          </div>

          {/* Logs strip */}
          <div className="logs-strip">
            <div className="logs-header-row">
              <button className="logs-header" onClick={() => setLogsOpen((o) => !o)}>
                <span className="logs-label">LOGS</span>
                <span className="logs-chevron">{logsOpen ? "▲" : "▼"}</span>
              </button>
              {logsOpen && (
                <div className="logs-tools">
                   <select className="log-filter" value={logFilter} onChange={e => setLogFilter(e.target.value as any)}>
                     <option value="ALL">ALL</option>
                     <option value="INFO">INFO</option>
                     <option value="ERR">ERROR</option>
                   </select>
                   <button className={`log-tool-btn ${autoScroll ? "active" : ""}`} onClick={() => setAutoScroll(a => !a)}>
                     Scroll: {autoScroll ? "ON" : "OFF"}
                   </button>
                   <button className="log-tool-btn" onClick={() => navigator.clipboard.writeText(filteredLogs.map((l: LogLine) => `[${l.ts}] [${l.type}] ${l.text}`).join('\n'))}>
                     Copy
                   </button>
                </div>
              )}
            </div>
            <div className={`logs-body ${logsOpen ? "logs-open" : ""}`}>
              {logsOpen
                ? (filteredLogs.length === 0
                  ? <div className="log-empty">No activity records found</div>
                  : filteredLogs.map((l: LogLine) => <LogRow key={l.id} log={l} />))
                : lastTwoLogs.length === 0
                  ? <div className="log-empty mini">Waiting for system events...</div>
                  : lastTwoLogs.map((l: LogLine) => <LogRow key={l.id} log={l} />)
              }
              <div ref={logsEndRef} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepRow({ idx, meta, state, isLast }: {
  idx: number; meta: StepMeta; state: StepState; isLast: boolean;
}) {
  const { status, progress, elapsed, skipped } = state;
  return (
    <div className="step-row">
      <div className="step-col">
        <div className={`step-node node-${status}`}>
          {status === "done" || status === "skip"
            ? <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 8 9 4"/></svg>
            : status === "error"
            ? <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>
            : status === "active"
            ? <div className="step-spinner" />
            : <span className="node-num">{idx + 1}</span>
          }
        </div>
        {!isLast && <div className={`step-line ${status === "done" || status === "skip" ? "line-done" : "line-pend"}`} />}
      </div>
      <div className="step-info">
        <div className="step-name-row">
          <span className={`step-name ${status === "pending" ? "name-pending" : ""}`}>{meta.label}</span>
          {status === "active" && elapsed > 0.5 && (
            <span className="step-elapsed">{elapsed.toFixed(1)}s</span>
          )}
          {skipped && <span className="step-skip-tag">skip</span>}
        </div>
        <div className="step-desc">{meta.desc}</div>
        {/* Progress bar only for downloading */}
        {idx === 3 && (status === "active" || status === "done") && (
          <div className="prog-track">
            <div className="prog-fill" style={{ width: `${progress}%` }} />
            <span className="prog-pct">{progress}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({ status, onClick, activeStep }: { status: PipelineStatus; onClick: () => void; activeStep?: string }) {
  const isConnecting = activeStep === "connecting";
  const cfg = {
    idle:      { label: "▶  Start Hosting", cls: "btn-start" },
    stopped:   { label: "▶  Start Hosting", cls: "btn-start" },
    running:   { label: "⏹  Stop",  cls: "btn-stop"  },
    error:     { label: "↺  Retry",         cls: "btn-retry" },
    completed: { label: "⏹  Stop",  cls: "btn-stop"  },
  }[status];
  return (
    <button
      className={`action-btn ${cfg.cls}`}
      onClick={onClick}
      disabled={isConnecting}
      style={{ opacity: isConnecting ? 0.5 : 1, cursor: isConnecting ? "not-allowed" : "pointer" }}
    >
      {isConnecting ? "Connecting..." : cfg.label}
    </button>
  );
}



function ConnectingDots() {
  return (
    <span className="connecting-wrap">
      Establishing tunnel
      <span className="dot d1">.</span>
      <span className="dot d2">.</span>
      <span className="dot d3">.</span>
    </span>
  );
}

function LogRow({ log }: { log: LogLine }) {
  const cls = { INFO: "log-info", OK: "log-ok", ERR: "log-err", SYS: "log-sys" }[log.type];
  return (
    <div className={`log-line ${cls}`}>
      [{log.ts}] [{log.type}] {log.text}
    </div>
  );
}
