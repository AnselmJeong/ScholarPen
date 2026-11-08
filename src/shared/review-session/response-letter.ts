import type { ResponseItem, ReviewSession } from './types';

/** The author-facing letter contains every comment and its current answer, in source order. */
export function responseLetterMarkdown(session: ReviewSession, responses: ResponseItem[]): string {
  const byId = new Map(responses.map(response => [response.commentId, response]));
  return '# Response to the Editor and Reviewers\n\n'
    + (session.input.mode === 'virtual' ? 'Virtual review simulation — not external peer review.\n\n' : '')
    + session.comments.map(comment => `## ${comment.reviewerId} · ${comment.id}\n\n### Reviewer comment\n\n${comment.original.split('\n').map(line => `> ${line}`).join('\n')}\n\n### Response\n\n${byId.get(comment.id)?.response || '[Response not yet written]'}\n`).join('\n');
}

const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Self-contained, escaped HTML: no remote assets, raw markup, or reviewer-supplied scripts. */
export function responseLetterHTML(session: ReviewSession, responses: ResponseItem[]): string {
  const byId = new Map(responses.map(response => [response.commentId, response]));
  return `<!doctype html><html lang="${/korean|한국|한글/i.test(session.input.language) ? 'ko' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Response to the Editor and Reviewers</title><style>
    body{max-width:800px;margin:48px auto;padding:0 24px;color:#172033;background:#fff;font:16px/1.7 system-ui,sans-serif}
    h1{font-size:26px;line-height:1.3}h2{font-size:19px;margin-top:36px;border-bottom:1px solid #cbd5e1;padding-bottom:8px}
    h3{font-size:14px;margin:20px 0 8px;color:#475569}blockquote{margin:0;padding:12px 18px;border-left:3px solid #94a3b8;background:#f8fafc}
    .text{white-space:pre-wrap;overflow-wrap:anywhere}h2,h3{break-after:avoid}p,blockquote{orphans:3;widows:3}
    @page{size:A4;margin:20mm}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}blockquote{background:none}}
  </style></head><body><h1>Response to the Editor and Reviewers</h1>${session.input.mode === 'virtual' ? '<p>Virtual review simulation — not external peer review.</p>' : ''}${session.comments.map(comment => `<section><h2>${escapeHTML(comment.reviewerId)} · ${escapeHTML(comment.id)}</h2><h3>Reviewer comment</h3><blockquote class="text">${escapeHTML(comment.original)}</blockquote><h3>Response</h3><div class="text">${escapeHTML(byId.get(comment.id)?.response || '[Response not yet written]')}</div></section>`).join('')}</body></html>`;
}
