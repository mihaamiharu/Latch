import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {command} from './native-browser.mjs';
import {hash,pixels,row,MiB} from '../fixtures/evidence-app.mjs';
import {spawnCommandSpec} from '../../src/platform.mjs';

// The pinned CLI already bundles pngjs; no runtime dependency or copied decoder.
export async function pngDecoder(){
 const which=await command('which',['playwright-cli']);const executable=await fs.realpath(which.out.trim());
 const module=process.env.LATCH_PLAYWRIGHT_MODULE||path.join(path.dirname(executable),'node_modules/playwright-core/index.mjs');
 return createRequire(import.meta.url)(path.join(path.dirname(module),'lib/utilsBundle.js')).PNG;
}
export async function captureCLI(f,index,args,{name='command',limit=64*MiB,timeout=65000,fail=false}={}){
 const dest=path.join(f.evidence,`${name}.stdout.partial`),start=performance.now();const file=await fs.open(dest,'wx',0o600);let bytes=0,stderr=Buffer.alloc(0),failure;
 const env={...f.env,DEBUG:''};
 const spec=await spawnCommandSpec('playwright-cli',['-s=agent','--json',...args],{env});
 const child=spawn(spec.command,spec.args,{cwd:f.workspaces[index],env,...spec.options,stdio:['ignore','pipe','pipe']});
 let force;const timer=setTimeout(()=>{failure=new Error('Fixture CLI deadline');child.kill('SIGTERM');kill()},timeout);
 const kill=()=>{force=setTimeout(()=>{child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy()},1000);force.unref()};
 child.stderr.on('data',b=>{if(stderr.length<16384)stderr=Buffer.concat([stderr,b.subarray(0,16384-stderr.length)])});
 const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
 try{for await(const b of child.stdout){bytes+=b.length;if(bytes>limit&&!failure){failure=new Error('Fixture stdout bound exceeded');child.kill('SIGTERM');kill()}if(!failure){let offset=0;while(offset<b.length){const {bytesWritten}=await file.write(b.subarray(offset));if(!bytesWritten)throw new Error('Incomplete fixture artifact write');offset+=bytesWritten}}}const code=await exit;await file.close();if(failure)throw failure;assert.equal((await fs.stat(dest)).size,bytes,'Captured stdout must contain every received byte');
  const parsed=JSON.parse(await fs.readFile(dest,'utf8'));if(!fail)assert.ok(code===0&&!parsed.isError,JSON.stringify(parsed).slice(0,1000));
  const saved=dest.replace('.partial','.json');await fs.rename(dest,saved);return {response:parsed,stdoutBytes:bytes,elapsedMs:performance.now()-start,saved,code};
 }catch(error){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');kill();await exit.catch(()=>{})}throw failure||error}finally{clearTimeout(timer);clearTimeout(force);await file.close().catch(()=>{})}
}
export async function screenshot(f,index,width,height,name){
 await f.pw(index,['run-code',`async(page)=>{await page.setViewportSize({width:${width},height:${height}});await page.evaluate(([w,h])=>evidence.paint(w,h),[${width},${height}]);return {dpr:await page.evaluate(()=>devicePixelRatio)}}`]);
 const partial=path.join(f.evidence,name+'.png.partial');const command=await captureCLI(f,index,['screenshot',`--filename=${partial}`],{name});
 const data=await fs.readFile(partial),PNG=await pngDecoder(),decoded=PNG.sync.read(data);assert.equal(decoded.width,width);assert.equal(decoded.height,height);assert.equal(hash(decoded.data),hash(pixels(width,height)));
 const saved=partial.replace('.partial','');await fs.rename(partial,saved);return {name,path:saved,bytes:data.length,sha256:hash(data),pixelSha256:hash(decoded.data),width,height,stdoutBytes:command.stdoutBytes,elapsedMs:command.elapsedMs};
}
export async function snapshot(f,index,count,width,name){
 await f.pw(index,['run-code',`async(page)=>{await page.evaluate(([n,w])=>evidence.dom(n,w),[${count},${width}])}`]);
 const partial=path.join(f.evidence,name+'.yaml.partial'),command=await captureCLI(f,index,['snapshot',`--filename=${partial}`],{name});const data=await fs.readFile(partial),text=data.toString();
 assert.ok(text.includes('FIRST-SENTINEL')&&text.includes('LAST-SENTINEL'));assert.equal([...text.matchAll(/ROW-\d{5}-/g)].length,count);let offset=0;for(let i=0;i<count;i++){const at=text.indexOf(row(i,width),offset);assert.ok(at>=offset,`Missing row ${i}`);offset=at+row(i,width).length}
 const saved=partial.replace('.partial','');await fs.rename(partial,saved);return {name,path:saved,bytes:data.length,sha256:hash(data),rows:count,stdoutBytes:command.stdoutBytes,elapsedMs:command.elapsedMs};
}
export async function responseBody(f,app,index,kind,size,operation,{delay=0,interrupt=false,expectFailure=false}={}){
 const actor=f.run+(index?':b':':a'),query=new URLSearchParams({kind,size:String(size),actor,op:operation,delay:String(delay),...(interrupt?{interrupt:'1'}:{})});
 const url=app.origin+'/body?'+query;const observed=await captureCLI(f,index,['run-code',`async(page)=>await page.evaluate(async url=>{try{const response=await fetch(url);const body=await response.arrayBuffer();return {ok:true,bytes:body.byteLength}}catch(e){return {ok:false,error:e.message}}},${JSON.stringify(url)})`],{name:operation+'-fetch',fail:expectFailure});
 if(expectFailure)return observed;
 assert.ok(!observed.response.isError);const listing=await f.pw(index,['requests']);const lines=Object.values(listing).filter(v=>typeof v==='string').join('\n').split('\n');const line=lines.find(l=>l.includes('op='+operation));assert.ok(line,'Exact fixture request must be discoverable');const number=line.match(/^(\d+)\./)?.[1];assert.ok(number,line);
 const partial=path.join(f.evidence,operation+'.body.partial');const savedResponse=await captureCLI(f,index,['response-body',number,`--filename=${partial}`],{name:operation+'-save'});
 const exists=await fs.stat(partial).catch(()=>null);
 if(!exists){
  const diagnosticURL=url+'&diagnostic=1';
  const diagnostic=await captureCLI(f,index,['run-code',`async(page)=>{const url=${JSON.stringify(diagnosticURL)};const pending=page.waitForResponse(r=>r.url()===url);const bytes=await page.evaluate(async url=>(await(await fetch(url)).arrayBuffer()).byteLength,url);const response=await pending;try{return {browserBytes:bytes,bodyBytes:(await response.body()).length}}catch(e){return {browserBytes:bytes,error:e.message}}}`],{name:operation+'-diagnostic'});
  const detail=JSON.parse(diagnostic.response.result);assert.ok(detail.error,JSON.stringify(detail));
  assert.match(detail.error,/evicted|No resource|No data found|body.*unavailable/i);assert.equal(detail.browserBytes,size);
  return {operation,actor,kind,bytes:size,outcome:'unsupported',reason:detail.error,agentArtifact:false,upstreamCLIResult:savedResponse.response};
 }
 const data=await fs.readFile(partial),expected=app.receipts.find(r=>r.operation===operation);assert.equal(data.length,size);assert.equal(hash(data),expected.sha256);assert.equal(expected.state,'sent');
 const saved=partial.replace('.partial',kind==='text'?'.txt':'.bin');await fs.rename(partial,saved);return {operation,actor,kind,path:saved,bytes:data.length,sha256:hash(data),stdoutBytes:savedResponse.stdoutBytes,elapsedMs:savedResponse.elapsedMs,fetchMs:observed.elapsedMs};
}
