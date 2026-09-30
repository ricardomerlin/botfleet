import { apiJson, getConfig, pair, unpair, cacheKey, normalizeUrl } from "./lib/api.js";

const app = document.getElementById("app");
const S = {
  view: location.hash === "#settings" ? "settings" : "main",
  cfg: null,
  tab: null,
  plan: null,
  planError: null,
  cache: null,
  deselected: new Set(),
  filter: "all",
  actions: [],
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const g = (b, cls = "g") => `<span class="${cls}" style="--c:${esc(b.color)}">${esc(b.glyph)}</span>`;
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const favicon = (u) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(u)}&size=32`);
const money = (n) => (!n ? "$0.00" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

const ICONS = {
  rocket: `<svg viewBox="0 0 24 24"><path d="M13.1 2.2c3.6-.6 6.9-.3 8.4.3.6 1.5.9 4.8.3 8.4-.6 3.3-2.7 6.4-6.1 8.8l.3 2.1-3.6 2.1-1.3-3.4-3.7-3.7-3.4-1.3 2.1-3.6 2.1.3c2.4-3.4 5.5-5.5 8.9-6.1zM16 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5.6 16.2l2.2 2.2c-.9 1.6-2.9 2.6-5.3 3.1.5-2.4 1.5-4.4 3.1-5.3z"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  open_url: `<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2m0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><path d="M8 3h11a2 2 0 0 1 2 2v11h-2V5H8zm-3 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2m0 2v10h10V9z"/></svg>`,
  highlight: `<svg viewBox="0 0 24 24"><path d="m15.2 3 5.8 5.8-9.9 9.9H5.3v-5.8zm0 2.8-7.9 7.9v3h3l7.9-7.9zM3 21h18v2H3z"/></svg>`,
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  S.tab = tab || null;
  S.cache = null;
  S.plan = null;
  S.planError = null;
  if (tab?.id != null) {
    const c = (await chrome.storage.session.get(cacheKey(tab.id)))[cacheKey(tab.id)];
    if (c && c.url === normalizeUrl(tab.url)) S.cache = c;
  }
  if (S.cfg?.token && tab && /^https?:/.test(tab.url || "")) {
    try {
      S.plan = await apiJson("/plan", { method: "POST", body: { url: tab.url } });
    } catch (err) {
      S.planError = err;
    }
  }
  render();
}

