// The gomin window around the agent's page: thread timeline, composer, and drafts.

const I18N = {
  ko: {
    brand: '고민',
    other: 'English',
    conversation: '대화',
    waiting: '에이전트가 기다리는 중',
    notWaiting: '에이전트 대기 안 함',
    enterHint: 'Enter 보내기 · Shift+Enter 줄바꿈',
    notWaitingHint: '보낸 내용은 저장돼요. 에이전트가 다음에 확인해요.',
    placeholder: '에이전트에게 답장하기…',
    send: '보내기',
    sending: '보내는 중…',
    sent: '에이전트에게 보냈어요',
    sendFailed: '보내지 못했어요',
    read: (time) => `에이전트가 읽음 · ${time}`,
    unread: '아직 안 읽음',
    you: '나',
    agent: '에이전트',
    newPage: '새 페이지',
    revised: (rev) => `수정됨 · v${rev}`,
    viewing: '보는 중',
    latest: '최신 페이지로',
    newPageArrived: '새 페이지가 도착했어요',
    view: '보기',
    commentMode: '코멘트',
    commentModeOn: '요소를 클릭하거나 텍스트를 드래그해 코멘트를 남겨요. Esc로 종료',
    answers: (n) => `답변 ${n}`,
    comments: (n) => `코멘트 ${n}`,
    clicked: (label) => `클릭 · ${label}`,
    changedAnswers: (n) => `바뀐 답변 ${n}개`,
    remove: '삭제',
    general: '전체',
    cleared: '(지움)',
    emptyThread: '아직 페이지가 없어요. 에이전트가 gomin open으로 페이지를 열면 여기에 나타나요.',
    emptyTimeline: '에이전트의 페이지와 내 답장이 여기에 쌓여요.',
    disconnected: 'gomin 서버와 연결이 끊겼어요. 다시 연결하는 중…',
    threads: '대화 목록',
    threadsSubtitle: '에이전트가 연 페이지들이에요.',
    noThreads: '아직 대화가 없어요. 에이전트에게 gomin으로 답해달라고 해보세요.',
    unreadBadge: (n) => `안 읽은 답장 ${n}`,
    pages: (n) => `페이지 ${n}개`,
    notFound: '이 대화를 찾을 수 없어요.',
  },
  en: {
    brand: 'gomin',
    other: '한국어',
    conversation: 'Conversation',
    waiting: 'Agent is listening',
    notWaiting: 'Agent not listening',
    enterHint: 'Enter to send · Shift+Enter for a new line',
    notWaitingHint: 'Your reply is saved; the agent picks it up next time.',
    placeholder: 'Reply to the agent…',
    send: 'Send',
    sending: 'Sending…',
    sent: 'Sent to the agent',
    sendFailed: 'Could not send',
    read: (time) => `Read by agent · ${time}`,
    unread: 'Not read yet',
    you: 'You',
    agent: 'Agent',
    newPage: 'New page',
    revised: (rev) => `Revised · v${rev}`,
    viewing: 'Viewing',
    latest: 'Back to latest',
    newPageArrived: 'A new page arrived',
    view: 'View',
    commentMode: 'Comment',
    commentModeOn: 'Click an element or select text to comment. Esc to exit.',
    answers: (n) => `${n} answer${n === 1 ? '' : 's'}`,
    comments: (n) => `${n} comment${n === 1 ? '' : 's'}`,
    clicked: (label) => `Clicked · ${label}`,
    changedAnswers: (n) => `${n} changed answer${n === 1 ? '' : 's'}`,
    remove: 'Remove',
    general: 'General',
    cleared: '(cleared)',
    emptyThread: 'No page yet. It appears here when the agent runs gomin open.',
    emptyTimeline: 'Pages from the agent and your replies collect here.',
    disconnected: 'Lost the connection to the gomin server. Reconnecting…',
    threads: 'Conversations',
    threadsSubtitle: 'Pages your agents have opened.',
    noThreads: 'No conversations yet. Ask your agent to answer with gomin.',
    unreadBadge: (n) => `${n} unread`,
    pages: (n) => `${n} page${n === 1 ? '' : 's'}`,
    notFound: 'This conversation does not exist.',
  },
};

