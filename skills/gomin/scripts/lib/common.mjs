// Shared constants and helpers for the gomin CLI and server.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, promises as fs, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.0';
export const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UI_DIR = path.join(SCRIPTS_DIR, 'ui');
export const CLI_PATH = path.join(SCRIPTS_DIR, 'gomin.mjs');

export function home() {
  return path.resolve(process.env.GOMIN_HOME || path.join(os.homedir(), '.gomin'));
}

// Sandboxed agents (e.g. Codex's workspace-write mode) may not write to ~/.gomin.
// Fall back to a per-user temp directory, which those sandboxes allow, and pin it
// in the environment so the server we spawn agrees.
export function ensureWritableHome() {
  if (process.env.GOMIN_HOME) return null;
  const preferred = path.join(os.homedir(), '.gomin');
  try {
    mkdirSync(preferred, { recursive: true, mode: 0o700 });
    const probe = path.join(preferred, `.probe-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return null;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error;
    const user = os.userInfo().uid ?? os.userInfo().username;
    process.env.GOMIN_HOME = path.join(os.tmpdir(), `gomin-${user}`);
    return `${preferred} is not writable here (sandbox?); using ${process.env.GOMIN_HOME}.`;
  }
}

// Explains the usual cause when a sandbox blocks the local server.
export function sandboxHint(error) {
  if (!/EPERM|EACCES|ECONNREFUSED|did not start/.test(`${error.code ?? ''} ${error.message}`)) return '';
  return '\nIf you are running inside an agent sandbox: gomin needs to listen on and connect to 127.0.0.1. '
    + 'In Codex, run gomin commands outside the sandbox (approve the escalation, ideally "always" for this command), '
    + 'or enable [sandbox_workspace_write] network_access = true in ~/.codex/config.toml.';
}

export function preferredPort() {
  const port = Number(process.env.GOMIN_PORT || 4949);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('GOMIN_PORT must be a port number.');
  return port;
}

export function slug(value, max = 40) {
  const result = String(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return result || 'thread';
}

// One conversation thread per working directory unless --thread names another.
export function threadIdFor(cwd, name) {
  if (name) {
    if (!/^[\p{Letter}\p{Number}][\p{Letter}\p{Number}_-]{0,63}$/u.test(name)) {
      throw new Error('--thread must be 1-64 letters, digits, "-" or "_".');
    }
    return name;
  }
  const hash = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 4);
  return `${slug(path.basename(path.resolve(cwd)) || 'root', 32)}-${hash}`;
}

export const randomId = (bytes = 12) => randomBytes(bytes).toString('base64url');
export const now = () => new Date().toISOString();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomId(6)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

// A tiny JSON client on node:http. fetch() (undici) aborts responses that stay
// silent for 5 minutes, which breaks long waits; node:http has no such limit.
export function request(port, method, route, body, { timeoutMs = 10000, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); onChunk?.(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        // Long waits stream whitespace heartbeats before the final JSON line.
        const last = text.split('\n').filter((line) => line.trim()).at(-1) ?? '';
        let json = null;
        try { json = last ? JSON.parse(last) : null; } catch { /* reported below */ }
        if (res.statusCode >= 400 || !json) {
          const error = new Error(json?.error || `gomin server answered HTTP ${res.statusCode}.`);
          error.status = res.statusCode;
          return reject(error);
        }
        resolve(json);
      });
      res.on('error', reject);
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
