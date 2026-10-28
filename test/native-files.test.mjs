import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserModel} from '../src/native-browser-model.mjs';

test('file input commands route to the owned frame and reject foreign or retired sessions before execution',async()=>{
 const calls=[],events=[];
 const model=new BrowserModel(async(op,p)=>{calls.push({op,...p});return p.method==='Target.getTargetInfo'?{targetInfo:{targetId:'root',type:'page'}}:{}},e=>events.push(e));
 model.setTab({id:1});await model.initialize();
 model.onEvent({source:{tabId:1},method:'Target.attachedToTarget',params:{sessionId:'frame',targetInfo:{targetId:'child',type:'iframe'}}});
 const wire=events.at(-1).params.sessionId,params={objectId:'input',files:['/task/inputs/file.txt']};
 await model.command({sessionId:wire,method:'DOM.setFileInputFiles',params});
 assert.deepEqual(calls.at(-1),{op:'command',tabId:1,sessionId:'frame',method:'DOM.setFileInputFiles',params});
 const before=calls.length;
 await assert.rejects(model.command({sessionId:'other-lease',method:'DOM.setFileInputFiles',params}),/not owned/);
 model.onEvent({source:{tabId:1},method:'Target.detachedFromTarget',params:{sessionId:'frame',targetId:'child'}});
 await assert.rejects(model.command({sessionId:wire,method:'DOM.setFileInputFiles',params}),/not owned/);
 assert.equal(calls.length,before);
});

test('native transport rejects managed download configuration and cancellation without changing browser state',async()=>{
 const calls=[];const model=new BrowserModel(async(...args)=>calls.push(args),()=>{});
 await assert.rejects(model.command({method:'Browser.setDownloadBehavior',params:{behavior:'allowAndName',downloadPath:'/task/evidence',eventsEnabled:true}}),/Managed downloads are unsupported.*exact-file retrieval/);
 await assert.rejects(model.command({method:'Browser.cancelDownload',params:{guid:'foreign'}}),/Unsupported browser-level/);
 assert.equal(calls.length,0);
});
