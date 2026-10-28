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
  const base=path.join(root,'work/installer-tests'); await fs.mkdir(base,{recursive:true});
  const temp=await fs.mkdtemp(path.join(base,'install-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const project=path.join(temp,'project with spaces');
  await fs.mkdir(path.join(project,'src'),{recursive:true}); await fs.mkdir(path.join(project,'extension'));
  for(const file of ['package.json','src/install.mjs','extension/protocol.js','extension/manifest.json'])
    await fs.copyFile(path.join(root,file),path.join(project,file));
  await fs.writeFile(path.join(project,'src/native-host.mjs'),"console.log(JSON.stringify(process.argv.slice(2)));\n");
  const prepared=JSON.parse((await exec(process.execPath,[path.join(project,'src/install.mjs'),'prepare'])).stdout);
  const caller=`chrome-extension://${prepared.extensionId}/`;
  const result=await exec(path.join(project,'install/native-host'),[caller,'argument with spaces']);
  assert.deepEqual(JSON.parse(result.stdout),[caller,'argument with spaces']);
});
