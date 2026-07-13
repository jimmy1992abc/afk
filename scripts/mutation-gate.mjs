#!/usr/bin/env node
// A green suite is not evidence that a defence is tested — this repo once had a
// suite that stayed green with an entire load-bearing path deleted. This gate
// applies each listed mutation, expects the scoped tests to go RED, and restores
// the file. A mutation that survives (or fails to apply) fails the gate: it
// means the defence it names has no test behind it.
//
//   node scripts/mutation-gate.mjs <mutations.json> [test files...]
//
// mutations.json: [{ "name", "file", "old", "new" }, ...] — `old` must match the
// file exactly (LF-normalised) and is replaced once.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const [manifestPath, ...testArgs] = process.argv.slice(2);
if (!manifestPath) {
  console.error('usage: node scripts/mutation-gate.mjs <mutations.json> [test files...]');
  process.exit(2);
}
const mutations = JSON.parse(readFileSync(manifestPath, 'utf8'));
const tests = testArgs.length > 0 ? testArgs : globSync('test/**/*.test.mjs');

function suiteIsRed() {
  try {
    // A mutant that HANGS the suite is red too — some mutations reintroduce
    // exactly the wait-for-ever bugs their tests exist to pin, and without this
    // bound the gate itself would hang on them.
    execFileSync(process.execPath, ['--test', ...tests], { stdio: 'pipe', timeout: 120_000 });
    return false;
  } catch {
    return true;
  }
}

const survivors = [];
for (const { name, file, old, new: replacement } of mutations) {
  const original = readFileSync(file, 'utf8');
  const normalised = original.replaceAll('\r\n', '\n');
  if (!normalised.includes(old)) {
    console.log(`[${name}] MUTATION DID NOT APPLY — invalid, counts as a survivor`);
    survivors.push(name);
    continue;
  }
  writeFileSync(file, normalised.replace(old, replacement));
  try {
    const caught = suiteIsRed();
    console.log(`[${name}] ${caught ? 'CAUGHT' : '*** SURVIVED — this defence has no test ***'}`);
    if (!caught) survivors.push(name);
  } finally {
    writeFileSync(file, original);
  }
}
console.log(`SURVIVORS: ${survivors.length === 0 ? 'none — every defence is pinned' : survivors.join('; ')}`);
process.exit(survivors.length === 0 ? 0 : 1);