const $ = (selector) => document.querySelector(selector);
const key = (value) => JSON.stringify(value ?? null);
const threadId = decodeURIComponent(location.pathname.match(/^\/t\/([^/]+)/)?.[1] ?? '');
const threadPath = `/api/threads/${encodeURIComponent(threadId)}`;

const storage = {
  get(name) { try { return localStorage.getItem(name); } catch { return null; } },
  set(name, value) { try { localStorage.setItem(name, value); } catch { /* private mode */ } },
};
// UI language: the user's explicit choice, else the page's lang (set from the conversation), else the browser's.
const supported = (lang) => (/^ko\b/i.test(lang ?? '') ? 'ko' : /^en\b/i.test(lang ?? '') ? 'en' : null);
let locale = storage.get('gomin.locale') || supported(navigator.languages?.[0] ?? navigator.language) || 'en';
let t = I18N[locale] ?? I18N.en;

function followPageLanguage(lang) {
  const next = supported(lang);
  if (!next || next === locale || storage.get('gomin.locale')) return;
  locale = next;
  applyLocale();
  render();
}

let thread = null;
let draft = { message: '', comments: [], pages: {} };
let viewingPageId = null;
let frame = null;
let frameSrc = '';
let commentMode = false;
let sending = false;
let panelOpen = false;
const scrollPositions = {};

// ---------- Helpers ----------

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

const icon = (path) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
};
const ICONS = {
  page: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

const time = (iso) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const short = (value, max = 60) => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const pageById = (id) => thread?.pages.find((page) => page.id === id) ?? null;

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

// Draft saves and sends share one queue so a late save never resurrects sent comments.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => enqueue(() => api(`${threadPath}/draft`, { method: 'PUT', body: draft }).catch(() => {})), 400);
}

let toastTimer = null;
function toast(message, { error = false, action } = {}) {
  const element = $('#toast');
  element.replaceChildren(h('span', {}, message), action ? h('button', { type: 'button', onclick: () => { element.hidden = true; action.run(); } }, action.label) : null);
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, action ? 8000 : error ? 6000 : 2600);
}

function banner(message) {
  $('#banner').textContent = message ?? '';
  $('#banner').hidden = !message;
}

// ---------- Draft ----------

function changedAnswers() {
  const list = [];
  for (const [pageId, entry] of Object.entries(draft.pages)) {
    if (!pageById(pageId)) continue;
    for (const field of Object.values(entry.fields ?? {})) {
      const baseline = entry.sent?.[field.name] ?? key(field.initial);
      if (key(field.value) !== baseline) list.push({ pageId, ...field });
    }
  }
  return list;
}

function restoreValues(pageId) {
  const values = {};
  for (const field of Object.values(draft.pages[pageId]?.fields ?? {})) {
    if (field.touched && field.kind !== 'custom') values[field.name] = field.value;
  }
  return values;
}

const commentsFor = (pageId) => draft.comments.filter((comment) => comment.pageId === pageId);
const canSend = () => !!(draft.message.trim() || draft.comments.length || changedAnswers().length);

// ---------- Page frame ----------

function postFrame(message) {
  frame?.contentWindow?.postMessage({ gomin: true, ...message }, '*');
}

function loadFrame() {
  const page = pageById(viewingPageId);
  const stage = $('.stage');
  $('#stage-empty').hidden = !!page;
  $('#stage-empty').textContent = t.emptyThread;
  if (!page) { frame?.remove(); frame = null; frameSrc = ''; return; }
  const src = `/p/${page.id}/${encodeURIComponent(page.name)}?v=${page.rev}`;
  if (src === frameSrc) return;
  frameSrc = src;
  // A fresh iframe per load keeps stale messages and frame history out of the way.
  const next = h('iframe', {
    id: 'page-frame',
    title: page.title,
    sandbox: 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    referrerpolicy: 'no-referrer',
    src,
  });
  if (frame) frame.replaceWith(next);
  else stage.prepend(next);
  frame = next;
}

