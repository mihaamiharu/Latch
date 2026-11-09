import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ledger,LIMITS} from './evidence-storage.mjs';
import {recordEvidence} from './evidence.mjs';
import {executeEvidenceAction} from './evidence-action.mjs';
import {resultValue} from './playwright.mjs';
import {fault} from '../extension/protocol.js';
import {regularFile,appendObservation,listRuns,boundRun,allocateRun,loadMeta,runPath,saveMeta,unbind,lockRun,indexArtifact,atomic,scrub} from './exploration-storage.mjs';
import {addStates,actionOf,describeAction,writeHandoff,finishIntegrity} from './exploration-model.mjs';

export const CAPTURE_SCRIPT=`async(page)=>{
 const identity=async p=>{const c=await p.context().newCDPSession(p);try{return (await c.send('Target.getTargetInfo')).targetInfo.targetId}finally{await c.detach()}};
 const dom=async frame=>frame.locator('input,button,a,textarea,select,[role],[data-testid],[data-test-id]').evaluateAll(els=>({total:els.length,nodes:els.slice(0,2000).map(el=>({tag:el.tagName.toLowerCase(),id:el.id||null,test_id:el.getAttribute('data-testid')||el.getAttribute('data-test-id'),test_id_attribute:el.hasAttribute('data-testid')?'data-testid':el.hasAttribute('data-test-id')?'data-test-id':null,name:el.getAttribute('name'),role:el.getAttribute('role'),label:el.getAttribute('aria-label')||(el.labels?[...el.labels].map(l=>l.textContent.trim()).join(' '):null),input_type:el.getAttribute('type')}))}));
 const currentTargetId=await identity(page);
 const pages=[];
 for(const p of page.context().pages()){
  try{
   const targetId=await identity(p),frames=[];const opener=await p.opener();const openerTargetId=opener?await identity(opener).catch(()=>null):null;
   for(const [i,frame] of p.frames().entries()){
    if(frame===p.mainFrame())continue;
    try{frames.push({id:'frame-'+i,name:frame.name(),url:frame.url(),snapshot:await frame.locator('body').ariaSnapshot({mode:'ai',timeout:3000}),dom:await dom(frame)})}
    catch{frames.push({id:'frame-'+i,url:frame.url(),error:'Frame snapshot unavailable'})}
   }
   pages.push({targetId,openerTargetId,viewport:await p.evaluate(()=>({width:innerWidth,height:innerHeight,device_scale:devicePixelRatio})),url:p.url(),title:await p.title(),snapshot:await p.ariaSnapshot({mode:'ai',timeout:5000}),dom:await dom(p),frames});
  }catch{}
 }
 return {currentTargetId,pages}
}`;
const id=prefix=>`${prefix}-${crypto.randomBytes(6).toString('hex')}`;
async function stopRequest(meta){try{return JSON.parse(await regularFile(path.join(await runPath(meta.id),'stop-request.json'),8192));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const selected=meta=>[...meta.states].reverse().find(s=>s.selected&&s.frame.id==='main');
const metaFlags=new Set(['objective','environment','data-ref','note','run','decision','destination','port','annotation-file','video']);
function cleanInvocation(inv){const flags={...inv.flags};for(const k of metaFlags)delete flags[k];return {...inv,flags};}
function internal(meta,args,step){return {command:'pw',captureTimeoutMs:15000,flags:{workspace:meta.workspace,session:meta.session,profile:meta.profile,'evidence-dir':null,step,inline:true},playwrightArgs:args};}
async function recorded(meta,inv,version,execute){const dir=await runPath(meta.id);return recordEvidence({...cleanInvocation(inv),flags:{...cleanInvocation(inv).flags,'evidence-dir':dir,inline:true}},version,execute);}
async function capture(meta,version,execute,{final=false,label='capture'}={}){
 const step=id(label);
 try{
  const response=await recorded(meta,{...internal(meta,['run-code',CAPTURE_SCRIPT],step),captureFinalization:final},version,execute),value=resultValue(response);
  if(!value||!Array.isArray(value.pages))throw fault('CAPTURE_INVALID','Capture returned no page inventory.');
  const beforePages=new Set(meta.states.map(s=>s.page));
  const result=await addStates(meta,value,{final,step});
  if(final)for(const page of beforePages)if(!value.pages.some(p=>p.targetId===page))meta.finals.push({page,state:[...meta.states].reverse().find(s=>s.page===page)?.id||null,status:'unavailable',reason:'Page closed or was unreachable at finish; last observed state retained.'});
  if(!value.pages.length)meta.gaps.push({step,reason:'No owned page could be captured.'});
  return result;
 }catch(e){meta.gaps.push({step,reason:'Snapshot capture failed',code:e.code||'CAPTURE_FAILED'});return null;}
}
async function startVideo(meta,version,execute){
 if(meta.videoRequested===false){meta.video={status:'disabled',clips:[],coverage:'Video explicitly disabled for this run.'};return;}
 const dir=await runPath(meta.id);await fs.mkdir(path.join(dir,'videos'),{recursive:true,mode:0o700});
 const startedAt=new Date().toISOString();
 try{if(meta.videoMode==='foreground')await recorded(meta,internal(meta,['run-code','async(page)=>page.bringToFront()'],id('video-focus')),version,execute);await recorded(meta,internal(meta,['video-start',path.join(dir,'videos','exploration.webm')],id('video-start')),version,execute);meta.video={status:'recording',mode:meta.videoMode||'on',startedAt,clips:[],page_mapping:'Per-page clips; mapping to page identities is not asserted.',coverage:'File finalization does not establish continuous/background frame coverage.'};}
 catch(e){meta.video={status:'unavailable',startedAt:null,clips:[],error:e.code||'VIDEO_START_FAILED'};meta.gaps.push({reason:'Video could not start',code:e.code||'VIDEO_START_FAILED'});}
}
async function stopVideo(meta,version,execute){
 if(meta.video.status!=='recording')return;
 try{
  const response=await recorded(meta,{...internal(meta,['video-stop'],id('video-stop')),captureFinalization:true},version,execute),result=String(resultValue(response)||'');
  const dir=await runPath(meta.id),clips=[],missing=[];
  for(const match of result.matchAll(/\[Video\]\(([^\n]+?)\)/g)){
   let link=match[1].replace(/^<|>$/g,'');try{link=decodeURIComponent(link)}catch{}
   const file=path.resolve(meta.workspace,link),relative=path.relative(dir,file);
   if(path.dirname(file)!==path.join(dir,'videos')||!/^exploration(?:-\d+)?\.webm$/.test(path.basename(file))){missing.push('Unexpected returned video path');continue;}
   try{
    // A closed page's encoder can flush after video-stop returns its path.
    for(let attempt=0;attempt<20;attempt++){try{await fs.stat(file);break;}catch(e){if(e.code!=='ENOENT'||attempt===19)throw e;await new Promise(r=>setTimeout(r,100));}}
    const signature=await fs.open(file,'r');try{const header=Buffer.alloc(4);await signature.read(header,0,4,0);if(header.toString('hex')!=='1a45dfa3')throw fault('VIDEO_INVALID','Not a WebM/Matroska recording.');}finally{await signature.close();}
    const a=await indexArtifact(meta,relative,'video');if(a.bytes<100)throw new Error('Empty recording');clips.push(relative);}catch(e){missing.push({path:relative,reason:e.code||'EMPTY_RECORDING'});}
  }
  meta.video={...meta.video,status:clips.length&&!missing.length?'complete':'partial',stoppedAt:new Date().toISOString(),clips,missing};
  if(!clips.length||missing.length)meta.gaps.push({reason:'Video has missing/empty clips; background or short-lived pages may not emit frames.',missing});
 }catch(e){meta.video={...meta.video,status:'partial',error:e.code||'VIDEO_STOP_FAILED'};meta.gaps.push({reason:'Video finalization failed; partial files retained',code:e.code||'VIDEO_STOP_FAILED'});}
}
async function mirrorRecorderArtifacts(meta){
 const dir=await runPath(meta.id);try{const result=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));for(const a of result.artifacts||[])if(a.valid!==false)await indexArtifact(meta,a.path,a.type);meta.cleanup=result.cleanup;}catch(e){meta.gaps.push({reason:'Recorder artifact indexing unavailable',code:e.code||'INDEX_FAILED'});}
}
async function persist(meta){await mirrorRecorderArtifacts(meta);await appendObservation(meta,{type:'summary',summary:{status:meta.status,video:meta.video,annotations:meta.annotations,gaps:meta.gaps,finals:meta.finals,cleanup:meta.cleanup,finishedAt:meta.finishedAt,pending:meta.pending||null},artifacts:meta.artifacts});await writeHandoff(meta);}
export async function finishRun(meta,version,execute,{disconnect=true}={}){
 // A forced Stop/closed tab can make captures fail. None of these paths repeat
 // application actions; disconnect is always attempted even if capture fails.
 try{await capture(meta,version,execute,{final:true,label:'final'});await stopVideo(meta,version,execute);}catch(e){meta.gaps.push({reason:'Final capture failed',code:e.code||'FINALIZE_FAILED'});}
 let result,error;
 if(disconnect)try{result=await recorded(meta,{command:'disconnect',flags:{session:meta.session,workspace:meta.workspace,profile:meta.profile,step:id('disconnect')}},version,execute);}catch(e){error=e;}
 meta.finishedAt=new Date().toISOString();meta.status=error?'interrupted':meta.gaps.length||!['complete','disabled'].includes(meta.video.status)?'partial':'finished';
 if(error)meta.gaps.push({reason:'Disconnect unconfirmed',code:error.code||'DISCONNECT_FAILED'});
 await persist(meta);await finishIntegrity(meta);if(!error)await unbind(meta);
 if(error){error.library={runId:meta.id,directory:await runPath(meta.id)};throw error;}
 return {...result,library:{runId:meta.id,directory:await runPath(meta.id),handoff:path.join(await runPath(meta.id),'exploration.yaml'),status:meta.status,video:meta.video.status,cleanup:meta.cleanup?.status,integrity:meta.integrity?.verified}};
}
export async function runExploration(invocation,version,execute=executeEvidenceAction){
 const inv=invocation,flags=inv.flags,core=cleanInvocation(inv);
 if(flags.video!==undefined&&(!['open','connect'].includes(inv.command)||!['on','off','foreground'].includes(flags.video)))throw fault('INVALID_ARGUMENT','Use --video on, foreground or off.');
 if(!['open','connect','pw','disconnect','checkpoint','finish'].includes(inv.command)||process.env.LATCH_CAPTURE==='off')return recordEvidence(core,version,execute);
 for(const [key,max]of [['objective',500],['environment',200],['data-ref',200],['note',8000]])if(flags[key]!==undefined&&(typeof flags[key]!=='string'||flags[key].length>max))throw fault('INVALID_ARGUMENT',`--${key} exceeds its supported length.`);
 const workspace=await fs.realpath(flags.workspace||process.cwd()),identity={workspace,session:flags.session,profile:flags.profile||'work'};
 if(!/^[a-zA-Z0-9_-]{1,40}$/.test(identity.profile))throw fault('INVALID_PROFILE','Use a simple profile alias.');
 if(!/^[a-zA-Z0-9_-]{1,60}$/.test(identity.session||''))return recordEvidence(core,version,execute);
 let binding=await boundRun(identity);
 if(flags['evidence-dir']&&!binding)return recordEvidence(core,version,execute); // Existing explicit recorder contract.
 if(binding&&flags['evidence-dir']&&path.resolve(flags['evidence-dir'])!==await runPath(binding.id))throw fault('EVIDENCE_IDENTITY_MISMATCH','This session already records into its central library run.');
 if(!binding&&!['open','connect'].includes(inv.command)){
  if(inv.command==='finish'){const prior=(await listRuns()).find(r=>r.workspace===workspace&&r.session===identity.session&&r.profile===identity.profile&&r.cleanup?.status==='confirmed');if(prior)return {finished:true,alreadyFinished:true,library:{runId:prior.id,handoff:path.join(await runPath(prior.id),'exploration.yaml'),status:prior.status}};}
  if(['finish','checkpoint'].includes(inv.command))throw fault('SESSION_UNAVAILABLE','No managed exploration is bound to this session.');
  return recordEvidence(core,version,execute);
 }
 let fresh=false,meta;
 if(!binding){meta=await allocateRun(identity,{objective:flags.objective,environment:flags.environment});binding={id:meta.id};fresh=true;meta.videoRequested=flags.video!=='off';meta.videoMode=flags.video||'on';await saveMeta(meta);}
 const operation=async()=>{
  meta=await loadMeta(binding.id);
  if(!fresh&&flags.video!==undefined&&flags.video!==(meta.videoMode||'on'))throw fault('SESSION_OPTIONS_CHANGED','Choose video mode when starting a new exploration.');
  if(inv.command==='pw'&&['video-start','video-stop'].includes(inv.playwrightArgs[0])&&meta.videoRequested!==false)throw fault('VIDEO_MANAGED','This exploration owns video recording. Use finish to finalize it, or start a new session with --video off for manual recording.');
  if(['finish','disconnect'].includes(inv.command))return finishRun(meta,version,execute);
  if(inv.command==='checkpoint'){
   await capture(meta,version,execute,{label:'checkpoint'});
   if(flags.note)meta.annotations.push({id:id('note'),kind:'finding',text:scrub(flags.note),evidence:meta.states.slice(-1).map(s=>s.snapshot),provenance:'agent_supplied',at:new Date().toISOString()});
   if(flags['annotation-file']){
    const annotation=JSON.parse(await regularFile(path.resolve(meta.workspace,flags['annotation-file']),16384));
    if(!['behavior','finding','prerequisite','test_data','question','coverage_gap'].includes(annotation.kind)||typeof (annotation.text||annotation.observed||annotation.reference)!=='string')throw fault('INVALID_ANNOTATION','Use a typed annotation with text, observed behavior or a test-data reference.');
    if(annotation.transition&&!meta.actions.some(a=>a.id===annotation.transition))throw fault('INVALID_ANNOTATION','Annotation transition does not exist.');
    const evidence=annotation.evidence||meta.states.slice(-1).map(s=>s.snapshot);
    if(!Array.isArray(evidence)||evidence.some(p=>!meta.artifacts.some(a=>a.path===p)))throw fault('INVALID_ANNOTATION','Use indexed evidence paths from this run.');
    const entry={id:id('annotation'),kind:annotation.kind,text:scrub(annotation.text||null),observed:scrub(annotation.observed||null),expected:scrub(annotation.expected??null),reference:scrub(annotation.reference||null),transition:annotation.transition||null,evidence,provenance:'agent_supplied',assertion_status:'not_asserted',at:new Date().toISOString()};
    meta.annotations.push(entry);
   }
   await persist(meta);return {checkpoint:true,library:{runId:meta.id,handoff:path.join(await runPath(meta.id),'exploration.yaml')}};
  }
  if(!fresh){const history=await ledger(await runPath(meta.id));if(history.events.filter(e=>e.event==='started').length>=LIMITS.commands-(meta.videoMode==='foreground'?5:4))throw fault('EXPLORATION_LIMIT','Finish this run before issuing more actions; capture capacity is reserved for final snapshots, video stop and disconnect. No new browser action was sent.');}
  // Preserve a durable attempt marker before browser work so interruption is
  // visible without trusting a last screenshot or trying the action again.
  const step=flags.step||id('action'),startedAt=new Date().toISOString(),before=selected(meta);
  meta.pending={step,startedAt,command:inv.command==='pw'?inv.playwrightArgs[0]:inv.command,from:before?.id||null,action:describeAction(inv,before)};await saveMeta(meta);
  let result,error;
  if(!fresh&&inv.command==='pw'&&meta.videoMode==='foreground')try{await recorded(meta,internal(meta,['run-code','async(page)=>page.bringToFront()'],id('video-focus')),version,execute);}catch(e){meta.gaps.push({step,reason:'Explicit foreground recording focus was unavailable',code:e.code});}
  try{result=await recorded(meta,{...inv,flags:{...flags,workspace,step}},version,execute);}catch(e){error=e;}
  if(fresh&&error){meta.status='start_failed';meta.gaps.push({reason:'Attachment/open failed; browser outcome may require inspection',code:error.code});delete meta.pending;await saveMeta(meta);try{await persist(meta);}catch{}await unbind(meta);error.library={runId:meta.id,status:'start_failed'};throw error;}
  if(fresh){meta.software={latch:version,extension:result.extensionVersion||null,playwright_cli:result.cliVersion||null,browser_build:'not_independently_verified'};meta.requestedStartURL=scrub(flags.url||null);meta.status='active';await startVideo(meta,version,execute);}
  const stateStart=meta.states.length;
  const stopped=await stopRequest(meta);
  const after=stopped?null:await capture(meta,version,execute,{label:fresh?'initial':'state'});
  if(stopped){meta.status='interrupted';meta.finishedAt=new Date().toISOString();meta.gaps.push({step,reason:'Stop/disconnect interrupted capture; no application action was replayed.'});if(stopped.confirmed)meta.cleanup={status:'confirmed',preservedUserTabs:true};}
  if(inv.command==='pw'){const action=actionOf(meta,inv,{step,before,after,error,startedAt});action.observed_states=meta.states.slice(stateStart).map(s=>s.id);await appendObservation(meta,{type:'action',action});}
  delete meta.pending;await persist(meta);
  const library={runId:meta.id,directory:await runPath(meta.id),handoff:path.join(await runPath(meta.id),'exploration.yaml'),video:meta.video.status,capture:meta.gaps.length?'partial':'active',gaps:meta.gaps.length};
  if(error){error.library=library;throw error;}
  return {...result,library};
 };
 // If an application call holds the library gate, disconnect still revokes the
 // exact browser lease immediately. Leave the bundle interrupted, never guess
 // at files an in-flight writer may be updating.
 if(['disconnect','finish'].includes(inv.command)){
  try{return await lockRun(binding.id,operation);}catch(e){if(e.code!=='EXPLORATION_BUSY')throw e;
   const dir=await runPath(binding.id);await atomic(path.join(dir,'stop-request.json'),JSON.stringify({requestedAt:new Date().toISOString(),confirmed:false}));
   const result=await execute({...core,command:'disconnect'});
   await atomic(path.join(dir,'stop-request.json'),JSON.stringify({requestedAt:new Date().toISOString(),confirmed:result.disconnected===true}));
   await unbind(await loadMeta(binding.id));
   return {...result,library:{runId:binding.id,status:'interrupted',finalization:'Command still in flight; rebuild offline after it exits.'}};}
 }
 return lockRun(binding.id,operation);
}
