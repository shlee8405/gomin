# Designing a gomin page

gomin injects a style kit into every page it opens. Plain semantic HTML already looks finished: centered 780px column, Pretendard/system fonts, Korean-friendly line breaking (`keep-all`), light and dark mode. Add the classes below for structure. Your own CSS always wins over the kit, because the kit sits in the lowest cascade layer.

## Page skeleton

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>결제 구조 정리</title>          <!-- becomes the page title in gomin -->
</head>
<body>
  <span class="eyebrow">설명 · 결제</span>
  <h1>결제는 세 단계로 흘러가요</h1>
  <p class="lede">한 문장으로 된 결론. 사용자가 이것만 읽어도 핵심을 알 수 있게.</p>
  <div class="meta"><span>2026-10-13</span><span>코드 기준: main@4f2a1c</span></div>

  <div class="tldr">
    <span class="title">핵심 요약</span>
    <ul><li>…</li><li>…</li></ul>
  </div>

  <h2>…</h2>
  …
</body>
</html>
```

`<body class="wide">` widens the column to 1100px for tables and dashboards; `<body class="full">` removes the limit.

## Components

| Need | Markup |
| --- | --- |
| Lead summary | `<div class="tldr"><span class="title">핵심 요약</span><ul>…</ul></div>` |
| Note / warning | `<div class="callout info|ok|warn|danger"><span class="title">주의</span><p>…</p></div>` |
| Cards in a grid | `<div class="grid"><div class="card"><h3>…</h3><p>…</p></div>…</div>` (`.card.accent` highlights one) |
| Fixed columns | `<div class="cols-2">…</div>`, `<div class="cols-3">…</div>` (stack on phones) |
| Key numbers | `<div class="stats"><div class="stat"><b>3.2s</b><span>p95 응답</span></div>…</div>` |
| Steps / timeline | `<ol class="steps"><li><strong>설계</strong>설명…</li>…</ol>` |
| Pros / cons | `<ul class="pros"><li>…</li></ul>` `<ul class="cons"><li>…</li></ul>` (`.check` for checklists) |
| Labels | `<span class="badge">추천</span>`, `<span class="tag">v2</span>`, modifiers `.ok .warn .danger` |
| Expandable detail | `<details><summary>자세히</summary><p>…</p></details>` |
| Table | plain `<table>` with `<thead>`; `td.num` right-aligns numbers; `tr.highlight`; `.yes` / `.no` for ✓/✗ cells |
| Code | `<pre><code>…</code></pre>`; `<ins>` / `<del>` for added and removed lines |
| Figure | `<figure class="diagram">…svg…<figcaption>…</figcaption></figure>` |
| Footnotes / sources | `<ol class="sources"><li><a href="…">…</a></li></ol>`, `<footer>` |
| Utilities | `.muted`, `.small`, `.center` |

Tokens you can reuse or override in `:root`: `--bg --fg --fg-2 --muted --line --soft --card --accent --accent-soft --ok --warn --danger` (each with a `-soft` variant), `--radius`, `--font`, `--mono`, `--width`. Example: `:root { --accent: #0f9d58; }` re-themes every component.

## Questions and answers

Anything with a `name` is collected when the user sends: `input` (text, number, date, range, color…), `select`, `textarea`, radios, and checkboxes. The question text comes from, in order: `data-question="…"` on the control or a wrapper, the `<fieldset>`'s `<legend>` (for radio/checkbox groups), the control's `<label>`, `aria-label`, `placeholder`, the nearest heading above it, and finally the `name`. Option labels come from `data-label`, else the `<strong>` in the option's label, else the label text.

```html
<form>
  <fieldset>
    <legend>첫 버전은 어디까지 만들까요?</legend>
    <div class="choices">
      <label class="choice">
        <input type="radio" name="scope" value="mvp">
        <span><strong>핵심 기능만 <span class="badge">추천</span></strong>
          <small>2주 안에 출시하고 반응을 봐요.</small></span>
      </label>
      <label class="choice">
        <input type="radio" name="scope" value="full">
        <span><strong>전체 기능</strong><small>6주, 결제와 알림까지 포함.</small></span>
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>꼭 들어가야 하는 기능</legend>
    <div class="choices stack">
      <label class="choice"><input type="checkbox" name="features" value="sso"><span><strong>SSO 로그인</strong></span></label>
      <label class="choice"><input type="checkbox" name="features" value="export"><span><strong>CSV 내보내기</strong></span></label>
    </div>
  </fieldset>

  <label class="field">그 밖에 알아야 할 것
    <textarea name="notes" placeholder="자유롭게 적어주세요"></textarea></label>

  <div class="actions">
    <button class="primary" name="decision" value="approve">이대로 진행</button>
    <button name="decision" value="revise">수정해서 다시 보여줘</button>
  </div>
</form>
```

- Submitting a form (any submit button) sends the reply immediately, including the clicked button's `name=value` and label. Use `type="button"` for buttons that should only do something in the page.
- Without a submit button the user sends from the conversation panel; answers are included either way.
- Only answers that changed since the user's last reply are sent. Defaults you authored count as "not changed", so do not pre-check options the user has not chosen.
- Answers survive reloads and revisions as long as you keep the same `name` and `value`s.
- `<button type="button" data-gomin-send>Label</button>` anywhere (no form needed) sends on click.
- Custom widgets (sliders you drew, drag-to-rank lists) can report values from your own script: `gomin.answer('priority', ['a', 'c', 'b'], { question: '우선순위', display: ['A', 'C', 'B'] })`. `gomin.send('optional message')` sends immediately.
- `data-gomin-ignore` on a control or container, or `<form data-gomin-local>`, keeps purely local controls (filters, calculators) out of the reply.

## Diagrams

- **Inline SVG** is the default for illustrations: exact, offline, and it inherits `currentColor` and the kit tokens (`fill="var(--accent-soft)" stroke="var(--accent)"`). Give every SVG a `viewBox` and no fixed width so it scales.
- **Mermaid** for flowcharts, sequences, state machines, and ER diagrams: write `<pre class="mermaid">flowchart LR\n  A --> B</pre>` and gomin loads Mermaid automatically (light/dark aware). Keep labels short; quote labels with special characters: `A["결제 (PG)"]`.
- **Charts:** inline SVG bars for a handful of values; for more, load a library from an HTTPS CDN such as `https://cdn.jsdelivr.net/npm/chart.js`.

## Korean typography (한국어 페이지)

- `<html lang="ko">`. The kit already applies `word-break: keep-all`, so 어절 are not split mid-word; avoid manual `<br>` for wrapping.
- Keep sentences short; prefer 해요체 or 합니다체 consistently with the conversation.
- Numbers and units: `3초`, `1,200원`, `p95 320ms`. Use `.num` cells and `tabular-nums` for aligned figures.
- Mixed Korean and English is fine; keep code identifiers in `<code>`.

## Custom design

When a page needs its own visual identity (a slide-like report, a mock UI, a playful explainer), write full CSS. Your rules override the kit automatically. To start from a blank slate, opt out entirely with `<html data-gomin-kit="off">`. Then also set a page background, text color, and fonts yourself, and test light and dark (`prefers-color-scheme`). Force a scheme with `<html data-theme="light">` or `"dark"`.

## Sandbox limits

The page runs in a sandboxed iframe with an opaque origin:

- `localStorage`, `sessionStorage`, IndexedDB, and cookies are unavailable; keep state in variables.
- `fetch` works only to HTTPS URLs, never to localhost.
- Links to `http(s)` open in a new tab; in-page `#anchors` work.
- Local assets must sit next to (or below) the HTML file and be referenced with relative paths (`img/arch.png`, not `/img/arch.png`). Dotfiles are never served.
- Maximum page size is 10 MB; keep pages much smaller. Embedded base64 images count toward it.
