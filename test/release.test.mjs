import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {build} from '../src/build.mjs';import {ROOT,hash,verifyKit,chromeVersion,releaseManifest} from '../src/release.mjs';
test('native release is reproducible, complete and leaves source/integration untouched',async t=>{
 const dir=await fs.mkdtemp(path.join(ROOT,'work/release-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const before=await fs.readFile(path.join(ROOT,'extension/manifest.json'));
 const a=await build({out:path.join(dir,'a')}),b=await build({out:path.join(dir,'b')});assert.deepEqual(a.archives.map(x=>x.sha256),b.archives.map(x=>x.sha256));assert.equal(hash(await fs.readFile(path.join(ROOT,'extension/manifest.json'))),hash(before));
 const descriptor=await verifyKit(a.kit);assert.equal(descriptor.version,'0.2.0-rc.3');const manifest=JSON.parse(await fs.readFile(path.join(a.kit,'extension/manifest.json')));assert.ok(manifest.permissions.includes('debugger'));assert.ok(manifest.permissions.includes('alarms'));assert.ok(!manifest.host_permissions&&!manifest.content_scripts&&!manifest.externally_connectable);
 assert.ok(!Object.keys(descriptor.files).some(n=>/^(work|test|install|\.git|assets)\//.test(n)));await fs.appendFile(path.join(a.kit,'extension/popup.js'),'\n// changed');await assert.rejects(verifyKit(a.kit),{code:'RELEASE_HASH_CHANGED'});
});
test('missing identity and invalid Chrome version mapping fail instead of regenerating identity',async t=>{
 assert.equal(chromeVersion('0.2.0-rc.3'),'0.1.99.3');assert.equal(chromeVersion('0.2.0'),'0.2.0');assert.throws(()=>chromeVersion('0.2.0-rc.0'),{code:'RELEASE_VERSION_INVALID'});
 const dir=await fs.mkdtemp(path.join(ROOT,'work/identity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'extension'));await fs.copyFile(path.join(ROOT,'package.json'),path.join(dir,'package.json'));await fs.writeFile(path.join(dir,'extension/manifest.json'),'{}');await assert.rejects(releaseManifest(dir),{code:'RELEASE_IDENTITY_INVALID'});
});
