import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {recordEvidence} from '../src/evidence.mjs';
import {inspectEvidence,renderEvidence} from '../src/evidence-report.mjs';
import {CLI_META} from '../src/playwright.mjs';
import {exportEvidence} from '../src/evidence-export.mjs';
import {LIMITS,scrub} from '../src/evidence-storage.mjs';
import {executeEvidenceAction} from '../src/evidence-action.mjs';
import {fault} from '../extension/protocol.js';
import {eventually} from './helpers/native-browser.mjs';

async function fixture(t) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'latch-recorder-')),dir=path.join(workspace,'work/latch/run');
  const prevCeiling=process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES=os.tmpdir();
  t.after(async()=>{prevCeiling===undefined?delete process.env.GIT_CEILING_DIRECTORIES:process.env.GIT_CEILING_DIRECTORIES=prevCeiling;await fs.rm(workspace,{recursive:true,force:true});});
  const invoke=(command,step,extra={})=>({command,flags:{session:'agent',profile:'work',workspace,'evidence-dir':dir,step,...extra},...(command==='pw'?{playwrightArgs:['run-code','async(page)=>page.title()']}: {})});
  const run=(command,step,operation,extra={})=>recordEvidence(invoke(command,step,extra),'test-release',operation);
  return {workspace,dir,invoke,run};
}
test('assertions, intentional tool errors, actual process metadata, redaction and cleanup are independently reported',async t=>{
  const f=await fixture(t);await f.run('connect','attach',async()=>({connected:true,transport:'native',focusEmulation:true,page:{url:'https://example.test',title:'Example'}}));
  const response=await f.run('pw','assert-title',async()=>({result:'Example',[CLI_META]:{exitCode:0}}),{'expect-result':'"Example"'});
  assert.equal(response.check.status,'pass');assert.equal(response.result,undefined);
  await assert.rejects(f.run('pw','expected-error',async()=>{throw Object.assign(fault('PLAYWRIGHT_ERROR','Bearer sensitive_token\nCookie: private=value'),{diagnostics:{exitCode:0,upstreamError:'ws://127.0.0.1/secret'}})}, {'expect-error':'PLAYWRIGHT_ERROR'}),e=>e.code==='PLAYWRIGHT_ERROR'&&e.evidence.checkStatus==='pass');
  await f.run('pw','credentials',async()=>({result:JSON.stringify({authorization:'Bearer never_export',cookie:'session=secret',token:'sensitive',url:'https://example.test/?access_token=private'})}));
  await f.run('disconnect','cleanup',async()=>({disconnected:true,preservedUserTabs:true}));
  const result=await inspectEvidence(f.dir);assert.equal(result.outcome,'pass');assert.equal(result.cleanup.status,'confirmed');assert.equal(result.integrity.verified,true);
  assert.equal(result.run.branch,null);assert.equal(result.run.context.provenance,'unverified');
  const negative=result.checks.find(c=>c.id==='expected-error');assert.equal(negative.operation.assertionExitCode,0);assert.equal(negative.operation.upstreamExitCode,0);assert.equal(negative.status,'pass');
  for(const name of ['commands.jsonl','result.json','report.md',...result.artifacts.map(a=>a.path)])assert.doesNotMatch(await fs.readFile(path.join(f.dir,name),'utf8'),/sensitive_token|private=value|never_export|session=secret|127\.0\.0\.1\/secret|access_token=private/);
  const report=await fs.readFile(path.join(f.dir,'report.md'),'utf8');assert.match(report,/\[assert-title.json\]\(raw\/assert-title.json\)/);
});
test('a successful action with a mismatched assertion exits as an assertion failure without replay',async t=>{
  const f=await fixture(t);let actions=0;
  await assert.rejects(f.run('pw','wrong-result',async()=>{actions++;return {result:'actual',[CLI_META]:{exitCode:0}}},{'expect-result':'"expected"'}),{code:'ASSERTION_FAILED'});
  const result=await inspectEvidence(f.dir);assert.equal(actions,1);assert.equal(result.applicationOutcome,'fail');assert.equal(result.checks[0].operation.normalizedToolExitCode,0);assert.equal(result.checks[0].operation.assertionExitCode,1);assert.equal(result.cleanup.status,'unconfirmed');
  await assert.rejects(f.run('pw','wrong-result',async()=>{actions++;return {result:'expected'}}),{code:'EVIDENCE_STEP_EXISTS'});assert.equal(actions,1);
});
test('fresh screenshots/snapshots use tested filename syntax once, preserve original images and verify hashes offline',async t=>{
  const f=await fixture(t),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]);let captures=0;
  for(const type of ['screenshot','snapshot']){
    const invocation={...f.invoke('pw',type),playwrightArgs:[type]};
    await recordEvidence(invocation,'test-release',async forwarded=>{captures++;assert.equal(forwarded.playwrightArgs.length,2);assert.match(forwarded.playwrightArgs[1],/^--filename=/);const file=forwarded.playwrightArgs[1].slice(11);await fs.writeFile(file,type==='screenshot'?png:'heading: Example\nCookie: sensitive\n');return {result:'saved',[CLI_META]:{exitCode:0}}});
  }
  assert.equal(captures,2);assert.deepEqual(await fs.readFile(path.join(f.dir,'screenshots/screenshot.png')),png);
  assert.match(await fs.readFile(path.join(f.dir,'report.md'),'utf8'),/!\[screenshot.png\]\(screenshots\/screenshot.png\)/);
  await fs.appendFile(path.join(f.dir,'raw/snapshot.yaml'),'changed');const result=await inspectEvidence(f.dir);assert.equal(result.integrity.verified,false);assert.equal(result.integrity.problems[0].code,'EVIDENCE_HASH_CHANGED');
  await renderEvidence(f.dir);assert.equal(captures,2);
});
test('timeout and cleanup failure retain unknown application outcome and separate failed cleanup',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run('pw','timeout',async()=>{throw fault('CLI_TIMEOUT','The action response was lost.')}),{code:'CLI_TIMEOUT'});
  await assert.rejects(f.run('disconnect','cleanup',async()=>{throw fault('BRIDGE_ACCESS_DENIED','EPERM')}),{code:'BRIDGE_ACCESS_DENIED'});
  const result=await inspectEvidence(f.dir);assert.equal(result.checks[0].operation.outcome,'unknown');assert.equal(result.applicationOutcome,'unknown');assert.equal(result.cleanup.status,'failed');
});
test('a lost page context leaves the action outcome unknown, while an ordinary page error stays failed',async t=>{
  const f=await fixture(t);
  for(const [step,message] of [['context','page.evaluate: Execution context was destroyed, most likely because of a navigation'],['frame','locator.click: frame was detached']])
    await assert.rejects(f.run('pw',step,async()=>{throw fault('PLAYWRIGHT_ERROR',message)}),{code:'PLAYWRIGHT_ERROR'});
  await assert.rejects(f.run('pw','ordinary',async()=>{throw fault('PLAYWRIGHT_ERROR','page.evaluate: Error: LATCH_EXPECTED_FAILURE')}),{code:'PLAYWRIGHT_ERROR'});
  const {checks}=await inspectEvidence(f.dir);assert.deepEqual(checks.map(c=>c.operation.outcome),['unknown','unknown','failed']);
});
test('report-write failure preserves completed action evidence and can be repaired without replay',async t=>{
  const f=await fixture(t);let actions=0;const rename=fs.rename.bind(fs);let failed=false;
  const mock=t.mock.method(fs,'rename',async(a,b)=>{if(b===path.join(f.dir,'result.json')&&!failed){failed=true;throw Object.assign(new Error('disk full fixture'),{code:'ENOSPC'})}return rename(a,b)});
  await assert.rejects(f.run('pw','once',async()=>{actions++;return {result:'saved'}}),e=>e.code==='EVIDENCE_WRITE_FAILED'&&e.reporting.operationOutcome==='succeeded'&&e.reporting.replayPermitted===false);
  mock.mock.restore();const report=await renderEvidence(f.dir);assert.equal(actions,1);assert.equal(report.checks,1);assert.equal((await inspectEvidence(f.dir)).checks[0].operation.outcome,'succeeded');
});
test('storage denial before an action prevents it, but cannot prevent explicitly requested cleanup',async t=>{
  const f=await fixture(t);await fs.mkdir(f.dir,{recursive:true});await fs.writeFile(path.join(f.dir,'foreign'),'preserve');let actions=0,cleanups=0;
  await assert.rejects(f.run('pw','blocked',async()=>{actions++}),{code:'EVIDENCE_DIRECTORY_FOREIGN'});assert.equal(actions,0);
  await assert.rejects(f.run('disconnect','cleanup',async()=>{cleanups++;return {disconnected:true}}),e=>e.code==='EVIDENCE_WRITE_FAILED'&&e.reporting.operationOutcome==='succeeded');
  assert.equal(cleanups,1);assert.equal(await fs.readFile(path.join(f.dir,'foreign'),'utf8'),'preserve');
});
test('separate tasks cannot mix evidence; parallel recording cannot block normal disconnect',async t=>{
  const f=await fixture(t);let resume;const holding=f.run('pw','held',async()=>{await new Promise(r=>resume=r);return {result:'done'}});
  await eventually(()=>!!resume);
  await assert.rejects(f.run('pw','parallel',async()=>{throw new Error('must not run')}),{code:'EVIDENCE_BUSY'});
  const other={...f.invoke('pw','other'),flags:{...f.invoke('pw','other').flags,session:'peer'}};
  await assert.rejects(recordEvidence(other,'test-release',async()=>{throw new Error('must not run')}),{code:'EVIDENCE_IDENTITY_MISMATCH'});
  await f.run('disconnect','cleanup',async()=>({disconnected:true,preservedUserTabs:true}));resume();await holding;
  const result=await inspectEvidence(f.dir);assert.equal(result.cleanup.status,'confirmed');assert.equal(result.checks.length,2);
});
test('process interruption leaves a durable unfinished step, offline report and independent cleanup',async t=>{
  const f=await fixture(t),script=path.join(f.workspace,'interrupt.mjs'),marker=path.join(f.workspace,'action-entered');
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {recordEvidence} from ${JSON.stringify(new URL('../src/evidence.mjs',import.meta.url).href)};setTimeout(()=>process.exit(99),10000);await recordEvidence(${JSON.stringify(f.invoke('pw','interrupted'))},'test-release',async()=>{await fs.writeFile(${JSON.stringify(marker)},'entered');await new Promise(()=>{})});`);
  const child=spawn(process.execPath,[script],{stdio:'ignore'});const ended=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});
  // Keep the process alive while its synthetic action is pending.
  await eventually(()=>fs.access(marker).then(()=>true,()=>false));assert.equal(child.kill('SIGKILL'),true);assert.equal((await ended).signal,'SIGKILL');
  const report=await renderEvidence(f.dir);assert.equal(report.outcome,'unknown');assert.equal((await inspectEvidence(f.dir)).checks[0].operation.helperExitCode,null);
  await f.run('disconnect','cleanup',async()=>({disconnected:true,preservedUserTabs:true}));assert.equal((await inspectEvidence(f.dir)).cleanup.status,'confirmed');
  await assert.rejects(fs.stat(path.join(f.dir,'active-command')).then(()=>{throw fault('PRESERVED','preserved')}),{code:'PRESERVED'});
});
test('inline data stays bounded, truncation is explicit and supplied client claims keep their provenance',async t=>{
  const f=await fixture(t),context=path.join(f.workspace,'context.json');await fs.writeFile(context,JSON.stringify({client:'Example CLI',permissions:{value:'workspace-write',provenance:'directly-observed'}}));
  const response=await f.run('pw','large',async()=>({result:'x'.repeat(LIMITS.textBytes+100)}),{'context-file':context});
  assert.ok(JSON.stringify(response).length<4096);const raw=JSON.parse(await fs.readFile(path.join(f.dir,'raw/large.json')));assert.equal(raw.truncated,true);assert.ok(raw.originalBytes>LIMITS.textBytes);
  assert.equal((await inspectEvidence(f.dir)).run.context.provenance,'agent-supplied');
});
test('recognized headers and browser storage values never enter persisted evidence, including assertion values',async t=>{
  assert.equal(scrub({name:'Set-Cookie',value:'private_cookie'}).value,'[redacted]');
  const f=await fixture(t),invocation={...f.invoke('pw','storage',{'expect-result':'[{"name":"sid","value":"private_cookie"}]'}),playwrightArgs:['cookie-list']};
  await recordEvidence(invocation,'test-release',async()=>({result:JSON.stringify([{name:'sid',value:'private_cookie'}])}));
  for(const name of ['run.json','commands.jsonl','result.json','report.md','raw/storage.json'])assert.doesNotMatch(await fs.readFile(path.join(f.dir,name),'utf8'),/private_cookie/);
});
test('selective export includes only chosen verified artifacts and check metadata, without replay or overwrite',async t=>{
  const f=await fixture(t);await f.run('pw','selected',async()=>({result:'selected-value'}),{'expect-result':'"selected-value"'});
  await f.run('pw','private',async()=>({result:'unselected-private-value'}),{'expect-result':'"unselected-private-value"'});
  const target=path.join(f.workspace,'export');const result=await exportEvidence({directory:f.dir,destination:target,include:['raw/selected.json']});assert.equal(result.selectedArtifacts,1);
  assert.deepEqual((await fs.readdir(target)).sort(),['export.json','raw','report.md','sha256.json']);assert.deepEqual(await fs.readdir(path.join(target,'raw')),['selected.json']);
  const exported=await fs.readFile(path.join(target,'export.json'),'utf8');assert.doesNotMatch(exported,/unselected-private-value|workspace/);
  await assert.rejects(exportEvidence({directory:f.dir,destination:target,include:['raw/selected.json']}),{code:'EEXIST'});
  await fs.appendFile(path.join(f.dir,'raw/selected.json'),'bad');await assert.rejects(exportEvidence({directory:f.dir,destination:target+'2',include:['raw/selected.json']}),{code:'EVIDENCE_INTEGRITY_FAILED'});
});
test('unsafe captures fail without modifying the linked file and leave a truthful post-action reporting failure',async t=>{
  const f=await fixture(t),privateFile=path.join(f.workspace,'keep');await fs.writeFile(privateFile,'private unchanged');
  const invocation={...f.invoke('pw','capture'),playwrightArgs:['snapshot']};let actions=0;
  await assert.rejects(recordEvidence(invocation,'test-release',async forwarded=>{actions++;const target=forwarded.playwrightArgs[1].slice(11);try{await fs.symlink(privateFile,target)}catch(e){if(e.code==='EPERM')await fs.symlink(f.workspace,target,'junction');else throw e}return {result:'saved'}}),e=>e.code==='EVIDENCE_WRITE_FAILED'&&e.reporting.operationOutcome==='succeeded');
  assert.equal(actions,1);assert.equal(await fs.readFile(privateFile,'utf8'),'private unchanged');assert.equal((await inspectEvidence(f.dir)).checks[0].status,'unknown');
});
test('report failure retains the actually observed action-helper exit independently of recording failure',async t=>{
  const f=await fixture(t),previous=process.env.LATCH_CONFIG;process.env.LATCH_CONFIG=path.join(f.workspace,'missing-config.json');
  t.after(()=>{previous===undefined?delete process.env.LATCH_CONFIG:process.env.LATCH_CONFIG=previous});
  const rename=fs.rename.bind(fs);let injected=false;
  const mock=t.mock.method(fs,'rename',async(a,b)=>{if(b===path.join(f.dir,'result.json')&&!injected){injected=true;throw Object.assign(new Error('disk full after helper exit'),{code:'ENOSPC'})}return rename(a,b)});
  await assert.rejects(f.run('diagnose','observed-exit',executeEvidenceAction),e=>e.code==='EVIDENCE_WRITE_FAILED'&&e.reporting.operationOutcome==='succeeded');
  mock.mock.restore();await renderEvidence(f.dir);const result=await inspectEvidence(f.dir);assert.equal(result.checks[0].operation.helperExitCode,0);assert.equal(result.checks[0].operation.upstreamExitCode,null);assert.equal(result.checks[0].status,'blocked');
});
test('routine steps do not reread prior image payloads; explicit offline verification does',async t=>{
  const f=await fixture(t),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]),invocation={...f.invoke('pw','image'),playwrightArgs:['screenshot']};
  await recordEvidence(invocation,'test-release',async forwarded=>{await fs.writeFile(forwarded.playwrightArgs[1].slice(11),png);return {result:'saved'}});
  const open=fs.open.bind(fs);let reads=0;t.mock.method(fs,'open',async(file,...args)=>{if(file===path.join(f.dir,'screenshots/image.png'))reads++;return open(file,...args)});
  await f.run('pw','later',async()=>({result:'small'}));assert.equal(reads,0);assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'result.json'))).integrity.verified,null);
  await renderEvidence(f.dir);assert.equal(reads,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'result.json'))).integrity.verified,true);
});
test('command budget stops new actions and reserves one durable cleanup slot',async t=>{
  const f=await fixture(t);await f.run('pw','bootstrap',async()=>({result:'ready'}));
  const file=path.join(f.dir,'commands.jsonl'),events=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  for(let i=1;i<LIMITS.commands-1;i++)events.push({...events[0],step:'fixture-'+i},{...events[1],step:'fixture-'+i,artifacts:[]});
  await fs.writeFile(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');let actions=0;
  await assert.rejects(f.run('pw','over-budget',async()=>{actions++}),{code:'EVIDENCE_LIMIT'});assert.equal(actions,0);
  await f.run('disconnect','cleanup',async()=>({disconnected:true,preservedUserTabs:true}));const result=await inspectEvidence(f.dir);assert.equal(result.checks.length,LIMITS.commands);assert.equal(result.cleanup.status,'confirmed');
});
test('partial ledger and oversized captures stay inspectable without replay or silent repair',async t=>{
  const f=await fixture(t);await f.run('pw','first',async()=>({result:'ready'}));const file=path.join(f.dir,'commands.jsonl');
  await fs.appendFile(file,'{"partial":');const original=await fs.readFile(file);let actions=0;
  const report=await renderEvidence(f.dir);assert.equal(report.integrity,false);
  await assert.rejects(f.run('pw','next',async()=>{actions++}),{code:'EVIDENCE_LEDGER_PARTIAL'});assert.equal(actions,0);assert.deepEqual(await fs.readFile(file),original);
  const other=await fixture(t),invocation={...other.invoke('pw','oversized'),playwrightArgs:['snapshot']};
  await assert.rejects(recordEvidence(invocation,'test-release',async forwarded=>{const handle=await fs.open(forwarded.playwrightArgs[1].slice(11),'wx');await handle.truncate(LIMITS.artifactBytes+1);await handle.close();return {result:'saved'}}),e=>e.code==='EVIDENCE_WRITE_FAILED'&&e.reporting.operationOutcome==='succeeded');
  assert.equal((await fs.stat(path.join(other.dir,'raw/oversized.yaml'))).size,LIMITS.artifactBytes+1);assert.equal((await inspectEvidence(other.dir)).checks[0].status,'unknown');
});
test('an invalid profile cannot create an unreadable evidence identity or dispatch an action',async t=>{
  const f=await fixture(t);let actions=0;
  await assert.rejects(f.run('pw','invalid-profile',async()=>{actions++},{profile:'invalid profile'}),{code:'INVALID_PROFILE'});
  assert.equal(actions,0);await assert.rejects(fs.stat(f.dir),{code:'ENOENT'});
});
