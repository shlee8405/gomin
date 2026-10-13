// The local gomin server. One process serves every thread on 127.0.0.1.
import http from 'node:http';
import path from 'node:path';
import { createReadStream, promises as fs, watchFile, unwatchFile } from 'node:fs';
import { UI_DIR, VERSION, now, readJson, writeJsonAtomic } from './common.mjs';
import { MAX_PAGE_BYTES, injectRuntime, lint, pageTitle } from './html.mjs';
import { HttpError, Store, check, cleanDraft, openPage, pendingReplies, pushEvent, sendReply } from './store.mjs';
import { formatReplies } from './format.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const UI_FILES = {
  'shell.js': 'text/javascript; charset=utf-8',
  'shell.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};
const ASSET_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
};

function pageCsp(origin) {
  return [
    'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' https: blob: ${origin}`,
    `style-src 'unsafe-inline' https: ${origin}`,
    `img-src data: blob: https: http: ${origin}`,
    `font-src data: https: ${origin}`,
    `media-src data: blob: https: ${origin}`,
    'connect-src https: data: blob:',
    'frame-src https:',
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join('; ');
}

async function readBody(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  check(type === 'application/json', 'Content-Type must be application/json.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    check(size <= MAX_BODY, 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    check(value && typeof value === 'object' && !Array.isArray(value), 'Body must be a JSON object.');
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => {
        const lock = await readJson(file).catch(() => null);
        if (lock?.pid === process.pid) await fs.unlink(file).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = await readJson(file).catch(() => null);
      let alive = false;
      if (Number.isSafeInteger(lock?.pid) && lock.pid > 0 && lock.pid !== process.pid) {
        try { process.kill(lock.pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
      }
      if (alive) throw Object.assign(new Error(`Another gomin server (pid ${lock.pid}) owns ${path.dirname(file)}.`), { code: 'GOMIN_RUNNING' });
      await fs.unlink(file).catch(() => {});
    }
  }
  throw new Error('Could not acquire the gomin server lock.');
}

export async function startServer({
  home,
  port = 4949,
  idleMs = 30 * 60 * 1000,
  closeGraceMs = Number(process.env.GOMIN_CLOSE_GRACE_MS || 30000),
  onExit,
} = {}) {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireLock(path.join(home, 'server.lock'));
  const store = new Store(home);
  const live = new Map(); // threadId -> { clients, waiters, watched, lastGone }
  const pageIndex = new Map(); // pageId -> threadId
  let lastActivity = Date.now();
  let server;

  const runtime = (id) => {
    if (!live.has(id)) live.set(id, { clients: new Set(), waiters: new Set(), watched: new Map(), lastGone: 0 });
    return live.get(id);
  };
  for (const thread of await store.list()) for (const pageId of Object.keys(thread.pages)) pageIndex.set(pageId, thread.id);

  function project(thread) {
    const info = runtime(thread.id);
    return {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      currentPageId: thread.currentPageId,
      pages: Object.values(thread.pages).map(({ id, title, rev, path: file, openedAt, updatedAt }) => ({ id, title, rev, path: file, name: path.basename(file), openedAt, updatedAt })),
      events: thread.events,
      draft: thread.draft,
      waiting: info.waiters.size > 0,
      clients: info.clients.size,
      version: VERSION,
    };
  }

  function broadcast(thread) {
    const info = runtime(thread.id);
    if (!info.clients.size) return;
    const { draft, ...state } = project(thread);
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of info.clients) client.write(frame);
  }

  function watchPage(threadId, page) {
    const info = runtime(threadId);
    if (info.watched.has(page.id)) return;
    let timer = null;
    const listener = (current, previous) => {
      if (!current.mtimeMs || current.mtimeMs === previous.mtimeMs) return;
      clearTimeout(timer);
      // Editors often write in several steps; settle before reloading.
      timer = setTimeout(async () => {
        try {
          const stat = await fs.stat(page.path);
          const html = await fs.readFile(page.path, 'utf8');
          const thread = await store.mutate(threadId, (current) => {
            const target = current.pages[page.id];
            if (target && target.mtimeMs !== stat.mtimeMs) {
              target.rev += 1;
              target.mtimeMs = stat.mtimeMs;
              target.updatedAt = now();
              target.title = pageTitle(html, target.title);
            }
            return current;
          });
          broadcast(thread);
        } catch { /* the file may be mid-write or gone; the next change retries */ }
      }, 250);
    };
    watchFile(page.path, { interval: 400, persistent: false }, listener);
    info.watched.set(page.id, () => { clearTimeout(timer); unwatchFile(page.path, listener); });
  }

  function unwatchAll(threadId) {
    const info = runtime(threadId);
    for (const stop of info.watched.values()) stop();
    info.watched.clear();
  }

  async function deliver(threadId) {
    const current = await store.load(threadId);
    if (!current || !pendingReplies(current).length) return null;
    let payload = null;
    await store.mutate(threadId, (thread) => {
      const pending = pendingReplies(thread);
      if (!pending.length) return;
      const at = now();
      for (const event of pending) event.deliveredAt = at;
      const ended = pending.some((event) => event.ended);
      payload = { status: ended ? 'ended' : 'reply', text: formatReplies(pending, thread), replies: pending };
    });
    return payload;
  }

  function wakeWaiters(threadId) {
    for (const waiter of runtime(threadId).waiters) waiter.check();
  }

  async function handleWait(req, res, threadId) {
    const input = await readBody(req);
    const timeout = Number(input.timeout ?? 0);
    check(Number.isFinite(timeout) && timeout >= 0, 'timeout must be a number of seconds (0 = no limit).');
    const thread = await store.load(threadId);
    check(thread, `Thread "${threadId}" not found. Run gomin open <file> first.`, 404);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    const info = runtime(threadId);
    let done = false;
    let busy = false;
    const waiter = { sawClient: info.clients.size > 0, check: () => {} };
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      info.waiters.delete(waiter);
      if (!res.destroyed) res.end(`${JSON.stringify(value)}\n`);
      store.load(threadId).then((current) => current && broadcast(current));
    };
    waiter.check = async () => {
      if (done || busy) return;
      busy = true;
      try {
        const payload = await deliver(threadId);
        if (payload) return finish(payload);
        if (waiter.sawClient && !info.clients.size && Date.now() - info.lastGone >= closeGraceMs) {
          return finish({ status: 'closed', text: 'The user closed the gomin page without replying. Do not reopen it uninvited; continue in chat or ask whether to reopen.' });
        }
      } catch (error) {
        finish({ status: 'error', error: error.message });
      } finally { busy = false; }
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(' \n');
      if (info.clients.size) waiter.sawClient = true;
      waiter.check();
    }, Math.min(15000, Math.max(250, closeGraceMs / 2)));
    const timer = timeout ? setTimeout(() => finish({ status: 'timeout', text: 'No reply yet. The page is still open; run gomin wait again to keep listening.' }), timeout * 1000) : null;
    res.on('close', () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      info.waiters.delete(waiter);
      store.load(threadId).then((current) => current && broadcast(current));
    });
    info.waiters.add(waiter);
    broadcast(thread);
    await waiter.check();
  }

  async function handleOpen(input) {
    const file = path.resolve(String(input.path ?? ''));
    const stat = await fs.stat(file).catch(() => null);
    check(stat?.isFile(), `File not found: ${file}`, 404);
    check(stat.size <= MAX_PAGE_BYTES, 'The page is larger than 10 MB.', 413);
    const threadId = String(input.thread ?? '');
    check(/^[\p{Letter}\p{Number}][\p{Letter}\p{Number}_-]{0,63}$/u.test(threadId), 'Invalid thread name.');
    const html = await fs.readFile(file, 'utf8');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : pageTitle(html, path.basename(file));
    const cwd = typeof input.cwd === 'string' ? input.cwd : null;
    const result = await store.mutate(threadId, (thread) => {
      const opened = openPage(thread, { file, title, mtimeMs: stat.mtimeMs, cwd });
      return { thread, ...opened };
    }, { create: { cwd } });
    pageIndex.set(result.page.id, threadId);
    const info = runtime(threadId);
    if (info.clients.size) watchPage(threadId, result.page);
    broadcast(result.thread);
    return {
      thread: threadId,
      page: result.page.id,
      rev: result.page.rev,
      kind: result.kind,
      title: result.page.title,
      clients: info.clients.size,
      waiting: info.waiters.size > 0,
      warnings: lint(html),
    };
  }

  function guard(req) {
    const host = req.headers.host ?? '';
    const port = server.address().port;
    check([`127.0.0.1:${port}`, `localhost:${port}`].includes(host), 'Invalid Host header.', 403);
    const url = new URL(req.url, `http://${host}`);
    // The sandboxed page loads its own assets with an opaque origin, so /p/ is
    // cross-site by nature; its unguessable page ID is the capability.
    if (url.pathname.startsWith('/p/') && req.method === 'GET') return url;
    const origin = req.headers.origin;
    check(origin === undefined || origin === `http://${host}`, 'Cross-origin requests are not allowed.', 403);
    const site = req.headers['sec-fetch-site'];
    const navigation = req.method === 'GET' && !url.pathname.startsWith('/api/');
    check(!site || site === 'same-origin' || site === 'none' || navigation, 'Cross-site requests are not allowed.', 403);
    return url;
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }

  async function serveShell(res) {
    const html = await fs.readFile(path.join(UI_DIR, 'shell.html'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  async function servePage(req, res, url) {
    const [, , pageId, ...rest] = url.pathname.split('/');
    const threadId = pageIndex.get(pageId);
    const thread = threadId && await store.load(threadId);
    const page = thread?.pages[pageId];
    check(page, 'Page not found.', 404);
    const relative = rest.map(decodeURIComponent).join('/');
    const origin = `http://${req.headers.host}`;
    if (relative === path.basename(page.path)) {
      const html = await fs.readFile(page.path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') throw new HttpError(404, `The page file no longer exists: ${page.path}`);
        throw error;
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': pageCsp(origin),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(await injectRuntime(html));
    }
    const base = path.dirname(page.path);
    const file = path.resolve(base, relative);
    check(file.startsWith(base + path.sep) && !relative.split('/').some((part) => part.startsWith('.')), 'Not found.', 404);
    const type = ASSET_TYPES[path.extname(file).toLowerCase()];
    check(type, 'Unsupported asset type.', 404);
    const stat = await fs.stat(file).catch(() => null);
    check(stat?.isFile() && stat.size <= 50 * 1024 * 1024, 'Not found.', 404);
    const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    // Fonts and module scripts from the opaque-origin page need CORS.
    if (req.headers.origin === 'null') headers['Access-Control-Allow-Origin'] = 'null';
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = pageCsp(origin);
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  }

  function openEvents(req, res, thread) {
    const info = runtime(thread.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    info.clients.add(res);
    for (const waiter of info.waiters) waiter.sawClient = true;
    for (const page of Object.values(thread.pages)) watchPage(thread.id, page);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(ping);
      info.clients.delete(res);
      if (!info.clients.size) {
        info.lastGone = Date.now();
        unwatchAll(thread.id);
        setTimeout(() => wakeWaiters(thread.id), closeGraceMs + 50);
      }
    });
    broadcast(thread);
  }

  async function route(req, res) {
    lastActivity = Date.now();
    const url = guard(req);
    const parts = url.pathname.split('/').filter(Boolean);
    const { method } = req;

    if (method === 'GET' && (url.pathname === '/' || parts[0] === 't')) return serveShell(res);
    if (method === 'GET' && parts[0] === '_' && UI_FILES[parts[1]]) {
      res.writeHead(200, { 'Content-Type': UI_FILES[parts[1]], 'Cache-Control': 'no-cache' });
      return res.end(await fs.readFile(path.join(UI_DIR, parts[1])));
    }
    if (method === 'GET' && parts[0] === 'p') return servePage(req, res, url);
    check(parts[0] === 'api', 'Not found.', 404);

    if (method === 'GET' && parts[1] === 'health') return sendJson(res, 200, { gomin: true, version: VERSION, pid: process.pid, home, port: server.address().port });
    if (method === 'POST' && parts[1] === 'shutdown') {
      res.once('finish', () => setImmediate(() => close()));
      return sendJson(res, 200, { status: 'stopping' });
    }
    if (method === 'POST' && parts[1] === 'open') return sendJson(res, 200, await handleOpen(await readBody(req)));
    if (method === 'GET' && parts[1] === 'threads' && parts.length === 2) {
      const threads = await store.list();
      return sendJson(res, 200, threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        cwd: thread.cwd,
        updatedAt: thread.updatedAt,
        pages: Object.keys(thread.pages).length,
        current: thread.pages[thread.currentPageId]?.title ?? null,
        waiting: runtime(thread.id).waiters.size > 0,
        unread: pendingReplies(thread).length,
      })));
    }

    check(parts[1] === 'threads' && parts[2], 'Not found.', 404);
    const threadId = decodeURIComponent(parts[2]);
    const action = parts[3];
    if (method === 'POST' && action === 'wait') return handleWait(req, res, threadId);
    const thread = await store.load(threadId);
    check(thread, `Thread "${threadId}" not found.`, 404);

    if (method === 'GET' && !action) return sendJson(res, 200, project(thread));
    if (method === 'GET' && action === 'events') return openEvents(req, res, thread);
    if ((method === 'PUT' || method === 'POST') && action === 'draft') {
      const draft = cleanDraft(await readBody(req));
      await store.mutate(threadId, (current) => { current.draft = draft; });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'messages') {
      const input = await readBody(req);
      const event = await store.mutate(threadId, (current) => sendReply(current, input));
      const current = await store.load(threadId);
      broadcast(current);
      wakeWaiters(threadId);
      return sendJson(res, 201, { event, state: project(current) });
    }
    if (method === 'POST' && action === 'say') {
      const input = await readBody(req);
      check(typeof input.text === 'string' && input.text.trim() && input.text.length <= 20000, 'text must be a nonempty string.');
      const event = await store.mutate(threadId, (current) => pushEvent(current, { type: 'agent', text: input.text.trim() }));
      broadcast(await store.load(threadId));
      return sendJson(res, 201, { event, clients: runtime(threadId).clients.size });
    }
    throw new HttpError(404, 'Not found.');
  }

  server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error; see server.log.' : error.message });
      else if (!res.writableEnded) res.end(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 0;

  try {
    await new Promise((resolve, reject) => {
      const listen = (candidate) => {
        server.once('error', (error) => {
          if (error.code === 'EADDRINUSE' && candidate !== 0) return listen(0);
          reject(error);
        });
        server.listen(candidate, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(); });
      };
      listen(port);
    });
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const actualPort = server.address().port;
  await writeJsonAtomic(path.join(home, 'server.json'), { pid: process.pid, port: actualPort, version: VERSION, startedAt: now() });

  const idleTimer = idleMs > 0 ? setInterval(() => {
    const busy = [...live.values()].some((info) => info.clients.size || info.waiters.size);
    if (!busy && Date.now() - lastActivity > idleMs) close();
  }, Math.min(60000, idleMs)) : null;
  idleTimer?.unref();

  let closing = null;
  function close() {
    closing ??= (async () => {
      clearInterval(idleTimer);
      for (const id of live.keys()) unwatchAll(id);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const info = await readJson(path.join(home, 'server.json')).catch(() => null);
      if (info?.pid === process.pid) await fs.unlink(path.join(home, 'server.json')).catch(() => {});
      await releaseLock();
      onExit?.();
    })();
    return closing;
  }

  return { port: actualPort, url: `http://127.0.0.1:${actualPort}`, close };
}
