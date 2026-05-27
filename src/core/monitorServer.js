/**
 * 內建監控 HTTP 伺服器
 *
 * - 登入前：顯示 QR Code 頁面供掃描
 * - 登入後：即時監控儀表板（統計數據 + 即時 terminal 日誌串流）
 * - SSE (Server-Sent Events) 推送即時日誌
 */

const http = require('http');
const { logStream } = require('./logStream');
const drawingSearch = require('../../skills/drawingSearch');

class MonitorServer {
    constructor(port = 3456) {
        this.port = port;
        this._isReady = false;
        this._qrDataUrl = '';
        this._services = null;
        this._server = null;
        this._sseClients = new Set();
    }

    start(services) {
        this._services = services;

        this._server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${this.port}`);

            switch (url.pathname) {
                case '/':
                    this._servePage(res);
                    break;
                case '/api/status':
                    this._serveApiStatus(res);
                    break;
                case '/api/logs/stream':
                    this._serveSse(req, res);
                    break;
                case '/api/deepscan/progress':
                    this._serveDeepscanProgress(res);
                    break;
                case '/deepscan':
                    this._serveDeepscanPage(res);
                    break;
                case '/api/deepscan/start':
                    this._serveDeepscanStart(res);
                    break;
                default:
                    res.writeHead(404);
                    res.end('Not Found');
            }
        });

        // SSE 訂閱日誌事件
        logStream.on('line', (line) => {
            const data = JSON.stringify(line);
            for (const client of this._sseClients) {
                try {
                    client.write(`data: ${data}\n\n`);
                } catch {}
            }
        });

        this._server.listen(this.port, () => {
            console.log(`🌐 監控儀表板: http://localhost:${this.port}`);
        });
    }

    setQrDataUrl(dataUrl) {
        this._qrDataUrl = dataUrl;
    }
    setReady(ready = true) {
        this._isReady = ready;
    }

    stop() {
        if (this._server) this._server.close();
    }

    // ========== SSE ==========

    _serveSse(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // 發送歷史日誌
        const recent = logStream.getRecent();
        for (const line of recent.slice(-50)) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
        }

        this._sseClients.add(res);
        req.on('close', () => {
            this._sseClients.delete(res);
        });
    }

    // ========== Page ==========

    _servePage(res) {
        const isReady = this._isReady;
        const qrData = this._qrDataUrl;

        const html = buildPage(isReady, qrData);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }

    // ========== API ==========

    _serveApiStatus(res) {
        if (!this._services) {
            res.writeHead(503);
            return res.end(JSON.stringify({ error: '未初始化' }));
        }

        const {
            authManager,
            sessionManager,
            messageLogger,
            healthMonitor,
            config,
        } = this._services;
        const stats = messageLogger?.getTodayStats() || {};
        const health = healthMonitor?.getSystemStatus() || {};
        const security = authManager?.getSecurityStatus() || {};
        const sessions = sessionManager?.getSummary() || [];

        const uptimeMs = health.uptime?.totalMs || 0;
        const d = Math.floor(uptimeMs / 86400000);
        const h = Math.floor((uptimeMs % 86400000) / 3600000);
        const m = Math.floor((uptimeMs % 3600000) / 60000);

        // 系統資源
        const mem = process.memoryUsage();
        const memory = {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        };
        const diskUsage = health.diskUsage || {
            directories: {},
            formattedTotalSize: '0 B',
        };

        // 熱門發送者 Top 5
        const topSenders = Object.entries(stats.senders || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));

        // 類型分布
        const typeBreakdown = stats.messageTypes || {};

        // 熱門命令 Top 6（從今日日誌解析）
        const topCommands = [];
        try {
            const logFile = messageLogger?.getLogFilename?.();
            if (logFile) {
                const logs = messageLogger.readExistingLogs(logFile);
                const cmdCounts = {};
                logs.forEach((log) => {
                    if (log.type === 'command' && log.content) {
                        const cmd = log.content
                            .trim()
                            .split(/\s+/)[0]
                            .replace(/^[!#]/, '');
                        if (cmd) cmdCounts[cmd] = (cmdCounts[cmd] || 0) + 1;
                    }
                });
                Object.entries(cmdCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 6)
                    .forEach(([cmd, count]) =>
                        topCommands.push({ cmd, count })
                    );
            }
        } catch {}

        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(
            JSON.stringify({
                ready: this._isReady,
                timestamp: new Date().toISOString(),
                uptime: d + 'd ' + h + 'h ' + m + 'm',
                stats: {
                    totalMessages: stats.totalMessages || 0,
                    groupMessages: stats.groupMessages || 0,
                    privateMessages: stats.privateMessages || 0,
                    commands: stats.commands || 0,
                    mediaMessages: stats.mediaMessages || 0,
                    typeBreakdown,
                    topCommands,
                    topSenders,
                },
                security: {
                    whitelistEnabled: security.whitelistEnabled,
                    adminCount: security.adminCount || 0,
                    blockedCount: security.blockedCount || 0,
                    authorizedGroupCount: security.authorizedGroupCount || 0,
                },
                health: {
                    messageCount: health.messageCount || 0,
                    errorCount: health.errorCount || 0,
                },
                system: { memory, diskUsage },
                sessions: sessions.map((s) => ({
                    userId: s.userId,
                    handler: s.handler,
                    step: s.step,
                    elapsedSeconds: s.elapsedSeconds,
                })),
                commandPrefix: config?.bot?.prefix || '!',
                version: config?.project?.version || '1.0.0',
                qrDataUrl: this._qrDataUrl || null,
            })
        );
    }

    // ========== DeepScan Progress API ==========

    _serveDeepscanProgress(res) {
        const p = drawingSearch.deepscanProgress || {};
        const elapsed = p.startTime ? (Date.now() - new Date(p.startTime).getTime()) : 0;
        const pct = p.total > 0 ? Math.min(100, Math.round(p.current / p.total * 100)) : 0;

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            running: p.running || false,
            total: p.total || 0,
            current: p.current || 0,
            percent: pct,
            currentFile: p.currentFile || '',
            scannedCount: p.scannedCount || 0,
            cachedCount: p.cachedCount || 0,
            errorCount: p.errorCount || 0,
            mappingCount: p.mappingCount || 0,
            dwgCount: p.dwgCount || 0,
            phase: p.phase || '',
            elapsedMs: elapsed,
            elapsedText: formatDuration(elapsed),
            startTime: p.startTime || '',
        }));
    }

    _serveDeepscanPage(res) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildDeepscanPage());
    }

    _serveDeepscanStart(res) {
        if (drawingSearch.deepscanProgress.running) {
            res.writeHead(409);
            return res.end(JSON.stringify({ error: '已有掃描正在執行' }));
        }

        const config = require('../../configs/settings.json');
        const porPath = config.paths?.por;
        if (!porPath) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: 'POR 路徑未設定' }));
        }

        // 異步啟動掃描（唔 block response）
        drawingSearch.rebuildTgMapping(porPath).catch(err => {
            console.error('Deep Scan 錯誤:', err);
        });

        res.writeHead(202);
        res.end(JSON.stringify({ message: '掃描已啟動', por: porPath }));
    }
}

