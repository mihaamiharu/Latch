#!/usr/bin/env node
import fs from 'node:fs/promises';import path from 'node:path';
import {ROOT,EXTENSION_ID,HOST_NAME,quote} from './release.mjs';
import {inspectSetup,stageSetup,activateSetup,verifySetup,configureNativeSetup,rollbackSetup,setupSkills,uninstallSetup} from './setup.mjs';
import {assertSetupPlatform} from './compatibility.mjs';
const help=`Latch local setup (macOS)
  node src/install.mjs inspect --kit PATH [--root PATH] [--registration-root PATH] [--playwright-cli PATH]
  node src/install.mjs stage --kit PATH
  node src/install.mjs activate --kit PATH --expect PLAN_TOKEN --tasks-drained --extension-unloaded
  node src/install.mjs verify [--profile work]
  node src/install.mjs configure-native [--profile work]
  node src/install.mjs skills [--user-root PATH]
  node src/install.mjs rollback --tasks-drained --extension-unloaded
  node src/install.mjs uninstall --tasks-drained --extension-unloaded
Optional upgrade evidence: --legacy-root PATH --rollback-kit PATH
Node/CLI are external prerequisites. Activation flags are operator attestations;
they do not automatically verify Chrome's permission acceptance or unload state.
prepare writes an unregistered development preview beneath dist/setup-preview only.
`;
try{
 const args=process.argv.slice(2),command=args.shift()||'help',options={};const names={'root':'root','registration-root':'registrationRoot','kit':'kit','node':'node','playwright-cli':'playwrightCLI','legacy-root':'legacyRoot','rollback-kit':'rollbackKit','user-root':'userRoot','profile':'profile','expect':'expect','tasks-drained':'tasksDrained','extension-unloaded':'extensionUnloaded'};
 while(args.length){const key=args.shift().slice(2),name=names[key];if(!name)throw new Error('Unknown setup argument.');if(['tasksDrained','extensionUnloaded'].includes(name))options[name]=true;else{const value=args.shift();if(!value||value.startsWith('--'))throw new Error('Missing setup argument.');options[name]=value}}
 if(['help','--help'].includes(command)){console.log(help)}else if(command==='prepare'){
  await assertSetupPlatform();
  const dir=path.join(ROOT,'dist/setup-preview');await fs.mkdir(dir,{recursive:true});const nativeHostLauncher=path.join(dir,'native-host'),cli=path.join(dir,'qa-browser');
  for(const [file,source] of [[nativeHostLauncher,'native-host'],[cli,'cli']]){await fs.writeFile(file,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(ROOT,'src',source+'.mjs'))} "$@"\n`,{mode:0o700});await fs.chmod(file,0o700)}
  const hostManifestSource=path.join(dir,HOST_NAME+'.json');await fs.writeFile(hostManifestSource,JSON.stringify({name:HOST_NAME,description:'Latch development preview',path:nativeHostLauncher,type:'stdio',allowed_origins:[`chrome-extension://${EXTENSION_ID}/`]},null,2)+'\n');
  console.log(JSON.stringify({extensionId:EXTENSION_ID,nativeHostLauncher,cli,registered:false,hostManifestSource}));
 }else{
  const actions={inspect:inspectSetup,stage:stageSetup,activate:activateSetup,verify:verifySetup,'configure-native':configureNativeSetup,rollback:rollbackSetup,skills:setupSkills,uninstall:uninstallSetup};if(!actions[command])throw new Error('Unknown setup command. Use help.');
  const result=await actions[command](options);console.log(JSON.stringify({ok:true,...result},null,2));
 }
}catch(e){console.error(JSON.stringify({ok:false,error:{code:e.code||'SETUP_FAILED',message:e.message}}));process.exitCode=1}
