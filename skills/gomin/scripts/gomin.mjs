#!/usr/bin/env node
// gomin CLI: show agent-written HTML in the browser and bring the user's reply back.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync, promises as fs } from 'node:fs';
import { CLI_PATH, VERSION, ensureWritableHome, home, preferredPort, readJson, request, sandboxHint, sleep, threadIdFor } from './lib/common.mjs';
import { formatStatus } from './lib/format.mjs';
import { exportStandalone, lint } from './lib/html.mjs';

const HELP = `gomin ${VERSION} — reply to the user with an HTML page and get their answer back.

Usage (run with node, e.g. node <skill-dir>/scripts/gomin.mjs <command>):
  open <file.html>   Show the page in the browser (new page or revision of the same file).
                     Re-run after editing the file; open tabs follow automatically.
  wait               Block until the user replies from the page, then print the reply.
  say <text>         Post a short note to the page's conversation (no page needed).
  status             Show the thread, its pages, and recent replies.
  list               List threads.
  export <file.html> Write a standalone copy with the style kit inlined (<name>.standalone.html).
  stop               Stop the background server.

Options:
  --thread <id>      Conversation thread. Default: one per working directory.
  --title <text>     (open) Page title. Default: <title> or first <h1>.
  --no-open          (open) Never launch a browser; print the URL instead.
  --timeout <sec>    (wait) Give up after this many seconds. Default: 0 = wait until a reply.
  --json             (wait, status) Machine-readable output.
  --out <file>       (export) Output path.

Environment: GOMIN_HOME (state dir, default ~/.gomin), GOMIN_PORT (default 4949),
GOMIN_NO_OPEN=1, GOMIN_THREAD, GOMIN_IDLE_MINUTES (server idle exit, default 30, 0 = never).

Authoring guide: references/design.md and references/patterns.md next to SKILL.md.`;

const VALUE_FLAGS = new Set(['thread', 'title', 'timeout', 'out', 'port']);
const BOOLEAN_FLAGS = new Set(['no-open', 'json', 'help', 'version']);

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option --${name}. Run gomin --help.`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { command: positional.shift(), positional, flags };
}

const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function findServer() {
  const info = await readJson(path.join(home(), 'server.json')).catch(() => null);
  if (!info?.port) return null;
  try {
    const health = await request(info.port, 'GET', '/api/health', undefined, { timeoutMs: 1500 });
    if (health.gomin && path.resolve(health.home) === home()) return { port: info.port, version: health.version };
  } catch { /* not running */ }
  return null;
}

async function ensureServer() {
  let server = await findServer();
  if (server && newer(VERSION, server.version)) {
    // A newer CLI replaces an older server; an older CLI uses a newer server as is.
    await request(server.port, 'POST', '/api/shutdown', {}).catch(() => {});
    for (let i = 0; i < 50 && await findServer(); i++) await sleep(100);
    server = null;
  }
  if (server) return server.port;

  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  const log = openSync(path.join(home(), 'server.log'), 'a', 0o600);
  try {
    spawn(process.execPath, [CLI_PATH, 'serve'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env }).unref();
  } finally { closeSync(log); }
  for (let i = 0; i < 100; i++) {
    await sleep(80);
    server = await findServer();
    if (server) return server.port;
  }
  throw new Error(`The gomin server did not start. See ${path.join(home(), 'server.log')}.`);
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function resolveThread(port, flags, { mustExist = true } = {}) {
  const id = threadIdFor(process.cwd(), flags.thread ?? process.env.GOMIN_THREAD);
  if (!mustExist) return id;
  try {
    await request(port, 'GET', `/api/threads/${encodeURIComponent(id)}`);
    return id;
  } catch (error) {
    if (error.status !== 404) throw error;
    const threads = await request(port, 'GET', '/api/threads').catch(() => []);
    const hint = threads.slice(0, 5).map((thread) => `  ${thread.id}  ${thread.cwd ?? ''}`).join('\n');
    throw new Error(`No gomin thread "${id}" for ${process.cwd()}.${hint ? `\nRecent threads (pass --thread <id>):\n${hint}` : ' Run open <file.html> first.'}`);
  }
}

const threadUrl = (port, id) => `http://127.0.0.1:${port}/t/${encodeURIComponent(id)}`;