// =============================================================================
// 頁面建構（獨立函數，使用 template literal 避免引號逃逸問題）
// =============================================================================

function buildPage(isReady, qrData) {
    const dotClass = isReady ? 'on' : 'off';
    const statusText = isReady ? '已連接' : '等待掃碼';
    const qrHidden = isReady ? 'hidden' : '';
    const dashHidden = isReady ? '' : 'hidden';
    const qrImg = qrData
        ? `<img src="${qrData}" alt="QR Code">`
        : '<p>⏳ QR Code 生成中...</p>';

    return `<!DOCTYPE html>
<html lang="zh-HK">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PBOTS 監控儀表板</title>
<style>
:root{--bg:#0a0f1a;--srf:#111827;--srf2:#161f30;--bd:#1e293b;--tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--ac:#38bdf8;--gn:#22c55e;--rd:#ef4444;--am:#f59e0b;--pu:#a855f7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;overflow:hidden}
.header{background:var(--srf);padding:10px 20px;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:center;height:44px;flex-shrink:0}
.header h1{font-size:1rem;color:var(--ac);font-weight:600;letter-spacing:-0.3px}
.header-r{display:flex;align-items:center;gap:10px;font-size:0.75rem;color:var(--t3)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%}
.dot.on{background:var(--gn);box-shadow:0 0 6px var(--gn)}
.dot.off{background:var(--rd);box-shadow:0 0 6px var(--rd)}
.main{display:flex;height:calc(100vh - 44px)}
.left{flex:1;overflow-y:auto;padding:14px;scroll-behavior:smooth}
.left::-webkit-scrollbar{width:4px}
.left::-webkit-scrollbar-thumb{background:var(--bd);border-radius:4px}
.right{width:420px;background:var(--srf);border-left:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0}
.log-toolbar{background:var(--srf2);padding:8px 10px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex-shrink:0}
.log-toolbar .lbl{font-size:0.7rem;color:var(--t3);margin-right:4px;white-space:nowrap}
.fbtn{background:transparent;border:1px solid var(--bd);color:var(--t3);padding:3px 8px;border-radius:4px;font-size:0.65rem;cursor:pointer;transition:all .15s;white-space:nowrap}
.fbtn:hover{background:var(--srf);color:var(--t2)}
.fbtn.on{background:#1e3a5f;border-color:var(--ac);color:var(--ac)}
.fbtn.on.warn-f{background:#422006;border-color:var(--am);color:var(--am)}
.fbtn.on.err-f{background:#450a0a;border-color:var(--rd);color:var(--rd)}
.log-search{background:var(--srf);border:1px solid var(--bd);color:var(--tx);padding:3px 8px;border-radius:4px;font-size:0.65rem;width:90px;outline:none}
.log-search:focus{border-color:var(--ac)}
.log-search::placeholder{color:var(--t3)}
.log-spacer{flex:1}
.toggle-btn{font-size:0.6rem;padding:2px 7px;border-radius:4px;border:1px solid var(--bd);background:transparent;color:var(--t3);cursor:pointer;white-space:nowrap;transition:all .15s}
.toggle-btn:hover{color:var(--t2)}
.toggle-btn.paused{background:#450a0a;border-color:var(--rd);color:var(--rd)}
.log-body{flex:1;overflow-y:auto;padding:6px 8px;font-family:"SF Mono",Monaco,Menlo,monospace;font-size:0.68rem;line-height:1.45}
.log-body::-webkit-scrollbar{width:4px}
.log-body::-webkit-scrollbar-thumb{background:var(--bd);border-radius:4px}
.log-line{padding:1px 4px;display:flex;gap:6px;border-bottom:1px solid rgba(30,41,59,0.3)}
.log-line .t{color:#334155;white-space:nowrap;flex-shrink:0}
.log-line .m{word-break:break-all;color:var(--t2)}
.log-line.warn .m{color:var(--am)}
.log-line.error .m{color:var(--rd)}
.log-line.hidden{display:none}
.sse-bar{background:var(--srf2);border-top:1px solid var(--bd);padding:4px 10px;font-size:0.6rem;color:var(--t3);display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
.sse-bar .err{color:var(--rd);display:none;margin-left:8px}
.sse-bar .err.show{display:inline}
.qr-section{text-align:center;padding:60px 20px}
.qr-section img{max-width:280px;border:3px solid #25D366;border-radius:12px;padding:12px;background:#fff}
.qr-section h2{color:#25D366;margin-bottom:16px;font-size:1.2rem}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px}
.card{background:var(--srf);border:1px solid var(--bd);border-radius:10px;overflow:hidden;transition:border-color .2s}
.card:hover{border-color:#334155}
.card-hd{padding:10px 14px;display:flex;justify-content:space-between;align-items:center;user-select:none}
.card-hd h3{font-size:0.68rem;font-weight:500;color:var(--t3);letter-spacing:0.3px}
.card-val{font-size:1.5rem;font-weight:700;color:var(--tx);line-height:1.1}
.card-val.sm{font-size:1.1rem}
.card-sub{font-size:0.65rem;color:var(--t3);margin-top:2px}
.card-detail{padding:0 14px 12px;border-top:1px solid var(--bd);font-size:0.7rem}
.d-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;color:var(--t2)}
.d-row .k{color:var(--t3)}
.d-row .v{font-weight:500;font-variant-numeric:tabular-nums;text-align:right}
.d-sep{font-size:0.6rem;color:var(--t3);padding:5px 0 1px;letter-spacing:0.5px}
.mini-bar{height:5px;border-radius:3px;background:var(--bd);overflow:hidden;margin:4px 0 6px;display:flex}
.mini-bar .seg{height:100%;transition:width .4s}
.mini-bar .seg.grp{background:var(--ac)}
.mini-bar .seg.pvt{background:var(--pu)}
.badge{display:inline-block;padding:1px 6px;border-radius:5px;font-size:0.6rem;font-weight:600}
.badge.g{background:#064e3b;color:var(--gn)}
.badge.r{background:#450a0a;color:var(--rd)}
.badge.y{background:#422006;color:var(--am)}
.hidden{display:none!important}
.tag{display:inline-block;background:var(--srf2);color:var(--t3);padding:1px 5px;border-radius:3px;font-size:0.6rem;margin-right:2px}
@media(max-width:768px){
.main{flex-direction:column}
.right{width:100%;height:45vh;border-left:none;border-top:1px solid var(--bd)}
.left{flex:none}
.cards{grid-template-columns:1fr}
.log-search{width:60px}
}
</style>
</head>
<body>
<div class="header">
  <h1>PBOTS 監控儀表板</h1>
  <div class="header-r" id="status-indicator">
    <span class="dot ${dotClass}"></span>
    <span id="status-text">${statusText}</span>
    <span style="margin-left:6px" id="refresh-time"></span>
  </div>
</div>
<div class="main">
  <div class="left">
    <div id="qr-section" class="qr-section ${qrHidden}">
      <h2>📱 請用 WhatsApp 掃描 QR Code</h2>
      ${qrImg}
      <p style="color:var(--t3);font-size:0.75rem;margin-top:12px">掃描成功後頁面自動切換為監控儀表板</p>
    </div>

    <div id="dashboard" class="${dashHidden}">
      <div class="cards">
        <div class="card">
          <div class="card-hd"><h3>📨 今日訊息</h3></div>
          <div style="padding:0 14px"><div class="card-val" id="m-total">-</div></div>
          <div class="card-detail" id="det-msgs"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>⚡ 命令與媒體</h3></div>
          <div style="padding:0 14px"><div class="card-val" id="m-cmd">-</div></div>
          <div class="card-detail" id="det-cmds"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>👑 管理</h3></div>
          <div style="padding:0 14px"><div class="card-val sm" id="m-admin">-</div></div>
          <div class="card-detail" id="det-admin"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>⏱️ 運行</h3></div>
          <div style="padding:0 14px"><div class="card-val sm" id="m-uptime">-</div></div>
          <div class="card-detail" id="det-sys"></div>
        </div>
      </div>
      <div class="cards">
        <div class="card">
          <div class="card-hd"><h3>📋 活躍會話</h3></div>
          <div class="card-detail" id="det-sessions"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>🔐 安全</h3></div>
          <div class="card-detail" id="det-sec"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="right">
    <div class="log-toolbar">
      <span class="lbl">📟 即時日誌</span>
      <button class="fbtn on" data-lvl="all">All</button>
      <button class="fbtn" data-lvl="info">Info</button>
      <button class="fbtn warn-f" data-lvl="warn">Warn</button>
      <button class="fbtn err-f" data-lvl="error">Error</button>
      <span class="log-spacer"></span>
      <input class="log-search" id="log-search" placeholder="搜尋...">
      <button class="toggle-btn" id="btn-clear">清除</button>
      <button class="toggle-btn" id="btn-scroll">暂停捲動</button>
    </div>
    <div class="log-body" id="log-container"></div>
    <div class="sse-bar">
      <span>已寫入 <span id="log-count">0</span> 條</span>
      <span class="err" id="sse-err">⚠ 日誌串流已斷線，正在重連…</span>
    </div>
  </div>
</div>

<script>
var isReady = ${isReady};
var activeFilter = "all";
var autoScroll = true;
var MAX_LINES = 300;
var logContainer = document.getElementById("log-container");
var logCount = 0;
var logSearchText = "";

// ---- Log helpers ----
function addLog(line) {
  var el = document.createElement("div");
  el.className = "log-line " + line.level;
  el.setAttribute("data-level", line.level);
  el.innerHTML = '<span class="t">' + line.time + '</span><span class="m">' + hesc(line.text) + '</span>';
  if (activeFilter !== "all" && line.level !== activeFilter) el.classList.add("hidden");
  if (logSearchText && line.text.toLowerCase().indexOf(logSearchText) === -1) el.classList.add("hidden");
  logContainer.appendChild(el);
  logCount++;
  document.getElementById("log-count").textContent = logCount;
  while (logContainer.children.length > MAX_LINES) logContainer.removeChild(logContainer.firstChild);
  if (autoScroll) logContainer.scrollTop = logContainer.scrollHeight;
}
function hesc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function reapplyFilters() {
  var lines = logContainer.children;
  for (var i = 0; i < lines.length; i++) {
    var lv = lines[i].getAttribute("data-level");
    var okLvl = activeFilter === "all" || lv === activeFilter;
    var okSearch = !logSearchText || (lines[i].textContent || "").toLowerCase().indexOf(logSearchText) !== -1;
    lines[i].classList.toggle("hidden", !okLvl || !okSearch);
  }
}
function applyFilter(lvl) {
  activeFilter = lvl;
  reapplyFilters();
  var btns = document.querySelectorAll(".fbtn");
  for (var i = 0; i < btns.length; i++) btns[i].classList.remove("on");
  var btn = document.querySelector('.fbtn[data-lvl="' + lvl + '"]');
  if (btn) btn.classList.add("on");
}

document.getElementById("log-search").addEventListener("input", function() {
  logSearchText = this.value.toLowerCase();
  reapplyFilters();
});

var filterBtns = document.querySelectorAll(".fbtn");
for (var i = 0; i < filterBtns.length; i++) {
  filterBtns[i].addEventListener("click", function() {
    applyFilter(this.getAttribute("data-lvl"));
  });
}

document.getElementById("btn-clear").addEventListener("click", function() {
  logContainer.innerHTML = ""; logCount = 0;
  document.getElementById("log-count").textContent = "0";
});

document.getElementById("btn-scroll").addEventListener("click", function() {
  autoScroll = !autoScroll;
  this.textContent = autoScroll ? "暂停捲動" : "繼續捲動";
  this.classList.toggle("paused", !autoScroll);
  if (autoScroll) logContainer.scrollTop = logContainer.scrollHeight;
});

// ---- SSE ----
var sseConnected = true;
var sseErr = document.getElementById("sse-err");
var sse = new EventSource("/api/logs/stream");
sse.onopen = function() { sseConnected = true; sseErr.classList.remove("show"); };
sse.onerror = function() {
  if (sseConnected) { sseConnected = false; sseErr.classList.add("show"); }
};
sse.onmessage = function(e) {
  if (!sseConnected) { sseConnected = true; sseErr.classList.remove("show"); }
  try { addLog(JSON.parse(e.data)); } catch(err) {}
};

// ---- Status polling ----
function dRow(k, v) {
  return '<div class="d-row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
}
function dSep(t) { return '<div class="d-sep">' + t + '</div>'; }
function pct(n, t) { return t > 0 ? Math.round(n / t * 100) : 0; }

async function fetchStatus() {
  try {
    var resp = await fetch("/api/status");
    var d = await resp.json();
    if (!isReady && d.ready) {
      isReady = true;
      document.getElementById("qr-section").classList.add("hidden");
      document.getElementById("dashboard").classList.remove("hidden");
      document.getElementById("status-indicator").innerHTML = '<span class="dot on"></span><span>已連接</span><span style="margin-left:6px" id="refresh-time"></span>';
    }
    // 動態更新 QR Code（如果頁面載入時仲未生成）
    if (!isReady && d.qrDataUrl) {
      var qrSection = document.getElementById("qr-section");
      if (qrSection) {
        var existingImg = qrSection.querySelector("img");
        if (existingImg) {
          existingImg.src = d.qrDataUrl;
        } else {
          qrSection.innerHTML = '<h2>📱 請用 WhatsApp 掃描 QR Code</h2><img src="' + d.qrDataUrl + '" alt="QR Code" style="max-width:280px;border:3px solid #25D366;border-radius:12px;padding:12px;background:#fff"><p style="color:var(--t3);font-size:0.75rem;margin-top:12px">掃描成功後頁面自動切換為監控儀表板</p>';
        }
      }
    }
    if (isReady) updateDashboard(d);
    document.getElementById("refresh-time").textContent = new Date().toLocaleTimeString("zh-HK",{hour12:false});
  } catch(err) {}
}

function updateDashboard(d) {
  var s = d.stats || {};
  var sec = d.security || {};
  var sys = d.system || {};
  var mem = sys.memory || {};
  var disk = sys.diskUsage || {};
  var h = d.health || {};

  // Card 1: Messages
  document.getElementById("m-total").textContent = s.totalMessages || 0;
  var grpPct = pct(s.groupMessages, s.totalMessages);
  var pvtPct = 100 - grpPct;
  var types = s.typeBreakdown || {};
  var typeKeys = Object.keys(types).sort(function(a,b){ return types[b] - types[a]; });
  var msgsHtml = '<div class="mini-bar"><div class="seg grp" style="width:' + grpPct + '%"></div><div class="seg pvt" style="width:' + pvtPct + '%"></div></div>';
  msgsHtml += dRow("👥 群組", s.groupMessages || 0);
  msgsHtml += dRow("👤 私訊", s.privateMessages || 0);
  msgsHtml += dSep("類型分布");
  if (typeKeys.length) {
    for (var i = 0; i < typeKeys.length; i++) { msgsHtml += dRow(typeKeys[i], types[typeKeys[i]]); }
  } else { msgsHtml += dRow("暫無", ""); }
  msgsHtml += dSep("最活躍");
  var senders = s.topSenders || [];
  for (var i = 0; i < senders.length; i++) { msgsHtml += dRow((i+1) + ". " + senders[i].name, senders[i].count); }
  document.getElementById("det-msgs").innerHTML = msgsHtml;

  // Card 2: Commands & Media
  document.getElementById("m-cmd").textContent = s.commands || 0;
  var cmdsHtml = dRow("📷 媒體總計", s.mediaMessages || 0);
  cmdsHtml += dSep("常用命令");
  var cmds = s.topCommands || [];
  if (cmds.length) {
    for (var i = 0; i < cmds.length; i++) { cmdsHtml += dRow((i+1) + ". #" + cmds[i].cmd, cmds[i].count); }
  } else { cmdsHtml += dRow("暫無", ""); }
  document.getElementById("det-cmds").innerHTML = cmdsHtml;

  // Card 3: Admin
  document.getElementById("m-admin").textContent = (sec.adminCount || 0) + " 人";
  var adminHtml = dRow("👥 授權群組", (sec.authorizedGroupCount || 0) + " 個");
  adminHtml += dRow("🚫 封鎖", sec.blockedCount || 0);
  adminHtml += dRow("🔌 前綴", d.commandPrefix || "!");
  adminHtml += dRow("📦 版本", d.version || "1.0.0");
  document.getElementById("det-admin").innerHTML = adminHtml;

  // Card 4: Runtime / System
  document.getElementById("m-uptime").textContent = d.uptime || "-";
  var diskDirs = disk.directories || {};
  var sysHtml = dRow("RSS", (mem.rss || 0) + " MB");
  sysHtml += dRow("Heap", (mem.heapUsed || 0) + " / " + (mem.heapTotal || 0) + " MB");
  sysHtml += dRow("📨 累計訊息", h.messageCount || 0);
  sysHtml += dRow("❌ 累計錯誤", h.errorCount || 0);
  sysHtml += dSep("磁碟用量");
  var dkeys = Object.keys(diskDirs);
  for (var i = 0; i < dkeys.length; i++) {
    sysHtml += dRow(dkeys[i], (diskDirs[dkeys[i]] && diskDirs[dkeys[i]].formattedSize) || "0 B");
  }
  document.getElementById("det-sys").innerHTML = sysHtml;

  // Card 5: Active Sessions
  var sessions = d.sessions || [];
  var sessHtml = "";
  if (sessions.length > 0) {
    for (var i = 0; i < sessions.length; i++) {
      var s0 = sessions[i];
      sessHtml += dRow("👤 " + s0.userId, '<span class="badge g">' + s0.handler + '</span> ' + (s0.step||0) + "步 " + (s0.elapsedSeconds||0) + "s");
    }
  } else {
    sessHtml = '<div class="d-row"><span style="color:var(--t3)">暫無</span></div>';
  }
  document.getElementById("det-sessions").innerHTML = sessHtml;

  // Card 6: Security
  var secHtml = '<div class="d-row"><span class="k">白名單模式</span><span class="badge ' + (sec.whitelistEnabled ? "g" : "r") + '">' + (sec.whitelistEnabled ? "啟用" : "禁用") + '</span></div>';
  secHtml += dRow("👑 管理員", (sec.adminCount || 0) + " 人");
  secHtml += dRow("👥 授權群組", (sec.authorizedGroupCount || 0) + " 個");
  secHtml += dRow("🚫 封鎖用戶", sec.blockedCount || 0);
  document.getElementById("det-sec").innerHTML = secHtml;
}

fetchStatus(); setInterval(fetchStatus, 5000);
</script>
</body>
</html>`;
}

