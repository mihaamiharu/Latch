#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
if(!process.argv[2]){process.stderr.write('Usage: node pilot-fixture.mjs FRESH_EVIDENCE_DIRECTORY\n');process.exit(1)}
const directory=path.resolve(process.argv[2]),run=crypto.randomUUID();await fs.mkdir(directory,{recursive:true});
const route='/case/'+run,receipts=[];let origin;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(url.pathname===route+'/save'&&req.method==='POST'){
  if(req.headers.origin!==origin){res.writeHead(403);res.end();return}
  let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return}}
  try{const data=JSON.parse(body);if(!['codex','claude','cursor','a','b'].includes(data.actor)||typeof data.value!=='string'||data.value.length>100)throw Error();const receipt={sequence:receipts.length+1,actor:data.actor,value:data.value,at:new Date().toISOString()};receipts.push(receipt);await fs.writeFile(path.join(directory,'server-receipts.json'),JSON.stringify(receipts,null,2)+'\n');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({saved:true,...receipt}));}catch{res.writeHead(400);res.end()}return;
 }
 if(url.pathname!==route||req.method!=='GET'){res.writeHead(404);res.end();return}
 const actor=url.searchParams.get('actor');if(!['codex','claude','cursor','a','b'].includes(actor)){res.writeHead(400);res.end();return}
 res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','latch_pilot=signed-in; Path='+route+'; SameSite=Strict');
 res.end(`<!doctype html><meta charset="utf-8"><title>Latch pilot ${actor}</title><h1>Latch pilot: ${actor}</h1><p id="actor">${actor}</p><label>Value <input id="value"></label><button id="save">Save fixture value</button><p id="result" role="status">Waiting</p><a id="child" href="${route}?actor=${actor}&child=1" target="_blank" rel="opener">Open fixture child</a><script>const actor=${JSON.stringify(actor)};document.querySelector('#save').onclick=async()=>{const response=await fetch(${JSON.stringify(route+'/save')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor,value:document.querySelector('#value').value})});const data=await response.json();document.querySelector('#result').textContent=data.saved?'Saved '+data.value:'Failed';console.log('fixture-save-'+actor)};localStorage.setItem('latch-pilot','retained');</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
const urls=Object.fromEntries(['codex','claude','cursor','a','b'].map(actor=>[actor,origin+route+'?actor='+actor]));await fs.writeFile(path.join(directory,'fixture.json'),JSON.stringify({run,pid:process.pid,urls,startedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({run,urls,directory}));
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