window.addEventListener('message', (event) => {
  if (!frame || event.source !== frame.contentWindow || event.data?.gomin !== true) return;
  const data = event.data;
  const pageId = viewingPageId;
  if (data.type === 'ready') {
    followPageLanguage(data.lang);
    postFrame({
      type: 'init',
      locale,
      values: restoreValues(pageId),
      comments: commentsFor(pageId),
      commentMode,
      scrollY: scrollPositions[pageId] ?? 0,
    });
  } else if (data.type === 'fields') {
    const entry = (draft.pages[pageId] ??= { fields: {}, sent: {} });
    entry.fields = data.fields ?? {};
    scheduleSave();
    renderComposer();
  } else if (data.type === 'comment') {
    const page = pageById(pageId);
    draft.comments.push({ id: crypto.randomUUID(), pageId, rev: page?.rev ?? null, ...data.comment });
    scheduleSave();
    postFrame({ type: 'comments', comments: commentsFor(pageId) });
    renderComposer();
  } else if (data.type === 'send') {
    if (data.message) $('#message').value = [$('#message').value.trim(), data.message].filter(Boolean).join('\n\n');
    send(data.submitter ?? null);
  } else if (data.type === 'scroll') {
    scrollPositions[pageId] = data.y;
  } else if (data.type === 'mode') {
    setCommentMode(!!data.comment, false);
  }
});

// ---------- Rendering ----------

function view(pageId) {
  viewingPageId = pageId;
  render();
}

function setCommentMode(on, notifyFrame = true) {
  commentMode = on;
  $('#comment-mode').setAttribute('aria-pressed', String(on));
  if (notifyFrame) postFrame({ type: 'mode', comment: on });
  if (on) toast(t.commentModeOn);
}

function renderTopbar() {
  const page = pageById(viewingPageId);
  $('#page-title').textContent = page?.title ?? thread?.title ?? '';
  $('#page-rev').hidden = !page;
  $('#page-rev').textContent = page ? `v${page.rev}` : '';
  $('#back-to-latest').hidden = !thread || viewingPageId === thread.currentPageId || !thread.currentPageId;
  $('#back-to-latest').textContent = t.latest;
  $('#comment-mode').hidden = !page;
  $('#comment-mode-label').textContent = t.commentMode;
  $('#locale').textContent = t.other;
  document.title = page ? `${page.title} · ${t.brand}` : t.brand;
  $('.brand-name').textContent = t.brand;
}

function renderPresence() {
  const on = !!thread?.waiting;
  $('#presence').classList.toggle('on', on);
  $('#presence-label').textContent = on ? t.waiting : t.notWaiting;
  $('#composer-hint').textContent = on ? t.enterHint : t.notWaitingHint;
}

function replyDetails(event) {
  const items = [];
  for (const answer of event.answers ?? []) {
    const values = Array.isArray(answer.display) ? answer.display : [answer.display ?? answer.value];
    items.push(h('li', {}, h('span', { class: 'q' }, answer.question || answer.name), answer.cleared ? t.cleared : values.filter((value) => value !== null).join(', ')));
  }
  for (const comment of event.comments ?? []) {
    const anchor = comment.quote ? `“${short(comment.quote, 50)}”` : comment.target || t.general;
    items.push(h('li', {}, h('span', { class: 'q' }, `💬 ${anchor}`), comment.text));
  }
  const tags = [];
  if (event.answers?.length) tags.push(h('span', { class: 'tag' }, t.answers(event.answers.length)));
  if (event.comments?.length) tags.push(h('span', { class: 'tag' }, t.comments(event.comments.length)));
  if (event.submitter) tags.push(h('span', { class: 'tag' }, t.clicked(short(event.submitter.label || event.submitter.value || event.submitter.name, 24))));
  if (!tags.length) return null;
  return items.length ? h('details', { class: 'reply-details' }, h('summary', {}, tags), h('ul', {}, items)) : h('div', { class: 'reply-details' }, h('summary', {}, tags));
}

