import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromePath} from './helpers/native-browser.mjs';

test('an explicit unqualified browser fails instead of selecting a different cached binary', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'latch-browser-pin-'));
  const binary = path.join(directory, process.platform === 'win32' ? 'browser.cmd' : 'browser');
  const names = ['LATCH_SPIKE_BROWSER', 'LATCH_BROWSER_LANE'], before = names.map(n => process.env[n]);
  t.after(async () => { names.forEach((n, i) => before[i] === undefined ? delete process.env[n] : process.env[n] = before[i]); await fs.rm(directory, {recursive: true, force: true}); });
  if (process.platform === 'win32') {
    await fs.writeFile(binary, '@echo off\r\necho Google Chrome for Testing 146.0.0.0\r\n');
  } else {
    await fs.writeFile(binary, '#!/bin/sh\nprintf "Google Chrome for Testing 146.0.0.0\\n"\n', {mode: 0o700});
  }
  process.env.LATCH_SPIKE_BROWSER = binary; process.env.LATCH_BROWSER_LANE = 'floor';
  await assert.rejects(chromePath(), /pin mismatch.*147\.0\.7727\.15/);
  process.env.LATCH_BROWSER_LANE = 'unknown'; await assert.rejects(chromePath(), /floor\|current/);
});
