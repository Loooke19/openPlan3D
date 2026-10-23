import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2];
const cur = process.argv[3];
const out = process.argv[4];
const rels = [
  'src/lib/components/viewer3d/ThreeViewer.svelte',
  'src/routes/nav/+page.svelte',
  'scripts/b3-transfer-timing.mjs',
];

function escReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let buf = '';
for (const rel of rels) {
  const a = path.join(base, rel);
  const b = path.join(cur, rel);
  if (!fs.existsSync(b)) continue;
  const args = ['diff', '--binary', '--no-index', '--'];
  let empty = null;
  if (fs.existsSync(a)) {
    args.push(a, b);
  } else {
    empty = path.join(os.tmpdir(), `b3-empty-${process.pid}`);
    fs.writeFileSync(empty, '');
    args.push(empty, b);
  }
  let text = '';
  try {
    text = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
  } catch (e) {
    text = String(e.stdout || '');
  }
  if (empty) fs.unlinkSync(empty);
  if (!text.includes('diff --git')) continue;
  text = text.replace(/\r\n/g, '\n');
  const variants = [a, b, empty].filter(Boolean).flatMap((p) => [p, p.replace(/\\/g, '/')]);
  for (const v of variants) {
    text = text.replace(new RegExp(escReg(v), 'g'), v === a || v === (a && a.replace(/\\/g, '/')) ? `a/${rel}` : `b/${rel}`);
  }
  // Force canonical headers
  text = text.replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`);
  text = text.replace(/^--- .*$/m, fs.existsSync(path.join(base, rel)) ? `--- a/${rel}` : '--- /dev/null');
  text = text.replace(/^\+\+\+ .*$/m, `+++ b/${rel}`);
  buf += text;
  if (!buf.endsWith('\n')) buf += '\n';
}
fs.writeFileSync(out, buf);
console.log(JSON.stringify({ bytes: Buffer.byteLength(buf), diffs: (buf.match(/^diff --git/gm) || []).length }));
