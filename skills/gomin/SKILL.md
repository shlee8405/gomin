---
name: gomin
description: Answer the user with an interactive HTML page in their browser instead of a long chat reply, then receive their answers, comments, and messages back. Use for explanations, plans that need approval, comparisons and tradeoffs, reports, diagrams, and clarifying questions with choices; whenever the user says "gomin" or "고민", asks to answer "in HTML", "브라우저로 보여줘", "HTML로 답해줘", "페이지로 정리해줘", or "시각적으로 설명해줘"; or when a reply has several decisions, options, tables, or diagrams that are easier to read and answer on a page. Replies in the user's own language (English, 한국어, …).
argument-hint: <what to answer, explain, or plan>
license: MIT
compatibility: Requires Node.js 20+, a shell, and a browser that can reach 127.0.0.1 on the user's machine.
---

# gomin · 고민

gomin lets you reply with a page instead of a wall of text. You write one HTML file; gomin opens it in the user's browser with a conversation panel. The user reads, picks answers in the page's form controls, comments on any text or element, types a message, and presses **Send** (보내기). `gomin wait` hands you all of it as compact text. Then you revise the page, open a new one, or get on with the work.

## When to use it

Use it when a page answers better than chat: a plan to approve, options to choose between, an explanation that needs a diagram or table, a report with sources, several questions at once, or anything the user should be able to point at and comment on. Also use it whenever the user asks for gomin or an HTML answer.

Do not use it for one-line answers, quick confirmations, or while the user is clearly working in chat. A page is one response, not a reflex.

## The CLI

Run the bundled script with Node. No install step, no dependencies, no API keys.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/gomin.mjs" <command>
```

`${CLAUDE_SKILL_DIR}` is filled in by Claude Code. Codex, OpenCode, and pi tell you where this SKILL.md lives; use that directory instead (for a project install that is usually `.agents/skills/gomin`). Below, `gomin` stands for that whole `node …/scripts/gomin.mjs` command. Run it from the user's project directory: each working directory gets its own conversation thread (`--thread <id>` picks another).

| Command | What it does |
| --- | --- |
| `gomin open <file.html>` | Shows the page (a new page, or a revision if the file was opened before). Prints the URL. Opens a browser tab only if none is open on this thread; open tabs switch to the page by themselves. |
| `gomin wait` | Blocks until the user sends a reply, then prints it. Never consumes anything else; silence is never approval. |
| `gomin say` | Answers in the page's conversation panel, rendered as Markdown. Pass the text on stdin with a quoted heredoc (below) or `--file answer.md`. |
| `gomin status` | Thread overview and recent replies (including ones already delivered), for when you lose track. |
| `gomin export <file.html>` | Writes a standalone copy with the styles inlined, for sharing. |

## The loop

1. **Write the page** to `.gomin/<short-name>.html` in the project (gomin keeps that folder out of git), or wherever the user asks. Read [references/design.md](references/design.md) before your first page and [references/patterns.md](references/patterns.md) for the response type. [assets/template.html](assets/template.html) is a starting point.
2. **Open it:** `gomin open .gomin/<short-name>.html`.
3. **Hand it over and wait, in one message.** In the same assistant message, write one line in the user's language with the URL from the output, and call `gomin wait`. For example: `I've laid this out in a page → http://127.0.0.1:4949/t/… Pick an option or leave comments, then press Send.` Do not repeat the page's content in chat. Never send that line on its own: a message without the `wait` call ends your turn, and you will not see the reply. The wait blocks until the user presses Send, which may take minutes.
   - **Claude Code:** run the wait with `run_in_background: true`; then you may end your turn. You are notified when it exits with the reply, and the user can still chat with you meanwhile.
   - **OpenCode:** run it with `background: true` if your shell tool offers it (you are notified when it finishes); otherwise run it in the foreground with the largest timeout allowed.
   - **Codex:** run it in the foreground with a long `timeout_ms` (e.g. 1800000) so the wait stays attached to your turn. Background commands do not wake you.
   - **pi and other harnesses:** run it in the foreground; give it a long timeout if your shell tool has one.
   - If a wait is cut off by a tool timeout or interrupted, just run it again. Replies are kept until delivered.