async function main() {
  const { command, positional, flags } = parse(process.argv.slice(2));
  if (flags.version) return console.log(VERSION);
  if (!command || flags.help || command === 'help') return console.log(HELP);
  if (command !== 'export') {
    const note = ensureWritableHome();
    if (note) process.stderr.write(`gomin: ${note}\n`);
  }

  if (command === 'serve') {
    const { startServer } = await import('./lib/server.mjs');
    const minutes = Number(process.env.GOMIN_IDLE_MINUTES ?? 30);
    try {
      const server = await startServer({
        home: home(),
        port: flags.port !== undefined ? Number(flags.port) : preferredPort(),
        idleMs: Number.isFinite(minutes) ? minutes * 60000 : 30 * 60000,
        onExit: () => process.exit(0),
      });
      console.log(`[${new Date().toISOString()}] gomin ${VERSION} listening on ${server.url} (home ${home()})`);
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
    } catch (error) {
      if (error.code === 'GOMIN_RUNNING') { console.log(error.message); return; }
      throw error;
    }
    return;
  }

  if (command === 'export') {
    const file = positional[0];
    if (!file) throw new Error('export needs an HTML file.');
    const source = path.resolve(file);
    const out = path.resolve(flags.out ?? source.replace(/\.html?$/i, '') + '.standalone.html');
    await fs.writeFile(out, await exportStandalone(await fs.readFile(source, 'utf8')));
    return console.log(`Exported ${out}`);
  }

  if (command === 'stop') {
    const server = await findServer();
    if (!server) return console.log('gomin server is not running.');
    await request(server.port, 'POST', '/api/shutdown', {});
    return console.log('gomin server stopped.');
  }

  if (command === 'open') {
    const file = positional[0];
    if (!file) throw new Error('open needs an HTML file: gomin open page.html');
    const absolute = path.resolve(file);
    const html = await fs.readFile(absolute, 'utf8').catch(() => { throw new Error(`Cannot read ${absolute}.`); });
    // Pages written to a project's .gomin/ folder stay out of git.
    if (path.basename(path.dirname(absolute)) === '.gomin') {
      await fs.writeFile(path.join(path.dirname(absolute), '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
    }
    const port = await ensureServer();
    const thread = await resolveThread(port, flags, { mustExist: false });
    const result = await request(port, 'POST', '/api/open', { path: absolute, thread, cwd: process.cwd(), title: flags.title });
    const url = threadUrl(port, thread);
    const noOpen = flags['no-open'] || process.env.GOMIN_NO_OPEN === '1';
    let browser;
    if (result.clients > 0) browser = `already open in ${result.clients} tab${result.clients > 1 ? 's' : ''}; it now shows this page`;
    else if (!noOpen && openBrowser(url)) browser = 'opened a browser tab';
    else browser = 'not opened; share the URL with the user';
    const kind = { new: 'new page', revised: `revised to rev ${result.rev}`, focus: `rev ${result.rev}, unchanged` }[result.kind];
    const lines = [
      `Opened "${result.title}" (${kind}) in thread ${thread}`,
      `url: ${url}`,
      `browser: ${browser}`,
      ...[...new Set([...lint(html), ...result.warnings])].map((warning) => `warning: ${warning}`),
      `next: in one message, give the user this URL in one line AND run "wait --thread ${thread}" (it blocks until they reply). Do not end your turn without the wait.`,
    ];
    return console.log(lines.join('\n'));
  }

  if (!['wait', 'say', 'status', 'list'].includes(command)) throw new Error(`Unknown command "${command}". Run gomin --help.`);
  const port = await ensureServer();

  if (command === 'list') {
    const threads = await request(port, 'GET', '/api/threads');
    if (!threads.length) return console.log('No threads yet.');
    return console.log(threads.map((thread) => `${thread.id}  ${thread.pages} page(s)  ${thread.unread ? `${thread.unread} unread  ` : ''}${thread.cwd ?? ''}\n  ${threadUrl(port, thread.id)}`).join('\n'));
  }

  const thread = await resolveThread(port, flags);

  if (command === 'say') {
    const text = positional.join(' ').trim();
    if (!text) throw new Error('say needs text: gomin say "Done — the plan is implemented."');
    const result = await request(port, 'POST', `/api/threads/${encodeURIComponent(thread)}/say`, { text });
    return console.log(`Posted to thread ${thread}${result.clients ? '' : ' (no browser tab is open right now)'}.`);
  }

  if (command === 'status') {
    const state = await request(port, 'GET', `/api/threads/${encodeURIComponent(thread)}`);
    if (flags.json) return console.log(JSON.stringify(state, null, 2));
    const pages = Object.fromEntries(state.pages.map((page) => [page.id, page]));
    return console.log(formatStatus({ ...state, pages }, { waiting: state.waiting, clients: state.clients, url: threadUrl(port, thread) }));
  }

  // wait
  const timeout = Number(flags.timeout ?? 0);
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('--timeout must be a number of seconds.');
  process.stderr.write(`gomin: waiting for the user's reply on ${threadUrl(port, thread)}${timeout ? ` (up to ${timeout}s)` : ''}…\n`);
  let result;
  try {
    result = await request(port, 'POST', `/api/threads/${encodeURIComponent(thread)}/wait`, { timeout }, { timeoutMs: 0 });
  } catch (error) {
    if (error.status) throw error;
    throw new Error(`Lost the connection to the gomin server (${error.message}). Run wait again; replies are kept until delivered.`);
  }
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  if (result.status === 'error') throw new Error(result.error);
  console.log(result.text);
}

main().catch((error) => {
  console.error(`gomin: ${error.message}${sandboxHint(error)}`);
  process.exitCode = 1;
});
