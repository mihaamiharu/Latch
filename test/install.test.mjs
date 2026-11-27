import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('generated native launcher preserves Chrome caller origin and argument boundaries', async t => {
  const base = path.join(root, 'work/installer-tests');
  await fs.mkdir(base, {recursive: true});
  const temp = await fs.mkdtemp(path.join(base, 'install-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const project = path.join(temp, 'project with spaces');
  await fs.mkdir(path.join(project, 'src'), {recursive: true});
  await fs.mkdir(path.join(project, 'extension'));
  await fs.cp(path.join(root, 'src'), path.join(project, 'src'), {recursive: true});
  for (const file of ['package.json', 'extension/protocol.js', 'extension/manifest.json']) {
    await fs.copyFile(path.join(root, file), path.join(project, file));
  }
  await fs.writeFile(path.join(project, 'src/native-host.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const prepared = JSON.parse((await exec(process.execPath, [path.join(project, 'src/install.mjs'), 'prepare'])).stdout);
  const caller = `chrome-extension://${prepared.extensionId}/`;
  let result;
  if (process.platform === 'win32') {
    const cmdLine = `""${prepared.nativeHostLauncher}" "${caller}" "argument with spaces""`;
    result = await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdLine], {windowsVerbatimArguments: true});
  } else {
    result = await exec(prepared.nativeHostLauncher, [caller, 'argument with spaces']);
  }
  assert.deepEqual(JSON.parse(result.stdout), [caller, 'argument with spaces']);
});
