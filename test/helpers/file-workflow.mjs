import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {inboxReceipts,sha256} from '../fixtures/file-app.mjs';import {valueOf} from './attachment-fixture.mjs';import {eventually} from './native-browser.mjs';
export const meta=files=>files.map(({filename,bytes,sha256})=>({filename,bytes,sha256}));
export async function upload(f,app,index,files,{operation,scope='page',input='single'}={}){
 const value=valueOf(await f.pw(index,['run-code',`async(page)=>{await page.bringToFront();const target=${scope};await target.locator('#${input}').evaluate((el,operation)=>el.ownerDocument.defaultView.fixture.operation=operation,${JSON.stringify(operation)});await target.locator('#${input}').setInputFiles(${JSON.stringify(files.map(f=>f.path))});await target.locator('#submit-${input}').click();await target.locator('#result').filter({hasText:${JSON.stringify(operation)}}).waitFor();return JSON.parse(await target.locator('#result').innerText())}`]));
 assert.equal(value.actor,f.run+(index?':b':':a'));assert.equal(value.operation,operation);assert.deepEqual(meta(value.files),meta(files));await eventually(()=>app.uploads.some(r=>r.operation===operation));assert.deepEqual(meta(app.uploads.find(r=>r.operation===operation).files),meta(files));return value;
}
export async function downloadProbe(f,index,{operation,variant='basic',scope='page',cancel=false,trigger='pointer',eventPage='page'}={}){
 await f.verifyInbox();const artifact=path.join(f.workspaces[index],'evidence',operation+'.txt');await fs.mkdir(path.dirname(artifact),{recursive:true});
 const action=trigger==='dom'?`await target.locator(${JSON.stringify('#download-'+variant)}).evaluate(el=>el.click());`:`await target.locator(${JSON.stringify('#download-'+variant)}).click({noWaitAfter:true});`;
 const result=valueOf(await f.pw(index,['run-code',`async(page)=>{${trigger==='pointer'?'await page.bringToFront();':''}const target=${scope};await target.locator('#download-${variant}').evaluate((el,operation)=>el.ownerDocument.defaultView.fixture.operation=operation,${JSON.stringify(operation)});const waiting=${eventPage}.waitForEvent('download',{timeout:2000}).then(d=>d,()=>null);${action}const d=await waiting;if(!d)return {event:false,agentArtifact:false,cancelSupported:false};const result={event:true,suggestedFilename:d.suggestedFilename()};try{${cancel?'await d.cancel();return {...result,cancelSupported:true,failure:await d.failure()}':`await d.saveAs(${JSON.stringify(artifact)});return {...result,agentArtifact:true}`}}catch(e){return {...result,agentArtifact:false,error:e.message}}}`]));
 assert.equal(typeof result?.event,'boolean','The probe must complete with an explicit download-event observation');
 if(result?.agentArtifact){const data=await fs.readFile(artifact);return {...result,artifact,bytes:data.length,sha256:sha256(data)}}
 assert.ok(!await fs.stat(artifact).catch(()=>null),'An unobserved download must not become an agent artifact');return result;
}
export async function received(f,app,operation){
 await eventually(async()=>{const r=app.downloads.find(r=>r.operation===operation);return r&&(await inboxReceipts(f.browserInbox)).some(file=>file.complete&&file.sha256===r.sha256)},15000);
 const expected=app.downloads.find(r=>r.operation===operation);
 const observed=(await inboxReceipts(f.browserInbox)).find(file=>file.complete&&file.sha256===expected.sha256);
 assert.equal(observed.bytes,expected.bytes);assert.equal(expected.response,'sent');
 return {operation,browserReceived:true,expected,observed};
}
export async function chooserUpload(f,app,index,files,{operation,scope='page'}={}){
 await f.pw(index,['run-code',`async(page)=>{await page.bringToFront();const target=${scope};await target.locator('#chooser').evaluate((el,op)=>el.ownerDocument.defaultView.fixture.operation=op,${JSON.stringify(operation)});await target.locator('#choose').click()}`]);
 await f.pw(index,['upload',...files.map(f=>f.path)]);
 const result=valueOf(await f.pw(index,['run-code',`async(page)=>{const target=${scope};await target.locator('#submit-chooser').click();await target.locator('#result').filter({hasText:${JSON.stringify(operation)}}).waitFor();return JSON.parse(await target.locator('#result').innerText())}`]));
 assert.equal(result.actor,f.run+(index?':b':':a'));assert.equal(result.operation,operation);assert.deepEqual(meta(result.files),meta(files));
 assert.deepEqual(meta(app.uploads.find(r=>r.operation===operation).files),meta(files));return result;
}