// ========== DeepScan 進度頁面 ==========

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
}

function buildDeepscanPage() {
    return `<!DOCTYPE html>
<html lang="zh-HK">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PBOTS Deep Scan 進度</title>
<style>
:root{--bg:#0a0f1a;--srf:#111827;--srf2:#161f30;--bd:#1e293b;--tx:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--ac:#38bdf8;--gn:#22c55e;--rd:#ef4444;--am:#f59e0b}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.container{max-width:600px;width:100%;background:var(--srf);border:1px solid var(--bd);border-radius:16px;padding:32px}
h1{font-size:1.2rem;color:var(--ac);margin-bottom:8px;text-align:center}
.sub{font-size:0.75rem;color:var(--t3);text-align:center;margin-bottom:24px}
.progress-wrap{background:var(--srf2);border-radius:12px;padding:24px;margin-bottom:16px}
.progress-label{display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:8px}
.progress-label .pct{color:var(--ac);font-weight:700;font-size:1.5rem}
.progress-label .count{color:var(--t2)}
.bar-bg{height:20px;background:var(--bd);border-radius:10px;overflow:hidden;margin-bottom:12px}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--ac),var(--gn));border-radius:10px;transition:width .5s ease;width:0%}
.filename{font-size:0.75rem;color:var(--t2);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:4px 0}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px}
.stat-box{background:var(--srf2);border-radius:8px;padding:12px;text-align:center}
.stat-box .num{font-size:1.3rem;font-weight:700;color:var(--tx)}
.stat-box .lbl{font-size:0.65rem;color:var(--t3);margin-top:2px}
.stat-box .num.gn{color:var(--gn)}
.stat-box .num.am{color:var(--am)}
.stat-box .num.rd{color:var(--rd)}
.phase{display:flex;justify-content:center;align-items:center;gap:8px;font-size:0.8rem;color:var(--t2);padding:8px}
.phase .spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--bd);border-top:2px solid var(--ac);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.phase.done{color:var(--gn)}
.phase.done .spinner{display:none}
.phase.idle .spinner{display:none}
.back-link{display:block;text-align:center;margin-top:16px;font-size:0.75rem;color:var(--t3)}
.back-link a{color:var(--ac);text-decoration:none}
.back-link a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
  <h1>🔍 TG Deep Scan</h1>
  <div class="sub">位置圖 DWG 預建索引進度</div>

  <div class="progress-wrap">
    <div class="progress-label">
      <span class="pct" id="pct">0%</span>
      <span class="count" id="count">0 / 0</span>
    </div>
    <div class="bar-bg"><div class="bar-fill" id="bar"></div></div>
    <div class="filename" id="filename">—</div>
  </div>

  <div class="stats">
    <div class="stat-box"><div class="num" id="s-scanned">0</div><div class="lbl">已掃描</div></div>
    <div class="stat-box"><div class="num" id="s-cached">0</div><div class="lbl">快取命中</div></div>
    <div class="stat-box"><div class="num gn" id="s-mappings">0</div><div class="lbl">映射數</div></div>
    <div class="stat-box"><div class="num am" id="s-errors">0</div><div class="lbl">錯誤</div></div>
  </div>

  <div class="phase idle" id="phase">
    <span class="spinner"></span>
    <span id="phase-text">等待掃描…</span>
  </div>

  <div id="time-info" style="text-align:center;font-size:0.7rem;color:var(--t3)"></div>

  <div class="back-link"><a href="/">← 返回儀表板</a></div>
</div>

<script>
function fmt(s) { return Math.floor(s / 60) + "m " + (s % 60) + "s"; }

async function poll() {
    try {
        var r = await fetch("/api/deepscan/progress");
        var d = await r.json();

        document.getElementById("pct").textContent = d.percent + "%";
        document.getElementById("count").textContent = d.current + " / " + d.total;
        document.getElementById("bar").style.width = d.percent + "%";
        document.getElementById("filename").textContent = d.currentFile || "—";
        document.getElementById("s-scanned").textContent = d.scannedCount;
        document.getElementById("s-cached").textContent = d.cachedCount;
        document.getElementById("s-mappings").textContent = d.mappingCount;
        document.getElementById("s-errors").textContent = d.errorCount;
        document.getElementById("phase-text").textContent = d.phase || (d.running ? "掃描中…" : "待機");
        document.getElementById("time-info").textContent = "已用 " + d.elapsedText;

        var phase = document.getElementById("phase");
        phase.className = "phase";
        if (!d.running) phase.classList.add("done");

    } catch(e) {}
    setTimeout(poll, 1000);
}
poll();
</script>
</body>
</html>`;
}

module.exports = MonitorServer;
