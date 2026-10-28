import test from 'node:test';import assert from 'node:assert/strict';
import {fileApp,sha256,FILE_BOUNDS} from './fixtures/file-app.mjs';
test('bounded fixture multipart receiver preserves duplicate names, UTF-8, empty and binary bytes',async t=>{
 const app=await fileApp();t.after(()=>app.close());const origin='http://127.0.0.1:'+new URL(app.origin).port;
 const files=[['same.txt',Buffer.from('first')],['same.txt',Buffer.from('second')],['ü space.txt',Buffer.from([0,1,127,128,255])],['empty.txt',Buffer.alloc(0)]];
 const form=new FormData();form.append('actor','unit');form.append('instance','instance');form.append('operation','bytes');for(const [name,bytes]of files)form.append('files',new Blob([bytes],{type:'application/octet-stream'}),name);
 const response=await fetch(origin+'/upload',{method:'POST',body:form});assert.equal(response.status,200);const receipt=await response.json();
 assert.deepEqual(receipt.files.map(f=>[f.filename,f.bytes,f.sha256]),files.map(([name,bytes])=>[name,bytes.length,sha256(bytes)]));assert.equal(app.uploads.length,1);
 const many=new FormData();for(let n=0;n<=FILE_BOUNDS.count;n++)many.append('files',new Blob(['x']),'x.txt');assert.equal((await fetch(origin+'/upload',{method:'POST',body:many})).status,413);assert.equal(app.uploads.length,1);
 const large=new FormData();large.append('files',new Blob([Buffer.alloc(FILE_BOUNDS.file+1)]),'oversized.bin');assert.equal((await fetch(origin+'/upload',{method:'POST',body:large})).status,413);assert.equal(app.uploads.length,1);
});
