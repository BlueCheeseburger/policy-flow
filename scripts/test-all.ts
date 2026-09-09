// Runs every headless test and reports one pass/fail summary.
//
// These came over from Warroom along with the pure logic they cover — the grid
// selection model, arrow geometry, the docx card parser, cite shortening, tab
// summaries, prompt-length handling. Keeping them is most of the reason this
// port could be trusted: the code they exercise did not change, so a green run
// here means the behavior really is the same as the desktop app's.
//
// Each file is a separate process because each one ends in process.exit() —
// importing them in sequence would stop the run at the first success. They are
// deliberately left exactly as they are upstream so the two copies don't drift.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const files = readdirSync(here)
  .filter((f) => f.startsWith('test-') && f.endsWith('.ts') && f !== 'test-all.ts')
  .sort();

const failures: string[] = [];
for (const f of files) {
  const res = spawnSync(process.execPath, [tsxCli, join(here, f)], { encoding: 'utf8' });
  const summary = (res.stdout ?? '').split('\n').filter((l) => /passed|failed|✅|❌/.test(l)).pop() ?? '';
  const ok = res.status === 0;
  if (!ok) failures.push(f);
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(34)} ${summary.trim()}`);
  if (!ok) console.error((res.stdout ?? '') + (res.stderr ?? ''));
}

if (failures.length) {
  console.error(`\n${failures.length} of ${files.length} test files FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);
