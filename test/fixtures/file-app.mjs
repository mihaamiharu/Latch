import http from 'node:http';import crypto from 'node:crypto';import fs from 'node:fs/promises';import path from 'node:path';
export const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const FILE_BOUNDS=Object.freeze({file:256*1024,body:1024*1024+64*1024,count:8});
async function readBounded(req,max=FILE_BOUNDS.body){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw Object.assign(new Error('Fixture request limit exceeded'),{status:413});chunks.push(chunk)}return Buffer.concat(chunks)}
export async function parseUpload(req){
 const body=await readBounded(req),form=await new Response(body,{headers:{'Content-Type':req.headers['content-type']||''}}).formData();
 const files=[];for(const [name,value]of form){if(name!=='files')continue;if(typeof value.arrayBuffer!=='function')throw new Error('Expected file');if(files.length>=FILE_BOUNDS.count||value.size>FILE_BOUNDS.file)throw Object.assign(new Error('Fixture file limit exceeded'),{status:413});const bytes=Buffer.from(await value.arrayBuffer());files.push({filename:value.name,mimeType:value.type,bytes:bytes.length,sha256:sha256(bytes)})}
 return {actor:String(form.get('actor')||''),instance:String(form.get('instance')||''),operation:String(form.get('operation')||''),files};
}
export async function fileApp(){
 const states=new Map(),seeds=new Map(),uploads=[],downloads=[],pending=new Map(),nonce=crypto.randomBytes(5).toString('hex');let origins;const timers=new Set();
 const payload=(actor,operation,variant)=>Buffer.from(`Latch fixture\n${actor}\n${operation}\n${variant}\n`.repeat(variant==='slow'||variant==='interrupt'?1500:8));
 const sendDownload=(req,res,{actor,operation,variant})=>{
  const bytes=payload(actor,operation,variant),filename=`latch-${nonce}-shared.txt`,receipt={id:crypto.randomUUID(),actor,operation,variant,filename,bytes:bytes.length,sha256:sha256(bytes),response:'in-progress'};downloads.push(receipt);
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':bytes.length,'Cache-Control':'no-store'});
  res.on('finish',()=>receipt.response='sent');res.on('close',()=>{if(receipt.response==='in-progress')receipt.response='interrupted'});
  if(variant==='interrupt'){res.write(bytes.subarray(0,Math.floor(bytes.length/3)));const timer=setTimeout(()=>{timers.delete(timer);res.destroy()},100);timers.add(timer);return}
  if(variant==='slow'){let offset=0;const timer=setInterval(()=>{if(res.destroyed){clearInterval(timer);timers.delete(timer);return}const end=Math.min(offset+4096,bytes.length);res.write(bytes.subarray(offset,end));offset=end;if(offset===bytes.length){clearInterval(timer);timers.delete(timer);res.end()}},150);timers.add(timer);return}
  res.end(bytes);
 };
 const server=http.createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='POST'&&url.pathname==='/upload'){const r=await parseUpload(req);uploads.push(r);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(r));return}
  if(req.method==='POST'&&url.pathname==='/__seed'){const v=JSON.parse((await readBounded(req,16384)).toString());seeds.set(v.run,v);res.end('ok');return}
  if(req.method==='POST'&&url.pathname==='/state'){const v=JSON.parse((await readBounded(req,16384)).toString());states.set(v.instance,v);res.end('ok');return}
  if(req.method==='POST'&&url.pathname==='/download'){
   const form=new URLSearchParams((await readBounded(req,16384)).toString()),data={actor:form.get('actor'),operation:form.get('operation'),variant:url.searchParams.get('variant')||'basic'};
   if(data.variant==='redirect'){const id=crypto.randomUUID();pending.set(id,data);res.writeHead(302,{Location:'/attachment/'+id});res.end();return}sendDownload(req,res,data);return;
  }
  if(url.pathname.startsWith('/attachment/')){const id=url.pathname.split('/').at(-1),data=pending.get(id);if(!data){res.writeHead(404);res.end();return}pending.delete(id);sendDownload(req,res,data);return}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return}
  const instance=crypto.randomUUID(),role=url.pathname==='/root'?'root':url.searchParams.get('role')||'popup';res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
  res.end(`<title>Latch file fixture</title><h1>${role}</h1><p id="actor"></p><p id="instance">${instance}</p>
   <input id="single" type="file"><button id="submit-single">Submit single</button><input id="multi" type="file" multiple><button id="submit-multi">Submit multi</button>
   <input id="chooser" type="file" multiple hidden><button id="choose">Choose files</button><button id="submit-chooser">Submit chooser</button><button id="replace-input">Replace input</button><p id="result">Waiting</p>
   ${['basic','redirect','slow','interrupt','concurrent'].map(v=>`<form method="POST" action="/download?variant=${v}" class="download"><input name="actor" hidden><input name="operation" hidden><button id="download-${v}">Download ${v}</button></form>`).join('')}
   ${role==='root'?'<button id="popup">Open popup</button><button id="remove-cross">Remove cross frame</button>':''}
   <script>
   const actor=decodeURIComponent(location.hash.slice(1))||sessionStorage.getItem('file-actor');sessionStorage.setItem('file-actor',actor);history.replaceState({},'',location.pathname+location.search);document.querySelector('#actor').textContent=actor;
   window.fixture={actor,instance:${JSON.stringify(instance)},role:${JSON.stringify(role)},operation:'initial'};
   fetch('/state',{method:'POST',body:JSON.stringify(fixture)});
   async function upload(selector){const form=new FormData();for(const k of ['actor','instance','operation'])form.append(k,fixture[k]);for(const file of document.querySelector(selector).files)form.append('files',file);const r=await fetch('/upload',{method:'POST',body:form});document.querySelector('#result').textContent=JSON.stringify(await r.json())}
   for(const id of ['single','multi','chooser'])document.querySelector('#submit-'+id).onclick=()=>upload('#'+id);
   document.querySelector('#choose').onclick=()=>document.querySelector('#chooser').click();document.querySelector('#replace-input').onclick=()=>{const old=document.querySelector('#single'),fresh=document.createElement('input');fresh.id='single';fresh.type='file';old.replaceWith(fresh)};
   for(const form of document.querySelectorAll('.download'))form.onsubmit=()=>{form.elements.actor.value=fixture.actor;form.elements.operation.value=fixture.operation};
   ${role==='root'?`for(const [id,origin]of [['same',${JSON.stringify(origins.a)}],['cross',${JSON.stringify(origins.b)}]]){const f=document.createElement('iframe');f.id=id;f.name=id;f.width=650;f.height=430;f.src=origin+'/frame?role='+id+'#'+encodeURIComponent(actor);document.body.append(f)}document.querySelector('#popup').onclick=()=>window.open('/popup#'+encodeURIComponent(actor),'_blank');document.querySelector('#remove-cross').onclick=()=>document.querySelector('#cross')?.remove();`:''}
   </script>`);
 })().catch(error=>{if(!res.headersSent)res.writeHead(error.status||400);res.end('Fixture request rejected')})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;origins={a:`http://a.files.test:${port}`,b:`http://b.other.test:${port}`};
 return {origin:origins.a,origins,states,seeds,uploads,downloads,rootRole:'root',privateDownloads:true,protocolEvidence:true,
  launchArgs:['--site-per-process','--no-proxy-server','--host-resolver-rules=MAP a.files.test 127.0.0.1,MAP b.other.test 127.0.0.1'],
  saveEvidence:async dir=>{await fs.writeFile(path.join(dir,'server-uploads.json'),JSON.stringify(uploads,null,2));await fs.writeFile(path.join(dir,'server-downloads.json'),JSON.stringify(downloads,null,2))},
  close:()=>new Promise(resolve=>{for(const t of timers){clearTimeout(t);clearInterval(t)}server.close(resolve);server.closeAllConnections()})};
}
export async function inputCorpus(workspace,actor){
 const dir=path.join(workspace,'inputs');await fs.mkdir(dir,{recursive:true});const definitions=[['note.txt',Buffer.from('Upload '+actor+'\n')],['empty.txt',Buffer.alloc(0)],['space ünicode.txt',Buffer.from('こんにちは '+actor)],['opaque.bin',Buffer.from(Array.from({length:131072},(_,i)=>(i*31)%256))],['first/same.txt',Buffer.from('first '+actor)],['second/same.txt',Buffer.from('second '+actor)]];
 const files=[];for(const [name,bytes]of definitions){const file=path.join(dir,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{mode:0o600});files.push({path:file,filename:path.basename(file),bytes:bytes.length,sha256:sha256(bytes)})}return files;
}
export async function inboxReceipts(inbox){const records=[],names=await fs.readdir(inbox);if(names.length>64)throw new Error('Fixture inbox count bound exceeded');for(const name of names){const file=path.join(inbox,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())continue;if(stat.size>FILE_BOUNDS.file)throw new Error('Fixture inbox file bound exceeded');const bytes=await fs.readFile(file);records.push({filename:name,bytes:bytes.length,sha256:sha256(bytes),complete:!name.endsWith('.crdownload')})}return records}
