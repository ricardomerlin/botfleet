import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Store } from "./store.js";
import { Secrets, hintFor } from "./secrets.js";
import { urlMatches } from "./match.js";
import { runBot, testKey, MODELS, BotError } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOTFLEET_PORT || 4477);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.BOTFLEET_DATA || path.join(here, "..", "data");
const VERSION = "1.0.0";

const store = new Store(DATA_DIR);
const secrets = new Secrets(DATA_DIR);
const app = express();
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// Security: loopback-only host check (blocks DNS rebinding), CORS limited to
// Chrome extensions, and a bearer token on every API route.
// ---------------------------------------------------------------------------
const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) return res.status(421).send("Misdirected request");
  const origin = req.headers.origin;
  if (origin && origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-botfleet-token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function tokenOk(provided) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(store.accessToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/healthz", (_req, res) => res.json({ ok: true, name: "botfleet", version: VERSION }));

app.use("/api", express.json({ limit: "2mb" }), (req, res, next) => {
  if (!tokenOk(req.headers["x-botfleet-token"])) {
    return res.status(401).json({ error: "Missing or invalid access token. Re-pair the extension from the dashboard." });
  }
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function apiKey() {
  const enc = store.settings.apiKeyEnc;
  if (enc) {
    try {
      return secrets.decrypt(enc);
    } catch {
      console.warn("[secrets] stored API key could not be decrypted; re-enter it in the dashboard");
    }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

function publicSettings() {
  const { apiKeyEnc, ...rest } = store.settings;
  const envKey = !apiKeyEnc && !!process.env.ANTHROPIC_API_KEY;
  return {
    ...rest,
    hasKey: !!apiKeyEnc || envKey,
    keySource: apiKeyEnc ? "stored" : envKey ? "env" : null,
    apiKeyHint: apiKeyEnc ? rest.apiKeyHint : envKey ? hintFor(process.env.ANTHROPIC_API_KEY) : null,
  };
}

const parse = (schema, body, res) => {
  const out = schema.safeParse(body);
  if (!out.success) {
    res.status(400).json({ error: out.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return null;
  }
  return out.data;
};

const SettingsZ = z
  .object({
    model: z.enum(Object.keys(MODELS)),
    useFallbacks: z.boolean(),
    autoScan: z.boolean(),
    redactPII: z.boolean(),
    maxPageChars: z.number().int().min(2000).max(120000),
    concurrency: z.number().int().min(1).max(8),
    blocklist: z.array(z.string().max(200)).max(200),
  })
  .partial()
  .strict();

const BotZ = z.object({
  name: z.string().trim().min(1).max(40),
  glyph: z.string().trim().min(1).max(3),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  description: z.string().max(200).default(""),
  mission: z.string().trim().min(10).max(4000),
  match: z.array(z.string().trim().max(200)).min(1).max(50),
  autoRun: z.boolean().default(false),
  enabled: z.boolean().default(true),
  effort: z.enum(["low", "medium", "high"]).default("low"),
});

const PageZ = z.object({
  url: z.string().url(),
  title: z.string().max(500).optional().default(""),
  description: z.string().max(2000).optional(),
  lang: z.string().max(20).optional(),
  siteName: z.string().max(200).optional(),
  pageType: z.string().max(300).optional(),
  selection: z.string().max(20000).optional(),
  headings: z.array(z.string().max(300)).max(80).optional(),
  forms: z
    .array(
      z.object({
        name: z.string().max(200).optional(),
        fields: z.array(z.object({ label: z.string().max(200).optional(), name: z.string().max(200).optional(), type: z.string().max(40), required: z.boolean().optional() })).max(80),
      }),
    )
    .max(10)
    .optional(),
  prices: z.array(z.string().max(40)).max(30).optional(),
  links: z.array(z.object({ text: z.string().max(200), href: z.string().max(2000) })).max(120).optional(),
  text: z.string().max(400000).optional().default(""),
});

const PII = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card-or-account-number]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
];
function redact(s) {
  if (!s) return s;
  return PII.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

function matchingBots(url, ids) {
  return store.bots.filter((b) => b.enabled && (ids ? ids.includes(b.id) : true) && urlMatches(url, b.match));
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function computeStats() {
  const runs = store.runs;
  const days = 14;
  const dayMs = 86_400_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daily = Array.from({ length: days }, (_, i) => ({ day: new Date(today.getTime() - (days - 1 - i) * dayMs).toISOString().slice(0, 10), runs: 0, recs: 0 }));
  const byBot = {};
  const byHost = {};
  let recs = 0,
    cost = 0,
    tokens = 0,
    cached = 0,
    botRuns = 0,
    errors = 0,
    ms = 0;
  for (const run of runs) {
    const idx = days - 1 - Math.floor((today.getTime() - new Date(run.at).setHours(0, 0, 0, 0)) / dayMs);
    byHost[run.host] = (byHost[run.host] || 0) + 1;
    for (const b of run.bots) {
      botRuns++;
      const n = b.recommendations?.length || 0;
      recs += n;
      cost += b.cost || 0;
      tokens += (b.inputTokens || 0) + (b.outputTokens || 0);
      cached += b.cachedTokens || 0;
      ms += b.ms || 0;
      if (b.status === "error") errors++;
      byBot[b.botId] ??= { botId: b.botId, name: b.name, color: b.color, glyph: b.glyph, runs: 0, recs: 0 };
      byBot[b.botId].runs++;
      byBot[b.botId].recs += n;
      if (idx >= 0 && idx < days) daily[idx].recs += n;
    }
    if (idx >= 0 && idx < days) daily[idx].runs++;
  }
  return {
    deployments: runs.length,
    botRuns,
    recommendations: recs,
    cost,
    tokens,
    cachedTokens: cached,
    errors,
    avgMs: botRuns ? Math.round(ms / botRuns) : 0,
    daily,
    topBots: Object.values(byBot).sort((a, b) => b.recs - a.recs).slice(0, 8),
    topHosts: Object.entries(byHost).map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/state", (_req, res) => {
  res.json({ version: VERSION, settings: publicSettings(), bots: store.bots, models: MODELS });
});

app.put("/api/settings", (req, res) => {
  const patch = parse(SettingsZ, req.body, res);
  if (!patch) return;
  store.updateSettings(patch);
  res.json(publicSettings());
});

app.put("/api/credentials", (req, res) => {
  const body = parse(z.object({ apiKey: z.string().trim().min(20).max(500) }), req.body, res);
  if (!body) return;
  store.updateSettings({ apiKeyEnc: secrets.encrypt(body.apiKey), apiKeyHint: hintFor(body.apiKey) });
  res.json(publicSettings());
});

app.delete("/api/credentials", (_req, res) => {
  store.updateSettings({ apiKeyEnc: null, apiKeyHint: null });
  res.json(publicSettings());
});

app.post("/api/credentials/test", async (req, res) => {
  const key = (typeof req.body?.apiKey === "string" && req.body.apiKey.trim()) || apiKey();
  if (!key) return res.json({ ok: false, code: "no_key", error: "No API key configured yet." });
  res.json(await testKey(key, store.settings.model));
});

app.get("/api/bots", (_req, res) => res.json(store.bots));

app.post("/api/bots", (req, res) => {
  const data = parse(BotZ, req.body, res);
  if (!data) return;
  res.status(201).json(store.createBot(data));
});

app.put("/api/bots/:id", (req, res) => {
  const data = parse(BotZ.partial(), req.body, res);
  if (!data) return;
  const bot = store.updateBot(req.params.id, data);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  res.json(bot);
});

app.delete("/api/bots/:id", (req, res) => {
  if (!store.deleteBot(req.params.id)) return res.status(404).json({ error: "Bot not found" });
  res.sendStatus(204);
});

app.post("/api/bots/bulk", (req, res) => {
  const body = parse(z.object({ enabled: z.boolean().optional(), autoRun: z.boolean().optional() }), req.body, res);
  if (!body) return;
  store.bots.forEach((b) => store.updateBot(b.id, body));
  res.json(store.bots);
});

app.post("/api/bots/reset", (_req, res) => res.json(store.resetBots()));

app.post("/api/plan", (req, res) => {
  const body = parse(z.object({ url: z.string() }), req.body, res);
  if (!body) return;
  const blocked = urlMatches(body.url, store.settings.blocklist);
  const bots = blocked ? [] : matchingBots(body.url);
  res.json({ blocked, hasKey: !!apiKey(), autoScan: store.settings.autoScan, bots: bots.map(({ id, name, glyph, color, description, autoRun, effort }) => ({ id, name, glyph, color, description, autoRun, effort })) });
});

// Deploy: runs the selected bots against a page in parallel and streams each
// bot's result back as NDJSON the moment it lands.
app.post("/api/deploy", async (req, res) => {
  const body = parse(
    z.object({ page: PageZ, botIds: z.array(z.string()).max(50).optional(), trigger: z.enum(["manual", "auto", "context-menu", "shortcut"]).default("manual") }),
    req.body,
    res,
  );
  if (!body) return;
  const { settings } = store;
  if (urlMatches(body.page.url, settings.blocklist)) {
    return res.status(403).json({ error: "This site is on your privacy blocklist. Bots won't run here." });
  }
  const key = apiKey();
  if (!key) return res.status(412).json({ error: "Add your Claude API key in the dashboard to deploy bots.", code: "no_key" });

  const bots = matchingBots(body.page.url, body.botIds).filter((b) => (body.trigger === "auto" ? b.autoRun : true));
  if (!bots.length) return res.status(409).json({ error: "No enabled bots target this page.", code: "no_bots" });

  const page = { ...body.page };
  if (settings.redactPII) {
    for (const k of ["text", "selection", "description"]) page[k] = redact(page[k]);
    page.headings = page.headings?.map(redact);
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  const run = {
    id: `run_${crypto.randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
    url: page.url,
    title: page.title,
    host: new URL(page.url).hostname.replace(/^www\./, ""),
    trigger: body.trigger,
    model: settings.model,
    bots: [],
  };
  send({ type: "start", runId: run.id, model: settings.model, bots: bots.map(({ id, name, glyph, color }) => ({ id, name, glyph, color })) });

  const started = Date.now();
  await pool(bots, settings.concurrency, async (bot) => {
    send({ type: "bot_start", botId: bot.id });
    const base = { botId: bot.id, name: bot.name, glyph: bot.glyph, color: bot.color };
    try {
      const { result, meta } = await runBot({ apiKey: key, settings, bot, page, signal: controller.signal });
      const entry = { ...base, status: result.relevant ? "ok" : "skipped", headline: result.headline, recommendations: result.recommendations, ...meta };
      run.bots.push(entry);
      send({ type: "bot_result", ...entry });
    } catch (err) {
      const e = err instanceof BotError ? err : new BotError("internal", err.message);
      const entry = { ...base, status: "error", code: e.code, error: e.message, recommendations: [] };
      run.bots.push(entry);
      send({ type: "bot_error", ...entry });
    }
  });

  run.ms = Date.now() - started;
  if (!controller.signal.aborted) store.addRun(run);
  send({
    type: "done",
    runId: run.id,
    ms: run.ms,
    recommendations: run.bots.reduce((n, b) => n + (b.recommendations?.length || 0), 0),
    cost: run.bots.reduce((n, b) => n + (b.cost || 0), 0),
  });
  res.end();
});

app.get("/api/runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const q = String(req.query.q || "").toLowerCase();
  const runs = q ? store.runs.filter((r) => r.host.includes(q) || (r.title || "").toLowerCase().includes(q)) : store.runs;
  res.json(runs.slice(0, limit));
});

app.delete("/api/runs", (_req, res) => {
  store.clearRuns();
  res.sendStatus(204);
});

app.get("/api/stats", (_req, res) => res.json(computeStats()));

app.post("/api/token/rotate", (_req, res) => res.json({ token: store.rotateToken() }));

// ---------------------------------------------------------------------------
// Dashboard. The access token is embedded server-side; browsers never let
// other origins read this response, and the host check above blocks rebinding.
// ---------------------------------------------------------------------------
const publicDir = path.join(here, "..", "public");
app.get(["/", "/index.html"], (_req, res) => {
  const html = fs
    .readFileSync(path.join(publicDir, "index.html"), "utf8")
    .replace("__BOTFLEET_TOKEN__", store.accessToken)
    .replace("__BOTFLEET_ORIGIN__", `http://localhost:${PORT}`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  res.send(html);
});
app.use(express.static(publicDir, { index: false }));

app.listen(PORT, HOST, () => {
  const key = apiKey();
  console.log(`
  ┌──────────────────────────────────────────────────────┐
  │  BotFleet server v${VERSION}                              │
  │  Dashboard:  http://localhost:${PORT}                   │
  └──────────────────────────────────────────────────────┘
  Bots: ${store.bots.filter((b) => b.enabled).length} enabled / ${store.bots.length}
  Claude API key: ${key ? "configured" : "not set. Add it in the dashboard (Credentials)."}
  Pair the extension from the dashboard's "Extension" page.
`);
});
