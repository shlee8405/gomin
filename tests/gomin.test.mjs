import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION, ensureWritableHome, readJson, sandboxHint, threadIdFor } from '../skills/gomin/scripts/lib/common.mjs';
import { injectRuntime, kitEnabled, lint, pageTitle } from '../skills/gomin/scripts/lib/html.mjs';
import { openPage, sendReply } from '../skills/gomin/scripts/lib/store.mjs';
import { NEXT_ENDED, NEXT_REPLY, formatReplies, formatReply } from '../skills/gomin/scripts/lib/format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'skills/gomin/scripts/gomin.mjs');

let temp, home, workspace, env;

function run(args, { cwd = workspace } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

function raw(port, { method = 'GET', route, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const port = async () => (await readJson(path.join(home, 'server.json'))).port;
const browser = (p) => ({ Origin: `http://127.0.0.1:${p}`, 'Sec-Fetch-Site': 'same-origin' });

before(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gomin-test-')));
  home = path.join(temp, 'home');
  workspace = path.join(temp, 'my project');
  await fs.mkdir(path.join(workspace, '.gomin'), { recursive: true });
  env = { ...process.env, GOMIN_HOME: home, GOMIN_PORT: '0', GOMIN_NO_OPEN: '1', GOMIN_CLOSE_GRACE_MS: '300', GOMIN_IDLE_MINUTES: '0' };
});

after(async () => {
  await run(['stop']);
  await fs.rm(temp, { recursive: true, force: true });
});

// ---------- Units ----------

test('injectRuntime adds doctype, viewport, kit layer, and bridge without touching author markup', async () => {
  const html = '<html lang="ko"><head><title>T</title></head><body><h1>안녕</h1></body></html>';
  const output = await injectRuntime(html);
  assert.match(output, /^<!doctype html>/);
  assert.match(output, /<meta name="viewport"/);
  assert.match(output, /@layer gomin-kit;/);
  assert.match(output, /<script data-gomin>/);
  assert.ok(output.includes('<body><h1>안녕</h1></body>'));
  assert.ok(output.indexOf('data-gomin') > output.indexOf('<head>'));

  const off = await injectRuntime('<!doctype html><html data-gomin-kit="off"><body>x</body></html>');
  assert.doesNotMatch(off, /@layer gomin-kit/);
  assert.match(off, /<script data-gomin>/);
  assert.equal(kitEnabled('<meta name="gomin-kit" content="off">'), false);
});

test('pageTitle and lint read pages without rendering', () => {
  assert.equal(pageTitle('<title> 결제 &amp; 환불 </title>', 'x'), '결제 & 환불');
  assert.equal(pageTitle('<h1>Only <em>heading</em></h1>', 'x'), 'Only heading');
  assert.equal(pageTitle('<p>nothing</p>', 'fallback.html'), 'fallback.html');
  assert.ok(lint('<form><input></form>').some((warning) => warning.includes('name=')));
  assert.ok(lint('<img src="/abs.png">').some((warning) => warning.includes('relative')));
  assert.deepEqual(lint('<!doctype html><html><body><form><input name="a"></form></body></html>'), []);
});

test('threadIdFor is stable per directory and validates explicit names', () => {
  assert.equal(threadIdFor('/a/My Project'), threadIdFor('/a/My Project'));
  assert.notEqual(threadIdFor('/a/x'), threadIdFor('/b/x'));
  assert.match(threadIdFor('/a/결제 서버'), /^결제-서버-[0-9a-f]{4}$/);
  assert.equal(threadIdFor('/a', 'plan_1'), 'plan_1');
  assert.throws(() => threadIdFor('/a', '../evil'));
});

test('sendReply sends only changed answers, reports unanswered questions, and clears comments', () => {
  const thread = { seq: 0, events: [], pages: {}, currentPageId: null, draft: { message: '', comments: [], pages: {} } };
  const { page } = openPage(thread, { file: '/x/plan.html', title: 'Plan', mtimeMs: 1 });
  const fields = {
    db: { name: 'db', question: '어떤 DB?', kind: 'radio', value: 'pg', display: 'Postgres', initial: null, touched: true },
    size: { name: 'size', question: 'Size', kind: 'select', value: 'm', display: 'Medium', initial: 'm', touched: false },
    note: { name: 'note', question: '메모', kind: 'textarea', value: '', display: '', initial: '', touched: false },
  };
  const draft = { message: ' 좋아요 ', comments: [{ id: 'c1', pageId: page.id, quote: '세 단계', text: '두 단계면?' }], pages: { [page.id]: { fields, sent: {} } } };
  const event = sendReply(thread, { draft, pageId: page.id, submitter: { name: 'decision', value: 'approve', label: '이대로 진행' } });

  assert.equal(event.message, '좋아요');
  assert.deepEqual(event.answers.map((answer) => answer.name), ['db']);
  assert.equal(event.answers[0].initial, undefined);
  assert.deepEqual(event.unanswered, ['메모']);
  assert.equal(event.comments.length, 1);
  assert.equal(thread.draft.comments.length, 0);
  assert.equal(thread.draft.pages[page.id].sent.db, '"pg"');

  // Unchanged answers are not repeated; an empty reply is refused.
  assert.throws(() => sendReply(thread, { draft: thread.draft, pageId: page.id }), /Nothing to send/);
  const again = sendReply(thread, { draft: { ...thread.draft, message: 'one more thing' }, pageId: page.id });
  assert.equal(again.answers.length, 0);
});

test('ending the conversation is a reply of its own and tells the agent to stop', () => {
  const thread = { seq: 0, events: [], pages: {}, currentPageId: null, draft: { message: '', comments: [], pages: {} } };
  const { page } = openPage(thread, { file: '/x/tour.html', title: 'Tour', mtimeMs: 1 });
  const ended = sendReply(thread, { draft: thread.draft, pageId: page.id, end: true });
  assert.equal(ended.ended, true);
  const text = formatReplies([ended], thread);
  assert.match(text, /Ended the conversation\./);
  assert.ok(text.endsWith(NEXT_ENDED));

  const reply = sendReply(thread, { draft: { ...thread.draft, message: 'What is in src/?' }, pageId: page.id });
  const next = formatReplies([reply], thread);
  assert.ok(next.endsWith(NEXT_REPLY));
  assert.match(NEXT_REPLY, /answer in the page/);
  assert.match(NEXT_REPLY, /wait` again/);
});

test('openPage announces new pages and revisions once', () => {
  const thread = { seq: 0, events: [], pages: {}, currentPageId: null };
  assert.equal(openPage(thread, { file: '/p.html', title: 'A', mtimeMs: 1 }).kind, 'new');
  assert.equal(openPage(thread, { file: '/p.html', title: 'A', mtimeMs: 1 }).kind, 'focus');
  const revised = openPage(thread, { file: '/p.html', title: 'A2', mtimeMs: 2 });
  assert.equal(revised.kind, 'revised');
  assert.equal(revised.page.rev, 2);
  assert.deepEqual(thread.events.map((event) => event.type), ['page', 'revise']);
});

test('formatReply is compact and keeps labels, values, quotes, and clicks', () => {
  const thread = { pages: { p: { title: '로그인 계획', path: '/w/.gomin/plan.html' } } };
  const text = formatReply({
    at: new Date().toISOString(), pageId: 'p', rev: 2, message: '진행해주세요',
    answers: [
      { pageId: 'p', name: 'mailer', question: '메일은 어디로?', kind: 'radio', value: 'ses', display: 'AWS SES' },
      { pageId: 'p', name: 'features', question: '기능', kind: 'checkbox', value: ['sso', 'csv'], display: ['SSO', 'CSV'] },
      { pageId: 'p', name: 'notes', question: '메모', kind: 'textarea', value: '줄1\n줄2', display: '줄1\n줄2' },
    ],
    unanswered: ['링크 유효 시간'],
    comments: [{ pageId: 'p', quote: '15분짜리 로그인 링크', context: '핵심 요약', text: '30분은 어때요?' }],
    submitter: { name: 'decision', value: 'approve', label: '이대로 진행' },
  }, thread);
  assert.match(text, /on "로그인 계획" \(rev 2\)/);
  assert.match(text, /file: \/w\/\.gomin\/plan\.html/);
  assert.match(text, /메일은 어디로\? \(mailer\): AWS SES \[ses\]/);
  assert.match(text, /기능 \(features\): SSO \[sso\], CSV \[csv\]/);
  assert.match(text, /\n {5}줄1\n {5}줄2/);
  assert.match(text, /Unanswered: 링크 유효 시간/);
  assert.match(text, /On "15분짜리 로그인 링크" — in "핵심 요약"\n {3}30분은 어때요\?/);
  assert.match(text, /Clicked: 이대로 진행 \[decision=approve\]/);
});

test('an unwritable ~/.gomin (agent sandbox) falls back to a temp directory', async () => {
  const saved = { HOME: process.env.HOME, GOMIN_HOME: process.env.GOMIN_HOME };
  const locked = path.join(temp, 'locked-home');
  await fs.mkdir(locked, { mode: 0o500 });
  try {
    process.env.HOME = locked;
    delete process.env.GOMIN_HOME;
    const note = ensureWritableHome();
    assert.match(note, /not writable/);
    assert.ok(process.env.GOMIN_HOME.startsWith(os.tmpdir()));
    // An explicit GOMIN_HOME is always respected.
    assert.equal(ensureWritableHome(), null);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.chmod(locked, 0o700);
  }
});

test('sandboxHint explains blocked localhost access and stays quiet otherwise', () => {
  assert.match(sandboxHint(Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1:4949'), { code: 'EPERM' })), /network_access = true/);
  assert.match(sandboxHint(new Error('The gomin server did not start.')), /outside the sandbox/);
  assert.equal(sandboxHint(new Error('open needs an HTML file')), '');
});

// ---------- End to end through the CLI and server ----------

test('open → browser reply → wait → revise → say → status', async () => {
  const page = path.join(workspace, '.gomin', 'plan.html');
  await fs.writeFile(page, '<!doctype html><html lang="ko"><head><title>로그인 계획</title></head><body><h1>계획</h1><form><input type="radio" name="db" value="pg"></form></body></html>');

  const opened = await run(['open', '.gomin/plan.html']);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Opened "로그인 계획" \(new page\)/);
  assert.match(opened.stdout, /browser: not opened/);
  assert.equal(await fs.readFile(path.join(workspace, '.gomin', '.gitignore'), 'utf8'), '*\n');

  const p = await port();
  const thread = threadIdFor(workspace);
  const state = JSON.parse((await raw(p, { route: `/api/threads/${encodeURIComponent(thread)}`, headers: browser(p) })).text);
  assert.equal(state.pages.length, 1);
  const pageId = state.currentPageId;

  // The page is served with the bridge, the kit, and a sandboxing CSP.
  const served = await raw(p, { route: `/p/${pageId}/plan.html` });
  assert.equal(served.status, 200);
  assert.match(served.headers['content-security-policy'], /sandbox allow-scripts/);
  assert.match(served.headers['content-security-policy'], /frame-ancestors http:\/\/127\.0\.0\.1:/);
  assert.match(served.text, /<script data-gomin>/);

  // Simulate the browser sending a reply.
  const sent = await raw(p, {
    method: 'POST',
    route: `/api/threads/${encodeURIComponent(thread)}/messages`,
    headers: browser(p),
    body: {
      pageId,
      draft: {
        message: '좋아요, 진행해주세요',
        comments: [{ id: 'c1', pageId, quote: '계획', context: '계획', text: '제목을 더 구체적으로' }],
        pages: { [pageId]: { fields: { db: { name: 'db', question: 'DB', kind: 'radio', value: 'pg', display: 'Postgres', initial: null, touched: true } }, sent: {} } },
      },
      submitter: { name: 'decision', value: 'approve', label: '이대로 진행' },
    },
  });
  assert.equal(sent.status, 201, sent.text);

  const waited = await run(['wait']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /The user replied in gomin/);
  assert.match(waited.stdout, /좋아요, 진행해주세요/);
  assert.match(waited.stdout, /DB \(db\): Postgres \[pg\]/);
  assert.match(waited.stdout, /제목을 더 구체적으로/);
  assert.match(waited.stdout, /Clicked: 이대로 진행 \[decision=approve\]/);

  // Delivered replies are not delivered twice.
  const empty = await run(['wait', '--timeout', '1']);
  assert.match(empty.stdout, /No reply yet/);

  // Editing the file and opening it again is a revision.
  await fs.appendFile(page, '\n<!-- v2 -->');
  utimesSync(page, new Date(), new Date(Date.now() + 5000));
  const revised = await run(['open', '.gomin/plan.html']);
  assert.match(revised.stdout, /revised to rev 2/);

  const said = await run(['say', '스키마 초안을 올렸어요']);
  assert.equal(said.code, 0, said.stderr);

  const status = await run(['status']);
  assert.match(status.stdout, /current: "로그인 계획" rev 2/);
  assert.match(status.stdout, /\(delivered\)/);

  const json = JSON.parse((await run(['status', '--json'])).stdout);
  assert.deepEqual(json.events.map((event) => event.type), ['page', 'user', 'revise', 'agent']);
});

test('wait reports a closed page after the last tab disconnects', async () => {
  const p = await port();
  const thread = threadIdFor(workspace);
  const events = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: `/api/threads/${encodeURIComponent(thread)}/events`, headers: browser(p) }, resolve);
  });
  const waiting = run(['wait']);
  await new Promise((resolve) => setTimeout(resolve, 400));
  events.destroy();
  const result = await waiting;
  assert.match(result.stdout, /closed the gomin page/);
});

test('say --file posts Markdown and the End button stops the agent loop', async () => {
  const p = await port();
  const thread = threadIdFor(workspace);
  const answer = path.join(temp, 'answer.md');
  await fs.writeFile(answer, '## src/\n- `server.mjs`: the HTTP server\n- `store.mjs`: threads');
  const said = await run(['say', '--file', answer]);
  assert.equal(said.code, 0, said.stderr);
  assert.match(said.stdout, /next: run "wait --thread/);
  const state = JSON.parse((await run(['status', '--json'])).stdout);
  assert.equal(state.events.at(-1).type, 'agent');
  assert.match(state.events.at(-1).text, /`server\.mjs`/);

  // A quoted heredoc on stdin keeps backticks and $ literal.
  const literal = 'Run `id` and keep $HOME as is.';
  execFileSync(process.execPath, [CLI, 'say'], { cwd: workspace, env, input: literal });
  const after = JSON.parse((await run(['status', '--json'])).stdout);
  assert.equal(after.events.at(-1).text, literal);

  const ended = await raw(p, {
    method: 'POST',
    route: `/api/threads/${encodeURIComponent(thread)}/messages`,
    headers: browser(p),
    body: { draft: { message: '', comments: [], pages: {} }, end: true },
  });
  assert.equal(ended.status, 201, ended.text);
  const result = JSON.parse((await run(['wait', '--json'])).stdout);
  assert.equal(result.status, 'ended');
  assert.match(result.text, /ended the conversation/);
});

test('the server rejects foreign hosts, cross-site requests, and path escapes', async () => {
  const p = await port();
  assert.equal((await raw(p, { route: '/api/threads', headers: { Host: `evil.example:${p}` } })).status, 403);
  assert.equal((await raw(p, { method: 'POST', route: '/api/shutdown', headers: { Origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await raw(p, { route: '/api/threads', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await raw(p, { route: '/p/unknown/plan.html' })).status, 404);

  const thread = threadIdFor(workspace);
  const state = JSON.parse((await raw(p, { route: `/api/threads/${encodeURIComponent(thread)}` })).text);
  const pageId = state.currentPageId;
  await fs.writeFile(path.join(workspace, 'secret.txt'), 'nope');
  await fs.writeFile(path.join(workspace, '.gomin', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal((await raw(p, { route: `/p/${pageId}/diagram.svg` })).status, 200);
  assert.equal((await raw(p, { route: `/p/${pageId}/..%2Fsecret.txt` })).status, 404);
  assert.equal((await raw(p, { route: `/p/${pageId}/.gitignore` })).status, 404);

  // The shell itself cannot be framed by other sites.
  const shell = await raw(p, { route: '/' });
  assert.equal(shell.headers['x-frame-options'], 'DENY');
});

test('version is consistent across the CLI and package manifests', async () => {
  const pkg = await readJson(path.join(ROOT, 'package.json'));
  const plugin = await readJson(path.join(ROOT, '.claude-plugin/plugin.json'));
  assert.equal(pkg.version, VERSION);
  assert.equal(plugin.version, VERSION);
  const { stdout } = await run(['--version']);
  assert.equal(stdout.trim(), VERSION);
});
