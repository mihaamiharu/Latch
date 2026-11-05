#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ROOT,EXTENSION_ID,HOST_NAME,hash,filesIn,releaseManifest,verifyKit} from './release.mjs';
import {SUPPORT, requiresSupportContract} from './compatibility.mjs';

// A revision alone overstates provenance: a modified tree is not that commit.
export function sourceProvenance(root) {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  const revision=git('rev-parse','HEAD'),status=git('status','--porcelain');
  return {sourceRevision:revision.status===0?revision.stdout.trim():null,sourceDirty:status.status===0?status.stdout.trim()!=='':null};
}
export async function build({root=ROOT,out=path.join(root,'dist')}={}) {
  const manifest=await releaseManifest(root),pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const kit=path.join(out,'latch-'+pkg.version),extension=path.join(out,'latch');
  await fs.mkdir(out,{recursive:true});
  for(const p of [kit,extension])await fs.rm(p,{recursive:true,force:true});
  await fs.mkdir(kit);
  for(const folder of ['extension','src','skills/latch','third_party/playwright','node_modules/ws','integrations/herdr'])await fs.cp(path.join(root,folder),path.join(kit,folder),{recursive:true});
  for(const file of ['package.json','package-lock.json'])await fs.copyFile(path.join(root,file),path.join(kit,file));
  await fs.copyFile(path.join(root,'SETUP.md'),path.join(kit,'README.md'));
  await fs.copyFile(path.join(root,'docs/SUPPORT.md'),path.join(kit,'SUPPORT.md'));
  await fs.copyFile(path.join(root,'docs/LIVE-VIEW.md'),path.join(kit,'LIVE-VIEW.md'));
  for(const file of ['PRIVACY.md','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,file),path.join(kit,file));
  await fs.rm(path.join(kit,'src/build.mjs'));
  for(const size of [16,32,48,128])await fs.rm(path.join(kit,`extension/icons/icon-${size}.png`),{force:true});
  await fs.writeFile(path.join(kit,'extension/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const files={};for(const name of await filesIn(kit))files[name]=hash(await fs.readFile(path.join(kit,name)));
  // No clock or user-machine paths in the descriptor: identical payloads hash identically.
  const descriptor={schema:1,...sourceProvenance(root),version:pkg.version,chromeVersion:manifest.version,extensionId:EXTENSION_ID,hostName:HOST_NAME,nodeVersion:'v22.21.1',cliVersion:'0.1.20',nativeSchema:4,uiControl:1,files};
  if(requiresSupportContract(pkg.version))descriptor.support=SUPPORT;
  await fs.writeFile(path.join(kit,'release.json'),JSON.stringify(descriptor,null,2)+'\n');
  await verifyKit(kit);await fs.cp(path.join(kit,'extension'),extension,{recursive:true});
  // zip -X omits local UID metadata; fixed mtimes and sorted inputs make archives reproducible.
  const stamp=new Date('2000-01-01T00:00:00Z');
  for(const dir of [kit,extension])for(const name of await filesIn(dir)){await fs.chmod(path.join(dir,name),0o644);await fs.utimes(path.join(dir,name),stamp,stamp)}
  const archives=[];
  for(const [dir,name] of [[kit,`latch-${pkg.version}-kit.zip`],[extension,`latch-${pkg.version}.zip`]]) {
    const archive=path.join(out,name);await fs.rm(archive,{force:true});
    const zipped=spawnSync('zip',['-X','-q',archive,'-@'],{cwd:dir,input:(await filesIn(dir)).join('\n')+'\n',encoding:'utf8'});
    if(zipped.status!==0)throw new Error(zipped.stderr||'zip failed');archives.push({path:archive,sha256:hash(await fs.readFile(archive))});
  }
  return {version:pkg.version,extensionId:EXTENSION_ID,kit,unpackedDirectory:extension,archives};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try{console.log(JSON.stringify(await build(),null,2))}catch(e){console.error(JSON.stringify({ok:false,error:{code:e.code||'BUILD_FAILED',message:e.message}}));process.exitCode=1}
}
