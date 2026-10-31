import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {build} from '../src/build.mjs';import {ROOT,hash,verifyKit,chromeVersion,releaseManifest} from '../src/release.mjs';
import {SUPPORT,assertMacOSVersion} from '../src/compatibility.mjs';
test('native release is reproducible, complete and leaves source/integration untouched',async t=>{
 const dir=await fs.mkdtemp(path.join(ROOT,'work/release-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const before=await fs.readFile(path.join(ROOT,'extension/manifest.json'));
 const a=await build({out:path.join(dir,'a')}),b=await build({out:path.join(dir,'b')});assert.deepEqual(a.archives.map(x=>x.sha256),b.archives.map(x=>x.sha256));assert.equal(hash(await fs.readFile(path.join(ROOT,'extension/manifest.json'))),hash(before));
 const descriptor=await verifyKit(a.kit);assert.equal(descriptor.version,'0.2.0-rc.5');const manifest=JSON.parse(await fs.readFile(path.join(a.kit,'extension/manifest.json')));assert.ok(manifest.permissions.includes('debugger'));assert.ok(manifest.permissions.includes('alarms'));assert.ok(!manifest.host_permissions&&!manifest.content_scripts&&!manifest.externally_connectable);
 assert.deepEqual(descriptor.support,SUPPORT);assert.equal(manifest.minimum_chrome_version,'147');assert.equal(JSON.parse(before).minimum_chrome_version,'120');assert.equal(JSON.parse(await fs.readFile(path.join(a.kit,'package.json'))).engines.node,'22.21.1');assert.ok(descriptor.files['skills/latch/assets/icon.png']);
 const descriptorFile=path.join(a.kit,'release.json'),originalDescriptor=await fs.readFile(descriptorFile),manifestFile=path.join(a.kit,'extension/manifest.json'),originalManifest=await fs.readFile(manifestFile);
 delete descriptor.support;await fs.writeFile(descriptorFile,JSON.stringify(descriptor));await assert.rejects(verifyKit(a.kit),{code:'RELEASE_SUPPORT_INVALID'});
 descriptor.support=SUPPORT;manifest.minimum_chrome_version='120';await fs.writeFile(manifestFile,JSON.stringify(manifest));descriptor.files['extension/manifest.json']=hash(await fs.readFile(manifestFile));await fs.writeFile(descriptorFile,JSON.stringify(descriptor));await assert.rejects(verifyKit(a.kit),{code:'RELEASE_SUPPORT_INVALID'});
 await fs.writeFile(descriptorFile,originalDescriptor);await fs.writeFile(manifestFile,originalManifest);
 assert.ok(!Object.keys(descriptor.files).some(n=>/^(work|test|install|\.git|assets)\//.test(n)));await fs.appendFile(path.join(a.kit,'extension/popup.js'),'\n// changed');await assert.rejects(verifyKit(a.kit),{code:'RELEASE_HASH_CHANGED'});
});
test('missing identity and invalid Chrome version mapping fail instead of regenerating identity',async t=>{
 assert.equal(chromeVersion('0.2.0-rc.5'),'0.1.99.5');assert.equal(chromeVersion('0.2.0'),'0.2.0');assert.throws(()=>chromeVersion('0.2.0-rc.0'),{code:'RELEASE_VERSION_INVALID'});
 const dir=await fs.mkdtemp(path.join(ROOT,'work/identity-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'extension'));await fs.copyFile(path.join(ROOT,'package.json'),path.join(dir,'package.json'));await fs.writeFile(path.join(dir,'extension/manifest.json'),'{}');await assert.rejects(releaseManifest(dir),{code:'RELEASE_IDENTITY_INVALID'});
});
test('candidate OS floor is explicit and malformed or earlier versions fail closed',()=>{
 for(const version of ['26.9.9','27','27.0','invalid',''])assert.throws(()=>assertMacOSVersion(version),{code:'SETUP_MACOS_UNSUPPORTED'});
 for(const version of ['27.0.1','27.0.2','28.0'])assert.doesNotThrow(()=>assertMacOSVersion(version));
});
