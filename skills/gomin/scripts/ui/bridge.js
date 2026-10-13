// gomin bridge: injected into the agent's page, which runs in an opaque-origin sandbox.
// It reports named form fields, lets the user comment on text or elements,
// and talks to the surrounding gomin window only through postMessage.
(() => {
  if (window.gomin?.bridge) return;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
  const TEXT_KINDS = new Set(['text', 'textarea', 'email', 'url', 'tel', 'search']);
  const strings = {
    ko: { comment: '코멘트', placeholder: '이 부분에 대한 생각을 남겨주세요…', add: '추가', cancel: '취소', hint: '⌘/Ctrl+Enter로 추가' },
    en: { comment: 'Comment', placeholder: 'What do you think about this?', add: 'Add', cancel: 'Cancel', hint: '⌘/Ctrl+Enter to add' },
  };

  let t = strings.en;
  let commentMode = false;
  let comments = [];
  const touched = new Set();
  const initial = new Map();
  const custom = new Map();

  const post = (type, data = {}) => parent.postMessage({ gomin: true, type, ...data }, '*');
  const clean = (value, max = 160) => {
    const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const key = (value) => JSON.stringify(value ?? null);

  // ---------- Fields ----------

  function controls() {
    return [...document.querySelectorAll('input[name], select[name], textarea[name]')].filter((el) =>
      !SKIP_TYPES.has(el.type) && !el.disabled && !el.closest('[data-gomin-ignore], form[data-gomin-local]'));
  }

  function groups() {
    const map = new Map();
    for (const el of controls()) {
      if (!map.has(el.name)) map.set(el.name, []);
      map.get(el.name).push(el);
    }
    return map;
  }

  function kindOf(els) {
    const el = els[0];
    if (el.type === 'radio') return 'radio';
    if (el.type === 'checkbox') return els.length > 1 || (el.getAttribute('value') ?? 'on') !== 'on' ? 'checkbox' : 'toggle';
    if (el.tagName === 'SELECT') return el.multiple ? 'multiselect' : 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    return el.type || 'text';
  }

  function textWithoutControls(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, script, style, [aria-hidden="true"], .badge, .tag').forEach((child) => child.remove());
    return clean(copy.textContent);
  }

  function nearestHeading(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return '';
    let found = null;
    for (const heading of document.querySelectorAll('h1, h2, h3, h4')) {
      if (heading === element || heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) found = heading;
      else break;
    }
    return found ? clean(found.textContent, 120) : '';
  }

  function labelledBy(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    return clean(ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  }

  function questionOf(els, kind) {
    const el = els[0];
    const explicit = el.getAttribute('data-question') || el.closest('[data-question]')?.getAttribute('data-question');
    if (explicit) return clean(explicit, 300);
    const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    const legend = group?.querySelector(':scope > legend');
    const groupLabel = legend ? textWithoutControls(legend) : group ? group.getAttribute('aria-label') || labelledBy(group) : '';
    if (kind === 'radio' || kind === 'checkbox') return clean(groupLabel || nearestHeading(el) || el.name, 300);
    const own = el.getAttribute('aria-label') || labelledBy(el) || (el.labels?.[0] ? textWithoutControls(el.labels[0]) : '');
    return clean(own || el.placeholder || groupLabel || nearestHeading(el) || el.name, 300);
  }

  function optionLabel(el) {
    if (el.dataset.label) return clean(el.dataset.label, 120);
    const label = el.labels?.[0];
    if (!label) return el.value;
    const title = label.querySelector('[data-label], strong, b, .title');
    return clean(textWithoutControls(title ?? label), 120) || el.value;
  }

  function valueOf(els, kind) {
    const el = els[0];
    if (kind === 'radio') {
      const checked = els.find((item) => item.checked);
      return checked ? { value: checked.value, display: optionLabel(checked) } : { value: null, display: null };
    }
    if (kind === 'checkbox') {
      const checked = els.filter((item) => item.checked);
      return { value: checked.map((item) => item.value), display: checked.map(optionLabel) };
    }
    if (kind === 'toggle') return { value: el.checked ? 'yes' : 'no', display: el.checked ? 'yes' : 'no' };
    if (kind === 'select') {
      const option = el.selectedOptions[0];
      return option && option.value !== '' ? { value: option.value, display: clean(option.textContent, 120) } : { value: null, display: null };
    }
    if (kind === 'multiselect') {
      const options = [...el.selectedOptions];
      return { value: options.map((option) => option.value), display: options.map((option) => clean(option.textContent, 120)) };
    }
    return { value: el.value, display: el.value };
  }

  function setValue(els, kind, value) {
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
    if (kind === 'radio' || kind === 'checkbox') els.forEach((el) => { el.checked = values.includes(el.value); });
    else if (kind === 'toggle') els[0].checked = value === 'yes';
    else if (kind === 'select' || kind === 'multiselect') [...els[0].options].forEach((option) => { option.selected = values.includes(option.value); });
    else els[0].value = values[0];
    els.forEach((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function fields() {
    const result = {};
    for (const [name, els] of groups()) {
      const kind = kindOf(els);
      const current = valueOf(els, kind);
      if (!initial.has(name)) initial.set(name, current.value);
      result[name] = {
        name,
        kind: TEXT_KINDS.has(kind) ? (kind === 'textarea' ? 'textarea' : 'text') : kind,
        question: questionOf(els, kind),
        value: current.value,
        display: current.display,
        initial: initial.get(name),
        touched: touched.has(name),
      };
    }
    for (const [name, entry] of custom) result[name] = { ...entry, initial: null, touched: true };
    return result;
  }

  let reportTimer = null;
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => post('fields', { fields: fields() }), 150);
  }

  function restore(values = {}) {
    const map = groups();
    for (const [name, value] of Object.entries(values)) {
      const els = map.get(name);
      if (!els) continue;
      const kind = kindOf(els);
      // Capture the authored default before overwriting it with the user's earlier answer.
      if (!initial.has(name)) initial.set(name, valueOf(els, kind).value);
      if (key(valueOf(els, kind).value) !== key(value)) setValue(els, kind, value);
      touched.add(name);
    }
  }

  const isField = (el) => el instanceof Element && el.matches('input[name], select[name], textarea[name]') && !el.closest('[data-gomin-ignore], form[data-gomin-local]');
  const onFieldEvent = (event) => {
    if (!isField(event.target)) return;
    // Page scripts may change values too; only real user input marks a field as answered.
    if (event.isTrusted) touched.add(event.target.name);
    report();
  };
  document.addEventListener('input', onFieldEvent, true);
  document.addEventListener('change', onFieldEvent, true);

  // ---------- Sending ----------

  function submitterOf(el) {
    if (!el) return null;
    const label = clean(el.dataset.label || el.textContent || el.value || el.getAttribute('aria-label'), 200);
    return { name: el.getAttribute('name') || '', value: el.getAttribute('value') ?? el.dataset.gominSend ?? '', label };
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.closest('form[data-gomin-local]')) return;
    event.preventDefault();
    post('fields', { fields: fields() });
    post('send', { submitter: submitterOf(event.submitter) });
  }, true);

  // ---------- Comments UI (isolated in a shadow root) ----------

  const host = document.createElement('gomin-ui');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    .box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #4f6bed; border-radius: 6px; background: rgb(79 107 237 / .06); transition: all .06s ease-out; }
    .chip { position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 6px; padding: 6px 11px; border: 0; border-radius: 999px; background: #1f2433; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 6px 20px rgb(0 0 0 / .18); }
    .chip:hover { background: #4f6bed; }
    .card { position: fixed; z-index: 2147483647; width: min(340px, calc(100vw - 24px)); padding: 12px; border-radius: 12px; background: #fff; color: #1f2433; border: 1px solid #e3e6ee; box-shadow: 0 12px 40px rgb(15 20 35 / .2); }
    .quote { margin: 0 0 8px; padding: 2px 0 2px 9px; border-left: 3px solid #f2c94c; color: #5b6275; font-size: 12.5px; line-height: 1.5; max-height: 4.5em; overflow: hidden; word-break: keep-all; overflow-wrap: anywhere; }
    textarea { width: 100%; min-height: 76px; resize: vertical; padding: 9px 10px; border: 1px solid #d5d9e4; border-radius: 8px; font-size: 14px; line-height: 1.55; color: inherit; background: transparent; outline: none; }
    textarea:focus { border-color: #4f6bed; box-shadow: 0 0 0 3px rgb(79 107 237 / .18); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .hint { font-size: 11.5px; color: #8a90a2; }
    .actions { display: flex; gap: 6px; }
    button.b { padding: 6px 12px; border-radius: 8px; border: 1px solid #d5d9e4; background: transparent; color: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.primary { background: #4f6bed; border-color: #4f6bed; color: #fff; }
    button.primary:disabled { opacity: .45; cursor: default; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1d2130; color: #e8eaf2; border-color: #333a50; }
      textarea, button.b { border-color: #3a4159; }
      .quote { color: #a9afc2; }
      .chip { background: #e8eaf2; color: #151924; }
    }
  </style>
  <div class="box" hidden></div>
  <button class="chip" type="button" hidden></button>
  <div class="card" hidden role="dialog" aria-label="Comment">
    <p class="quote" hidden></p>
    <textarea></textarea>
    <div class="row"><span class="hint"></span><span class="actions"><button class="b cancel" type="button"></button><button class="b primary add" type="button"></button></span></div>
  </div>`;
  const box = shadow.querySelector('.box');
  const chip = shadow.querySelector('.chip');
  const card = shadow.querySelector('.card');
  const cardQuote = shadow.querySelector('.quote');
  const textarea = shadow.querySelector('textarea');
  const addButton = shadow.querySelector('.add');
  let pending = null; // { quote, context, target, selector }

  function applyStrings() {
    chip.textContent = `💬 ${t.comment}`;
    textarea.placeholder = t.placeholder;
    addButton.textContent = t.add;
    shadow.querySelector('.cancel').textContent = t.cancel;
    shadow.querySelector('.hint').textContent = t.hint;
  }
  applyStrings();

  const insideUi = (event) => event.composedPath().includes(host);

  function place(element, rect, { below = true } = {}) {
    const width = element.offsetWidth || 340;
    const height = element.offsetHeight || 160;
    const left = Math.min(Math.max(8, rect.left), innerWidth - width - 8);
    let top = below ? rect.bottom + 8 : rect.top - height - 8;
    if (top + height > innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    if (top < 8) top = Math.min(innerHeight - height - 8, rect.bottom + 8);
    element.style.left = `${left}px`;
    element.style.top = `${Math.max(8, top)}px`;
  }

  function openCard(target, rect) {
    pending = target;
    chip.hidden = true;
    box.hidden = true;
    cardQuote.hidden = !target.quote && !target.target;
    cardQuote.textContent = target.quote ? clean(target.quote, 240) : target.target;
    textarea.value = '';
    addButton.disabled = true;
    card.hidden = false;
    place(card, rect);
    textarea.focus();
  }

  function closeCard() {
    card.hidden = true;
    pending = null;
    if (!commentMode) box.hidden = true;
  }

  function saveCard() {
    const text = textarea.value.trim();
    if (!text || !pending) return;
    post('comment', { comment: { ...pending, text } });
    getSelection()?.removeAllRanges();
    closeCard();
  }

  textarea.addEventListener('input', () => { addButton.disabled = !textarea.value.trim(); });
  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveCard(); }
    if (event.key === 'Escape') { event.preventDefault(); closeCard(); }
  });
  addButton.addEventListener('click', saveCard);
  shadow.querySelector('.cancel').addEventListener('click', closeCard);

  // Text selection → floating "Comment" chip.
  let selectionTarget = null;
  function checkSelection() {
    const selection = getSelection();
    const text = selection?.toString().trim();
    const anchor = selection?.anchorNode?.parentElement;
    if (!text || !selection.rangeCount || anchor?.closest('input, textarea, select, [contenteditable="true"]') || !card.hidden) {
      chip.hidden = true;
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    selectionTarget = { quote: text.slice(0, 4000), context: nearestHeading(range.startContainer), target: '', selector: '' };
    chip.hidden = false;
    place(chip, { left: rect.right - 40, right: rect.right, top: rect.top, bottom: rect.bottom });
  }
  document.addEventListener('mouseup', (event) => { if (!insideUi(event)) setTimeout(checkSelection, 0); });
  document.addEventListener('keyup', (event) => { if (event.shiftKey && !insideUi(event)) checkSelection(); });
  document.addEventListener('mousedown', (event) => {
    if (insideUi(event)) return;
    chip.hidden = true;
    if (!card.hidden && !textarea.value.trim()) closeCard();
  });
  chip.addEventListener('mousedown', (event) => event.preventDefault());
  chip.addEventListener('click', () => {
    if (!selectionTarget) return;
    const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
    openCard(selectionTarget, range ? range.getBoundingClientRect() : chip.getBoundingClientRect());
  });

  // Comment mode → click any element.
  function describe(element) {
    const tag = element.tagName.toLowerCase();
    const label = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.textContent;
    return `<${tag}>${label ? ` "${clean(label, 80)}"` : ''}`;
  }
  function selectorOf(element) {
    const parts = [];
    for (let node = element; node && node !== document.body && node.parentElement; node = node.parentElement) {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
    }
    return parts.join(' > ');
  }
  const commentable = (element) => element instanceof Element && element !== document.documentElement && element !== document.body && element !== host;

  document.addEventListener('mousemove', (event) => {
    if (!commentMode || !card.hidden || insideUi(event) || !commentable(event.target)) return;
    const rect = event.target.getBoundingClientRect();
    Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
    box.hidden = false;
  }, true);
  document.addEventListener('click', (event) => {
    if (insideUi(event)) return;
    if (commentMode && commentable(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      const element = event.target;
      openCard({ quote: '', target: describe(element), context: nearestHeading(element), selector: selectorOf(element) }, element.getBoundingClientRect());
      return;
    }
    const sender = event.target.closest?.('[data-gomin-send]');
    if (sender) {
      event.preventDefault();
      post('fields', { fields: fields() });
      post('send', { submitter: submitterOf(sender) });
      return;
    }
    const link = event.target.closest?.('a[href]');
    if (link && !link.getAttribute('href').startsWith('#')) {
      // Never navigate the page frame away; open real links in a new tab.
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(link.href)) window.open(link.href, '_blank', 'noopener');
    }
  }, true);

  function setMode(on, notify) {
    commentMode = on;
    document.documentElement.toggleAttribute('data-gomin-commenting', on);
    if (!on) box.hidden = true;
    if (notify) post('mode', { comment: on });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    if (!card.hidden) closeCard();
    else if (commentMode) setMode(false, true);
    chip.hidden = true;
  });

  // ---------- Highlights for unsent comments ----------

  function textIndex() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest('script, style, noscript, gomin-ui') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let flat = '';
    const map = [];
    let lastSpace = true;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.data.length; i++) {
        const space = /\s/.test(node.data[i]);
        if (space && lastSpace) continue;
        flat += space ? ' ' : node.data[i];
        map.push([node, i]);
        lastSpace = space;
      }
    }
    return { flat, map };
  }

  function findRange(quote, index) {
    const needle = quote.replace(/\s+/g, ' ').trim();
    const at = needle ? index.flat.indexOf(needle) : -1;
    if (at < 0) return null;
    const [startNode, startOffset] = index.map[at];
    const [endNode, endOffset] = index.map[at + needle.length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    return range;
  }

  function locate(comment, index) {
    if (comment.quote) return findRange(comment.quote, index);
    if (comment.selector) {
      try { return document.querySelector(comment.selector); } catch { return null; }
    }
    return null;
  }

  function paintComments() {
    document.querySelectorAll('[data-gomin-commented]').forEach((element) => element.removeAttribute('data-gomin-commented'));
    const index = textIndex();
    const ranges = [];
    for (const comment of comments) {
      const found = locate(comment, index);
      if (found instanceof Range) ranges.push(found);
      else if (found instanceof Element) found.setAttribute('data-gomin-commented', '');
    }
    if (window.CSS?.highlights && window.Highlight) {
      CSS.highlights.set('gomin-comment', new Highlight(...ranges));
    }
  }

  function focusComment(id) {
    const comment = comments.find((entry) => entry.id === id);
    const found = comment && locate(comment, textIndex());
    if (!found) return;
    const element = found instanceof Range ? found.startContainer.parentElement : found;
    element?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    if (found instanceof Range && window.CSS?.highlights) {
      CSS.highlights.set('gomin-flash', new Highlight(found));
      setTimeout(() => CSS.highlights.delete('gomin-flash'), 1400);
    } else if (element) {
      element.setAttribute('data-gomin-flash', '');
      setTimeout(() => element.removeAttribute('data-gomin-flash'), 1400);
    }
  }

  // ---------- Mermaid ----------

  function loadMermaid() {
    if (!document.querySelector('.mermaid') || window.mermaid) return;
    const authored = [...document.scripts].some((script) => !script.hasAttribute('data-gomin') && (/mermaid/i.test(script.src) || /mermaid\.(initialize|run)/.test(script.textContent)));
    if (authored) return;
    const script = document.createElement('script');
    script.type = 'module';
    script.textContent = `import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', fontFamily: getComputedStyle(document.body).fontFamily });
      await mermaid.run({ querySelector: '.mermaid' });
      parent.postMessage({ gomin: true, type: 'rendered' }, '*');`;
    document.head.appendChild(script);
  }

  // ---------- Wiring ----------

  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.gomin !== true) return;
    const data = event.data;
    if (data.type === 'init') {
      t = strings[data.locale] ?? strings.en;
      applyStrings();
      restore(data.values);
      comments = data.comments ?? [];
      paintComments();
      setMode(!!data.commentMode, false);
      if (Number.isFinite(data.scrollY) && data.scrollY > 0) scrollTo({ top: data.scrollY, behavior: 'instant' });
      post('fields', { fields: fields() });
    } else if (data.type === 'comments') {
      comments = data.comments ?? [];
      paintComments();
    } else if (data.type === 'focus') {
      focusComment(data.id);
    } else if (data.type === 'mode') {
      setMode(!!data.comment, false);
    } else if (data.type === 'locale') {
      t = strings[data.locale] ?? strings.en;
      applyStrings();
    }
  });

  let scrollTicking = false;
  addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      chip.hidden = true;
      post('scroll', { y: scrollY });
    });
  }, { passive: true });

  window.gomin = Object.freeze({
    bridge: true,
    // Record an answer from a custom widget that has no native form control.
    answer(name, value, { question = name, display = value } = {}) {
      custom.set(String(name), { name: String(name), kind: 'custom', question: String(question), value, display });
      report();
    },
    // Send the reply now, optionally with a message.
    send(message = '') {
      post('fields', { fields: fields() });
      post('send', { message: String(message) });
    },
  });

  function start() {
    const style = document.createElement('style');
    style.setAttribute('data-gomin', '');
    style.textContent = `::highlight(gomin-comment) { background: rgb(242 201 76 / .45); }
      ::highlight(gomin-flash) { background: rgb(79 107 237 / .35); }
      [data-gomin-commented] { outline: 2px dashed rgb(242 170 40 / .9); outline-offset: 3px; }
      [data-gomin-flash] { outline: 3px solid rgb(79 107 237 / .8) !important; outline-offset: 4px; }
      html[data-gomin-commenting] body, html[data-gomin-commenting] body * { cursor: crosshair !important; }`;
    document.head.appendChild(style);
    document.documentElement.appendChild(host);
    loadMermaid();
    post('ready', { title: document.title, lang: document.documentElement.lang || '' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
