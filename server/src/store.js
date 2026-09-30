// Tiny durable JSON store. Writes are debounced and atomic (tmp file + rename),
// so a crash mid-write never leaves a corrupt database behind.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_BOTS } from "./bots.default.js";

const MAX_RUNS = 500;

export const DEFAULT_SETTINGS = {
  model: "claude-opus-5-5",
  useFallbacks: true,
  autoScan: false,
  redactPII: true,
  maxPageChars: 20000,
  concurrency: 4,
  blocklist: [
    "*bank*",
    "*.paypal.com",
    "accounts.google.com",
    "mail.google.com",
    "*.1password.com",
    "*.lastpass.com",
    "localhost",
    "127.0.0.1",
  ],
  apiKeyEnc: null,
  apiKeyHint: null,
};

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "db.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = this.#load();
    this.timer = null;
  }

  #load() {
    let db = null;
    if (fs.existsSync(this.file)) {
      try {
        db = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (err) {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, backup);
        console.warn(`[store] db.json was unreadable, moved to ${backup}`);
      }
    }
    db ??= {};
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    db.bots ??= DEFAULT_BOTS.map((b) => ({ ...b, createdAt: Date.now(), updatedAt: Date.now() }));
    db.runs ??= [];
    db.accessToken ??= crypto.randomBytes(24).toString("base64url");
    this.db = db;
    this.flush();
    return db;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- settings -----------------------------------------------------------
  get settings() {
    return this.db.settings;
  }

  updateSettings(patch) {
    this.db.settings = { ...this.db.settings, ...patch };
    this.save();
    return this.db.settings;
  }

  // ---- bots ---------------------------------------------------------------
  get bots() {
    return this.db.bots;
  }

  getBot(id) {
    return this.db.bots.find((b) => b.id === id);
  }

  createBot(data) {
    const bot = {
      ...data,
      id: `bot_${crypto.randomBytes(5).toString("hex")}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db.bots.push(bot);
    this.save();
    return bot;
  }

  updateBot(id, patch) {
    const bot = this.getBot(id);
    if (!bot) return null;
    Object.assign(bot, patch, { id, updatedAt: Date.now() });
    this.save();
    return bot;
  }

  deleteBot(id) {
    const before = this.db.bots.length;
    this.db.bots = this.db.bots.filter((b) => b.id !== id);
    this.save();
    return this.db.bots.length !== before;
  }

  resetBots() {
    this.db.bots = DEFAULT_BOTS.map((b) => ({ ...b, createdAt: Date.now(), updatedAt: Date.now() }));
    this.save();
    return this.db.bots;
  }

  // ---- runs ---------------------------------------------------------------
  get runs() {
    return this.db.runs;
  }

  addRun(run) {
    this.db.runs.unshift(run);
    if (this.db.runs.length > MAX_RUNS) this.db.runs.length = MAX_RUNS;
    this.save();
  }

  clearRuns() {
    this.db.runs = [];
    this.save();
  }

  get accessToken() {
    return this.db.accessToken;
  }

  rotateToken() {
    this.db.accessToken = crypto.randomBytes(24).toString("base64url");
    this.flush();
    return this.db.accessToken;
  }
}