async function init() {
  S.cfg = await getConfig();
  const { deselected = [] } = await chrome.storage.local.get("deselected");
  S.deselected = new Set(deselected);
  if (!S.cfg.token) S.view = "pair";
  await loadTab();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function setConn() {
  const el = document.getElementById("conn");
  const code = S.planError?.code;
  el.className = "conn " + (!S.cfg?.token ? "warn" : code === "offline" || code === "unpaired" ? "off" : S.plan && !S.plan.hasKey ? "warn" : S.plan ? "on" : "");
  el.title = !S.cfg?.token ? "Not paired" : code === "offline" ? "Server offline" : S.plan && !S.plan.hasKey ? "No API key" : "Connected";
}

function render() {
  setConn();
  if (S.view === "pair") return renderPair();
  if (S.view === "settings") return renderSettings();
  renderMain();
}

function renderPair(error = "") {
  app.innerHTML = `
    <div class="hero-empty">
      <div class="orb"><img src="icons/icon128.png" alt="" /></div>
      <h2>Launch your fleet</h2>
      <p>AI bots that read the page you're on and recommend what to do next, powered by your own Claude API key.</p>
    </div>
    <div class="card">
      <ol class="steps">
        <li>Start the server: <code>cd BotFleet/server && npm start</code></li>
        <li>Open <b>localhost:4477</b> and add your Claude API key.</li>
        <li>Go to <b>Extension</b> and copy the pairing code.</li>
      </ol>
    </div>
    <div class="card">
      <label class="lbl" for="code">Pairing code</label>
      <textarea class="textarea" id="code" placeholder="bf1_…" spellcheck="false"></textarea>
      ${error ? `<div class="notice bad" style="margin-top:10px"><span class="e">⚠️</span><div>${esc(error)}</div></div>` : ""}
      <div class="row" style="margin-top:10px">
        <button class="btn" data-a="open-dashboard">Open dashboard</button>
        <span class="spacer"></span>
        <button class="btn primary" data-a="pair">Connect</button>
      </div>
    </div>`;
  document.getElementById("code").focus();
}

function renderSettings() {
  app.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:10px"><b style="font-size:14px">Connection</b><span class="spacer"></span><button class="btn" data-a="back">Done</button></div>
      <div class="muted" style="font-size:12.5px">Server <code>${esc(S.cfg.server)}</code></div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">Status: ${S.planError ? esc(S.planError.message) : S.plan ? (S.plan.hasKey ? "connected, API key configured" : "connected, but no API key yet") : "open a web page to check"}</div>
    </div>
    <div class="card">
      <label class="lbl" for="code">Re-pair with a new code</label>
      <textarea class="textarea" id="code" placeholder="bf1_…" spellcheck="false"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" data-a="unpair">Disconnect</button><span class="spacer"></span><button class="btn primary" data-a="pair">Connect</button></div>
    </div>
    <div class="card">
      <b style="font-size:14px">Manage in the dashboard</b>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">
        <button class="btn" data-a="open-dashboard" data-path="#/bots">Bots</button>
        <button class="btn" data-a="open-dashboard" data-path="#/credentials">AI credentials</button>
        <button class="btn" data-a="open-dashboard" data-path="#/privacy">Privacy</button>
        <button class="btn" data-a="open-dashboard" data-path="#/activity">Activity</button>
      </div>
      <div class="faint" style="font-size:12px;margin-top:12px">Shortcuts: <code>Alt+Shift+D</code> deploy all · <code>Alt+Shift+F</code> open panel. Change them at <code>chrome://extensions/shortcuts</code>.</div>
    </div>`;
}

function renderMain() {
  const tab = S.tab;
  const url = tab?.url || "";
  const web = /^https?:/.test(url);
  const plan = S.plan;
  const cache = S.cache;
  const running = cache?.status === "running";
  let body = "";

  body += `<div class="card page">${web ? `<img src="${esc(favicon(url))}" alt="" />` : `<img src="icons/icon32.png" alt="" />`}<div style="min-width:0;flex:1"><div class="t">${esc(tab?.title || "No page")}</div><div class="h">${esc(web ? host(url) : "Not a web page")}</div></div></div>`;

  if (!web) {
    body += `<div class="notice"><span class="e">🧭</span><div><b>Open a website</b>Bots work on regular web pages. Browser pages like settings or the new tab page can't be read.</div></div>`;
    app.innerHTML = body;
    return;
  }
  if (S.planError) {
    const offline = S.planError.code === "offline";
    body += `<div class="notice bad"><span class="e">${offline ? "🔌" : "🔑"}</span><div><b>${offline ? "Server offline" : "Connection problem"}</b>${esc(S.planError.message)}<div class="row" style="margin-top:8px"><button class="btn" data-a="retry">Retry</button>${S.planError.code === "unpaired" ? `<button class="btn" data-a="settings">Re-pair</button>` : ""}</div></div></div>`;
    app.innerHTML = body;
    return;
  }
  if (!plan) {
    body += `<div class="card"><div class="sk" style="width:60%"></div></div>`;
    app.innerHTML = body;
    return;
  }
  if (plan.blocked) {
    body += `<div class="notice warn"><span class="e">🛡️</span><div><b>Blocked for privacy</b>This site is on your blocklist, so no bot will read it. Edit the list in the dashboard under Privacy.</div></div>`;
    app.innerHTML = body;
    return;
  }
  if (!plan.hasKey) {
    body += `<div class="notice warn"><span class="e">🔑</span><div><b>Connect your AI</b>Add your Claude API key in the dashboard to launch the fleet.<div style="margin-top:8px"><button class="btn primary" data-a="open-dashboard" data-path="#/credentials">Add API key</button></div></div></div>`;
  }

  const bots = plan.bots;
  const selected = bots.filter((b) => !S.deselected.has(b.id));
  const allSelected = selected.length === bots.length;
  const label = running ? "Deploying…" : !bots.length ? "No bots target this page" : allSelected ? `Deploy all ${bots.length} bots` : `Deploy ${selected.length} of ${bots.length} bots`;
  body += `<div class="card">
    <button class="deploy ${running ? "busy" : ""}" data-a="${running ? "cancel" : "deploy"}" ${(!running && (!selected.length || !plan.hasKey)) ? "disabled" : ""}>
      <span class="ico">${running ? ICONS.stop : ICONS.rocket}</span>
      <span><b>${label}</b><small>${running ? "Tap to stop" : "Every selected bot analyzes this page in parallel"}</small></span>
      ${running ? "" : `<kbd>⌥⇧D</kbd>`}
    </button>
    ${bots.length ? `<div class="chips">${bots.map((b) => `<button class="chip ${S.deselected.has(b.id) ? "" : "on"}" style="--c:${esc(b.color)}" data-chip="${b.id}" title="${esc(b.description)}">${g(b)}${esc(b.name)}</button>`).join("")}</div>` : `<div class="faint" style="font-size:12.5px;margin-top:10px">Enable or add bots in the dashboard.</div>`}
    <div class="toggle-row"><label class="switch"><input type="checkbox" data-a="autopilot" ${plan.autoScan ? "checked" : ""}/><span></span></label><div style="flex:1"><b>Auto-pilot</b> <span class="faint">scan pages automatically as you browse</span></div></div>
  </div>`;

  body += renderResults(cache);
  app.innerHTML = body;
}

