// Markdown report. The runner records statuses, timings, recipients and
// truncated outbound text; configured secrets are redacted before this point.
const ICON = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', inconclusive: 'INCONCLUSIVE', skip: 'SKIP', error: 'ERROR' };

export function toMarkdown(rep) {
  const c = rep.counts;
  const lines = [];
  lines.push('# WhatsApp Bot Failure Lab report', '');
  lines.push(`- Webhook: \`${rep.webhookUrl}\``);
  lines.push(`- Mock Graph API: \`${rep.mockUrl}\``);
  lines.push(`- Signed deliveries: ${rep.signing ? 'yes' : 'no (appSecret not configured)'}`);
  lines.push(`- Started: ${rep.startedAt}, took ${(rep.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Result: **${c.pass || 0} pass, ${c.fail || 0} fail, ${c.warn || 0} warn, ${c.inconclusive || 0} inconclusive, ${c.skip || 0} skipped${c.error ? `, ${c.error} harness error(s)` : ''}**`);
  if (rep.aborted) lines.push('', '> Preflight failed, so no scenarios ran. Fix the preflight issue first.');
  lines.push('', '| Result | Scenario | Summary |', '|---|---|---|');
  for (const r of rep.results) lines.push(`| ${ICON[r.status] || r.status} | ${esc(r.title)} | ${esc(r.summary)} |`);
  lines.push('', '## Evidence', '');
  for (const r of rep.results) {
    if (!r.evidence?.length) continue;
    lines.push(`### ${ICON[r.status] || r.status}: ${r.title}`, '', '```');
    for (const e of r.evidence.slice(0, 40)) lines.push(e);
    if (r.evidence.length > 40) lines.push(`... ${r.evidence.length - 40} more`);
    lines.push('```', '');
  }
  lines.push('## Limits', '');
  lines.push('- Each scenario observes outbound traffic for a bounded window. "No reply" means none was seen within that window, not that the bot can never reply.');
  lines.push('- Only send paths that reach the mock are observed; a second SDK, worker or hard-coded URL could still call the real Graph API. Side effects (orders, tickets) are visible only if the bot reports them to `/__lab/effect`.');
  lines.push('- Synthetic payloads follow the public Cloud API webhook format; they do not prove Meta-side behaviour such as the 24-hour window.');
  if (rep.botLogTail) lines.push('', '## Bot output (tail)', '', '```', rep.botLogTail.trim().slice(-3000), '```');
  return lines.join('\n') + '\n';
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function toConsole(rep) {
  const out = [];
  for (const r of rep.results) out.push(`${(ICON[r.status] || r.status).padEnd(12)} ${r.id}: ${r.summary}`);
  const c = rep.counts;
  out.push('', `${c.pass || 0} pass, ${c.fail || 0} fail, ${c.warn || 0} warn, ${c.inconclusive || 0} inconclusive, ${c.skip || 0} skipped${c.error ? `, ${c.error} harness error(s)` : ''}`);
  return out.join('\n');
}
