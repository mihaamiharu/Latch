import http from 'node:http';
import crypto from 'node:crypto';
export const MiB=1024*1024;
export const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function pixels(width,height,seed=194){
 const data=Buffer.alloc(width*height*4);let state=seed;
 for(let i=0;i<data.length;i+=4){for(let c=0;c<3;c++){state^=state<<13;state^=state>>>17;state^=state<<5;data[i+c]=state&255}data[i+3]=255}return data;
}
export const row=(i,width)=>`ROW-${String(i).padStart(5,'0')}-`+String.fromCharCode(65+i%26).repeat(width)+`-END-${String(i).padStart(5,'0')}`;
export function bodyBytes(kind,size,actor,operation){
 if(!Number.isSafeInteger(size)||size<1||size>16*MiB)throw new Error('Fixture body bound exceeded');
 const prefix=Buffer.from(`Latch:${actor}:${operation}\n`),out=Buffer.alloc(size);prefix.copy(out);
 if(kind==='text'){const pattern=Buffer.from('雪|"\\\nABcD0123');let offset=Math.min(prefix.length,size);while(offset+pattern.length<=size){pattern.copy(out,offset);offset+=pattern.length}out.fill(65,offset)}
 else{let state=194;for(let i=Math.min(prefix.length,size);i<size;i++){state^=state<<13;state^=state>>>17;state^=state<<5;out[i]=state&255}}return out;
}
export async function evidenceApp(){
 const states=new Map(),seeds=new Map(),receipts=[],timers=new Set(),gates=new Map(),openGates=new Set();let origin;
 const server=http.createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('Cache-Control','no-store');
  if(req.method==='POST'){let body='';for await(const b of req){body+=b;if(Buffer.byteLength(body)>16384)throw new Error('Fixture state bound')}const value=JSON.parse(body);if(url.pathname==='/__seed')seeds.set(value.run,value);else states.set(value.instance,value);res.end('ok');return}
  if(url.pathname==='/gate'){const op=url.searchParams.get('op');receipts.push({gate:op,actor:url.searchParams.get('actor')});if(openGates.has(op))res.end('released');else{const waiting=gates.get(op)||[];waiting.push(res);gates.set(op,waiting)}return}
  if(url.pathname==='/body'){
   const kind=url.searchParams.get('kind')||'binary',size=Number(url.searchParams.get('size')),actor=url.searchParams.get('actor')||'',operation=url.searchParams.get('op')||'';
   const data=bodyBytes(kind,size,actor,operation),receipt={actor,operation,kind,bytes:data.length,sha256:hash(data),state:'waiting'};receipts.push(receipt);
   const send=()=>{receipt.state='sending';res.writeHead(200,{'Content-Type':kind==='text'?'text/plain; charset=utf-8':'application/octet-stream','Content-Length':data.length});
    if(url.searchParams.get('interrupt')){res.write(data.subarray(0,Math.floor(data.length/3)));const timer=setTimeout(()=>{timers.delete(timer);receipt.state='interrupted';res.destroy()},100);timers.add(timer)}else res.end(data)};
   res.on('finish',()=>receipt.state='sent');const delay=Number(url.searchParams.get('delay')||0);if(delay<0||delay>11000)throw new Error('Delay bound');
   if(delay){const timer=setTimeout(()=>{timers.delete(timer);send()},delay);timers.add(timer)}else send();return;
  }
  if(url.pathname==='/event'){receipts.push({actor:url.searchParams.get('actor'),operation:url.searchParams.get('op'),event:Number(url.searchParams.get('n'))});res.end('ok');return}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
  const instance=crypto.randomUUID();res.setHeader('Content-Type','text/html');
  res.end(`<title>Latch evidence fixture</title><style>body{margin:0}canvas{display:block}</style><main><p id="actor"></p><input id="value"><button id="save">Save</button><p id="result">Waiting</p></main><script>
  const actor=decodeURIComponent(location.hash.slice(1))||sessionStorage.getItem('evidence-actor');sessionStorage.setItem('evidence-actor',actor);history.replaceState({},'',location.pathname);document.querySelector('#actor').textContent=actor;
  window.evidence={actor,instance:${JSON.stringify(instance)},role:'root'};fetch('/state',{method:'POST',body:JSON.stringify(evidence)});
  document.querySelector('#save').onclick=()=>{document.querySelector('#result').textContent='Saved '+document.querySelector('#value').value};
  evidence.paint=(width,height)=>{if(width*height>2048*2048)throw new Error('Pixel bound');const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;document.body.replaceChildren(canvas);const ctx=canvas.getContext('2d'),image=ctx.createImageData(width,height);let state=194;for(let i=0;i<image.data.length;i+=4){for(let c=0;c<3;c++){state^=state<<13;state^=state>>>17;state^=state<<5;image.data[i+c]=state&255}image.data[i+3]=255}ctx.putImageData(image,0,0)};
  const makeRow=${row.toString()};evidence.dom=(count,width)=>{if(count>20000||count*width>16*1024*1024)throw new Error('DOM bound');const main=document.createElement('main');for(let n=-1;n<=count;n++){const p=document.createElement('p');p.textContent=n===-1?'FIRST-SENTINEL':n===count?'LAST-SENTINEL':makeRow(n,width);main.append(p)}document.body.replaceChildren(main)};
  evidence.burst=async(op)=>{for(let batch=0;batch<32;batch++){for(let i=0;i<16;i++)console.log('LATCH-EVENT:'+actor+':'+op+':'+(batch*16+i));if(batch<4)await Promise.all(Array.from({length:16},(_,i)=>fetch('/event?actor='+encodeURIComponent(actor)+'&op='+op+'&n='+(batch*16+i))));await new Promise(r=>setTimeout(r,0))}return {logs:512,requests:64}};
  </script>`);
 })().catch(()=>{if(!res.headersSent)res.writeHead(400);res.end('Fixture rejected')})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 return {origin,states,seeds,receipts,openGate:op=>{openGates.add(op);for(const res of gates.get(op)||[])res.end('released');gates.delete(op)},rootRole:'root',saveEvidence:async dir=>{const fs=await import('node:fs/promises');await fs.writeFile(dir+'/server-receipts.json',JSON.stringify(receipts,null,2))},close:()=>new Promise(resolve=>{for(const timer of timers)clearTimeout(timer);server.close(resolve);server.closeAllConnections()})};
}
