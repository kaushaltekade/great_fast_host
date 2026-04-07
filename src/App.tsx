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

// ─── Demo simulation ──────────────────────────────────────────────────────────

const DEMO_URL = "https://fkhost-demo.trycloudflare.com";

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

  // Load config on mount
  useEffect(() => {
    invoke<AppConfig>("get_config").then(cfg => {
      setAppConfig(cfg);
    }).catch(() => {});
  }, []);

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

  // ── Demo simulation ──────────────────────────────────────────────────────────
  const runDemo = useCallback(async () => {
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
    addLog("SYS", `Session started · ${sid.slice(0, 8)}`);

    const setStep = (k: StepKey, st: StepStatus, prog = 0) => {
      setSteps((prev) => ({ ...prev, [k]: { ...prev[k], status: st, progress: prog, startTs: Date.now() / 1000 } }));
    };
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Steps 0–2 quick
    for (const k of ["initializing","config_loaded","checking_tunnel"] as StepKey[]) {
      setStep(k, "active");
      addLog("INFO", `[${STEP_META[k].label}] ${STEP_META[k].desc}`);
      await delay(700);
      setStep(k, "done");
      addLog("OK", `[${STEP_META[k].label}] complete`);
    }

    // Step 3: downloading with progress
    setStep("downloading", "active");
    addLog("INFO", "Fetching cloudflared · 47 MB");
    for (let p = 0; p <= 100; p += 4) {
      await delay(100);
      setSteps((prev) => ({ ...prev, downloading: { ...prev.downloading, progress: p } }));
    }
    setStep("downloading", "done", 100);
    addLog("OK", "Binary downloaded · 47.2 MB");

    // Steps 4–6
    for (const k of ["verifying","starting_tunnel","connecting"] as StepKey[]) {
      setStep(k, "active");
      addLog("INFO", `[${STEP_META[k].label}] ${STEP_META[k].desc}`);
      await delay(k === "connecting" ? 900 : 500);
      setStep(k, "done");
      addLog("OK", `[${STEP_META[k].label}] complete`);
    }

    // Live
    setStep("live", "done");
    setLiveUrl(DEMO_URL);
    isLockedRef.current = true;
    setStatus("completed");
    addLog("OK", `Tunnel live · ${DEMO_URL}`);
  }, [addLog]);

  // ── Real start / stop ────────────────────────────────────────────────────────
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
  }, [addLog]);

  const handleStop = useCallback(async () => {
    try { await invoke("stop_tunnel", { sessionId: sessionRef.current }); } catch (_) {}
    setStatus("stopped");
    addLog("SYS", "Session stopped by user");
  }, [addLog]);

  // Detect if Tauri is available
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const handleButton = () => {
    if (status === "running") {
      isTauri ? handleStop() : setStatus("idle");
    } else {
      isTauri ? handleStart() : runDemo();
    }
  };

  const lastTwoLogs = logs.slice(-2);
  const filteredLogs = logs.filter(l => logFilter === "ALL" || (logFilter === "ERR" && l.type === "ERR") || (logFilter === "INFO" && (l.type === "INFO" || l.type === "OK" || l.type === "SYS")));

  return (
    <div className="root">

      {/* ── Titlebar ── */}
      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-left" data-tauri-drag-region>
          <span className="tb-wordmark">fk<strong>host</strong></span>
          <span className="tb-version">v0.4.1</span>
        </div>
        <div className="tb-right">
          <StatusPill status={status} />
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
            <select
              className="host-select"
              value={appConfig.tunnel_mode.mode}
              onChange={(e) => setAppConfig(c => ({...c, tunnel_mode: e.target.value === "Quick" ? { mode: "Quick" } : { mode: "Named", tunnel_id: "", domain: "" }}))}
              disabled={status === "running"}
            >
              <option value="Quick">Quick (Random URL)</option>
              <option value="Named">Custom Domain</option>
            </select>
          </div>

          {appConfig.tunnel_mode.mode === "Named" && (
            <div className="cfg-sub">
              <input type="text" className="cfg-input" placeholder="Tunnel UUID" value={appConfig.tunnel_mode.tunnel_id} onChange={e => setAppConfig(c => ({...c, tunnel_mode: { mode: "Named", tunnel_id: e.target.value, domain: (c.tunnel_mode as any).domain }}))} disabled={status === "running"} />
              <input type="text" className="cfg-input" placeholder="example.com" value={appConfig.tunnel_mode.domain} onChange={e => setAppConfig(c => ({...c, tunnel_mode: { mode: "Named", tunnel_id: (c.tunnel_mode as any).tunnel_id, domain: e.target.value }}))} disabled={status === "running"} />
            </div>
          )}

          <div className="cfg-group">
            <span className="cfg-label">Target Port</span>
            <input type="number" className="cfg-input" value={appConfig.port} onChange={e => setAppConfig(c => ({...c, port: parseInt(e.target.value) || 8080}))} disabled={status === "running"} />
          </div>

          <div className="cfg-group">
            <span className="cfg-label">Presets</span>
            <div className="preset-row">
              <button className="cfg-btn" onClick={() => setAppConfig(c => ({...c, port: 5173, hosting_type: { mode: "Custom" }}))} disabled={status === "running"}>React</button>
              <button className="cfg-btn" onClick={() => setAppConfig(c => ({...c, port: 3000, hosting_type: { mode: "Custom" }}))} disabled={status === "running"}>Next.js</button>
              <button className="cfg-btn" onClick={async () => {
                const selected = await openDialog({ directory: true });
                if (selected) {
                  setAppConfig(c => ({...c, hosting_type: { mode: "Website", folder: selected as string }, port: 8000 }));
                }
              }} disabled={status === "running"}>
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
                <div className="live-card-top">
                  <span className="live-dot" />
                  <span className="live-url">{liveUrl}</span>
                  <button className="copy-btn" onClick={() => navigator.clipboard.writeText(liveUrl)}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                      <path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" stroke="currentColor" strokeWidth="1.2"/>
                    </svg>
                    Copy
                  </button>
                </div>
                <div className="live-card-sub">Secure · Cloudflare · end-to-end encrypted</div>
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
                  ? <div className="log-line log-sys">[{nowTs()}] [SYS] No logs yet</div>
                  : filteredLogs.map((l: LogLine) => <LogRow key={l.id} log={l} />))
                : lastTwoLogs.length === 0
                  ? <div className="log-line log-sys">[{nowTs()}] [SYS] Waiting for events…</div>
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
            ? <svg width="9" height="9" viewBox="0 0 9 9"><polyline points="1,5 3.5,7.5 8,2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : status === "error"
            ? <svg width="8" height="8" viewBox="0 0 8 8"><line x1="0" y1="0" x2="8" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="8" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            : status === "active"
            ? null
            : <span className="node-num">{idx}</span>
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

function StatusPill({ status }: { status: PipelineStatus }) {
  const labels: Record<PipelineStatus, string> = {
    idle: "IDLE", running: "RUNNING", error: "ERROR", completed: "LIVE", stopped: "IDLE",
  };
  return <div className={`status-pill pill-${status}`}><span className="pill-dot" />{labels[status]}</div>;
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