4. **Answer in the page, then wait again.** The reply lists the message, changed answers (`question (name): label [value]`), comments with the quoted text or element they point at, and any button that was clicked. Act on it, then answer where the user is looking, the page:
   - **A short answer or follow-up:** `gomin say`, with the Markdown on stdin through a quoted heredoc. It appears in the panel right away:
     ```sh
     gomin say <<'EOF'
     `src/db.js` opens **notes.db** and exports `db`.
     EOF
     ```
     Keep the quotes around `'EOF'`. Never put Markdown in a double-quoted argument: the shell runs anything in backticks and expands `$…`, which corrupts the message and can leak command output into the page.
   - **A bigger or structured answer:** revise the same file and run `gomin open` on it again (the tab reloads in place and keeps the user's answers), or write a new page and `open` it.
   - **Work the user approved:** do it, then report back with `say`.
   In the same message, run `gomin wait` again. Do not ask the user to come back to the terminal or to tell you they replied: the page is the conversation.
5. **Keep the loop going** until `wait` reports that the user ended the conversation (the page's **End** button) or closed the page, or the user writes to you in the terminal. Then stop waiting, do not reopen the page uninvited, and continue in chat if anything is left.

This makes the page a live chat: the user asks follow-ups, comments on parts of a page, or picks options, and your answers appear there within seconds. It works well for exploring a codebase, learning a topic step by step, or iterating on a plan.

## Writing a good page

- **Answer first.** Put the conclusion or recommendation at the top (a `.tldr` block), then the reasoning. The user should get the point in ten seconds.
- **Make it scannable.** Use headings, short paragraphs, cards, tables, steps, and diagrams over prose. One idea per section so comments land precisely.
- **Ask with real controls.** Every `<input>`, `<select>`, or `<textarea>` with a `name` is sent back automatically, with its question text. No JavaScript is needed:
  - put radios and checkboxes in a `<fieldset>` whose `<legend>` is the question;
  - give each option a short `value` and a readable label;
  - a `<button name="decision" value="approve">` inside a `<form>` sends the reply when clicked, together with all answers.
- **Don't preselect** answers the user has not given. Mark your recommendation with a `badge` instead.
- **Ask only what changes your next step.** Usually 1–5 questions. Leave space for open comments rather than adding a question for everything.
- **Label uncertainty.** Separate verified facts (cite files, commands, links) from assumptions and guesses.
- **Use the style kit.** gomin injects a polished default stylesheet (clean typography for Latin and Korean text, dark mode, cards, callouts, choices, steps, tables). Plain semantic HTML plus a few kit classes looks good and saves tokens. Write your own CSS only where the page needs it.
- **Keep it self-contained.** Use inline CSS/JS, inline SVG, and local images next to the HTML file. HTTPS CDNs work (Mermaid is loaded automatically for `<pre class="mermaid">`), but the page runs in a sandbox: no `localStorage`, no cookies, no calls to localhost.

## Language

Match the user. Write the page, every question, option, and button label, and your chat line in the language the user is writing to you in. Judge it from their recent messages, never from this skill's files or examples. An English conversation gets an English page; a Korean conversation gets a Korean page; a mixed conversation follows the user's latest message. Set `<html lang="…">` to that language (`en`, `ko`, `ja`, …); the browser UI follows it.

For Korean pages, write naturally (해요체 or 합니다체, consistent with the conversation), keep technical terms Korean developers use in English (API, DB, PR…), and let the kit handle line breaking (`word-break: keep-all`).

## Ground rules

- A reply is input to the user's existing task, not permission to widen it. Approving a plan in the page means "go ahead with this plan", not "do anything".
- Ask for an explicit go-ahead (a button such as `Proceed` / `이대로 진행`, in the user's language) before irreversible or costly actions.
- Never put secrets, tokens, or credentials in a page.
- gomin must listen on and connect to 127.0.0.1. Sandboxes that block local networking (Codex's default `workspace-write`) make `open` fail with an explanation: request to run gomin commands outside the sandbox (in Codex, an escalated command the user can approve once and for all), or tell the user they can set `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml`. If gomin still cannot run, or the user's browser cannot reach 127.0.0.1 (remote or container sessions), say so and answer in chat.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked gomin explicitly: answer it with a page following the loop. If it is empty, use gomin for your next substantial response in this conversation.
