import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {fault} from '../extension/protocol.js';
import {cliError, resultValue, CLI_META} from './playwright.mjs';
import {LIMITS, idPattern, digest, scrub, directory, regularFile, exclusive, atomic, append, readRun, ledger, artifact} from './evidence-storage.mjs';
import {renderEvidence} from './evidence-report.mjs';
import {ACTION_META} from './evidence-action.mjs';
import {ROOT} from './release.mjs';

const supported = new Set(['preflight','diagnose','doctor','tabs','connect','pw','release','disconnect']);
const blocked = /^(?:BRIDGE_|PROFILE_|CLI_UNAVAILABLE|UNSUPPORTED_VERSION|NATIVE_TRANSPORT_UNAVAILABLE|SESSION_|DAEMON_|TAB_UNAVAILABLE|INVALID_|EVIDENCE_)/;
const uncertain = /(?:CLI_TIMEOUT|CLI_OUTPUT_LARGE|CLI_RESPONSE_INVALID|CONNECTION|DISCONNECTED|TIMEOUT)/;
const uncertainError = error => uncertain.test(error?.code||'') || /TimeoutError|Target.*closed|Session.*closed|Connection closed|interrupted/i.test(error?.message||'');
function reportingFailure(error, phase, operationOutcome) {
  return Object.assign(fault('EVIDENCE_WRITE_FAILED','Evidence recording failed. Do not repeat a browser action to regenerate evidence; inspect the ledger and render offline when storage is available.'),
    {reporting:{phase,operationOutcome,cause:cliError(error),replayPermitted:false}});
}
async function init(dir, identity, contextFile) {
  try { await directory(dir); }
  catch (error) { if(error.code!=='ENOENT')throw error; await fs.mkdir(path.dirname(dir),{recursive:true,mode:0o700}); await fs.mkdir(dir,{mode:0o700}); }
  let run;
  try { run = await readRun(dir); }
  catch (error) {
    if(error.code!=='ENOENT')throw error;
    if((await fs.readdir(dir)).length)throw fault('EVIDENCE_DIRECTORY_FOREIGN','Choose an empty evidence directory or this task\'s existing Latch run.');
    let branch = null; try { branch=(await promisify(execFile)('git',['symbolic-ref','--short','HEAD'],{cwd:identity.workspace,timeout:2000,maxBuffer:4096})).stdout.trim(); } catch {}
    let context = {provenance:'unverified',value:null};
    if(contextFile)context={provenance:'agent-supplied',value:scrub(JSON.parse(await regularFile(path.resolve(contextFile),16384)))};
    let software={provenance:'unverified',sourceRevision:null};
    try{const data=await regularFile(path.join(ROOT,'release.json'),65536),descriptor=JSON.parse(data);software={provenance:'descriptor-reported',sourceRevision:descriptor.sourceRevision,descriptorSHA256:digest(data)}}
    catch(e){if(e.code==='ENOENT')try{const revision=(await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:ROOT,timeout:2000,maxBuffer:4096})).stdout.trim(),status=(await promisify(execFile)('git',['status','--porcelain'],{cwd:ROOT,timeout:2000,maxBuffer:65536})).stdout;software={provenance:'observed-source-checkout',sourceRevision:revision,dirty:!!status.trim()}}catch{}}
    run={schema:1,runId:crypto.randomUUID(),createdAt:new Date().toISOString(),...identity,branch,nodeVersion:process.version,platform:process.platform,architecture:process.arch,software,context};
    await exclusive(path.join(dir,'run.json'),JSON.stringify(run,null,2)+'\n');
    await fs.mkdir(path.join(dir,'raw'),{mode:0o700}); await fs.mkdir(path.join(dir,'screenshots'),{mode:0o700});
    await exclusive(path.join(dir,'commands.jsonl'),'');
  }
  if(run.workspace!==identity.workspace||run.session!==identity.session||run.profile!==identity.profile||run.releaseVersion!==identity.releaseVersion)
    throw fault('EVIDENCE_IDENTITY_MISMATCH','This evidence directory belongs to another workspace/session/profile or runtime release.');
  return run;
}
export function evidenceOptions({command,flags,playwrightArgs}) {
  const active = flags['evidence-dir'] !== undefined;
  const extra = ['step','expect-result','expect-error','check-kind','context-file','inline'];
  if(extra.some(k=>flags[k]!==undefined)&&!active)throw fault('INVALID_ARGUMENT','Evidence flags require --evidence-dir.');
  if(!active)return null;
  if(!supported.has(command))throw fault('INVALID_ARGUMENT','This command does not support evidence recording.');
  if(!idPattern.test(flags.session||''))throw fault('INVALID_SESSION','Evidence needs this task\'s explicit --session.');
  const step=flags.step||`${command}-${crypto.randomBytes(4).toString('hex')}`;
  if(!idPattern.test(step))throw fault('INVALID_ARGUMENT','Use a simple --step ID of at most 60 characters.');
  if(flags['expect-result']!==undefined&&flags['expect-error']!==undefined)throw fault('INVALID_ARGUMENT','Choose one expectation.');
  if((flags['expect-result']!==undefined||flags['expect-error']!==undefined||flags['check-kind']!==undefined)&&command!=='pw')throw fault('INVALID_ARGUMENT','Assertions belong to pw commands.');
  let expected=null;
  if(flags['expect-result']!==undefined){if(Buffer.byteLength(flags['expect-result'])>16384)throw fault('INVALID_ARGUMENT','Expected JSON is too large.');try{expected={result:JSON.parse(flags['expect-result'])}}catch{throw fault('INVALID_ARGUMENT','--expect-result must contain valid JSON.')}}
  if(flags['expect-error']!==undefined){if(!/^[A-Z][A-Z0-9_]{0,79}$/.test(flags['expect-error']))throw fault('INVALID_ARGUMENT','Use a structured error code.');expected={error:flags['expect-error']};}
  const kind=flags['check-kind']||(expected?.error?'adapter':expected?'application':command==='pw'?['snapshot','screenshot'].includes(playwrightArgs[0])?'capture':'operation':'infrastructure');
  if(!['application','adapter','environment','capture','operation','infrastructure'].includes(kind))throw fault('INVALID_ARGUMENT','Unknown evidence check kind.');
  if(flags['check-kind']&&!expected)throw fault('INVALID_ARGUMENT','--check-kind requires an explicit expectation.');
  if(command==='pw'&&['snapshot','screenshot'].includes(playwrightArgs[0])&&playwrightArgs.some(a=>a==='--filename'||a.startsWith('--filename=')))
    throw fault('INVALID_ARGUMENT','Evidence-managed snapshot/screenshot supplies its own fresh filename. Omit --filename.');
  return {dir:path.resolve(flags['evidence-dir']),step,expected,kind};
}
function observation(command, result, error, expected) {
  const failureStatus=error?(blocked.test(error.code||'')?'blocked':uncertainError(error)?'unknown':'fail'):'fail';
  if(expected?.error)return {status:error?.code===expected.error?'pass':failureStatus,observed:{error:error?.code||null}};
  if(expected&&Object.hasOwn(expected,'result'))return {status:error?failureStatus:isDeepStrictEqual(resultValue(result),expected.result)?'pass':'fail',observed:error?{error:error.code}:scrub(resultValue(result))};
  if(error)return {status:failureStatus,observed:{error:error.code||'BROWSER_ERROR'}};
  if(command==='connect')return {status:result.connected===true?'pass':'unknown',observed:{connected:result.connected,transport:result.transport,focusEmulation:result.focusEmulation??null}};
  if(command==='disconnect')return {status:result.disconnected===true?'pass':'unknown',observed:{disconnected:result.disconnected,preservedUserTabs:result.preservedUserTabs}};
  if(command==='preflight')return {status:result.ready?'pass':'blocked',observed:{ready:result.ready}};
  if(command==='diagnose'||command==='doctor')return {status:result.healthy===false?'blocked':'pass',observed:{healthy:result.healthy??null}};
  return {status:'unknown',observed:'Command completed; no application assertion was supplied.'};
}
function bounded(value, maximum=4096) {
  if(value===undefined)return null;
  const cleaned=scrub(value), data=JSON.stringify(cleaned);
  return Buffer.byteLength(data)>maximum?{truncated:true,originalBytes:Buffer.byteLength(data),preview:data.slice(0,512)}:cleaned;
}
export async function recordEvidence(invocation, releaseVersion, execute) {
  const options=evidenceOptions(invocation);
  if(!options)return execute(invocation);
  const {command,flags,playwrightArgs}=invocation,{dir,step,expected,kind}=options;
  const sensitive=command==='pw'&&/^(cookie-|state-|localstorage-|sessionstorage-)/.test(playwrightArgs[0]);
  const workspace=await fs.realpath(flags.workspace||process.cwd());
  const lock=path.join(dir,'active-command');
  let run, acquired=false, started=false, preparationError, capture;
  let forwarded=invocation;
  try {
    run=await init(dir,{workspace,session:flags.session,profile:flags.profile||'work',releaseVersion},flags['context-file']);
    // Disconnect must remain possible while another action is held or storage
    // is damaged. It does not acquire the recorder's application-command gate.
    if(command!=='disconnect'){try{await fs.mkdir(lock,{mode:0o700});acquired=true}catch(e){if(e.code==='EEXIST')throw fault('EVIDENCE_BUSY','Another recorded command is active or unfinished. Preserve its gate; report offline and disconnect separately.');throw e}}
    const history=await ledger(dir), starts=history.events.filter(e=>e.event==='started');
    if(starts.some(e=>e.step===step))throw fault('EVIDENCE_STEP_EXISTS','Step IDs cannot be replayed or overwritten. Inspect the original outcome.');
    if(starts.length>=LIMITS.commands-(command==='disconnect'?0:1))throw fault('EVIDENCE_LIMIT','This run reached its command limit. Disconnect and preserve the evidence.');
    if(command==='connect'&&history.events.some(e=>e.cleanup?.confirmed))throw fault('EVIDENCE_RUN_CLOSED','Use a fresh session/evidence directory for a new connected run.');
    const used=history.events.flatMap(e=>e.artifacts||[]).reduce((n,a)=>n+a.bytes,0);
    if(used>LIMITS.totalBytes-LIMITS.artifactBytes-LIMITS.textBytes&&command!=='disconnect')throw fault('EVIDENCE_LIMIT','Evidence budget is exhausted; no browser action was attempted.');
    if(command==='pw'&&['snapshot','screenshot'].includes(playwrightArgs[0])) {
      const screenshot=playwrightArgs[0]==='screenshot';capture={path:`${screenshot?'screenshots':'raw'}/${step}.${screenshot?'png':'yaml'}`,type:screenshot?'screenshot':'snapshot'};
      await fs.lstat(path.join(dir,capture.path)).then(()=>{throw fault('EVIDENCE_FILE_EXISTS','A capture already exists at this step path.');},e=>{if(e.code!=='ENOENT')throw e});
      forwarded={...invocation,playwrightArgs:[...playwrightArgs,'--filename='+path.join(dir,capture.path)]};
    }
    await append(dir,{schema:1,event:'started',runId:run.runId,step,at:new Date().toISOString(),command:command==='pw'?playwrightArgs[0]:command,
      kind,expected:sensitive?{redacted:true}:bounded(expected),argumentCount:playwrightArgs?.length||0,argumentSHA256:playwrightArgs?digest(JSON.stringify(playwrightArgs)):null});
    started=true;
  } catch(error) {
    if(acquired){await fs.rmdir(lock);acquired=false;}
    if(command!=='disconnect')throw error.code?.startsWith('EVIDENCE_')?error:reportingFailure(error,'before-operation','not-attempted');
    preparationError=error;
  }
  let result,error,assertion,summary;
  try {
    try { result=await execute(forwarded); } catch(e) {error=e;}
    assertion=observation(command,result,error,expected);
    if(sensitive)assertion.observed='Storage values excluded; any explicit comparison was executed locally.';
    if(assertion.status==='fail'&&!error&&expected)error=Object.assign(fault('ASSERTION_FAILED','The command completed but its explicit expected result did not match.'),{assertionOnly:true});
    if(preparationError)throw reportingFailure(preparationError,'before-cleanup-recording',error?'unknown':'succeeded');
    const artifacts=[], rawName=`raw/${step}.json`, raw=JSON.stringify(bounded({result:sensitive?{redacted:true,reason:'Browser storage output is excluded from recorded evidence.'}:result,error:error?sensitive?{code:error.code,message:'Storage command details excluded.'}:cliError(error):null},LIMITS.textBytes))+'\n';
    await exclusive(path.join(dir,rawName),raw);artifacts.push(await artifact(dir,rawName,'command-output',LIMITS.textBytes+1024));
    if(capture) {
      try {
        if(capture.type==='snapshot') {
          const original=await regularFile(path.join(dir,capture.path),LIMITS.artifactBytes), cleaned=scrub(original.toString('utf8'));
          await atomic(path.join(dir,capture.path),cleaned);
        }
        const indexed=await artifact(dir,capture.path,capture.type);
        if(!error&&capture.type==='screenshot'){
          const data=await regularFile(path.join(dir,capture.path),LIMITS.artifactBytes);
          if(data.length<24||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fault('EVIDENCE_CAPTURE_INVALID','The screenshot command did not produce a valid PNG header.');
        }
        if(!error&&indexed.bytes===0)throw fault('EVIDENCE_CAPTURE_INVALID','The capture was empty.');
        artifacts.push({...indexed,complete:!error});
        if(!error&&!expected){assertion.status='pass';assertion.observed={capture: capture.path,bytes:indexed.bytes,application:'not-asserted'};}
      } catch(e) {if(!error)throw e;}
    }
    const toolError=error&&!error.assertionOnly;
    const operation={outcome:toolError?(uncertainError(error)?'unknown':'failed'):'succeeded',
      helperExitCode:result?.[ACTION_META]?.exitCode??error?.[ACTION_META]?.exitCode??null,
      helperSignal:result?.[ACTION_META]?.signal??error?.[ACTION_META]?.signal??null,
      assertionExitCode:assertion.status==='pass'?0:assertion.status==='fail'?1:null,normalizedToolExitCode:toolError?1:0,
      upstreamExitCode:result?.[CLI_META]?.exitCode??error?.diagnostics?.exitCode??null,
      upstreamSignal:result?.[CLI_META]?.signal??error?.diagnostics?.signal??null};
    await append(dir,{schema:1,event:'finished',runId:run.runId,step,at:new Date().toISOString(),operation,check:{...assertion,observed:bounded(assertion.observed)},artifacts,
      ...(command==='connect'&&!error?{connection:bounded({connected:result.connected,transport:result.transport,transportSource:result.transportSource,focusEmulation:result.focusEmulation??null,cliVersion:result.cliVersion??null,extensionVersion:result.extensionVersion??null,extensionRelease:result.extensionRelease??null,tabId:result.tabId,page:result.page||null})}:{}),
      ...(command==='disconnect'?{cleanup:{confirmed:!error&&result.disconnected===true,preservedUserTabs:result?.preservedUserTabs??null}}:{})});
    summary=await renderEvidence(dir,{verifyArtifacts:command==='disconnect'});
    if(error){error.evidence={...summary,step,checkStatus:assertion.status};throw error;}
    return flags.inline?{...result,evidence:{...summary,step,checkStatus:assertion.status}}:
      {session:flags.session,operation,check:{id:step,status:assertion.status,observed:bounded(assertion.observed,512)},evidence:summary};
  } catch(failure) {
    if(failure===error)throw failure;
    const problem=failure.code==='EVIDENCE_WRITE_FAILED'?failure:reportingFailure(failure,started?'after-operation':'before-operation',error&&!error.assertionOnly?'unknown':'succeeded');
    if(error){error.reporting=problem.reporting;throw error;}
    throw problem;
  } finally {
    if(acquired)await fs.rmdir(lock).catch(()=>{});
  }
}
