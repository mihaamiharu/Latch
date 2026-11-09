import fs from 'node:fs/promises';
import path from 'node:path';
import {fault} from '../extension/protocol.js';
import {atomic,indexArtifact,runPath,saveMeta,scrub,verifyArtifacts,appendObservation} from './exploration-storage.mjs';

// Emission only: observations are validated JSON records, never executable YAML.
export function yaml(value,level=0){
 const pad=' '.repeat(level);
 if(Array.isArray(value)){if(!value.length)return '[]';return value.map(v=>typeof v==='object'&&v!==null?`${pad}-\n${yaml(v,level+2)}`:`${pad}- ${JSON.stringify(v)}`).join('\n');}
 if(value&&typeof value==='object'){const entries=Object.entries(value).filter(([,v])=>v!==undefined);if(!entries.length)return pad+'{}';return entries.map(([k,v])=>{const key=/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)?k:JSON.stringify(k);return v&&typeof v==='object'&&Object.keys(v).length?`${pad}${key}:\n${yaml(v,level+2)}`:`${pad}${key}: ${JSON.stringify(v)}`;}).join('\n');}
 return pad+JSON.stringify(value);
}
export function elementsOf(snapshot,frame='main'){
 const elements=[];
 for(const line of snapshot.split('\n')){
  const m=line.match(/^\s*-\s+([a-z][a-z0-9_-]*)(?:\s+("(?:[^"\\]|\\.)*"))?[^\n]*?\[ref=([^\]]+)\]/i);
  if(!m)continue;let name=null;if(m[2])try{name=JSON.parse(m[2]);}catch{}
  const candidate=name&&m[1]!=='generic'?{strategy:'role',role:m[1],name,exact:true}:null;
  elements.push({snapshot_ref:m[3],frame,role:m[1],name,locator_candidate:candidate,
   observed_flags:['disabled','checked','expanded','selected'].filter(f=>line.includes(`[${f}]`)),provenance:'snapshot'});
 }
 for(const e of elements)e.ambiguous=!!e.locator_candidate&&elements.filter(x=>x.role===e.role&&x.name===e.name).length>1;
 return elements;
}
export function validateExploration(graph){
 if(graph.schema_version!==1||!graph.run_id||!Array.isArray(graph.states)||!Array.isArray(graph.transitions))throw fault('EXPLORATION_SCHEMA_INVALID','Invalid exploration schema.');
 const ids=new Set();for(const state of graph.states){if(!state.id||ids.has(state.id)||!/^snapshots\/[a-zA-Z0-9_-]+\.yaml$/.test(state.snapshot||'')||!state.page||!/^[a-f0-9]{64}$/.test(state.sha256||'')||!Array.isArray(state.elements))throw fault('EXPLORATION_SCHEMA_INVALID','State identity/path is invalid.');ids.add(state.id);}
 const steps=new Set();for(const t of graph.transitions){if(!t.id||steps.has(t.id)||t.from&&!ids.has(t.from)||t.to&&!ids.has(t.to))throw fault('EXPLORATION_SCHEMA_INVALID','Transition points to a missing state.');steps.add(t.id);if((t.observed_states||[]).some(id=>!ids.has(id)))throw fault('EXPLORATION_SCHEMA_INVALID','Transition observation state is missing.');if(t.action?.target?.state&&!ids.has(t.action.target.state))throw fault('EXPLORATION_SCHEMA_INVALID','Locator state is missing.');}
 for(const f of graph.final_states)if(f.state&&!ids.has(f.state))throw fault('EXPLORATION_SCHEMA_INVALID','Final state is missing.');
 return graph;
}
export function graphOf(meta){
 const evidence=new Set(meta.artifacts.map(a=>a.path));
 const annotations=meta.annotations||[];
 for(const a of annotations)for(const ref of a.evidence||[])if(!evidence.has(ref))throw fault('EXPLORATION_SCHEMA_INVALID','Annotation references unindexed evidence.');
 return validateExploration({'$schema':'./exploration.schema.json',schema_version:1,run_id:meta.id,objective:meta.objective,environment:meta.environment,
  software:meta.software||null,requested_start_url:meta.requestedStartURL||null,observed_start_url:meta.states.find(s=>s.frame.id==='main')?.url||null,session:{profile:meta.profile,workspace:meta.workspace,name:meta.session},created_at:meta.createdAt,finished_at:meta.finishedAt||null,
  status:meta.status,pages:[...new Set(meta.states.map(s=>s.page))].map(id=>{const states=meta.states.filter(s=>s.page===id);return {id,opener_page:states[0].opener_page||null,first_observed_url:states[0].url,last_observed_url:states.at(-1).url,frames:[...new Set(states.map(s=>s.frame.id))]};}),prerequisites:annotations.filter(a=>a.kind==='prerequisite'),states:meta.states,transitions:meta.actions,
  behaviors:annotations.filter(a=>a.kind==='behavior'),findings:annotations.filter(a=>a.kind==='finding'),test_data:annotations.filter(a=>a.kind==='test_data'),
  final_states:meta.finals,video:meta.video,coverage:{scope:'Only observed session-owned pages and commands routed through Latch are represented.',gaps:meta.gaps,questions:annotations.filter(a=>a.kind==='question'),agent_reported_gaps:annotations.filter(a=>a.kind==='coverage_gap'),
   locator_lifetime:'Snapshot refs are historical. Refresh locator candidates against the live app before creating tests.',
   completeness:'Opaque scripts and external/direct Playwright calls may contain uncaptured intermediate actions. No full-site coverage is claimed.'},
  cleanup:meta.cleanup||{status:'unconfirmed'},artifacts:meta.artifacts.filter(a=>!['handoff','manifest'].includes(a.type))});
}
export async function writeHandoff(meta){
 const dir=await runPath(meta.id);
 const schema=await fs.readFile(new URL('./schemas/exploration.schema.json',import.meta.url));await atomic(path.join(dir,'exploration.schema.json'),schema);await indexArtifact(meta,'exploration.schema.json','schema');
 for(const name of ['events.jsonl','commands.jsonl','run.json']){try{await indexArtifact(meta,name,name.endsWith('.jsonl')?'ledger':'run-metadata');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const graph=graphOf(meta);
 await atomic(path.join(dir,'exploration.yaml'),yaml(scrub(graph))+'\n');
 await indexArtifact(meta,'exploration.yaml','handoff');
 await atomic(path.join(dir,'exploration.json'),JSON.stringify(scrub(graph),null,2)+'\n');await indexArtifact(meta,'exploration.json','handoff');
 await atomic(path.join(dir,'artifacts.json'),JSON.stringify({schema:1,run_id:meta.id,artifacts:meta.artifacts},null,2)+'\n');
 await saveMeta(meta);return graph;
}
export async function addStates(meta,capture,{final=false,step}={}){
 const dir=await runPath(meta.id),time=new Date().toISOString(),added=[];
 for(const page of capture.pages||[]){
  const parts=[{id:'main',url:page.url,name:null,snapshot:page.snapshot,dom:page.dom},...(page.frames||[])];
  for(const frame of parts){
   if(frame.error){meta.gaps.push({step,page:page.targetId,frame:frame.id,reason:frame.error});continue;}
   if(typeof frame.snapshot!=='string'){meta.gaps.push({step,page:page.targetId,reason:'Snapshot unavailable'});continue;}
   const id=`state-${String(meta.states.length+1).padStart(5,'0')}`,relative=`snapshots/${id}.yaml`;
   await fs.mkdir(path.join(dir,'snapshots'),{recursive:true,mode:0o700});await atomic(path.join(dir,relative),scrub(frame.snapshot)+'\n');
   const entry=await indexArtifact(meta,relative,'snapshot');
   const state={id,page:page.targetId,opener_page:page.openerTargetId||null,frame:{id:frame.id,name:frame.name||null,url:frame.url||page.url},url:page.url,title:page.title,viewport:page.viewport||null,captured_at:time,
    command_id:step,snapshot:relative,sha256:entry.sha256,selected:page.targetId===capture.currentTargetId,
    elements:elementsOf(frame.snapshot,frame.id),locator_observations:(frame.dom?.nodes||[]).map((node,index)=>({id:`${id}-dom-${index}`,frame:frame.id,attributes:node,
     locator_candidate:node.test_id?{strategy:'attribute',attribute:node.test_id_attribute,value:node.test_id}:node.id?{strategy:'attribute',attribute:'id',value:node.id}:node.label?{strategy:'label',name:node.label}:null,provenance:'observed_dom_attributes'})),provenance:'observed_browser_state'};
   meta.states.push(state);added.push(state);
   if(frame.dom?.total>2000)meta.gaps.push({step,page:page.targetId,frame:frame.id,reason:'DOM locator observations limited to 2000 elements; full accessible snapshot retained.'});
   if(final){const finalPath=`snapshots/final-${page.targetId.replace(/[^a-zA-Z0-9_-]/g,'_')}-${frame.id}.yaml`;
    await atomic(path.join(dir,finalPath),scrub(frame.snapshot)+'\n');await indexArtifact(meta,finalPath,'final-snapshot');
    meta.finals.push({page:page.targetId,frame:frame.id,state:id,snapshot:finalPath,captured_at:time,status:'captured'});}
   await appendObservation(meta,{type:'state',state,artifacts:meta.artifacts.filter(a=>a.path===state.snapshot||a.path.startsWith('snapshots/final-'+page.targetId))});
  }
 }
 return added.find(s=>s.selected&&s.frame.id==='main')||null;
}
export function describeAction(invocation,before){
 const args=invocation.playwrightArgs||[],type=args[0]||invocation.command;
 const targeted=new Set(['click','dblclick','fill','check','uncheck','select','drag','drop','hover','generate-locator','highlight']);
 const targetFor=value=>{if(!value)return null;const e=before?.elements.find(e=>e.snapshot_ref===value);return {state:before?.id||null,snapshot_ref:e?.snapshot_ref||null,locator_candidate:e?.locator_candidate||null,supplied_selector:e?null:scrub(value),provenance:e?'observed_snapshot':'agent_supplied_unverified'};};
 return {type,target:targeted.has(type)?targetFor(args[1]):null,
  destination:type==='drag'?targetFor(args[2]):null,navigation_url:type==='goto'?scrub(args[1]||null):null,
  page_selection:type==='tab-select'?args[1]||null:null,data_reference:invocation.flags['data-ref']||null,values_stored:false};
}
export function actionOf(meta,invocation,{step,before,after,error,startedAt}){
 const args=invocation.playwrightArgs||[],type=args[0]||invocation.command;
 const action={id:step,command_id:step,started_at:startedAt,finished_at:new Date().toISOString(),from:before?.id||null,to:after?.id||null,
  action:describeAction(invocation,before),outcome:error?(error.assertionOnly?'succeeded_assertion_failed':'failed_or_unknown'):'succeeded',
  expectation:invocation.flags['expect-result']!==undefined?{value:scrub(JSON.parse(invocation.flags['expect-result'])),provenance:'agent_supplied'}:invocation.flags['expect-error']?{error:invocation.flags['expect-error'],provenance:'agent_supplied'}:null,
  assertion_status:(invocation.flags['expect-result']!==undefined||invocation.flags['expect-error'])?(error?.evidence?.checkStatus||(error?'unknown':'pass')):'not_asserted',
  error:error?{code:error.code||'BROWSER_ERROR',message:scrub(error.message)}:null,
  video:{run_elapsed_ms:meta.video.startedAt?Math.max(0,Date.parse(startedAt)-Date.parse(meta.video.startedAt)):null,
   segment_alignment:'Run elapsed time only; per-page clip offsets are not asserted.'}};
 if(['run-code','eval'].includes(type))meta.gaps.push({step,reason:'Opaque script: only its command boundary and observed resulting states are captured. Use checkpoints for intermediate states.'});
 if(['fill','type','select','upload'].includes(type)&&!invocation.flags['data-ref'])meta.gaps.push({step,reason:'Input values are omitted. Add a test-data reference before generating automation.'});
 meta.actions.push(action);return action;
}
export async function finishIntegrity(meta){const check=await verifyArtifacts(meta);meta.integrity=check;await saveMeta(meta);return check;}
