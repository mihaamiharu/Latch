#!/usr/bin/env node
// Cross-platform `VAR=1 node --test ...` for npm scripts (POSIX env prefixes
// do not work in cmd.exe or PowerShell). Usage:
//   node scripts/test-env.mjs LATCH_OPEN_TAB=1 [MORE=x] -- --test test/open-tab-browser.test.mjs
import {spawn} from 'node:child_process';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 1) {
  console.error('Usage: node scripts/test-env.mjs NAME=value [...] -- <node args>');
  process.exit(2);
}
const env = {...process.env};
for (const pair of argv.slice(0, split)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(pair);
  if (!match) {
    console.error(`Invalid environment assignment: ${pair}`);
    process.exit(2);
  }
  env[match[1]] = match[2];
}
const child = spawn(process.execPath, argv.slice(split + 1), {env, stdio: 'inherit'});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
