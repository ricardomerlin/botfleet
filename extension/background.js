// Service worker: owns deployments so they keep running when the side panel
// closes, caches results per tab, drives the toolbar badge, and runs
// auto-pilot scans on page load.
import { api, apiJson, getConfig, readNdjson, cacheKey, normalizeUrl } from "./lib/api.js";

const running = new Map(); // tabId -> AbortController
const autoTimers = new Map(); // tabId -> timeout
const AUTO_FRESH_MS = 30 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "deploy-page", title: "Deploy all bots on this page", contexts: ["page", "link", "image"] });
    chrome.contextMenus.create({ id: "deploy-selection", title: "Deploy bots on \"%s\"", contexts: ["selection"] });
  });
});

chrome.runtime.onStartup.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));

// ---------------------------------------------------------------------------
// Cache + badge
// ---------------------------------------------------------------------------
async function getCache(tabId) {
  return (await chrome.storage.session.get(cacheKey(tabId)))[cacheKey(tabId)] || null;
}
async function setCache(tabId, value) {
  await chrome.storage.session.set({ [cacheKey(tabId)]: value });
}
function recCount(cache) {
  return Object.values(cache?.bots || {}).reduce((n, b) => n + (b.recommendations?.length || 0), 0);
}
async function setBadge(tabId, cache) {
  try {
    if (!cache) return chrome.action.setBadgeText({ tabId, text: "" });
    if (cache.status === "running") {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#5b8cff" });
      return chrome.action.setBadgeText({ tabId, text: "···" });
    }
    if (cache.status === "error") {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#ef4444" });
      return chrome.action.setBadgeText({ tabId, text: "!" });
    }
    const n = recCount(cache);
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#8b6cff" });
    await chrome.action.setBadgeTextColor?.({ tabId, color: "#ffffff" });
    await chrome.action.setBadgeText({ tabId, text: n ? String(n > 99 ? "99+" : n) : "" });
  } catch {
    // Tab closed mid-update.
  }
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------
async function snapshot(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] });
  if (!result) throw new Error("Couldn't read this page.");
  return result;
}

async function deploy(tabId, { botIds, trigger = "manual", selection } = {}) {
  running.get(tabId)?.abort();
  const controller = new AbortController();
  running.set(tabId, controller);
  // Extension API calls keep the service worker alive during long runs.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);

  const tab = await chrome.tabs.get(tabId);
  const cache = {
    url: normalizeUrl(tab.url),
    title: tab.title,
    status: "running",
    trigger,
    startedAt: Date.now(),
    order: [],
    bots: {},
    error: null,
  };

  const commit = async () => {
    await setCache(tabId, cache);
    await setBadge(tabId, cache);
  };

  try {
    if (!/^https?:/.test(tab.url || "")) throw Object.assign(new Error("Bots can only run on regular web pages."), { code: "unsupported" });
    await commit();
    const page = await snapshot(tabId);
    if (selection) page.selection = selection.slice(0, 8000);

    const res = await api("/deploy", { method: "POST", body: { page, botIds, trigger }, signal: controller.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `Deploy failed (${res.status})`), { code: data.code });
    }

    for await (const ev of readNdjson(res)) {
      if (ev.type === "start") {
        cache.runId = ev.runId;
        cache.model = ev.model;
        cache.order = ev.bots.map((b) => b.id);
        for (const b of ev.bots) cache.bots[b.id] = { ...b, status: "queued" };
      } else if (ev.type === "bot_start") {
        cache.bots[ev.botId].status = "running";
      } else if (ev.type === "bot_result" || ev.type === "bot_error") {
        cache.bots[ev.botId] = { ...cache.bots[ev.botId], ...ev, id: ev.botId };
      } else if (ev.type === "done") {
        cache.status = "done";
        cache.ms = ev.ms;
        cache.cost = ev.cost;
      }
      await commit();
    }
    if (cache.status === "running") cache.status = "done";
  } catch (err) {
    if (err.name === "AbortError") {
      cache.status = "cancelled";
      for (const b of Object.values(cache.bots)) if (b.status === "running" || b.status === "queued") b.status = "cancelled";
    } else {
      cache.status = "error";
      cache.error = err.message;
      cache.errorCode = err.code || null;
    }
  } finally {
    clearInterval(keepAlive);
    if (running.get(tabId) === controller) running.delete(tabId);
    cache.finishedAt = Date.now();
    await commit().catch(() => {});
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Auto-pilot
// ---------------------------------------------------------------------------
async function maybeAutoScan(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || "") || running.has(tabId)) return;
  const cfg = await getConfig();
  if (!cfg.token) return;
  const existing = await getCache(tabId);
  if (existing && existing.url === normalizeUrl(tab.url) && Date.now() - existing.startedAt < AUTO_FRESH_MS) return;
  let plan;
  try {
    plan = await apiJson("/plan", { method: "POST", body: { url: tab.url } });
  } catch {
    return;
  }
  if (!plan.autoScan || !plan.hasKey || plan.blocked || !plan.bots.some((b) => b.autoRun)) return;
  deploy(tabId, { trigger: "auto" });
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) {
    // Navigated: results for the old URL no longer apply.
    const cache = await getCache(tabId);
    if (cache && cache.url !== normalizeUrl(info.url)) {
      running.get(tabId)?.abort();
      await chrome.storage.session.remove(cacheKey(tabId));
      await setBadge(tabId, null);
    }
  }
  if (info.status === "complete" && tab.active) {
    clearTimeout(autoTimers.get(tabId));
    autoTimers.set(tabId, setTimeout(() => maybeAutoScan(tabId), 1500));
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  clearTimeout(autoTimers.get(tabId));
  autoTimers.set(tabId, setTimeout(() => maybeAutoScan(tabId), 800));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  running.get(tabId)?.abort();
  clearTimeout(autoTimers.get(tabId));
  chrome.storage.session.remove(cacheKey(tabId));
});

// ---------------------------------------------------------------------------
// Entry points: side panel messages, shortcuts, context menu
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "deploy") {
    deploy(msg.tabId, { botIds: msg.botIds, trigger: msg.trigger || "manual" });
    sendResponse({ ok: true });
  } else if (msg?.type === "cancel") {
    running.get(msg.tabId)?.abort();
    sendResponse({ ok: true });
  } else if (msg?.type === "clear") {
    chrome.storage.session.remove(cacheKey(msg.tabId)).then(() => setBadge(msg.tabId, null));
    sendResponse({ ok: true });
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  if (command === "open-panel" || command === "deploy-all") {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  if (command === "deploy-all") deploy(tab.id, { trigger: "shortcut" });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  deploy(tab.id, { trigger: "context-menu", selection: info.menuItemId === "deploy-selection" ? info.selectionText : undefined });
});
