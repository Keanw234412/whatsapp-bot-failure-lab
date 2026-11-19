#!/usr/bin/env node
// WhatsApp Bot Failure Lab: reproduces webhook failure modes against a locally
// running WhatsApp Cloud API bot and reports what broke, with evidence.
//
//   node lab.mjs init [--config lab.config.json]
//   node lab.mjs run  [--config lab.config.json] [--only id,id] [--out dir] [--json] [--strict]
//                     [--include-bot-log] [--allow-remote]
//   Exit codes: 0 ok, 1 failure (or warn/inconclusive with --strict), 2 harness/config error, 3 preflight failed
//   node lab.mjs mock [--port 8788]          (mock Graph API only, for manual testing)
//   node lab.mjs list
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, sampleConfig } from './lib/config.mjs';
import { runLab } from './lib/runner.mjs';
import { startMock } from './lib/mock.mjs';
import { toMarkdown, toConsole } from './lib/report.mjs';
import { coreScenarios } from './scenarios/core.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Node.js 22+ is required (found ${process.versions.node}).`);
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args.shift() : 'run';
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

async function loadScenarios() {
  const all = [...coreScenarios];
  try {
    const pro = await import('./scenarios/pro.mjs');
    all.push(...pro.proScenarios);
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  return all;
}

async function main() {
  const configPath = resolve(opt('config', 'lab.config.json'));
  if (cmd === 'init') {
    try {
      await access(configPath);
      console.error(`${configPath} already exists; not overwriting.`);
      process.exit(2);
    } catch {}
    await writeFile(configPath, JSON.stringify(sampleConfig(), null, 2) + '\n');
    console.log(`Wrote ${configPath}. Set webhookUrl, then export WA_APP_SECRET / WA_VERIFY_TOKEN (or set those keys to null).`);
    return;
  }
  if (cmd === 'list') {
    for (const s of await loadScenarios()) console.log(`${s.tier.padEnd(5)} ${s.id.padEnd(26)} ${s.title}`);
    return;
  }
  if (cmd === 'mock') {
    const m = await startMock({ port: Number(opt('port', 8788)) });
    console.log(`Mock Graph API on ${m.url}. Ctrl+C to stop. Outbound messages are printed below.`);
    let n = 0;
    setInterval(() => {
      while (n < m.records.length) console.log(JSON.stringify(m.records[n++]));
    }, 250);
    return;
  }
  if (cmd !== 'run') {
    console.error(`Unknown command "${cmd}". Use init, run, list or mock.`);
    process.exit(2);
  }

  const cfg = await loadConfig(configPath);
  if (!cfg.webhookIsLocal && !flag('allow-remote')) {
    console.error(`Refusing to send synthetic messages to non-local ${cfg.webhookUrl}. Run the bot locally, or pass --allow-remote for a test deployment you own.`);
    process.exit(2);
  }
  const only = opt('only') ? opt('only').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const json = flag('json');
  const rep = await runLab(cfg, await loadScenarios(), { only, includeBotLog: flag('include-bot-log'), log: json ? () => {} : (m) => console.error(m) });
  const outDir = resolve(opt('out', 'wa-lab-report'));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), JSON.stringify(rep, null, 2));
  await writeFile(join(outDir, 'report.md'), toMarkdown(rep));
  if (json) console.log(JSON.stringify(rep, null, 2));
  else console.log('\n' + toConsole(rep) + `\n\nReport: ${join(outDir, 'report.md')}`);
  // 0 all good, 1 a scenario failed (or warn/inconclusive with --strict), 2 harness error, 3 preflight failed
  const c = rep.counts;
  process.exitCode = rep.aborted ? 3 : c.error ? 2 : c.fail ? 1 : flag('strict') && (c.warn || c.inconclusive) ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
