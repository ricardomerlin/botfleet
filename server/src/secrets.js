// Encrypts the user's AI credentials at rest with AES-256-GCM.
// The master key lives in its own 0600 file next to the database, so a copied
// db.json alone never exposes the API key.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Secrets {
  constructor(dataDir) {
    const keyFile = path.join(dataDir, ".master.key");
    if (!fs.existsSync(keyFile)) {
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    this.key = fs.readFileSync(keyFile);
  }

  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, data].map((b) => b.toString("base64")).join(".");
  }

  decrypt(blob) {
    const [iv, tag, data] = blob.split(".").map((s) => Buffer.from(s, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}

export function hintFor(key) {
  if (!key || key.length < 12) return "••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
