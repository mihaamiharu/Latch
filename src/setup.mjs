import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,EXTENSION_ID,HOST_NAME,hash,quote,verifyKit,filesIn,releaseManifest} from './release.mjs';
import {privateDirectory,readConfig,socketPath,configPath,rootDir} from './local.mjs';
import {fault} from '../extension/protocol.js';
import {assertVersion} from './playwright.mjs';
import {targetsFor} from './install-skills.mjs';
const exec=promisify(execFile);
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const optional=async p=>{try{return await fs.readFile(p,'utf8')}catch(e){if(e.code==='ENOENT')return null;throw e}};
export function setupPaths(options={}){
 const root=path.resolve(options.root||path.join(os.homedir(),'Library/Application Support/Work Browser Bridge/runtime'));
 return {root,configuration:configPath(),runtimeDirectory:rootDir(),releases:path.join(root,'releases'),extension:path.join(root,'extension'),current:path.join(root,'current'),receipt:path.join(root,'receipt.json'),transaction:path.join(root,'transaction.json'),gate:path.join(root,'setup.lock'),registration:path.join(options.registrationRoot||path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts'),HOST_NAME+'.json'),node:options.node||process.execPath};
}
async function ownedRoot(p){
 let stat;try{stat=await fs.lstat(p.root)}catch(e){if(e.code!=='ENOENT')throw e}
 if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw fault('INSTALL_ROOT_FOREIGN','Installation root must be a dedicated owned directory.');
 if(stat){const marker=await optional(path.join(p.root,'.latch-root.json'));if(marker){if(JSON.parse(marker).extensionId!==EXTENSION_ID)throw fault('INSTALL_ROOT_FOREIGN','Installation marker differs.');}else if((await fs.readdir(p.root)).length)throw fault('INSTALL_ROOT_FOREIGN','Nonempty unowned installation directory; preserved.');}
 await privateDirectory(p.root);const marker=path.join(p.root,'.latch-root.json');try{await fs.writeFile(marker,JSON.stringify({extensionId:EXTENSION_ID,schema:1}),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}
}
async function atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,value,{flag:'wx',mode:0o600});await fs.rename(temp,file)}
async function pointer(file,target){const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.symlink(target,temp,'dir');await fs.rename(temp,file)}
async function unreachable(instance){
 return new Promise((resolve,reject)=>{const socket=net.createConnection(socketPath(instance));const done=(error,value)=>{socket.destroy();error?reject(error):resolve(value)};socket.once('connect',()=>done(null,false));socket.once('error',e=>['ENOENT','ECONNREFUSED'].includes(e.code)?done(null,true):done(fault('BRIDGE_ACCESS_DENIED','Cannot establish maintenance: '+e.code)));socket.setTimeout(1000,()=>done(fault('MAINTENANCE_UNVERIFIED','Bridge liveness is uncertain.')))});
}
async function maintenance(options){
 const profiles=(await readConfig()).profiles||{};
 if(!options.extensionUnloaded||!options.tasksDrained)throw fault('MAINTENANCE_UNVERIFIED','Drain tasks and unload the target extension before activation. The flags record operator attestation, not automatic browser verification.');
 for(const profile of Object.values(profiles))if(!await unreachable(profile.instanceId))throw fault('INSTALL_ACTIVE','A configured bridge is still reachable. No activation was performed.');
 return {operatorAttested:true,configuredBridgesUnreachable:true};
}
async function legacyOwnership(options,p,registration){
 if(!options.legacyRoot)return null;
 const legacy=path.resolve(options.legacyRoot),preview=await json(path.join(legacy,'install/preview.json'));
 const source=await optional(path.join(legacy,'install',HOST_NAME+'.json'));
 if(preview.extensionId!==EXTENSION_ID||preview.hostManifestDestination!==p.registration||source!==registration)throw fault('INSTALL_FOREIGN_REGISTRATION','Legacy installation evidence does not match this registration.');
 const manifest=JSON.parse(source);
 if(manifest.name!==HOST_NAME||manifest.path!==path.join(legacy,'install/native-host')||JSON.stringify(manifest.allowed_origins)!==JSON.stringify([`chrome-extension://${EXTENSION_ID}/`]))throw fault('INSTALL_FOREIGN_REGISTRATION','Legacy registration identity differs.');
 if(!options.rollbackKit)throw fault('ROLLBACK_KIT_REQUIRED','Supply a retained complete 0.1.2 rollback kit.');
 const pkg=await json(path.join(options.rollbackKit,'package.json')),old=await releaseManifest(path.resolve(options.rollbackKit));
 if(pkg.version!=='0.1.2'||old.key!== (await releaseManifest()).key)throw fault('ROLLBACK_KIT_INVALID','Expected the retained 0.1.2 compatibility payload.');
 return {legacy,rollbackKit:path.resolve(options.rollbackKit)};
}
export async function inspectSetup(options={}){
 const p=setupPaths(options),kit=path.resolve(options.kit||ROOT),release=await verifyKit(kit);
 const nodeVersion=(await exec(p.node,['-p','process.version'],{timeout:5000})).stdout.trim();
 if(nodeVersion!==release.nodeVersion)throw fault('SETUP_NODE_VERSION','Validated Node executable required: '+release.nodeVersion);
 await assertVersion({workspace:kit,timeout:10000});
 const rawReceipt=await optional(p.receipt),receipt=rawReceipt?JSON.parse(rawReceipt):null,registration=await optional(p.registration);
 let legacy=null;
 if(registration&&registration!==receipt?.registration)legacy=await legacyOwnership(options,p,registration);
 if(registration&&registration!==receipt?.registration&&!legacy)throw fault('INSTALL_FOREIGN_REGISTRATION','Existing native registration is not owned by this installation.');
 let activePointer=null,extensionInventory=null;
 if(receipt){
  activePointer=await fs.realpath(p.current);if(activePointer!==receipt.active)throw fault('INSTALL_CHANGED','Active release selection changed.');
  extensionInventory=await extensionValid(p,await payloadValid(receipt.active));
 }
 const existingManifest=receipt?await json(path.join(p.extension,'manifest.json')):legacy?await json(path.join(legacy.rollbackKit,'extension/manifest.json')):null;
 const permissionDelta=(await json(path.join(kit,'extension/manifest.json'))).permissions.filter(name=>!existingManifest?.permissions?.includes(name));
 const gate=await fs.lstat(p.gate).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e});
 const token=hash(JSON.stringify({activePointer,extensionInventory,release:hash(await fs.readFile(path.join(kit,'release.json'))),root:p.root,registration,node:p.node,receipt:rawReceipt,configuration:p.configuration,runtimeDirectory:p.runtimeDirectory,legacy,skillLinks:receipt?.skillLinks||[]}));
 return {paths:p,kit,release,receipt,registration,legacy,gate,transaction:await optional(p.transaction),planToken:token,permissionDelta,changes:{registrationPath:registration?JSON.parse(registration).path:null,newRegistrationPath:path.join(p.root,'bin/native-host'),extensionDirectory:p.extension},blockers:gate?['SETUP_BUSY']:[]};
}
export async function stageSetup(options={}){
 const plan=await inspectSetup(options);if(plan.gate)throw fault('SETUP_BUSY','An installer transaction already exists; inspect it without removing its gate.');
 await ownedRoot(plan.paths);await privateDirectory(plan.paths.releases);
 const id=plan.release.version+'-'+hash(await fs.readFile(path.join(plan.kit,'release.json'))).slice(0,12),dest=path.join(plan.paths.releases,id);
 try{await fs.access(dest);if(hash(await fs.readFile(path.join(dest,'release.json')))!==hash(await fs.readFile(path.join(plan.kit,'release.json'))))throw fault('RELEASE_HASH_CHANGED','Staged release descriptor changed.');await verifyKit(dest)}catch(e){if(e.code!=='ENOENT')throw e;const temp=await fs.mkdtemp(path.join(plan.paths.releases,'.stage-'));try{await fs.cp(plan.kit,temp,{recursive:true});await verifyKit(temp);await fs.rename(temp,dest)}catch(error){await fs.rm(temp,{recursive:true,force:true});throw error}}
 return {...plan,staged:dest,releaseId:id};
}
async function snapshotLegacy(plan){
 const src=plan.legacy.rollbackKit,dest=await fs.mkdtemp(path.join(plan.paths.releases,'legacy-0.1.2-'));
 for(const dir of ['src','extension','skills/latch','third_party/playwright']){try{await fs.cp(path.join(src,dir),path.join(dest,dir),{recursive:true})}catch(e){if(e.code!=='ENOENT')throw e}}
 for(const name of ['package.json','package-lock.json']){const raw=await optional(path.join(src,name));if(raw!==null)await fs.writeFile(path.join(dest,name),raw)}
 const files={};for(const name of await filesIn(dest))files[name]=hash(await fs.readFile(path.join(dest,name)));
 await fs.writeFile(path.join(dest,'legacy-release.json'),JSON.stringify({version:'0.1.2',files}));return dest;
}
async function payloadValid(dir){
 const raw=await optional(path.join(dir,'legacy-release.json'));if(!raw)return verifyKit(dir);
 const legacy=JSON.parse(raw);if(legacy.version!=='0.1.2'||JSON.stringify((await filesIn(dir)).filter(n=>n!=='legacy-release.json'))!==JSON.stringify(Object.keys(legacy.files).sort()))throw fault('ROLLBACK_KIT_CHANGED','Retained legacy inventory changed.');for(const [name,digest] of Object.entries(legacy.files))if(hash(await fs.readFile(path.join(dir,name)))!==digest)throw fault('ROLLBACK_KIT_CHANGED','Retained legacy payload changed.');return legacy;
}
async function extensionValid(p,descriptor){
 const inventory={};for(const name of await filesIn(p.extension)){inventory[name]=hash(await fs.readFile(path.join(p.extension,name)));if(inventory[name]!==descriptor.files['extension/'+name])throw fault('INSTALL_CHANGED','Stable extension files changed.');}
 if(Object.keys(descriptor.files).filter(n=>n.startsWith('extension/')).length!==Object.keys(inventory).length)throw fault('INSTALL_CHANGED','Stable extension inventory changed.');return inventory;
}
async function installBoot(p){
 await privateDirectory(path.join(p.root,'bin'));
 const source=`import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';try{const root=path.dirname(fileURLToPath(import.meta.url)),receipt=JSON.parse(await fs.readFile(path.join(root,'receipt.json'),'utf8')),release=await fs.realpath(path.join(root,'current'));if(release!==receipt.active)throw new Error('Active release/receipt mismatch');process.env.QA_BROWSER_CONFIG=receipt.configuration;process.env.QA_BROWSER_RUNTIME_DIR=receipt.runtimeDirectory;const mode=process.argv[2];if(!['native-host','cli'].includes(mode))throw new Error('Invalid launcher');const target=path.join(release,'src',mode+'.mjs');process.argv=[process.argv[0],target,...process.argv.slice(3)];await import(pathToFileURL(target).href)}catch(e){process.stderr.write(JSON.stringify({ok:false,error:{code:'LATCH_ACTIVE_RUNTIME_UNAVAILABLE',message:e.message}})+'\\n');process.exitCode=1}`;
 await atomic(path.join(p.root,'boot.mjs'),source);
 for(const [name,mode] of [['native-host','native-host'],['qa-browser','cli']]){const file=path.join(p.root,'bin',name);await atomic(file,`#!/bin/sh\nexec ${quote(p.node)} ${quote(path.join(p.root,'boot.mjs'))} ${quote(mode)} "$@"\n`);await fs.chmod(file,0o700)}
}
async function replaceExtension(p,source){
 const temp=await fs.mkdtemp(path.join(p.root,'.extension-'));await fs.cp(path.join(source,'extension'),temp,{recursive:true});const old=path.join(p.root,'.extension-previous');
 if(await fs.lstat(old).catch(e=>{if(e.code==='ENOENT')return null;throw e}))throw fault('INSTALL_RECOVERY_BLOCKED','Previous extension directory requires inspection; preserved.');
 try{await fs.rename(p.extension,old)}catch(e){if(e.code!=='ENOENT')throw e}
 try{await fs.rename(temp,p.extension)}catch(e){await fs.rename(old,p.extension).catch(()=>{});throw e}
 await fs.rm(old,{recursive:true,force:true});
}
async function transaction(p,fn){
 await ownedRoot(p);
 try{await fs.mkdir(p.gate,{mode:0o700})}catch(e){if(e.code==='EEXIST')throw fault('SETUP_BUSY','An installer transaction gate exists; PID/age do not authorize removal.');throw e}
 const nonce=crypto.randomUUID();await fs.writeFile(path.join(p.gate,'owner.json'),JSON.stringify({nonce,pid:process.pid}),{mode:0o600});
 let release=true;try{return await fn()}catch(e){if(e.retainGate)release=false;throw e}finally{if(release){await fs.unlink(path.join(p.gate,'owner.json'));await fs.rmdir(p.gate)}}
}
export async function activateSetup(options={}){
 const staged=await stageSetup(options),p=staged.paths;
 if(options.expect!==staged.planToken)throw fault('SETUP_PLAN_CHANGED','Inspect the current installation plan before activating.');
 return transaction(p,async()=>{
  const fresh=await inspectSetup(options);if(fresh.planToken!==options.expect)throw fault('SETUP_PLAN_CHANGED','Installation changed before activation.');
  // The gate created by this transaction is expected here; no other gate is reclaimed.
  const proof=await maintenance(options),priorActive=fresh.receipt?.active||(fresh.legacy?await snapshotLegacy(fresh):null);
  const previous=priorActive===staged.staged?fresh.receipt.previous:priorActive;
  const launchers=[];for(const file of ['boot.mjs','bin/native-host','bin/qa-browser']){const full=path.join(p.root,file),raw=await optional(full);launchers.push({file:full,raw,mode:raw===null?null:(await fs.stat(full)).mode&0o777})}
  const before={receipt:await optional(p.receipt),registration:await optional(p.registration),active:priorActive};
  await atomic(p.transaction,JSON.stringify({state:'activating',candidate:staged.staged,before,proof}));
  try{
   await installBoot(p);await pointer(p.current,staged.staged);await replaceExtension(p,staged.staged);
   const registration=JSON.stringify({name:HOST_NAME,description:'Latch local browser transport',path:path.join(p.root,'bin/native-host'),type:'stdio',allowed_origins:[`chrome-extension://${EXTENSION_ID}/`]},null,2)+'\n';
   await privateDirectory(path.dirname(p.registration));await atomic(p.registration,registration);
   const receipt={schema:1,version:staged.release.version,chromeVersion:staged.release.chromeVersion,configuration:p.configuration,runtimeDirectory:p.runtimeDirectory,active:staged.staged,previous,registration,node:p.node,extensionId:EXTENSION_ID,skillLinks:fresh.receipt?.skillLinks||[],skillBefore:fresh.receipt?.skillBefore||[],legacySkillSource:fresh.receipt?.legacySkillSource||(fresh.legacy?path.join(fresh.legacy.legacy,'skills/latch'):null),maintenance:proof};await atomic(p.receipt,JSON.stringify(receipt,null,2)+'\n');
   await atomic(p.transaction,JSON.stringify({state:'activated-awaiting-browser-verification',active:staged.staged,previous}));
   return {activated:true,verified:false,version:receipt.version,extensionDirectory:p.extension,cli:path.join(p.root,'bin/qa-browser'),retainedPrevious:previous};
  }catch(e){
   try{
   if(before.active){await pointer(p.current,before.active);await replaceExtension(p,before.active)}else{await fs.unlink(p.current).catch(()=>{});await fs.rm(p.extension,{recursive:true,force:true})}
   for(const [file,raw] of [[p.receipt,before.receipt],[p.registration,before.registration]])raw===null?await fs.unlink(file).catch(()=>{}):await atomic(file,raw);
   for(const item of launchers){if(item.raw===null)await fs.unlink(item.file).catch(error=>{if(error.code!=='ENOENT')throw error});else{await atomic(item.file,item.raw);await fs.chmod(item.file,item.mode)}}
   await atomic(p.transaction,JSON.stringify({state:'activation-failed-restored',code:e.code||'SETUP_FAILED'}));
   }catch(restoreError){const failure=fault('SETUP_ROLLBACK_UNCONFIRMED','Activation failed and restoration is unconfirmed; transaction gate retained.');failure.retainGate=true;throw failure}
   throw e;
  }
 });
}
export async function rollbackSetup(options={}){
 const p=setupPaths(options);return transaction(p,async()=>{
  const raw=await optional(p.receipt),receipt=JSON.parse(raw);if(!receipt.previous)throw fault('ROLLBACK_UNAVAILABLE','No retained previous release.');await maintenance(options);
  if(await optional(p.registration)!==receipt.registration||await fs.realpath(p.current)!==receipt.active)throw fault('INSTALL_CHANGED','Installed selection or registration changed; rollback was not applied.');
  await extensionValid(p,await payloadValid(receipt.active));
  const old=await payloadValid(receipt.previous),active=receipt.active,restore=[];
  if(old.version==='0.1.2')for(const item of receipt.skillBefore||[]){if(item.target===null)continue;const stat=await fs.lstat(item.path).catch(()=>null);if(!stat?.isSymbolicLink()||path.resolve(path.dirname(item.path),await fs.readlink(item.path))!==path.join(p.current,'skills/latch'))throw fault('SKILL_CONFLICT','A skill changed; rollback cannot overwrite it.');restore.push(item)}
  const restored=[];
  await atomic(p.transaction,JSON.stringify({state:'rolling-back',before:receipt}));
  try{
   await pointer(p.current,receipt.previous);await replaceExtension(p,receipt.previous);
   for(const item of restore){await pointer(item.path,item.target);restored.push(item.path)}
   const next={...receipt,active:receipt.previous,previous:active,version:old.version,chromeVersion:old.chromeVersion||old.version,skillLinks:receipt.skillLinks.filter(p=>!restored.includes(p))};await atomic(p.receipt,JSON.stringify(next,null,2)+'\n');await atomic(p.transaction,JSON.stringify({state:'rollback-awaiting-browser-verification',active:next.active}));return {rolledBack:true,verified:false,version:old.version,extensionDirectory:p.extension};
  }catch(error){try{for(const file of restored)await pointer(file,path.join(p.current,'skills/latch'));await pointer(p.current,active);await replaceExtension(p,active);await atomic(p.receipt,raw);await atomic(p.transaction,JSON.stringify({state:'rollback-failed-restored',code:error.code||'SETUP_FAILED'}))}catch(restoreError){const failure=fault('SETUP_ROLLBACK_UNCONFIRMED','Rollback restoration is unconfirmed; transaction gate retained.');failure.retainGate=true;throw failure}throw error}
 });
}
export async function verifySetup(options={}){
 const p=setupPaths(options),receipt=await json(p.receipt);await extensionValid(p,await payloadValid(receipt.active));
 if(await fs.realpath(p.current)!==receipt.active||await optional(p.registration)!==receipt.registration)throw fault('INSTALL_CHANGED','Installed registration or active release changed.');
 const result=await exec(path.join(p.root,'bin/qa-browser'),['diagnose','--profile',options.profile||'work'],{timeout:15000});const health=JSON.parse(result.stdout);
 if(!health.healthy)throw fault('INSTALL_NOT_READY','Installed profile is not ready. Inspect diagnostics.');
 if(receipt.version!=='0.1.2'&&(health.connection?.extensionVersion!==receipt.chromeVersion||health.connection?.releaseVersion!==receipt.version||health.connection?.capabilities?.nativeSessionSchema!==4||health.connection?.capabilities?.uiControl!==1))throw fault('INSTALL_CAPABILITY_MISMATCH','Reload/accept the candidate extension before verifying.');
 return {verified:true,scope:'identity-and-readiness',applicationSmokeRequired:true,version:receipt.version,health};
}
export async function setupSkills(options={}){
 const p=setupPaths(options);return transaction(p,async()=>{
  const receipt=await json(p.receipt),target=path.join(p.current,'skills/latch');await fs.access(path.join(target,'SKILL.md'));const links=targetsFor(options.userRoot).map(t=>t.path),before=[];
  for(const file of links){try{const stat=await fs.lstat(file);if(!stat.isSymbolicLink())throw fault('SKILL_CONFLICT','An unrelated skill directory exists.');const raw=await fs.readlink(file),resolved=path.resolve(path.dirname(file),raw);let canonical;try{canonical=await fs.realpath(file)}catch{canonical=resolved}let legacy;try{legacy=receipt.legacySkillSource&&await fs.realpath(receipt.legacySkillSource)}catch{}if(!(receipt.skillLinks.includes(file)&&resolved===target)&&!(legacy&&canonical===legacy))throw fault('SKILL_CONFLICT','An unrelated skill link exists.');before.push({path:file,target:raw})}catch(e){if(e.code!=='ENOENT')throw e;before.push({path:file,target:null})}}
  const changed=[];
  try{for(const item of before){if(item.target===target)continue;await fs.mkdir(path.dirname(item.path),{recursive:true});await pointer(item.path,target);changed.push(item)}const prior=receipt.skillBefore.length?receipt.skillBefore:before;await atomic(p.receipt,JSON.stringify({...receipt,skillLinks:links,skillBefore:prior},null,2)+'\n')}catch(e){for(const item of changed.reverse())item.target===null?await fs.unlink(item.path):await pointer(item.path,item.target);throw e}return {skillsInstalled:true,links};
 });
}
export async function uninstallSetup(options={}){
 const p=setupPaths(options);return transaction(p,async()=>{
  const receipt=await json(p.receipt);await maintenance(options);if(await optional(p.registration)!==receipt.registration)throw fault('INSTALL_FOREIGN_REGISTRATION','Registration differs; preserved.');
  for(const file of receipt.skillLinks){const stat=await fs.lstat(file).catch(()=>null);if(stat?.isSymbolicLink()&&path.resolve(path.dirname(file),await fs.readlink(file))===path.join(p.current,'skills/latch'))await fs.unlink(file)}await fs.unlink(p.registration);await atomic(p.transaction,JSON.stringify({state:'unregistered',dataPreserved:true}));return {unregistered:true,dataPreserved:true};
 });
}
