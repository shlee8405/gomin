// Thread state: the pages an agent opened, the user's replies, and unsent drafts.
// The server is the only writer; each thread is one JSON file written atomically.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { now, randomId, readJson, writeJsonAtomic } from './common.mjs';

const MAX_EVENTS = 1000;
const MAX_TEXT = 20000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

const text = (value, name, max = MAX_TEXT) => {
  if (value === undefined || value === null) return '';
  check(typeof value === 'string' && value.length <= max, `${name} must be a string of at most ${max} characters.`);
  return value;
};
const key = (value) => JSON.stringify(value ?? null);
const isEmpty = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

function emptyThread(id, cwd) {
  return {
    schema: 1,
    id,
    title: path.basename(cwd || '') || id,
    cwd: cwd || null,
    createdAt: now(),
    updatedAt: now(),
    seq: 0,
    currentPageId: null,
    pages: {},
    events: [],
    draft: { message: '', comments: [], pages: {} },
  };
}

export class Store {
  constructor(root) {
    this.root = path.join(root, 'threads');
    this.threads = new Map();
    this.queues = new Map();
  }

  file(id) { return path.join(this.root, id, 'thread.json'); }

  async load(id) {
    if (this.threads.has(id)) return this.threads.get(id);
    const thread = await readJson(this.file(id));
    if (thread) this.threads.set(id, thread);
    return thread;
  }

  async list() {
    const names = await fs.readdir(this.root).catch(() => []);
    const threads = [];
    for (const name of names) {
      const thread = await this.load(name).catch(() => null);
      if (thread) threads.push(thread);
    }
    return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Serializes writes per thread so concurrent requests never interleave.
  async mutate(id, operation, { create } = {}) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      let thread = await this.load(id);
      if (!thread) {
        check(create, 'Thread not found.', 404);
        thread = emptyThread(id, create.cwd);
      }
      const result = await operation(thread);
      thread.updatedAt = now();
      if (thread.events.length > MAX_EVENTS) thread.events.splice(0, thread.events.length - MAX_EVENTS);
      await fs.mkdir(path.dirname(this.file(id)), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.file(id), thread);
      this.threads.set(id, thread);
      return result;
    });
    this.queues.set(id, run.catch(() => {}));
    return run;
  }
}

export function pageByPath(thread, file) {
  return Object.values(thread.pages).find((page) => page.path === file) ?? null;
}

export function pushEvent(thread, event) {
  thread.seq += 1;
  const entry = { seq: thread.seq, at: now(), ...event };
  thread.events.push(entry);
  return entry;
}

// Registers or refreshes a page. Returns what changed so callers can announce it.
export function openPage(thread, { file, title, mtimeMs, cwd }) {
  if (cwd && !thread.cwd) thread.cwd = cwd;
  let page = pageByPath(thread, file);
  let kind = 'focus';
  if (!page) {
    page = { id: randomId(), path: file, title, rev: 1, announcedRev: 1, mtimeMs, openedAt: now(), updatedAt: now() };
    thread.pages[page.id] = page;
    pushEvent(thread, { type: 'page', pageId: page.id, rev: 1, title });
    kind = 'new';
  } else {
    page.title = title;
    if (page.mtimeMs !== mtimeMs) { page.rev += 1; page.mtimeMs = mtimeMs; page.updatedAt = now(); }
    if (page.rev > page.announcedRev) {
      page.announcedRev = page.rev;
      pushEvent(thread, { type: 'revise', pageId: page.id, rev: page.rev, title });
      kind = 'revised';
    }
  }
  thread.currentPageId = page.id;
  return { page, kind };
}

// The browser keeps its draft on the server so it survives reloads, restarts and new revisions.
export function cleanDraft(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'draft must be an object.');
  const pages = {};
  for (const [pageId, entry] of Object.entries(input.pages ?? {}).slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue;
    const fields = {};
    for (const [name, field] of Object.entries(entry.fields ?? {}).slice(0, 500)) {
      if (!field || typeof field !== 'object') continue;
      fields[name] = {
        name,
        question: text(field.question, 'question', 500),
        kind: text(field.kind, 'kind', 40),
        value: field.value ?? null,
        display: field.display ?? null,
        initial: field.initial ?? null,
        touched: field.touched === true,
      };
    }
    pages[pageId] = { fields, sent: entry.sent && typeof entry.sent === 'object' ? entry.sent : {} };
  }
  const comments = (Array.isArray(input.comments) ? input.comments : []).slice(0, 500).map((comment) => ({
    id: text(comment.id, 'comment.id', 64) || randomId(6),
    pageId: text(comment.pageId, 'comment.pageId', 64),
    rev: Number.isSafeInteger(comment.rev) ? comment.rev : null,
    quote: text(comment.quote, 'comment.quote', 4000),
    target: text(comment.target, 'comment.target', 500),
    selector: text(comment.selector, 'comment.selector', 1000),
    context: text(comment.context, 'comment.context', 500),
    text: text(comment.text, 'comment.text'),
  }));
  return { message: text(input.message, 'message'), comments, pages };
}

// Builds a user reply from the draft: the message, comments, and every answer
// that changed since the last reply (or since the page's authored default).
export function sendReply(thread, input) {
  const draft = cleanDraft(input.draft ?? thread.draft);
  const viewingPageId = typeof input.pageId === 'string' && thread.pages[input.pageId] ? input.pageId : thread.currentPageId;
  const submitter = input.submitter && typeof input.submitter === 'object' ? {
    name: text(input.submitter.name, 'submitter.name', 200),
    value: text(input.submitter.value, 'submitter.value', 2000),
    label: text(input.submitter.label, 'submitter.label', 500),
  } : null;

  const answers = [];
  const unanswered = [];
  for (const [pageId, entry] of Object.entries(draft.pages)) {
    if (!thread.pages[pageId]) continue;
    for (const field of Object.values(entry.fields)) {
      const baseline = entry.sent[field.name] ?? key(field.initial);
      if (key(field.value) !== baseline) {
        const { initial, touched, ...answer } = field;
        answers.push({ pageId, ...answer, cleared: isEmpty(field.value) });
      }
      else if (pageId === viewingPageId && isEmpty(field.value)) unanswered.push(field.question || field.name);
      entry.sent[field.name] = key(field.value);
    }
  }
  const comments = draft.comments.filter((comment) => comment.text.trim() && (!comment.pageId || thread.pages[comment.pageId]));
  const message = draft.message.trim();
  const ended = input.end === true;
  check(message || comments.length || answers.length || submitter || ended, 'Nothing to send yet. Write a message, answer a question, or add a comment.');

  const page = thread.pages[viewingPageId];
  const event = pushEvent(thread, {
    type: 'user',
    id: randomId(8),
    pageId: viewingPageId,
    rev: page?.rev ?? null,
    message,
    answers,
    comments,
    unanswered: answers.length || submitter ? unanswered : [],
    submitter,
    ended,
    deliveredAt: null,
  });
  thread.draft = { message: '', comments: [], pages: draft.pages };
  return event;
}

export const pendingReplies = (thread) => thread.events.filter((event) => event.type === 'user' && !event.deliveredAt);
