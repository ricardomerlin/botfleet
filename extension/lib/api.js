// Shared by the service worker and the side panel: pairing config, server
// calls, and the NDJSON stream reader for live deployments.
export const DEFAULT_SERVER = "http://localhost:4477";

export async function getConfig() {
  const { server, token } = await chrome.storage.local.get(["server", "token"]);
  return { server: server || DEFAULT_SERVER, token: token || null };
}

export function parsePairingCode(code) {
  const raw = code.trim();
  if (!raw.startsWith("bf1_")) throw new Error("That doesn't look like a BotFleet pairing code. It should start with bf1_.");
  let data;
  try {
    data = JSON.parse(atob(raw.slice(4)));
  } catch {
    throw new Error("The pairing code is incomplete. Copy it again from the dashboard.");
  }
  if (!data.o || !data.t) throw new Error("The pairing code is missing information.");
  const url = new URL(data.o);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("BotFleet only pairs with a server on this computer.");
  return { server: url.origin, token: data.t };
}

export async function pair(code) {
  const cfg = parsePairingCode(code);
  const res = await fetch(`${cfg.server}/api/state`, { headers: { "x-botfleet-token": cfg.token } }).catch(() => null);
  if (!res) throw new Error(`Couldn't reach the BotFleet server at ${cfg.server}. Is it running?`);
  if (res.status === 401) throw new Error("The server rejected this code. It may have been rotated. Copy a fresh one.");
  if (!res.ok) throw new Error(`Server error (${res.status}).`);
  await chrome.storage.local.set(cfg);
  return cfg;
}

export async function unpair() {
  await chrome.storage.local.remove(["token"]);
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = "GET", body, signal } = {}) {
  const { server, token } = await getConfig();
  if (!token) throw new ApiError("Not paired with a BotFleet server yet.", 0, "unpaired");
  let res;
  try {
    res = await fetch(`${server}/api${path}`, {
      method,
      signal,
      headers: { "x-botfleet-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(`BotFleet server is offline. Start it with "npm start" in BotFleet/server.`, 0, "offline");
  }
  if (res.status === 401) throw new ApiError("Pairing expired. Paste a new pairing code from the dashboard.", 401, "unpaired");
  return res;
}

export async function apiJson(path, opts) {
  const res = await api(path, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data;
}

export async function* readNdjson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

export const cacheKey = (tabId) => `tab:${tabId}`;
export const normalizeUrl = (u) => {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.href;
  } catch {
    return u;
  }
};
