import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {listRuns,loadMeta,runPath,saveMeta,libraryRoot,regularFile,atomic,verifyArtifacts,indexArtifact,exclusive,runPattern,scrub,artifactPath,digest,lockRun,recoverLibraryLock,replayObservations,appendObservation} from './exploration-storage.mjs';
import {writeHandoff} from './exploration-model.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decisions=new Set(['unreviewed','automate','investigate','report_bug','closed']);
export async function saveReview(id,{decision,note=''}){
 if(!decisions.has(decision)||typeof note!=='string'||note.length>8000)throw fault('INVALID_REVIEW','Choose unreviewed, automate, investigate, report_bug or closed, and a note under 8000 characters.');
 await loadMeta(id);const review={schema:1,run_id:id,decision,note:scrub(note),updated_at:new Date().toISOString(),provenance:'qa_review'};
 await atomic(path.join(await runPath(id),'review.json'),JSON.stringify(review,null,2)+'\n');return review;
}
async function reviewOf(id){try{return JSON.parse(await regularFile(path.join(await runPath(id),'review.json'),16384));}catch(e){if(e.code==='ENOENT')return {decision:'unreviewed',note:''};throw e;}}
const artifactURL=(id,relative)=>`/artifact/${id}/${relative.split('/').map(encodeURIComponent).join('/')}`;
const style=`:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui;background:#f4f4f0;color:#24342e}body{margin:0}[hidden]{display:none!important}header{padding:22px 5%;background:#173c32;color:#fff;display:flex;justify-content:space-between;align-items:center}header a{color:white;text-decoration:none;font-weight:700;font-size:22px}main{max-width:1160px;margin:32px auto;padding:0 24px}h1{font-size:32px;margin:12px 0}h2{font-size:21px}p{line-height:1.6}.muted,small{color:#66766d}.card{background:#fff;border:1px solid #d9dfd7;border-radius:14px;padding:22px;margin:16px 0}.pill{display:inline-block;font-size:12px;background:#e5eee7;color:#28503c;padding:5px 10px;border-radius:20px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:22px}.runs{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px}.runs .card{margin:0;display:block;text-decoration:none;color:inherit}.runs .card:hover{border-color:#2d7b59}button,.button{background:#1b684a;color:white;border:0;border-radius:8px;padding:10px 16px;font:inherit;text-decoration:none;cursor:pointer}input,select,textarea{box-sizing:border-box;font:inherit;border:1px solid #c4cec3;border-radius:8px;padding:10px;width:100%;margin:8px 0}textarea{min-height:110px}video{width:100%;max-height:480px;background:#101d18;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#eef2ec;padding:12px;border-radius:6px}details{margin:10px 0;padding:8px 0;border-bottom:1px solid #e1e5de}a{color:#17643f}label{display:block}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:10px;border-bottom:1px solid #e1e5de}nav{margin:18px 0}.warning{background:#fff2da;border-left:4px solid #bd8d25;padding:12px}#saved{font-size:13px;min-height:22px}footer{padding:24px 0;color:#66766d;font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr}}`;
function shell(title,body,script='',nonce=''){
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Latch</title><style>${style}</style></head><body><header><a href="/">Latch <span style="font-weight:400;font-size:15px">/ Exploration library</span></a><span>LOCAL ON THIS MACHINE</span></header><main>${body}<footer>Observed evidence stays separate from QA decisions. Local files may contain page content.</footer></main>${script?`<script nonce="${nonce}">${script}</script>`:''}</body></html>`;
}
async function catalogue(nonce){
 const runs=await listRuns();return shell('Library',`<p class="muted">EXPLORATION → REVIEW → AUTOMATION</p><h1>Pick up where the agent left off.</h1><p class="muted">Review the video and captured behavior, then decide what deserves a test.</p><input id="search" aria-label="Search explorations" placeholder="Search project, objective or status"><div class="runs">${runs.map(r=>`<a class="card" data-search="${escape([r.objective,r.workspace,r.status,r.environment].join(' ').toLowerCase())}" href="/run/${r.id}"><span class="pill">${escape(r.status)}</span><h2>${escape(r.objective)}</h2><p>${escape(path.basename(r.workspace||''))} · ${escape(r.environment||'Environment not specified')}</p><small>${escape(r.createdAt)}<br>${escape(r.states?.length||0)} captured states · ${escape(r.actions?.length||0)} transitions</small></a>`).join('')||'<div class="card">No explorations yet. Start one with Latch open or connect.</div>'}</div>`,`document.getElementById('search').addEventListener('input',e=>{for(const el of document.querySelectorAll('[data-search]'))el.hidden=!el.dataset.search.includes(e.target.value.toLowerCase())})`,nonce);
}
async function runHTML(id,token,nonce){
 const meta=await loadMeta(id),review=await reviewOf(id),integrity=await verifyArtifacts(meta);
 const link=(relative,label)=>`<a href="${artifactURL(id,relative)}">${escape(label||relative)}</a>`;
 return shell(meta.objective,`<nav><a href="/">← All explorations</a></nav><span class="pill">${escape(meta.status)}</span><h1>${escape(meta.objective)}</h1><p class="muted">${escape(meta.workspace)} · ${escape(meta.environment||'Environment not specified')} · ${escape(meta.createdAt)}</p>
 ${!integrity.verified?'<p class="warning">Some evidence has changed or is missing. Review the integrity problems before handing this run off.</p>':''}
 <div class="grid"><section><div class="card"><h2>Watch the exploration</h2>${(meta.video.clips||[]).map((file,i)=>`<p>Clip ${i+1}</p><video controls preload="metadata" src="${artifactURL(id,file)}"></video>`).join('')||'<p>No finalized video is available.</p>'}<p class="warning">A saved video file does not prove every background or short-lived popup state was recorded. Use YAML and capture gaps alongside the clips.</p><p class="muted">Video: ${escape(meta.video.status)} · mode ${escape(meta.video.mode||'on')}. Clips can belong to different owned pages; exact per-page timeline alignment is not asserted.</p></div>
 <div class="card"><h2>What the agent explored</h2>${meta.actions.map(a=>`<details><summary>${escape(a.action.type)} · ${escape(a.outcome)} · ${escape(a.started_at)}</summary><p>${escape(a.from||'Unknown source')} → ${escape(a.to||'Unknown result')}</p><pre>${escape(JSON.stringify(a.action,null,2))}</pre></details>`).join('')||'<p>No managed action steps were recorded.</p>'}</div>
 <div class="card"><h2>Page states and locators</h2>${meta.states.map(s=>`<details><summary>${escape(s.id)} · ${escape(s.title||s.url)} · ${escape(s.frame.id)}</summary><p>${escape(s.url)}</p><p>${link(s.snapshot,'Open YAML snapshot')} · ${escape(s.captured_at)}</p><pre>${escape(JSON.stringify({accessible_elements:s.elements,dom_attributes:s.locator_observations||[]},null,2))}</pre></details>`).join('')}</div></section>
 <aside><div class="card"><h2>Automation handoff</h2><p>${link('exploration.yaml','Download exploration.yaml')}</p><p>${link('artifacts.json','Artifact manifest')}</p><small>Contains observed states, transitions and locator candidates. Generated code is excluded.</small></div>
 <div class="card"><h2>Your next step</h2><form id="review"><label>Decision<select id="decision">${[...decisions].map(d=>`<option value="${d}" ${d===review.decision?'selected':''}>${escape(d.replaceAll('_',' '))}</option>`).join('')}</select></label><label>Review notes<textarea id="note">${escape(review.note)}</textarea></label><button>Save review</button><p id="saved" role="status"></p></form></div>
 <div class="card"><h2>Findings and gaps</h2>${meta.annotations.filter(a=>['finding','behavior'].includes(a.kind)).map(a=>`<details><summary>${escape(a.kind)} · agent supplied</summary><p>${escape(a.text||a.observed)}</p>${a.observed?`<p><strong>Observed:</strong> ${escape(a.observed)}</p>`:''}<p><strong>Expected:</strong> ${escape(a.expected===null||a.expected===undefined?'Not specified; needs QA review':typeof a.expected==='string'?a.expected:JSON.stringify(a.expected))}</p><small>Assertion: ${escape(a.assertion_status||'not_asserted')}</small></details>`).join('')}${meta.gaps.map(g=>`<p class="warning">${escape(g.reason)} ${escape(g.code||'')}</p>`).join('')||'<p>No capture gaps reported.</p>'}<p>Cleanup: ${escape(meta.cleanup?.status||'unconfirmed')}</p></div></aside></div>`,
 `document.getElementById('review').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('saved');status.textContent='Saving…';try{const r=await fetch('/review/${id}',{method:'POST',headers:{'Content-Type':'application/json','X-Latch-Review':${JSON.stringify(token)}},body:JSON.stringify({decision:document.getElementById('decision').value,note:document.getElementById('note').value})});if(!r.ok)throw Error('Could not save');status.textContent='Review saved on this machine.'}catch{status.textContent='Could not save review. Try again.'}})`,nonce);
}
export async function startLibraryServer({port=0}={}){
 const token=crypto.randomBytes(32).toString('hex');
 const server=http.createServer(async(req,res)=>{
  const nonce=crypto.randomBytes(16).toString('hex');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'`);
  try{
   const origin=`http://127.0.0.1:${server.address().port}`;
   if(req.headers.host!==`127.0.0.1:${server.address().port}`)throw fault('FORBIDDEN','Invalid host.');
   const url=new URL(req.url,origin);
   if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await catalogue(nonce));return;}
   const run=url.pathname.match(/^\/run\/([a-f0-9-]+)$/);
   if(req.method==='GET'&&run){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await runHTML(run[1],token,nonce));return;}
   const review=url.pathname.match(/^\/review\/([a-f0-9-]+)$/);
   if(req.method==='POST'&&review){
    if(req.headers.origin!==origin||req.headers['x-latch-review']!==token)throw fault('FORBIDDEN','Review requires this local library page.');
    let body='';for await(const b of req){body+=b;if(Buffer.byteLength(body)>16384)throw fault('INVALID_REVIEW','Review too large.');}
    const result=await saveReview(review[1],JSON.parse(body));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
   }
   const artifact=url.pathname.match(/^\/artifact\/([a-f0-9-]+)\/(.+)$/);
   if(req.method==='GET'&&artifact){
    const meta=await loadMeta(artifact[1]),relative=decodeURIComponent(artifact[2]);
    const indexed=meta.artifacts.find(a=>a.path===relative);
    if(!indexed&&relative!=='artifacts.json')throw fault('NOT_FOUND','Not an indexed artifact.');
    if(path.isAbsolute(relative)||relative.split(/[\\/]/).some(s=>!s||s==='..'||s==='.'))throw fault('FORBIDDEN','Invalid artifact path.');
    const dir=await runPath(meta.id);let parent=path.dirname(path.join(dir,relative));while(parent!==dir){const s=await fs.lstat(parent);if(!s.isDirectory()||s.isSymbolicLink())throw fault('FORBIDDEN','Invalid artifact directory.');parent=path.dirname(parent);}
    const file=path.join(dir,relative),handle=await fs.open(file,'r');let streamed=false;
    try{
     const stat=await handle.stat(),link=await fs.lstat(file);if(!stat.isFile()||link.isSymbolicLink()||stat.ino!==link.ino)throw fault('FORBIDDEN','Invalid artifact.');
     const ext=path.extname(file);const types={'.webm':'video/webm','.png':'image/png','.yaml':'text/plain; charset=utf-8','.json':'application/json','.md':'text/plain; charset=utf-8'};res.setHeader('Content-Type',types[ext]||'application/octet-stream');
     if(!['.webm','.png'].includes(ext))res.setHeader('Content-Disposition',`attachment; filename="${path.basename(file).replaceAll('"','')}"`);
     let start=0,end=stat.size-1;
     if(req.headers.range){const m=req.headers.range.match(/^bytes=(\d+)-(\d*)$/);if(!m||+m[1]>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}start=+m[1];end=m[2]?Math.min(+m[2],end):end;if(end<start)throw fault('INVALID_RANGE','Invalid range');res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
     res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',Math.max(0,end-start+1));
     if(!stat.size){res.end();return;}const stream=handle.createReadStream({start,end,autoClose:true});streamed=true;stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);
    }finally{if(!streamed)await handle.close();}return;
   }
   res.writeHead(404);res.end('Not found');
  }catch(e){if(res.headersSent){res.destroy();return;}res.statusCode=e.code==='FORBIDDEN'?403:e.code==='NOT_FOUND'||e.code==='ENOENT'?404:400;res.end(e.code||'LIBRARY_ERROR');}
 });
 server.requestTimeout=10000;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(port),'127.0.0.1',resolve)});
 return {server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})};
}
export async function exportRun(id,destination){
 const meta=await loadMeta(id),integrity=await verifyArtifacts(meta);if(!integrity.verified)throw fault('EVIDENCE_INTEGRITY_FAILED','Review missing/changed evidence before export.');
 if(!destination)throw fault('INVALID_ARGUMENT','Specify --destination for a new handoff directory.');
 const dest=path.resolve(destination);await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.mkdir(dest,{mode:0o700});
 const dir=await runPath(id);const names=new Set(['exploration.yaml','exploration.json','artifacts.json',...meta.artifacts.map(a=>a.path)]);
 for(const name of names){if(path.isAbsolute(name)||name.split(/[\\/]/).some(p=>p==='..'))throw fault('EVIDENCE_PATH_UNSAFE','Invalid export path.');await fs.mkdir(path.dirname(path.join(dest,name)),{recursive:true,mode:0o700});const data=await regularFile(await artifactPath(meta,name),name.endsWith('.webm')?512*1024*1024:32*1024*1024);const expected=meta.artifacts.find(a=>a.path===name);if(expected&&digest(data)!==expected.sha256)throw fault('EVIDENCE_CHANGED','Artifact changed during export; partial export preserved.');await exclusive(path.join(dest,name),data);}
 const review=await reviewOf(id);await exclusive(path.join(dest,'review.json'),JSON.stringify(review,null,2)+'\n');return {exported:true,directory:dest,runId:id,files:names.size+1};
}
export async function libraryCommand(action,flags){
 if(action==='list')return {root:libraryRoot(),runs:(await listRuns()).map(r=>({id:r.id,objective:r.objective,environment:r.environment,workspace:r.workspace,status:r.status,createdAt:r.createdAt,video:r.video?.status,states:r.states?.length||0,transitions:r.actions?.length||0}))};
 if(action==='serve'){
  const app=await startLibraryServer({port:flags.port||0});console.log(JSON.stringify({localLibrary:app.url,localOnly:true}));for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close();});await new Promise(resolve=>app.server.once('close',resolve));return;
 }
 if(!flags.run)throw fault('INVALID_RUN','Specify --run from library list.');
 if(action==='show'){const meta=await loadMeta(flags.run);return {run:meta,review:await reviewOf(meta.id),integrity:await verifyArtifacts(meta),handoff:path.join(await runPath(meta.id),'exploration.yaml')};}
 if(action==='review')return saveReview(flags.run,{decision:flags.decision,note:flags.note});
 if(action==='export')return exportRun(flags.run,flags.destination);
 if(action==='repair'){
  await recoverLibraryLock(flags.run);
  return lockRun(flags.run,async()=>{const meta=await replayObservations(await loadMeta(flags.run));if(meta.pending){
   meta.status='interrupted';let completion;
   try{const lines=(await regularFile(path.join(await runPath(meta.id),'commands.jsonl'),8*1024*1024)).toString('utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));completion=lines.find(e=>e.event==='finished'&&e.step===meta.pending.step);}catch{}
   if(!meta.actions.some(a=>a.id===meta.pending.step))meta.actions.push({id:meta.pending.step,command_id:meta.pending.step,from:meta.pending.from||null,to:null,action:meta.pending.action||{type:meta.pending.command},outcome:completion?.operation?.outcome==='succeeded'?'succeeded':'unknown',provenance:'recovered_command_ledger',resulting_state:'unavailable'});
   meta.gaps.push({reason:completion?'Command completion recovered; resulting state unavailable. No action was replayed.':'An action has no durable completion. Its outcome is unknown; no action was replayed.',step:meta.pending.step});delete meta.pending;
  }
  try{const stop=JSON.parse(await regularFile(path.join(await runPath(meta.id),'stop-request.json'),8192));if(stop.confirmed)meta.cleanup={status:'confirmed',preservedUserTabs:true};}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!meta.observationTailIncomplete)await appendObservation(meta,{type:'summary',summary:{status:meta.status,video:meta.video,annotations:meta.annotations,gaps:meta.gaps,finals:meta.finals,cleanup:meta.cleanup,finishedAt:meta.finishedAt,pending:meta.pending||null},artifacts:meta.artifacts});
  await writeHandoff(meta);return {repaired:true,replayedActions:0,runId:meta.id,integrity:await verifyArtifacts(meta)};});
 }
 throw fault('INVALID_COMMAND','Use library list, show, serve, review, export or repair.');
}
