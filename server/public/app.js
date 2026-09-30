// BotFleet dashboard. Dependency-free SPA with hash routing.
const TOKEN = document.querySelector('meta[name="botfleet-token"]').content;
const ORIGIN = document.querySelector('meta[name="botfleet-origin"]').content;
const PALETTE = ["#8b6cff", "#22c55e", "#f59e0b", "#06b6d4", "#ef4444", "#ec4899", "#a3e635", "#f97316", "#3b82f6", "#14b8a6", "#e879f9", "#94a3b8"];

const state = { settings: null, bots: [], models: {}, stats: null, runs: [] };
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = new Intl.NumberFormat();
const money = (n) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const compact = (n) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-botfleet-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="badge ${kind}"><span class="dot"></span></span><span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }], { duration: 200 }).finished.then(() => el.remove()), 3200);
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const glyph = (b, cls = "") => `<div class="glyph ${cls}" style="--c:${esc(b.color)}">${esc(b.glyph)}</div>`;
const hostAvatar = (host) => {
  const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<div class="glyph sm" style="--c:hsl(${hue} 45% 42%)">${esc(host[0]?.toUpperCase() || "?")}</div>`;
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const views = {
  async overview() {
    const [stats, runs] = await Promise.all([api("/stats"), api("/runs?limit=6")]);
    state.stats = stats;
    const s = state.settings;
    const enabled = state.bots.filter((b) => b.enabled).length;
    const max = Math.max(1, ...stats.daily.map((d) => d.recs));
    const W = 700, H = 200, pad = 24, bw = (W - pad) / stats.daily.length;
    const bars = stats.daily
      .map((d, i) => {
        const h = Math.max(2, ((H - 40) * d.recs) / max);
        const x = pad + i * bw + 5;
        const label = new Date(d.day + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return `<rect class="bar-bg" x="${x}" y="10" width="${bw - 10}" height="${H - 40}" rx="6"/>
          <rect class="bar" x="${x}" y="${H - 30 - h}" width="${bw - 10}" height="${h}" rx="6"><title>${label}: ${d.recs} recommendations, ${d.runs} deployments</title></rect>
          ${i % 2 === 0 ? `<text x="${x + (bw - 10) / 2}" y="${H - 10}" text-anchor="middle">${label}</text>` : ""}`;
      })
      .join("");
    const maxBot = Math.max(1, ...stats.topBots.map((b) => b.recs));

    return `
      <div class="page-head">
        <div><h1>Fleet overview</h1><p>Every deployment your bots have made, what they recommended, and what it cost.</p></div>
        <div class="row"><a class="btn" href="#/bots">Manage bots</a><a class="btn primary" href="#/extension">Open extension setup</a></div>
      </div>
      ${
        !s.hasKey
          ? `<div class="callout warn" style="margin-bottom:18px"><div style="font-size:20px">🔑</div><div style="flex:1"><b>Connect your AI to launch the fleet</b><span class="muted">Bots run on your own Claude API key. It's encrypted on this machine and never leaves it except to call the API.</span></div><a class="btn primary sm" href="#/credentials">Add API key</a></div>`
          : ""
      }
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Deployments</div><div class="value">${fmt.format(stats.deployments)}</div><div class="sub">${fmt.format(stats.botRuns)} bot runs total</div></div>
        <div class="card kpi"><div class="label">Recommendations</div><div class="value">${fmt.format(stats.recommendations)}</div><div class="sub">${stats.botRuns ? (stats.recommendations / stats.botRuns).toFixed(1) : "0"} per bot run</div></div>
        <div class="card kpi"><div class="label">AI spend</div><div class="value">${money(stats.cost)}</div><div class="sub">${compact(stats.tokens)} tokens · ${compact(stats.cachedTokens)} from cache</div></div>
        <div class="card kpi"><div class="label">Active bots</div><div class="value">${enabled}<span class="faint" style="font-size:18px"> / ${state.bots.length}</span></div><div class="sub">avg ${(stats.avgMs / 1000).toFixed(1)}s per bot · ${state.models[s.model]?.label || s.model}</div></div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="row"><h2 style="margin:0">Recommendations, last 14 days</h2><span class="spacer"></span><span class="badge accent">${fmt.format(stats.daily.reduce((n, d) => n + d.recs, 0))} total</span></div>
          <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="margin-top:12px">
            <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b6cff"/><stop offset="1" stop-color="#5b8cff" stop-opacity=".6"/></linearGradient></defs>
            ${bars}
          </svg>
        </div>
        <div class="card">
          <h2>Top performers</h2>
          <div class="list">
            ${
              stats.topBots.length
                ? stats.topBots.map((b) => `<div class="list-row">${glyph(b, "sm")}<div style="flex:1;min-width:0"><div style="font-weight:600">${esc(b.name)}</div><div class="faint" style="font-size:12px">${b.runs} runs</div></div><div class="meter" style="--c:${esc(b.color)}"><i style="width:${(100 * b.recs) / maxBot}%"></i></div><b style="width:32px;text-align:right">${b.recs}</b></div>`).join("")
                : `<div class="faint" style="padding:20px 0">No runs yet. Deploy from the extension and results land here.</div>`
            }
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="row" style="margin-bottom:6px"><h2 style="margin:0">Recent deployments</h2><span class="spacer"></span><a class="btn ghost sm" href="#/activity">View all →</a></div>
        <div class="list">${runs.length ? runs.map(runRowCompact).join("") : `<div class="faint" style="padding:20px 0">Nothing yet.</div>`}</div>
      </div>`;
  },

  async bots() {
    const all = state.bots;
    const on = all.filter((b) => b.enabled).length;
    return `
      <div class="page-head">
        <div><h1>Bots</h1><p>Each bot is a mission, a set of sites it targets, and how hard it thinks. "Deploy all" in the extension launches every enabled bot that targets the page.</p></div>
        <div class="row">
          <button class="btn" data-act="bulk-on">Enable all</button>
          <button class="btn" data-act="bulk-off">Disable all</button>
          <button class="btn ghost" data-act="reset">Restore defaults</button>
          <button class="btn primary" data-act="new-bot"><svg viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>New bot</button>
        </div>
      </div>
      <div class="row" style="margin-bottom:14px"><span class="badge good"><span class="dot"></span>${on} enabled</span><span class="badge">${all.filter((b) => b.autoRun && b.enabled).length} on auto-pilot</span></div>
      <div class="grid bots">
        ${all.map(botCard).join("")}
        <div class="card bot-card new" data-act="new-bot"><div class="plus">+</div><b>Build a new bot</b><span class="faint" style="font-size:12.5px">Give it a mission in plain English</span></div>
      </div>`;
  },

  async activity() {
    state.runs = await api("/runs?limit=200");
    return `
      <div class="page-head">
        <div><h1>Activity</h1><p>Every deployment with the full set of recommendations each bot returned.</p></div>
        <div class="row"><input class="input" id="run-q" placeholder="Filter by site or title…" style="width:240px" /><button class="btn danger" data-act="clear-runs">Clear history</button></div>
      </div>
      <div class="stack" id="runs">${renderRuns(state.runs)}</div>`;
  },

  async credentials() {
    const s = state.settings;
    const models = Object.entries(state.models);
    return `
      <div class="page-head"><div><h1>AI credentials</h1><p>Your bots think with your own Claude API key. It's encrypted with AES-256-GCM on this machine; the dashboard and extension only ever see a masked hint.</p></div></div>
      <div class="grid two">
        <div class="card">
          <h2>Claude API key</h2>
          ${
            s.hasKey
              ? `<div class="status-pill" style="margin-bottom:16px"><span class="badge good"><span class="dot"></span>Connected</span><div style="flex:1"><b class="mono">${esc(s.apiKeyHint)}</b><span class="faint">${s.keySource === "env" ? "From the ANTHROPIC_API_KEY environment variable" : "Stored encrypted"}</span></div>${s.keySource === "stored" ? `<button class="btn sm danger" data-act="remove-key">Remove</button>` : ""}</div>`
              : ""
          }
          <div class="field">
            <label for="key">${s.hasKey ? "Replace key" : "API key"}</label>
            <input class="input mono" id="key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" />
            <span class="hint">Create one at console.anthropic.com → API keys.</span>
          </div>
          <div class="row"><button class="btn" data-act="test-key">Test connection</button><button class="btn primary" data-act="save-key">Save key</button><span id="key-status" class="muted"></span></div>
        </div>
        <div class="card">
          <h2>Model</h2>
          <div class="stack" style="gap:10px">
            ${models
              .map(
                ([id, m]) => `<label class="status-pill" style="cursor:pointer;${s.model === id ? "border-color:var(--accent);background:var(--accent-soft)" : ""}">
                  <input type="radio" name="model" value="${id}" ${s.model === id ? "checked" : ""} style="accent-color:var(--accent)" />
                  <div style="flex:1"><b>${esc(m.label)}</b><span class="faint">$${m.inPerM} in / $${m.outPerM} out per 1M tokens</span></div>
                  ${id === "claude-opus-5-5" ? `<span class="badge accent">Recommended</span>` : `<span class="badge">Faster</span>`}
                </label>`,
              )
              .join("")}
          </div>
          <div class="setting" style="margin-top:14px;border-top:1px solid var(--line);padding-top:16px">
            <div class="txt"><b>Automatic fallback</b><small>If the model declines a page, the API retries on a recommended fallback model instead of failing.</small></div>
            <label class="switch"><input type="checkbox" data-setting="useFallbacks" ${s.useFallbacks ? "checked" : ""}/><span></span></label>
          </div>
          <div class="setting">
            <div class="txt"><b>Parallel bots</b><small>How many bots run at the same time during a deployment.</small></div>
            <div class="segmented" data-seg="concurrency">${[2, 4, 6, 8].map((n) => `<button class="${s.concurrency === n ? "on" : ""}" data-v="${n}">${n}</button>`).join("")}</div>
          </div>
        </div>
      </div>`;
  },

  async privacy() {
    const s = state.settings;
    return `
      <div class="page-head"><div><h1>Privacy &amp; auto-pilot</h1><p>Control what bots can see and when they run on their own.</p></div></div>
      <div class="grid two">
        <div class="card">
          <h2>Behavior</h2>
          <div class="setting">
            <div class="txt"><b>Auto-pilot</b><small>When a page finishes loading, bots marked "auto" analyze it in the background and the toolbar badge shows how many recommendations are waiting. Off by default because every scan uses API credits.</small></div>
            <label class="switch"><input type="checkbox" data-setting="autoScan" ${s.autoScan ? "checked" : ""}/><span></span></label>
          </div>
          <div class="setting">
            <div class="txt"><b>Redact personal info</b><small>Strips emails, phone numbers, card-like and SSN-like numbers from page text before it's sent to the AI.</small></div>
            <label class="switch"><input type="checkbox" data-setting="redactPII" ${s.redactPII ? "checked" : ""}/><span></span></label>
          </div>
          <div class="setting">
            <div class="txt"><b>Page text budget</b><small>Maximum characters of page text each bot reads. Higher means more context and more cost.</small></div>
            <div class="segmented" data-seg="maxPageChars">${[8000, 20000, 50000].map((n) => `<button class="${s.maxPageChars === n ? "on" : ""}" data-v="${n}">${compact(n)}</button>`).join("")}</div>
          </div>
          <div class="callout" style="margin-top:12px"><div>🛡️</div><div class="muted" style="font-size:13px"><b style="color:var(--text)">Always on</b>Form field values and password inputs are never captured. Only field labels and types are sent, so bots can tell you what a form needs without seeing what you typed.</div></div>
        </div>
        <div class="card">
          <h2>Blocklist</h2>
          <p class="muted" style="margin-top:-6px;font-size:13px">Bots never run on these sites, manually or on auto-pilot. One pattern per line. <code class="inline">*bank*</code> matches any host containing "bank"; <code class="inline">*.example.com</code> matches a domain and its subdomains.</p>
          <textarea class="textarea mono" id="blocklist" rows="12">${esc(s.blocklist.join("\n"))}</textarea>
          <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" data-act="save-blocklist">Save blocklist</button></div>
        </div>
      </div>`;
  },

  async extension() {
    const code = pairingCode();
    return `
      <div class="page-head"><div><h1>Chrome extension</h1><p>Install the extension once, then pair it with this server using the code below.</p></div></div>
      <div class="grid two">
        <div class="card">
          <h2>Install</h2>
          <ol class="steps">
            <li><b>Open Chrome's extensions page</b><span class="muted">Go to <code class="inline">chrome://extensions</code> and switch on <b style="display:inline">Developer mode</b> (top right).</span></li>
            <li><b>Load the extension</b><span class="muted">Click <b style="display:inline">Load unpacked</b> and choose the <code class="inline">BotFleet/extension</code> folder.</span></li>
            <li><b>Pin it</b><span class="muted">Pin BotFleet from the puzzle-piece menu. Clicking the icon opens the fleet side panel.</span></li>
            <li><b>Pair</b><span class="muted">The side panel asks for a pairing code the first time. Paste the one on the right.</span></li>
          </ol>
          <h2 style="margin-top:8px">Shortcuts</h2>
          <div class="list">
            <div class="list-row"><span class="tag">Alt+Shift+D</span><span class="muted">Deploy all bots on the current page</span></div>
            <div class="list-row"><span class="tag">Alt+Shift+F</span><span class="muted">Open the fleet side panel</span></div>
            <div class="list-row"><span class="tag">Right-click</span><span class="muted">"Deploy bots on selection" for selected text</span></div>
          </div>
        </div>
        <div class="card">
          <h2>Pairing code</h2>
          <p class="muted" style="margin-top:-6px;font-size:13px">This code lets the extension talk to this server. Treat it like a password. Rotating it disconnects any paired browser.</p>
          <div class="codebox"><span id="pair-code">${esc(code)}</span><button class="btn sm" data-act="copy-pair">Copy</button></div>
          <div class="row" style="margin-top:14px"><span class="faint" style="font-size:12.5px">Server: <span class="mono">${esc(ORIGIN)}</span></span><span class="spacer"></span><button class="btn sm danger" data-act="rotate">Rotate code</button></div>
        </div>
      </div>`;
  },
};

let currentToken = TOKEN;
function pairingCode() {
  return `bf1_${btoa(JSON.stringify({ o: ORIGIN, t: currentToken }))}`;
}

function botCard(b) {
  return `<div class="card bot-card ${b.enabled ? "" : "off"}" style="--c:${esc(b.color)}">
    <div class="top">${glyph(b)}<div style="flex:1;min-width:0"><div class="name">${esc(b.name)}</div><div class="desc">${esc(b.description)}</div></div>
      <label class="switch" title="${b.enabled ? "Enabled" : "Disabled"}"><input type="checkbox" data-toggle="${b.id}" ${b.enabled ? "checked" : ""}/><span></span></label></div>
    <div class="meta">
      ${b.match.slice(0, 3).map((m) => `<span class="tag">${esc(m === "*" ? "all sites" : m)}</span>`).join("")}${b.match.length > 3 ? `<span class="tag">+${b.match.length - 3}</span>` : ""}
    </div>
    <div class="foot">
      ${b.autoRun ? `<span class="badge accent">Auto-pilot</span>` : `<span class="badge">Manual</span>`}
      <span class="badge">${esc(b.effort)} effort</span>
      <span class="spacer"></span>
      <button class="btn sm ghost" data-dup="${b.id}">Duplicate</button>
      <button class="btn sm" data-edit="${b.id}">Edit</button>
    </div>
  </div>`;
}

function runRowCompact(r) {
  const n = r.bots.reduce((a, b) => a + (b.recommendations?.length || 0), 0);
  return `<a class="list-row" href="#/activity">${hostAvatar(r.host)}<div style="flex:1;min-width:0"><div class="run-title">${esc(r.title || r.host)}</div><div class="run-sub">${esc(r.host)} · ${ago(r.at)} · ${esc(r.trigger)}</div></div>
    <div class="stack-glyphs">${r.bots.slice(0, 5).map((b) => glyph(b, "sm")).join("")}</div><span class="badge accent">${n} recs</span></a>`;
}

function renderRuns(runs) {
  if (!runs.length) return `<div class="card empty"><div class="big">🛰️</div><b>No deployments yet</b><div>Open the extension on any page and hit "Deploy all bots".</div></div>`;
  return runs
    .map((r) => {
      const n = r.bots.reduce((a, b) => a + (b.recommendations?.length || 0), 0);
      const cost = r.bots.reduce((a, b) => a + (b.cost || 0), 0);
      const errs = r.bots.filter((b) => b.status === "error").length;
      return `<div class="card run">
        <div class="run-head" data-run="${r.id}">
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="m9 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6z"/></svg>
          ${hostAvatar(r.host)}
          <div style="flex:1;min-width:0"><div class="run-title">${esc(r.title || r.host)}</div><div class="run-sub">${esc(r.host)} · ${ago(r.at)} · ${esc(r.trigger)} · ${(r.ms / 1000).toFixed(1)}s · ${money(cost)}</div></div>
          <div class="stack-glyphs">${r.bots.slice(0, 6).map((b) => glyph(b, "sm")).join("")}</div>
          ${errs ? `<span class="badge bad">${errs} failed</span>` : ""}
          <span class="badge accent">${n} recs</span>
        </div>
        <div class="run-body">${r.bots.map(botOut).join("")}</div>
      </div>`;
    })
    .join("");
}

function botOut(b) {
  const status = b.status === "error" ? `<span class="badge bad">${esc(b.code || "error")}</span>` : b.status === "skipped" ? `<span class="badge">not relevant</span>` : `<span class="badge good">${b.recommendations.length} recs</span>`;
  return `<div class="bot-out"><div class="hd">${glyph(b, "sm")}<b style="flex:1">${esc(b.name)}</b>${status}</div>
    <div class="muted" style="font-size:13px">${esc(b.error || b.headline || "")}</div>
    ${(b.recommendations || [])
      .map((r) => `<div class="rec"><div class="row" style="gap:6px"><span class="badge ${r.priority === "high" ? "bad" : r.priority === "medium" ? "warn" : ""}">${esc(r.priority)}</span><b>${esc(r.title)}</b></div><p>${esc(r.detail)}</p></div>`)
      .join("")}
  </div>`;
}

// ---------------------------------------------------------------------------
// Bot editor
// ---------------------------------------------------------------------------
function openEditor(bot) {
  const isNew = !bot?.id;
  const b = bot || { name: "", glyph: "", color: PALETTE[state.bots.length % PALETTE.length], description: "", mission: "", match: ["*"], autoRun: false, enabled: true, effort: "low" };
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head"><div id="ed-preview">${glyph(b)}</div><h3>${isNew ? "New bot" : `Edit ${esc(b.name)}`}</h3><button class="btn icon ghost" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field"><label>Name</label><input class="input" id="ed-name" maxlength="40" value="${esc(b.name)}" placeholder="e.g. Recipe Helper" /></div>
        <div class="field"><label>Badge text</label><input class="input" id="ed-glyph" maxlength="3" value="${esc(b.glyph)}" placeholder="1 to 3 characters" /></div>
      </div>
      <div class="field"><label>Color</label><div class="swatches">${PALETTE.map((c) => `<button type="button" style="--c:${c}" data-color="${c}" class="${c === b.color ? "on" : ""}" aria-label="${c}"></button>`).join("")}</div></div>
      <div class="field"><label>One-line description</label><input class="input" id="ed-desc" maxlength="200" value="${esc(b.description)}" placeholder="What does this bot do for you?" /></div>
      <div class="field"><label>Mission</label><textarea class="textarea" id="ed-mission" rows="6" placeholder="Describe, in plain English, what this bot should look for on a page and what it should recommend. Tell it when to say the page isn't relevant.">${esc(b.mission)}</textarea><span class="hint">The mission becomes the bot's instructions. The output format and safety rules are handled for you.</span></div>
      <div class="field"><label>Targets sites</label><textarea class="textarea mono" id="ed-match" rows="3" style="min-height:76px" placeholder="*">${esc(b.match.join("\n"))}</textarea><span class="hint">One pattern per line. <code class="inline">*</code> = every site, <code class="inline">github.com/*</code>, <code class="inline">*.shopify.com</code>, <code class="inline">docs.*</code></span></div>
      <div class="field-row">
        <div class="field"><label>Thinking effort</label><div class="segmented" id="ed-effort">${["low", "medium", "high"].map((e) => `<button type="button" data-v="${e}" class="${b.effort === e ? "on" : ""}">${e}</button>`).join("")}</div><span class="hint">Low is fastest and cheapest. High is for deep analysis.</span></div>
        <div class="field"><label>Auto-pilot</label><div class="row"><label class="switch"><input type="checkbox" id="ed-auto" ${b.autoRun ? "checked" : ""}/><span></span></label><span class="muted" style="font-size:13px">Run automatically when auto-pilot is on</span></div></div>
      </div>
    </div>
    <div class="modal-foot">${isNew ? "" : `<button class="btn danger" id="ed-delete">Delete bot</button><span class="spacer"></span>`}<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ed-save">${isNew ? "Create bot" : "Save changes"}</button></div>
  </div></div>`;

  let color = b.color;
  let effort = b.effort;
  const close = () => (root.innerHTML = "");
  const preview = () => ($("#ed-preview").innerHTML = glyph({ color, glyph: $("#ed-glyph").value || "?" }));
  $$("[data-close]", root).forEach((el) => el.addEventListener("click", close));
  $(".modal-back", root).addEventListener("mousedown", (e) => e.target.classList.contains("modal-back") && close());
  $("#ed-glyph").addEventListener("input", preview);
  $$("[data-color]", root).forEach((el) =>
    el.addEventListener("click", () => {
      color = el.dataset.color;
      $$("[data-color]", root).forEach((x) => x.classList.toggle("on", x === el));
      preview();
    }),
  );
  $$("#ed-effort button", root).forEach((el) =>
    el.addEventListener("click", () => {
      effort = el.dataset.v;
      $$("#ed-effort button", root).forEach((x) => x.classList.toggle("on", x === el));
    }),
  );
  $("#ed-name").focus();
  $("#ed-delete")?.addEventListener("click", async () => {
    if (!confirm(`Delete "${b.name}"? This can't be undone.`)) return;
    await api(`/bots/${b.id}`, { method: "DELETE" });
    toast(`${b.name} deleted`);
    close();
    await refresh();
  });
  $("#ed-save").addEventListener("click", async () => {
    const data = {
      name: $("#ed-name").value.trim(),
      glyph: $("#ed-glyph").value.trim() || $("#ed-name").value.trim().slice(0, 1).toUpperCase(),
      color,
      description: $("#ed-desc").value.trim(),
      mission: $("#ed-mission").value.trim(),
      match: $("#ed-match").value.split("\n").map((s) => s.trim()).filter(Boolean),
      autoRun: $("#ed-auto").checked,
      effort,
      enabled: b.enabled,
    };
    if (!data.match.length) data.match = ["*"];
    try {
      if (isNew) await api("/bots", { method: "POST", body: data });
      else await api(`/bots/${b.id}`, { method: "PUT", body: data });
      toast(isNew ? `${data.name} joined the fleet` : "Bot saved", "good");
      close();
      await refresh();
    } catch (err) {
      toast(err.message, "bad");
    }
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act],[data-edit],[data-dup],[data-run],[data-seg] button");
  if (!t) return;
  try {
    if (t.dataset.edit) return openEditor(state.bots.find((b) => b.id === t.dataset.edit));
    if (t.dataset.dup) {
      const src = state.bots.find((b) => b.id === t.dataset.dup);
      const { id, createdAt, updatedAt, ...rest } = src;
      return openEditor({ ...rest, name: `${src.name} copy`.slice(0, 40) });
    }
    if (t.dataset.run) return t.closest(".run").classList.toggle("open");
    const seg = t.closest("[data-seg]");
    if (seg) {
      state.settings = await api("/settings", { method: "PUT", body: { [seg.dataset.seg]: Number(t.dataset.v) } });
      $$("button", seg).forEach((x) => x.classList.toggle("on", x === t));
      return toast("Saved", "good");
    }
    switch (t.dataset.act) {
      case "new-bot":
        return openEditor(null);
      case "bulk-on":
      case "bulk-off":
        state.bots = await api("/bots/bulk", { method: "POST", body: { enabled: t.dataset.act === "bulk-on" } });
        return render();
      case "reset":
        if (!confirm("Replace all bots with the default fleet? Custom bots will be removed.")) return;
        state.bots = await api("/bots/reset", { method: "POST" });
        toast("Default fleet restored", "good");
        return render();
      case "clear-runs":
        if (!confirm("Delete all deployment history?")) return;
        await api("/runs", { method: "DELETE" });
        return render();
      case "test-key": {
        const key = $("#key").value.trim();
        $("#key-status").textContent = "Testing…";
        const r = await api("/credentials/test", { method: "POST", body: key ? { apiKey: key } : {} });
        $("#key-status").innerHTML = r.ok ? `<span class="badge good"><span class="dot"></span>Works · ${esc(r.model)}</span>` : `<span class="badge bad">${esc(r.error)}</span>`;
        return;
      }
      case "save-key": {
        const key = $("#key").value.trim();
        if (!key) return toast("Paste your API key first", "bad");
        $("#key-status").textContent = "Verifying…";
        const r = await api("/credentials/test", { method: "POST", body: { apiKey: key } });
        if (!r.ok && r.code === "auth") {
          $("#key-status").innerHTML = `<span class="badge bad">${esc(r.error)}</span>`;
          return;
        }
        state.settings = await api("/credentials", { method: "PUT", body: { apiKey: key } });
        toast(r.ok ? "API key saved and verified" : "API key saved (couldn't verify right now)", r.ok ? "good" : "");
        return render();
      }
      case "remove-key":
        if (!confirm("Remove the stored API key? Bots will stop working until you add one again.")) return;
        state.settings = await api("/credentials", { method: "DELETE" });
        return render();
      case "save-blocklist":
        state.settings = await api("/settings", { method: "PUT", body: { blocklist: $("#blocklist").value.split("\n").map((s) => s.trim()).filter(Boolean) } });
        return toast("Blocklist saved", "good");
      case "copy-pair":
        await navigator.clipboard.writeText(pairingCode());
        return toast("Pairing code copied", "good");
      case "rotate": {
        if (!confirm("Rotate the pairing code? Paired extensions will need the new code.")) return;
        const { token } = await api("/token/rotate", { method: "POST" });
        currentToken = token;
        toast("Code rotated. Reloading…");
        return setTimeout(() => location.reload(), 700);
      }
    }
  } catch (err) {
    toast(err.message, "bad");
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  try {
    if (t.dataset.toggle) {
      const bot = await api(`/bots/${t.dataset.toggle}`, { method: "PUT", body: { enabled: t.checked } });
      Object.assign(state.bots.find((b) => b.id === bot.id), bot);
      t.closest(".bot-card").classList.toggle("off", !bot.enabled);
    } else if (t.dataset.setting) {
      state.settings = await api("/settings", { method: "PUT", body: { [t.dataset.setting]: t.checked } });
      toast("Saved", "good");
      renderFoot();
    } else if (t.name === "model") {
      state.settings = await api("/settings", { method: "PUT", body: { model: t.value } });
      toast(`Fleet now runs on ${state.models[t.value].label}`, "good");
      render();
    }
  } catch (err) {
    toast(err.message, "bad");
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "run-q") return;
  const q = e.target.value.toLowerCase();
  $("#runs").innerHTML = renderRuns(state.runs.filter((r) => r.host.includes(q) || (r.title || "").toLowerCase().includes(q)));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal-root").innerHTML = "";
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function renderFoot() {
  const s = state.settings;
  $("#status-foot").innerHTML = `<div class="status-pill"><span class="badge ${s.hasKey ? "good" : "warn"}"><span class="dot"></span></span><div><b>${s.hasKey ? "Fleet online" : "Needs API key"}</b><span class="faint">${esc(state.models[s.model]?.label || s.model)} · auto-pilot ${s.autoScan ? "on" : "off"}</span></div></div>`;
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const route = (location.hash.replace("#/", "") || "overview").split("?")[0];
  const view = views[route] || views.overview;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  let html;
  try {
    html = await view();
  } catch (err) {
    html = `<div class="card empty"><div class="big">⚠️</div><b>Couldn't load this page</b><div>${esc(err.message)}</div></div>`;
  }
  // A newer navigation started while this view was loading; let it win.
  if (seq !== renderSeq) return;
  $("#view").innerHTML = html;
  renderFoot();
}

async function refresh() {
  const s = await api("/state");
  Object.assign(state, { settings: s.settings, bots: s.bots, models: s.models });
  await render();
}

window.addEventListener("hashchange", render);
refresh();
