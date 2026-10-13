# Response patterns

Pick the pattern that matches what the user needs to do with your answer, then combine freely: a plan often contains a comparison and a diagram. Every pattern starts with the answer at the top.

## 1. Answer / explanation — 설명형 답변

**When:** the user asked "how does X work", "why did Y happen", "what is Z". The goal is understanding, not a decision.

**Structure:**
1. `h1` phrased as the answer, not the topic: "결제 실패는 웹훅 재시도 때문이에요", not "결제 시스템".
2. `.lede` with the one-sentence answer, then `.tldr` with 2–4 bullets.
3. One section per claim, each short. Put a diagram next to the claim that needs it (Mermaid for flows, SVG for structures).
4. Evidence in place: file paths in `<code>`, links in `.sources`. Label inference as inference.
5. End with "더 볼 만한 것" (what was left out, where to look), not a recap.

Optional: a closing `<textarea name="followup">` such as "더 궁금한 점" if a follow-up is likely.

## 2. Plan for approval — 계획 / 승인

**When:** before implementing anything non-trivial, or when the user asked for a plan.

**Structure:**
1. `.tldr`: what will change, how long it will take, and the main risk.
2. `ol.steps` with concrete steps: files and components touched, what each step delivers.
3. "결정이 필요한 것" — one `fieldset` per open decision, `.choices` cards, recommendation marked with a `badge`.
4. Scope: `cols-2` with `ul.check` (포함) and `ul.cons` (제외/나중에).
5. Risks and how you will verify (`.callout warn`, tests to run).
6. Actions: `<button class="primary" name="decision" value="approve">이대로 진행</button>` and `<button name="decision" value="revise">수정 필요</button>`.

After `decision=approve`, carry out exactly that plan with the chosen options. After `revise`, apply the comments, revise the same file, and `open` it again. gomin shows the new version in place, and the user's answers carry over.

## 3. Options and tradeoffs — 비교 / 선택

**When:** two to four realistic alternatives (libraries, architectures, designs, vendors).

**Structure:**
1. `.tldr` with your recommendation and the deciding factor ("팀 규모가 작아서 B").
2. A comparison `<table>`: one row per criterion that actually differs; `.yes`/`.no` or short phrases; `tr.highlight` on the deciding row.
3. One `.card` per option with `ul.pros` / `ul.cons` and "이럴 때 좋아요".
4. A `fieldset` with `.choices` to pick one (recommended option badged, not pre-checked), plus a `textarea` for constraints you might have missed.

## 4. Clarifying questions — 질문지

**When:** the request is ambiguous and several answers would change the work. Prefer this over a chat message with five questions.

**Structure:**
1. One line on why you are asking and what you will do with the answers.
2. Up to ~6 questions, most important first. Each is a `fieldset` with a `legend`. Use radios for one choice, checkboxes for several, `select` for long lists, `textarea` for open input. Include a "잘 모르겠어요 / 알아서" option where a default is acceptable, and say what that default would be.
3. A primary submit button: `<button class="primary" name="decision" value="answered">답변 보내기</button>`.

## 5. Report / research — 리포트 / 조사

**When:** summarizing findings, status, an audit, a postmortem, or research.

**Structure:**
1. `.stats` with the 3–4 key numbers, then `.tldr` with the conclusions.
2. Findings as sections or a table, sorted by importance. Mark severity with `.badge.danger/.warn/.ok`.
3. Charts as inline SVG (small data) or Chart.js (larger).
4. Sources: numbered `.sources` list with real links; cite inline with `<sup>[1]</sup>`.
5. "다음 단계" with checkboxes the user can tick (`name="next"`), so the reply tells you what to do next.

## 6. Code walkthrough / review — 코드 설명 / 리뷰

**When:** explaining a change, reviewing a diff, or proposing code.

**Structure:**
1. `.tldr`: what the change does and whether it is safe.
2. File-by-file sections with `<pre><code>` excerpts (only the relevant lines, with `<ins>`/`<del>` for diffs) and a sentence of explanation each.
3. Findings as a triage table, one row per finding with an ID, and a `select name="F1"` disposition (`fix` / `skip` / `discuss`), so every finding comes back with a decision.

## 7. Triage / bulk review — 분류

**When:** the user must decide on many similar items (issues, test failures, copy strings, candidates).

**Structure:** `<body class="wide">`, a table with one row per item and a stable visible ID, and a control per row (`select` or radios named after the ID). Add a short "전체 메모" textarea. Ask the user to send once at the end.

## After the reply

- Read every changed answer and comment; account for each one in your next page or in chat.
- Keep `name`s and `value`s stable across revisions so earlier answers carry over.
- A revision should make what changed visible: mark it with `<span class="badge">수정됨</span>`, or add a short "이번 수정" callout at the top.
- When the conversation moves to a new subject, start a new page rather than growing one page forever.
