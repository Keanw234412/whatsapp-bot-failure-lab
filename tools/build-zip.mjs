// Builds the skill zips with SKILL.md at the zip root:
//   dist/whatsapp-bot-failure-lab.zip      free (MIT) edition
//   dist/whatsapp-bot-failure-lab-pro.zip  free + Pro pack (for Agensi), only if the Pro files are present
import { cp, mkdir, rm, access, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'skill', 'whatsapp-bot-failure-lab');
const dist = join(root, 'dist');
const PRO = ['scripts/scenarios/pro.mjs', 'references/fixes.md', 'LICENSE-PRO.txt'];

const exists = (p) => access(p).then(() => true, () => false);

async function stage(name, includePro) {
  const dir = join(dist, 'stage', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(src, dir, {
    recursive: true,
    filter: (p) => {
      const rel = p.slice(src.length + 1).replaceAll('\\', '/');
      if (!includePro && PRO.includes(rel)) return false;
      return !/(^|\/)(wa-lab-report|node_modules)(\/|$)|lab\.config\.json$/.test(rel);
    },
  });
  const zip = join(dist, `${name}.zip`);
  await rm(zip, { force: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
  const entries = await readdir(dir);
  if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', zip, ...entries], { cwd: dir });
  else execFileSync(tar, ['-r', '-q', zip, ...entries], { cwd: dir });
  console.log(`built ${zip}`);
}

await mkdir(dist, { recursive: true });
await stage('whatsapp-bot-failure-lab', false);
const hasPro = (await Promise.all(PRO.map((p) => exists(join(src, p))))).every(Boolean);
if (hasPro) await stage('whatsapp-bot-failure-lab-pro', true);
else console.log('Pro pack files not present; skipped the Pro zip.');
await rm(join(dist, 'stage'), { recursive: true, force: true });
