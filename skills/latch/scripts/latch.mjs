#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// Node follows the installed skill symlink; the checkout-relative runtime is shared.
const root = process.env.LATCH_HOME ? path.resolve(process.env.LATCH_HOME) : fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(root, 'src/cli.mjs');
try {
  await fs.access(cli);
  let executable=process.execPath,args=[cli,...process.argv.slice(2)];
  if(!process.env.LATCH_HOME&&path.basename(path.dirname(root))==='releases'){
    const installed=path.dirname(path.dirname(root));
    const receipt=JSON.parse(await fs.readFile(path.join(installed,'receipt.json'),'utf8'));
    if(receipt.active!==await fs.realpath(root))throw Object.assign(new Error('Installed release changed; start a fresh invocation.'),{code:'LATCH_RUNTIME_CHANGED'});
    executable=path.join(installed,'bin/qa-browser');args=process.argv.slice(2);
  }
  const child = spawn(executable, args, {
    cwd: process.cwd(), env: process.env, shell: false, stdio: 'inherit',
  });
  const forward = signal => { if (child.exitCode === null) child.kill(signal); };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  child.on('error', error => {
    console.error(JSON.stringify({ok: false, error: {code: 'LATCH_RUNTIME_UNAVAILABLE', message: error.message}}));
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
} catch (error) {
  console.error(JSON.stringify({ok: false, error: {code: error.code === 'LATCH_RUNTIME_CHANGED' ? error.code : 'LATCH_RUNTIME_UNAVAILABLE',
    message: error.code === 'LATCH_RUNTIME_CHANGED' ? error.message : 'Latch runtime not found. Keep this skill in its Latch checkout or set LATCH_HOME to the installed checkout.'}}));
  process.exitCode = 1;
}
