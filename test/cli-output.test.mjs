import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {runCLI} from '../src/playwright.mjs';
const MAX=2*1024*1024;
test('CLI output uses exact UTF-8 byte boundaries and preserves split multibyte characters',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latch-output-')),script=path.join(dir,'cli');const old=process.env.QA_BROWSER_PLAYWRIGHT_CLI;
 t.after(async()=>{if(old===undefined)delete process.env.QA_BROWSER_PLAYWRIGHT_CLI;else process.env.QA_BROWSER_PLAYWRIGHT_CLI=old;await fs.rm(dir,{recursive:true,force:true})});
 await fs.writeFile(script,`#!${process.execPath}\nconst [size,unicode]=JSON.parse(process.argv.at(-1));const overhead=Buffer.byteLength(JSON.stringify({result:''}));const n=size-overhead;const text=unicode?'雪'.repeat(Math.floor(n/3))+'x'.repeat(n%3):'x'.repeat(n);const bytes=Buffer.from(JSON.stringify({result:text}));(async()=>{for(let i=0;i<Math.min(40,bytes.length);i++)await new Promise(r=>process.stdout.write(bytes.subarray(i,i+1),r));for(let i=40;i<bytes.length;i+=65536)await new Promise(r=>process.stdout.write(bytes.subarray(i,i+65536),r))})();`,{mode:0o700});process.env.QA_BROWSER_PLAYWRIGHT_CLI=script;
 for(const unicode of [false,true])for(const size of [MAX-1,MAX,MAX+1]){
  const op=runCLI('test',['output',JSON.stringify([size,unicode])],{workspace:dir});
  if(size>MAX)await assert.rejects(op,{code:'CLI_OUTPUT_LARGE'});else{const result=await op;assert.equal(Buffer.byteLength(JSON.stringify(result)),size);if(unicode)assert.ok(!result.result.includes('\ufffd'))}
 }
});
test('CLI deadline reaps a subprocess that ignores SIGTERM and reports uncertain browser outcome',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latch-timeout-')),script=path.join(dir,'cli'),pidFile=path.join(dir,'pid'),old=process.env.QA_BROWSER_PLAYWRIGHT_CLI;let pid;
 t.after(async()=>{if(pid)try{process.kill(pid,'SIGKILL')}catch{}if(old===undefined)delete process.env.QA_BROWSER_PLAYWRIGHT_CLI;else process.env.QA_BROWSER_PLAYWRIGHT_CLI=old;await fs.rm(dir,{recursive:true,force:true})});
 await fs.writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{mode:0o700});process.env.QA_BROWSER_PLAYWRIGHT_CLI=script;
 await assert.rejects(runCLI('test',['stuck'],{workspace:dir,timeout:1500}),error=>error.code==='CLI_TIMEOUT'&&/unknown outcome/.test(error.message));pid=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=undefined;
 const descendantFile=path.join(dir,'descendant');
 const descendantCode=`require('fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},1000)`;
 await fs.writeFile(script,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,{mode:0o700});
 await assert.rejects(runCLI('test',['inherited-pipe'],{workspace:dir,timeout:1500}),{code:'CLI_TIMEOUT'});
 const parent=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(parent,0),{code:'ESRCH'});
 pid=Number(await fs.readFile(descendantFile,'utf8'));process.kill(pid,0);process.kill(pid,'SIGKILL');pid=undefined;
});