function renderResults(cache) {
  S.actions = [];
  if (!cache) return "";
  if (cache.status === "error") {
    return `<div class="notice bad"><span class="e">⚠️</span><div><b>Deployment failed</b>${esc(cache.error)}${cache.errorCode === "no_key" ? `<div style="margin-top:8px"><button class="btn primary" data-a="open-dashboard" data-path="#/credentials">Add API key</button></div>` : ""}</div></div>`;
  }
  const bots = cache.order.map((id) => cache.bots[id]).filter(Boolean);
  if (!bots.length) return `<div class="card"><div class="row"><span class="spin"></span><span class="muted">Reading the page…</span></div></div>`;

  const withRecs = bots.filter((b) => b.recommendations?.length);
  const pending = bots.filter((b) => b.status === "queued" || b.status === "running");
  const errors = bots.filter((b) => b.status === "error");
  const skipped = bots.filter((b) => b.status === "skipped" || (b.status === "ok" && !b.recommendations?.length));
  const total = withRecs.reduce((n, b) => n + b.recommendations.length, 0);
  const highs = withRecs.reduce((n, b) => n + b.recommendations.filter((r) => r.priority === "high").length, 0);

  let html = `<div class="summary"><b style="color:var(--text)">${total} recommendation${total === 1 ? "" : "s"}</b>${cache.status === "done" ? `<span>· ${((cache.ms || 0) / 1000).toFixed(1)}s · ${money(cache.cost)}</span>` : cache.status === "cancelled" ? "<span>· stopped</span>" : `<span>· ${pending.length} bot${pending.length === 1 ? "" : "s"} working</span>`}<span class="spacer"></span>
    ${total ? `<div class="seg"><button class="${S.filter === "all" ? "on" : ""}" data-filter="all">All</button><button class="${S.filter === "high" ? "on" : ""}" data-filter="high">High${highs ? ` · ${highs}` : ""}</button></div>` : ""}
    <button class="icon-btn" data-a="clear" title="Clear results" aria-label="Clear results"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7zm3-4h6l1 2h4v2H4V5h4z"/></svg></button></div>`;

  for (const b of withRecs) {
    const recs = b.recommendations.filter((r) => S.filter === "all" || r.priority === "high");
    if (!recs.length) continue;
    html += `<div class="card bot"><div class="bot-hd">${g(b)}<div style="flex:1;min-width:0"><div class="n">${esc(b.name)}</div><div class="hl">${esc(b.headline)}</div></div></div><div class="bot-recs">
      ${recs
        .map((r) => {
          const i = S.actions.push(r.action) - 1;
          const act = r.action.kind !== "none" ? `<div class="act"><button class="btn" data-act="${i}">${ICONS[r.action.kind] || ""}${esc(r.action.label || "Go")}</button></div>` : "";
          return `<div class="rec ${esc(r.priority)}"><div class="row" style="gap:6px;align-items:baseline"><span class="pill ${esc(r.priority)}">${esc(r.priority)}</span><span class="tt">${esc(r.title)}</span></div><p>${esc(r.detail)}</p>${act}</div>`;
        })
        .join("")}
    </div></div>`;
  }

  for (const b of pending) {
    html += `<div class="card bot" style="--c:${esc(b.color)}"><div class="bot-hd">${g(b)}<div style="flex:1"><div class="n">${esc(b.name)}</div><div class="hl">${b.status === "queued" ? "Queued" : "Analyzing the page…"}</div></div><span class="spin"></span></div>
      ${b.status === "running" ? `<div class="sk-wrap"><div class="sk" style="width:85%"></div><div class="sk" style="width:65%"></div></div>` : ""}</div>`;
  }

  for (const b of errors) {
    html += `<div class="card bot"><div class="bot-hd">${g(b)}<div style="flex:1;min-width:0"><div class="n">${esc(b.name)}</div><div class="hl">${esc(b.error)}</div></div><span class="status error">failed</span></div></div>`;
  }

  if (skipped.length) {
    html += `<div class="skipped"><span>Nothing to add here:</span>${skipped.map((b) => `<span class="row" style="gap:4px" title="${esc(b.headline || "")}">${g(b)}${esc(b.name)}</span>`).join("")}</div>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function highlightInPage(needle) {
  const target = needle.trim().toLowerCase();
  document.querySelectorAll("mark[data-botfleet]").forEach((m) => m.replaceWith(...m.childNodes));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.nodeValue.toLowerCase().indexOf(target);
    if (idx < 0) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + target.length);
    const mark = document.createElement("mark");
    mark.dataset.botfleet = "1";
    mark.style.cssText = "background:rgba(139,108,255,.35);color:inherit;border-radius:3px;box-shadow:0 0 0 2px rgba(139,108,255,.6);transition:box-shadow .6s";
    range.surroundContents(mark);
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }
  // Fallback: the browser's own find handles matches that span elements.
  window.getSelection()?.removeAllRanges();
  const found = window.find(needle.trim(), false, false, true, false, false, false);
  if (found) window.getSelection().getRangeAt(0).startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  return found;
}

async function runAction(action) {
  switch (action.kind) {
    case "open_url":
      return chrome.tabs.create({ url: action.value, index: S.tab.index + 1 });
    case "search":
      return chrome.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(action.value)}`, index: S.tab.index + 1 });
    case "copy":
      await navigator.clipboard.writeText(action.value);
      return toast("Copied to clipboard");
    case "highlight": {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: highlightInPage, args: [action.value] });
      return toast(result ? "Highlighted on the page" : "Couldn't find that text on the page");
    }
  }
}

