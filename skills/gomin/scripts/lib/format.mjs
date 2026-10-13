// Turns replies into compact, agent-readable text.

const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const quote = (value, max = 160) => {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
};
const indent = (value, prefix = '   ') => String(value).trim().split('\n').map((line) => `${prefix}${line}`).join('\n');

function answerValue(answer) {
  if (answer.cleared) return '(cleared)';
  const values = Array.isArray(answer.value) ? answer.value : [answer.value];
  const displays = Array.isArray(answer.display) ? answer.display : [answer.display];
  if (['text', 'textarea', 'custom'].includes(answer.kind) || answer.kind === undefined) {
    const shown = displays[0] ?? values[0];
    return typeof shown === 'string' && shown.includes('\n') ? `\n${indent(shown, '     ')}` : quote(shown, 2000);
  }
  return values.map((value, index) => {
    const label = displays[index];
    return label && label !== String(value) ? `${label} [${value}]` : String(value);
  }).join(', ');
}

export function formatReply(event, thread) {
  const page = thread.pages[event.pageId];
  const lines = [];
  lines.push(`## Reply · ${time(event.at)} · on "${page?.title ?? 'page'}" (rev ${event.rev ?? '?'})`);
  if (page) lines.push(`file: ${page.path}`);
  if (event.message) lines.push('', 'Message:', indent(event.message));
  if (event.answers?.length) {
    lines.push('', 'Answers:');
    for (const answer of event.answers) {
      const where = answer.pageId !== event.pageId && thread.pages[answer.pageId] ? ` (on "${thread.pages[answer.pageId].title}")` : '';
      const question = answer.question && answer.question !== answer.name ? `${answer.question} (${answer.name})` : answer.name;
      lines.push(`- ${question}${where}: ${answerValue(answer)}`);
    }
  }
  if (event.unanswered?.length) lines.push(`- Unanswered: ${event.unanswered.join('; ')}`);
  if (event.comments?.length) {
    lines.push('', 'Comments:');
    event.comments.forEach((comment, index) => {
      const anchor = comment.quote ? `On ${quote(comment.quote)}` : comment.target ? `On ${comment.target}` : 'General';
      const context = comment.context ? ` — in "${comment.context}"` : '';
      const other = comment.pageId && comment.pageId !== event.pageId && thread.pages[comment.pageId] ? ` (page "${thread.pages[comment.pageId].title}")` : '';
      lines.push(`${index + 1}. ${anchor}${context}${other}`, indent(comment.text));
    });
  }
  if (event.submitter) {
    const { label, name, value } = event.submitter;
    lines.push('', `Clicked: ${label || value || name}${name ? ` [${name}=${value}]` : ''}`);
  }
  if (event.ended) lines.push('', 'Ended the conversation.');
  return lines.join('\n');
}

export const NEXT_REPLY = 'Next: the user is reading the page, not your terminal. Act on this, then answer in the page: '
  + "`gomin say <<'EOF'` … `EOF` for a short Markdown answer (quoted heredoc, never a double-quoted argument), or revise the page / open a new one for anything bigger. "
  + 'Then run `gomin wait` again in the same message. Keep this loop going until the user ends the conversation.';
export const NEXT_ENDED = 'The user ended the conversation in gomin. Stop waiting and do not reopen the page unless asked; continue in the terminal chat if anything is left.';

export function formatReplies(events, thread) {
  const ended = events.some((event) => event.ended);
  const header = events.length === 1 ? 'The user replied in gomin.' : `The user sent ${events.length} replies in gomin.`;
  return [
    header,
    '',
    events.map((event) => formatReply(event, thread)).join('\n\n'),
    '',
    ended ? NEXT_ENDED : NEXT_REPLY,
  ].join('\n');
}

export function formatStatus(thread, { waiting, clients, url, limit = 10 }) {
  const pages = Object.values(thread.pages);
  const current = thread.pages[thread.currentPageId];
  const lines = [
    `thread: ${thread.id} · ${url}`,
    `pages: ${pages.length} · current: ${current ? `"${current.title}" rev ${current.rev} (${current.path})` : 'none'}`,
    `browser tabs: ${clients} · agent waiting: ${waiting ? 'yes' : 'no'}`,
  ];
  const replies = thread.events.filter((event) => event.type === 'user').slice(-limit);
  if (replies.length) {
    lines.push('', `Last ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}:`, '');
    lines.push(replies.map((event) => `${formatReply(event, thread)}\n(${event.deliveredAt ? 'delivered' : 'not yet delivered'})`).join('\n\n'));
  }
  return lines.join('\n');
}
