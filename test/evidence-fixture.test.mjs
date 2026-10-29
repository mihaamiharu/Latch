import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {evidenceApp,bodyBytes,hash,pixels,MiB} from './fixtures/evidence-app.mjs';import {captureCLI} from './helpers/evidence-capture.mjs';
test('evidence fixture has deterministic independent content and finite body bounds',async t=>{
 assert.equal(hash(pixels(64,64)),'012414b10040439aefdf12abe4c271f3eda3157f916ba983a05984551ac3d6b2');
 assert.throws(()=>bodyBytes('binary',16*MiB+1,'a','b'),/bound/);
 const app=await evidenceApp();t.after(()=>app.close());
 for(const kind of ['binary','text']){const url=app.origin+`/body?kind=${kind}&size=1048576&actor=unit&op=${kind}`;const response=await fetch(url),bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,MiB);assert.equal(hash(bytes),hash(bodyBytes(kind,MiB,'unit',kind)));if(kind==='text')assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
});
test('bounded evidence sink reaps over-limit output and leaves it explicitly partial',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latch-evidence-sink-')),pidFile=path.join(dir,'pid');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'playwright-cli'),`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);`,{mode:0o700});
 const f={evidence:dir,workspaces:[dir],env:{...process.env,PATH:dir+':'+process.env.PATH}};
 await assert.rejects(captureCLI(f,0,['fake'],{name:'overflow',limit:1024}),/bound/);const pid=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.ok(await fs.stat(path.join(dir,'overflow.stdout.partial')));await assert.rejects(fs.stat(path.join(dir,'overflow.stdout.json')),{code:'ENOENT'});
});