function renderTimeline() {
  const list = $('#timeline');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const openDetails = new Set([...list.querySelectorAll('details[open]')].map((element) => element.dataset.seq));
  const items = [];
  for (const event of thread.events) {
    if (event.type === 'page') {
      const page = pageById(event.pageId);
      items.push(h('li', {}, h('button', {
        type: 'button',
        class: `event-page${viewingPageId === event.pageId ? ' viewing' : ''}`,
        onclick: () => view(event.pageId),
      },
      h('span', { class: 'icon' }, icon(ICONS.page)),
      h('span', { class: 'body' },
        h('span', { class: 'title' }, page?.title ?? event.title),
        h('span', { class: 'meta' }, `${viewingPageId === event.pageId ? t.viewing : t.newPage} · ${time(event.at)}`)))));
    } else if (event.type === 'revise') {
      items.push(h('li', { class: 'event-revise' }, `✏️ ${short(pageById(event.pageId)?.title ?? event.title, 28)} · ${t.revised(event.rev)} · ${time(event.at)}`));
    } else if (event.type === 'user') {
      const details = replyDetails(event);
      if (details?.tagName === 'DETAILS') {
        details.dataset.seq = String(event.seq);
        if (openDetails.has(String(event.seq))) details.open = true;
      }
      items.push(h('li', { class: 'from-user' },
        h('span', { class: 'who' }, `${t.you} · ${time(event.at)}`),
        event.message ? h('div', { class: 'bubble' }, event.message) : null,
        details,
        h('span', { class: `receipt${event.deliveredAt ? ' read' : ''}` }, event.deliveredAt ? `✓ ${t.read(time(event.deliveredAt))}` : t.unread)));
    } else if (event.type === 'agent') {
      items.push(h('li', { class: 'from-agent' },
        h('span', { class: 'who' }, `${t.agent} · ${time(event.at)}`),
        h('div', { class: 'bubble' }, event.text)));
    }
  }
  if (!items.length) items.push(h('li', { class: 'empty' }, t.emptyTimeline));
  list.replaceChildren(...items);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderComposer() {
  const chips = [];
  const answers = changedAnswers();
  if (answers.length) {
    chips.push(h('span', { class: 'chip answers', title: answers.map((answer) => `${answer.question || answer.name}: ${[].concat(answer.display ?? answer.value).join(', ')}`).join('\n') },
      h('span', { class: 'text' }, `✎ ${t.changedAnswers(answers.length)}`)));
  }
  for (const comment of draft.comments) {
    const anchor = comment.quote ? `“${short(comment.quote, 24)}”` : comment.target ? short(comment.target, 24) : t.general;
    chips.push(h('span', { class: 'chip comment' },
      h('button', {
        type: 'button',
        class: 'text',
        title: comment.text,
        onclick: () => {
          if (comment.pageId !== viewingPageId) view(comment.pageId);
          else postFrame({ type: 'focus', id: comment.id });
        },
      }, `💬 ${anchor} — ${short(comment.text, 40)}`),
      h('button', {
        type: 'button',
        'aria-label': t.remove,
        title: t.remove,
        onclick: () => {
          draft.comments = draft.comments.filter((entry) => entry.id !== comment.id);
          scheduleSave();
          postFrame({ type: 'comments', comments: commentsFor(viewingPageId) });
          renderComposer();
        },
      }, icon(ICONS.close))));
  }
  $('#pending').replaceChildren(...chips);
  $('#message').placeholder = t.placeholder;
  $('#message-label').textContent = t.placeholder;
  $('#send').disabled = sending || !canSend();
  $('#send-label').textContent = sending ? t.sending : t.send;
  const summary = [t.conversation];
  if (draft.comments.length) summary.push(t.comments(draft.comments.length));
  if (answers.length) summary.push(t.answers(answers.length));
  $('#handle-summary').textContent = summary.join(' · ');
  $('#panel-title').textContent = t.conversation;
}

function render() {
  if (!thread) return;
  if (!pageById(viewingPageId)) viewingPageId = thread.currentPageId;
  renderTopbar();
  renderPresence();
  renderTimeline();
  renderComposer();
  loadFrame();
}

// ---------- Sending ----------

async function send(submitter = null) {
  if (sending) return;
  draft.message = $('#message').value;
  if (!submitter && !canSend()) return;
  sending = true;
  renderComposer();
  clearTimeout(saveTimer);
  try {
    const result = await enqueue(() => api(`${threadPath}/messages`, { method: 'POST', body: { draft, pageId: viewingPageId, submitter } }));
    draft = result.state.draft ?? { message: '', comments: [], pages: draft.pages };
    $('#message').value = '';
    autosize();
    thread = result.state;
    postFrame({ type: 'comments', comments: [] });
    toast(t.sent);
  } catch (error) {
    toast(`${t.sendFailed}: ${error.message}`, { error: true });
  } finally {
    sending = false;
    render();
  }
}

function autosize() {
  const area = $('#message');
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight + 2, innerHeight * 0.4)}px`;
}

// ---------- Live updates ----------

function onState(next) {
  const previousCurrent = thread?.currentPageId;
  const followed = !thread || viewingPageId === previousCurrent;
  thread = next;
  if (next.currentPageId !== previousCurrent && next.currentPageId) {
    if (followed) viewingPageId = next.currentPageId;
    else toast(t.newPageArrived, { action: { label: t.view, run: () => view(next.currentPageId) } });
  }
  render();
}

function connect() {
  const source = new EventSource(`${threadPath}/events`);
  let failures = 0;
  source.addEventListener('state', (event) => {
    failures = 0;
    banner(null);
    onState(JSON.parse(event.data));
  });
  source.addEventListener('error', () => {
    failures += 1;
    if (failures > 1) banner(t.disconnected);
  });
}

// ---------- Index ----------

async function showIndex() {
  $('#index-view').hidden = false;
  $('#index-title').textContent = t.threads;
  $('#index-subtitle').textContent = t.threadsSubtitle;
  $('#comment-mode').hidden = true;
  $('#locale').textContent = t.other;
  const threads = await api('/api/threads').catch(() => []);
  const list = $('#thread-list');
  if (!threads.length) return list.replaceChildren(h('li', { class: 'muted' }, t.noThreads));
  list.replaceChildren(...threads.map((entry) => h('li', {}, h('a', { href: `/t/${encodeURIComponent(entry.id)}` },
    h('strong', {}, entry.current ?? entry.title, entry.unread ? h('span', { class: 'badge' }, t.unreadBadge(entry.unread)) : null),
    h('span', {}, `${entry.title} · ${t.pages(entry.pages)} · ${new Date(entry.updatedAt).toLocaleString(locale)}`),
    entry.cwd ? h('span', {}, entry.cwd) : null))));
}

// ---------- Boot ----------

function applyLocale() {
  document.documentElement.lang = locale;
  t = I18N[locale] ?? I18N.en;
}

$('#locale').addEventListener('click', () => {
  locale = locale === 'ko' ? 'en' : 'ko';
  storage.set('gomin.locale', locale);
  applyLocale();
  if (thread) { render(); postFrame({ type: 'locale', locale }); } else showIndex();
});
$('#comment-mode').addEventListener('click', () => setCommentMode(!commentMode));
$('#back-to-latest').addEventListener('click', () => view(thread.currentPageId));
$('#panel-handle').addEventListener('click', () => {
  panelOpen = !panelOpen;
  $('#panel').classList.toggle('open', panelOpen);
  $('#panel-handle').setAttribute('aria-expanded', String(panelOpen));
});
$('#composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
$('#message').addEventListener('input', () => {
  draft.message = $('#message').value;
  autosize();
  scheduleSave();
  renderComposer();
});
$('#message').addEventListener('keydown', (event) => {
  // Never send in the middle of Korean (or any IME) composition.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
});
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && commentMode) setCommentMode(false);
});
addEventListener('pagehide', () => {
  if (!threadId) return;
  clearTimeout(saveTimer);
  fetch(`${threadPath}/draft`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }).catch(() => {});
});

async function boot() {
  applyLocale();
  if (!threadId) return showIndex();
  $('#thread-view').hidden = false;
  try {
    const state = await api(threadPath);
    draft = state.draft ?? draft;
    $('#message').value = draft.message ?? '';
    autosize();
    viewingPageId = state.currentPageId;
    onState(state);
    connect();
  } catch (error) {
    $('#thread-view').hidden = true;
    $('#index-view').hidden = false;
    $('#index-title').textContent = error.status === 404 ? t.notFound : error.message;
    $('#index-subtitle').innerHTML = '';
    $('#index-subtitle').append(h('a', { href: '/' }, t.threads));
  }
}

boot();
