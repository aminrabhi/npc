// Syntax check for every module the village ships and every server route.
//
//   npm run check
//
// node --check reads a file as CommonJS by default, so each module is copied to a
// temporary .mjs file first. That keeps this dependency-free and covers both the
// browser modules and the Vercel functions.

import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collect(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [
  ...(await collect(path.join(root, 'js'))),
  ...(await collect(path.join(root, 'server'))),
  ...(await collect(path.join(root, 'api'))),
  ...(await collect(path.join(root, 'tools'))),
];

const tmp = await mkdtemp(path.join(os.tmpdir(), 'village-check-'));
let failed = 0;

for (const file of files) {
  const target = path.join(tmp, `${path.basename(file, '.js')}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(target, await readFile(file, 'utf8'));
  try {
    await run(process.execPath, ['--check', target]);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${path.relative(root, file)}`);
    console.error(String(error.stderr || error.message).split('\n').slice(0, 6).join('\n'));
  }
}

await rm(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} modules.`);
