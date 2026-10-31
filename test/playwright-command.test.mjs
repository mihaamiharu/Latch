import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {validatePlaywrightArgs} from '../src/playwright-command.mjs';
import {sessionKey} from '../src/playwright.mjs';
import {daemonFile} from '../src/daemon-identity.mjs';
import {command} from './helpers/native-browser.mjs';

test('pw keeps lifecycle and global session/format overrides out of forwarded commands',()=>{
 for(const args of [[],['attach'],['close-all'],['tab-new'],['click','e1','--session=other'],['snapshot','-sother'],['snapshot','-xsother'],['run-code','async()=>1','--json=false'],['snapshot','--no-json'],['snapshot','--raw']])assert.throws(()=>validatePlaywrightArgs(args),{code:'INVALID_ARGUMENT'});
 for(const args of [['snapshot','--filename=a b.yaml'],['fill','e1','value with spaces'],['run-code','async(page)=>page.title()']])validatePlaywrightArgs(args);
});

test('pw propagates zero-exit tool errors and never starts an absent, foreign or stale task',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'latch-command-')),runtime=`/tmp/latch-command-${crypto.randomBytes(5).toString('hex')}`;
 await fs.mkdir(runtime,{mode:0o700});const workspace=await fs.realpath(dir),session='test',key=sessionKey(workspace,session),instanceId=crypto.randomUUID(),epoch=crypto.randomUUID();
 const config=path.join(dir,'config.json'),script=path.join(dir,'fake-cli'),calls=path.join(dir,'calls.jsonl'),daemonRoot=path.join(dir,'daemon'),taskSocket=path.join(runtime,'task.sock');
 const env={...process.env,QA_BROWSER_RUNTIME_DIR:runtime,QA_BROWSER_CONFIG:config,QA_BROWSER_PLAYWRIGHT_CLI:script,PWTEST_DAEMON_SESSION_DIR:daemonRoot};
 await fs.writeFile(config,JSON.stringify({profiles:{work:{instanceId,chromeProfileDir:'Default'}}}));
 const state={instanceId,epoch,workspace,session,groupId:7};const stateFile=path.join(runtime,key+'.session.json');
 await fs.writeFile(script,`#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+'\\n');console.log(JSON.stringify({isError:true,error:'TimeoutError: locator.click: waiting for element to be visible, enabled and stable'}));`,{mode:0o700});
 const host=net.createServer(socket=>{let body='';socket.on('data',b=>{body+=b;if(!body.includes('\n'))return;const m=JSON.parse(body);socket.end(JSON.stringify({v:1,id:m.id,ok:true,result:{instanceId,epoch,sessions:[{key,groupId:7}]}})+'\n')})}),daemon=net.createServer(socket=>socket.end());
 await new Promise(r=>host.listen(path.join(runtime,instanceId+'.sock'),r));await new Promise(r=>daemon.listen(taskSocket,r));
 t.after(async()=>{await Promise.all([host,daemon].map(s=>new Promise(r=>s.close(r))));await fs.rm(dir,{recursive:true,force:true});await fs.rm(runtime,{recursive:true,force:true})});
 const run=async(args,flags=[])=>{const r=await command(process.execPath,[new URL('../src/cli.mjs',import.meta.url).pathname,'pw','--session',session,'--workspace',workspace,...flags,'--',...args],{cwd:workspace,env});return {...r,data:JSON.parse(r.out||r.err)}};
 let r=await run(['click','e1']);assert.equal(r.code,1);assert.equal(r.data.error.code,'SESSION_UNAVAILABLE');await assert.rejects(fs.access(calls),{code:'ENOENT'});
 await fs.writeFile(stateFile,JSON.stringify({...state,workspace:workspace+'-other'}));r=await run(['snapshot']);assert.equal(r.data.error.code,'SESSION_STALE');
 await fs.writeFile(stateFile,JSON.stringify(state));r=await run(['snapshot']);assert.equal(r.data.error.code,'DAEMON_IDENTITY_UNCONFIRMED');await assert.rejects(fs.access(calls),{code:'ENOENT'});
 r=await run(['snapshot'],['--transport','native']);assert.equal(r.data.error.code,'TRANSPORT_MISMATCH');await assert.rejects(fs.access(calls),{code:'ENOENT'});
 // daemonFile depends only on its configured base, so use the same base in this process.
 const prior=process.env.PWTEST_DAEMON_SESSION_DIR;process.env.PWTEST_DAEMON_SESSION_DIR=daemonRoot;const registry=daemonFile(workspace,session);prior===undefined?delete process.env.PWTEST_DAEMON_SESSION_DIR:process.env.PWTEST_DAEMON_SESSION_DIR=prior;
 await fs.mkdir(path.dirname(registry),{recursive:true});await fs.writeFile(registry,JSON.stringify({name:session,workspaceDir:workspace,attached:true,version:'0.1.20',timestamp:Date.now(),socketPath:taskSocket}));
 r=await run(['click','e1']);assert.equal(r.code,1);assert.equal(r.data.error.code,'PLAYWRIGHT_ERROR');assert.equal(r.data.error.diagnostics.exitCode,0);assert.match(r.data.error.diagnostics.upstreamError,/visible, enabled and stable/);
 const invoked=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(invoked.length,1);assert.deepEqual(invoked[0],{argv:['-s=test','--json','click','e1'],cwd:workspace});assert.deepEqual(JSON.parse(await fs.readFile(stateFile)),state);
 const evidence=path.join(workspace,'recorded');const captured=await command(process.execPath,[new URL('../src/cli.mjs',import.meta.url).pathname,'pw','--session',session,'--workspace',workspace,'--evidence-dir',evidence,'--step','zero-exit','--expect-error','PLAYWRIGHT_ERROR','--','click','e1'],{cwd:workspace,env});
 assert.equal(captured.code,1);const normalized=JSON.parse(captured.err);assert.equal(normalized.error.code,'PLAYWRIGHT_ERROR');assert.equal(normalized.error.evidence.checkStatus,'pass');
 const check=JSON.parse(await fs.readFile(path.join(evidence,'result.json'))).checks[0];assert.equal(check.operation.helperExitCode,1);assert.equal(check.operation.upstreamExitCode,0);assert.equal(check.operation.assertionExitCode,0);assert.equal(check.status,'pass');
});