async function openDashboard(path = "") {
  const url = `${S.cfg.server}/${path}`;
  const [existing] = await chrome.tabs.query({ url: `${S.cfg.server}/*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-a],[data-chip],[data-act],[data-filter]");
  if (!el) return;
  try {
    if (el.dataset.chip) {
      const id = el.dataset.chip;
      S.deselected.has(id) ? S.deselected.delete(id) : S.deselected.add(id);
      await chrome.storage.local.set({ deselected: [...S.deselected] });
      return renderMain();
    }
    if (el.dataset.act) return runAction(S.actions[Number(el.dataset.act)]);
    if (el.dataset.filter) {
      S.filter = el.dataset.filter;
      return renderMain();
    }
    switch (el.dataset.a) {
      case "deploy": {
        const botIds = S.plan.bots.filter((b) => !S.deselected.has(b.id)).map((b) => b.id);
        return chrome.runtime.sendMessage({ type: "deploy", tabId: S.tab.id, botIds });
      }
      case "cancel":
        return chrome.runtime.sendMessage({ type: "cancel", tabId: S.tab.id });
      case "clear":
        return chrome.runtime.sendMessage({ type: "clear", tabId: S.tab.id });
      case "retry":
        return loadTab();
      case "settings":
        S.view = "settings";
        return render();
      case "back":
        S.view = "main";
        return loadTab();
      case "open-dashboard":
        return openDashboard(el.dataset.path || "");
      case "pair": {
        const code = document.getElementById("code").value;
        try {
          S.cfg = await pair(code);
          S.view = "main";
          toast("Connected to your fleet");
          return loadTab();
        } catch (err) {
          if (S.view === "pair") return renderPair(err.message);
          return toast(err.message);
        }
      }
      case "unpair":
        await unpair();
        S.cfg = await getConfig();
        S.view = "pair";
        return render();
    }
  } catch (err) {
    toast(err.message);
  }
});

app.addEventListener("change", async (e) => {
  if (e.target.dataset.a !== "autopilot") return;
  try {
    await apiJson("/settings", { method: "PUT", body: { autoScan: e.target.checked } });
    S.plan.autoScan = e.target.checked;
    toast(e.target.checked ? "Auto-pilot on: auto bots scan as you browse" : "Auto-pilot off");
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});

document.getElementById("btn-settings").addEventListener("click", () => {
  S.view = S.cfg?.token ? (S.view === "settings" ? "main" : "settings") : "pair";
  S.view === "main" ? loadTab() : render();
});
document.getElementById("btn-dashboard").addEventListener("click", () => openDashboard());

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
chrome.storage.session.onChanged.addListener((changes) => {
  if (S.tab?.id == null) return;
  const change = changes[cacheKey(S.tab.id)];
  if (!change) return;
  S.cache = change.newValue && change.newValue.url === normalizeUrl(S.tab.url) ? change.newValue : null;
  if (S.view === "main") renderMain();
});

chrome.tabs.onActivated.addListener(() => S.view !== "pair" && loadTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== S.tab?.id || S.view === "pair") return;
  if (info.url || info.status === "complete" || info.title) loadTab();
});
window.addEventListener("focus", () => S.view === "main" && loadTab());

init();
