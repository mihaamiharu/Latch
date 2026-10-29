import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {chromePath, eventually, command, stopBrowser, control, HEADLESS_ARGS} from './native-browser.mjs';
import {redact,sessionKey} from '../../src/playwright.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export const valueOf = value => { try{return JSON.parse(value.result)}catch{return value.result} };

export async function attachmentFixture(t, app, transport) {
  const chrome=await chromePath(), run=crypto.randomUUID();
  const versions={node:process.version,playwrightCLI:'0.1.20',chrome:(await command(chrome,['--version'])).out.trim()};
  const base=path.join(root,'work/attachment-compat');await fs.mkdir(base,{recursive:true});
  const temp=await fs.mkdtemp(path.join(base,transport+'-'));
  const profile=path.join(temp,'profile'), extension=path.join(temp,'extension'), evidence=path.join(temp,'evidence');
  const browserInbox=app.privateDownloads?path.join(temp,'browser-inbox'):undefined;
  if(browserInbox){
    await fs.mkdir(browserInbox,{mode:0o700});await fs.mkdir(path.join(profile,'Default'),{recursive:true});
    await fs.writeFile(path.join(profile,'Default/Preferences'),JSON.stringify({download:{default_directory:browserInbox,prompt_for_download:false,directory_upgrade:true}}),{mode:0o600});
  }
  const verifyInbox=async()=>{
    if(!browserInbox)return;
    const prefs=JSON.parse(await fs.readFile(path.join(profile,'Default/Preferences'),'utf8'));
    if(prefs.download?.default_directory!==browserInbox||prefs.download?.prompt_for_download!==false)throw new Error('Private download inbox was not retained; refusing to trigger downloads.');
  };
  const runtime=`/tmp/latch-ab-${crypto.randomBytes(5).toString('hex')}`;
  const cliBrowser=path.join(temp,'headless-browser');
  await fs.mkdir(evidence);await fs.cp(path.join(root,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json')));
  if(transport==='native')manifest.permissions.push('debugger');
  await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const extensionId=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)]
    .map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
  const hostName=`com.latch.compat_${crypto.randomBytes(5).toString('hex')}`;
  await fs.writeFile(path.join(extension,'protocol.js'),(await fs.readFile(path.join(extension,'protocol.js'),'utf8')).replace("'com.qa_browser.bridge'",JSON.stringify(hostName)));
  const env={...process.env,DEBUG:app.protocolEvidence?'pw:protocol':'',QA_BROWSER_RUNTIME_DIR:runtime,QA_BROWSER_CONFIG:path.join(temp,'config.json'),
    PWTEST_DAEMON_SESSION_DIR:path.join(temp,'daemon'),NO_UPDATE_NOTIFIER:'1',
    PLAYWRIGHT_MCP_EXECUTABLE_PATH:cliBrowser,PWTEST_EXTENSION_USER_DATA_DIR:profile};
  const workspaces=[];for(const name of ['a','b','outsider']){const p=path.join(temp,name);await fs.mkdir(p);workspaces.push(p)}
  let browser, registration, setupBrowser, identity, deliveryServer, deliveryURL, closed=false;
  const hosts=path.join(profile,'NativeMessagingHosts'), hostFile=path.join(hosts,hostName+'.json');
  const official=process.env.QA_BROWSER_OFFICIAL_EXTENSION||path.join(root,'work/browser-bridge/official-extension');
  const extensions=[extension];
  if(transport==='official') {
    await fs.access(path.join(official,'manifest.json'));
    versions.officialExtension=JSON.parse(await fs.readFile(path.join(official,'manifest.json'))).version;
    const which=await command('which',['playwright-cli']);const executable=await fs.realpath(which.out.trim());
    const module=process.env.QA_BROWSER_PLAYWRIGHT_MODULE||path.join(path.dirname(executable),'node_modules/playwright-core/index.mjs');
    const {chromium}=await import(pathToFileURL(module).href);
    const token=crypto.randomUUID();env.PLAYWRIGHT_MCP_EXTENSION_TOKEN=token;
    // One-time authorization setup in this disposable profile only. The actual
    // comparison below relaunches Chrome without a driver/debugging connection.
    setupBrowser=await chromium.launchPersistentContext(profile,{executablePath:chrome,channel:'chromium',headless:true,
      args:['--use-mock-keychain','--password-store=basic',`--disable-extensions-except=${official}`,`--load-extension=${official}`]});
    try {
      const page=await setupBrowser.newPage();await page.goto('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html');
      await page.evaluate(token=>localStorage.setItem('auth-token',token),token);
    } finally {await setupBrowser.close();setupBrowser=undefined;}
    extensions.push(official);
    // Full Chrome headless does not reliably deliver a connect URL to an
    // already-running process on macOS. Adapt only URL delivery in this fixture:
    // the unmodified CLI invokes its configured launcher, and the fixture opens
    // the normal official connect page. No automation protocol is substituted.
    const queue=[],route='/'+crypto.randomBytes(32).toString('hex');
    deliveryServer=http.createServer((req,res)=>{
      res.setHeader('Access-Control-Allow-Origin',`chrome-extension://${extensionId}`);
      if(req.url!==route){res.writeHead(404);res.end();return}
      if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(queue.shift()||null));return}
      if(req.method!=='POST'||queue.length>=4){res.writeHead(400);res.end();return}
      let body='';req.on('data',b=>{body+=b;if(body.length>16384)req.destroy()});req.on('end',()=>{
        try{const u=new URL(JSON.parse(body));if((u.protocol!=='chrome-extension:'||u.hostname!=='mmlmfjhmonkocbjadbfplnigmagldckm')||u.pathname!=='/connect.html')throw new Error();queue.push(u.href);res.end('ok')}
        catch{res.writeHead(400);res.end()}
      });
    });
    await new Promise(resolve=>deliveryServer.listen(0,'127.0.0.1',resolve));
    deliveryURL=`http://127.0.0.1:${deliveryServer.address().port}${route}`;
    t.after(()=>new Promise(resolve=>{deliveryServer.close(resolve);deliveryServer.closeAllConnections()}));
    const client=path.join(temp,'deliver-connect-url.mjs');
    await fs.writeFile(client,`import http from 'node:http';const url=process.argv.find(a=>a.startsWith('chrome-extension://'));if(!url)process.exit(1);const body=JSON.stringify(url);const r=http.request(${JSON.stringify(deliveryURL)},{method:'POST',headers:{'Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===200?0:1))});r.on('error',()=>process.exit(1));r.end(body);`);
    await fs.writeFile(cliBrowser,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(client)} "$@"\n`,{mode:0o700});
  }else{
    await fs.writeFile(cliBrowser,`#!/bin/sh\nexec ${quote(chrome)} --headless=new --use-mock-keychain --password-store=basic "$@"\n`,{mode:0o700});
  }
  const launcher=path.join(temp,'native-host');
  await fs.writeFile(launcher,`#!/bin/sh\nexport QA_BROWSER_RUNTIME_DIR=${quote(runtime)}\nexec ${quote(process.execPath)} ${quote(path.join(root,'src/native-host.mjs'))} "$@" 2>>${quote(path.join(temp,'native.stderr.log'))}\n`,{mode:0o700});
  await fs.mkdir(hosts,{recursive:true});
  registration=JSON.stringify({name:hostName,description:'Attachment comparison fixture',type:'stdio',path:launcher,allowed_origins:[`chrome-extension://${extensionId}/`]});
  await fs.writeFile(hostFile,registration,{mode:0o600,flag:'wx'});
  const seed=`(async()=>{const w=await chrome.windows.create({url:${JSON.stringify(['a','b','outsider'].map(name=>app.origin+'/root#'+encodeURIComponent(run+':'+name)))},type:'normal'});await fetch(${JSON.stringify(app.origin+'/__seed')},{method:'POST',body:JSON.stringify({run,tabs:w.tabs.map(t=>t.id)})})})().catch(e=>console.error('Fixture provisioning failed',e.message));`;
  const delivery=deliveryURL?`setInterval(async()=>{try{const url=await(await fetch(${JSON.stringify(deliveryURL)})).json();if(url)await chrome.tabs.create({url})}catch{}},100);`:'';
  await fs.writeFile(path.join(extension,'fixture-seed.js'),`const run=${JSON.stringify(run)};${seed}${delivery}`);
  await fs.appendFile(path.join(extension,'background.js'),"\nimport './fixture-seed.js';\n");
  const progress=(kind,index,operation,event)=>fs.appendFile(path.join(temp,'progress.jsonl'),JSON.stringify({kind,index,operation,event,at:Date.now()})+'\n');
  const protocolEvents=async()=>{
    const events=[];
    for(const dir of await fs.readdir(path.join(temp,'daemon')).catch(()=>[])){
      const file=path.join(temp,'daemon',dir,'agent.err');
      const stat=await fs.stat(file).catch(()=>null);if(!stat)continue;
      if(stat.size>64*1024*1024)throw new Error('Private protocol log exceeded fixture bound.');
      for(const line of (await fs.readFile(file,'utf8')).split('\n')){
        const match=line.match(/pw:protocol.*?RECV.*?(\{.*)/);if(!match)continue;
        let m;try{m=JSON.parse(match[1])}catch{continue}
        const p=m.params||{},info=p.targetInfo||{};
        if(['Target.attachedToTarget','Target.detachedFromTarget'].includes(m.method))
          events.push({daemon:dir,method:m.method,sessionId:m.sessionId,childSessionId:p.sessionId,targetId:info.targetId||p.targetId,type:info.type});
        if(['Page.frameAttached','Page.frameDetached'].includes(m.method))
          events.push({daemon:dir,method:m.method,sessionId:m.sessionId,frameId:p.frameId,parentFrameId:p.parentFrameId,reason:p.reason});
        if(['Page.fileChooserOpened','Page.downloadWillBegin','Page.downloadProgress','Browser.downloadWillBegin','Browser.downloadProgress'].includes(m.method))
          events.push({daemon:dir,method:m.method,sessionId:m.sessionId,frameId:p.frameId,guid:p.guid,state:p.state,suggestedFilename:p.suggestedFilename,receivedBytes:p.receivedBytes,totalBytes:p.totalBytes,mode:p.mode,filePathPresent:!!p.filePath});
      }
    }
    if(events.length>4096)throw new Error('Protocol metadata exceeded fixture bound.');
    return events;
  };
  const nativeStatus=async()=>transport==='native'?control(path.join(runtime,identity.instanceId+'.sock'),{v:1,id:crypto.randomUUID(),op:'native-status',payload:{...identity,sessionKey:sessionKey(workspaces[0],'agent')}}):undefined;
  const captureTrace=async index=>{
    if(!identity||transport!=='native')return;
    const payload={...identity,sessionKey:sessionKey(workspaces[index],'agent')};
    const trace=await control(path.join(runtime,identity.instanceId+'.sock'),{v:1,id:crypto.randomUUID(),op:'native-trace',payload}).catch(()=>null);
    // Explicit test disconnects happen before final fixture teardown. Preserve
    // their live trace; a later empty session must not overwrite it.
    const status=await nativeStatus().catch(()=>null);if(status?.sessions?.length)await fs.writeFile(path.join(evidence,'native-status.json'),JSON.stringify(status,null,2));
    if(trace?.length)await fs.writeFile(path.join(evidence,`trace-${index}.json`),JSON.stringify(trace,null,2));
  };
  const latch=async(index,args,{fail=false}={})=>{
    if(args[0]==='disconnect')await captureTrace(index);
    await progress('latch',index,args[0],'start');
    const result=await command(process.execPath,[path.join(root,'skills/latch/scripts/latch.mjs'),...args,'--workspace',workspaces[index]],{cwd:workspaces[index],env});
    await progress('latch',index,args[0],'done');
    const parsed=JSON.parse(result.out||result.err);
    if(result.code!==(fail?1:0))throw new Error(`Latch ${args[0]} failed: ${redact(JSON.stringify(parsed))}`);
    return parsed;
  };
  const pw=async(index,args,{fail=false}={})=>{
    await progress('playwright',index,args[0],'start');
    const result=await command('playwright-cli',['-s=agent','--json',...args],{cwd:workspaces[index],env});
    await progress('playwright',index,args[0],'done');
    const parsed=JSON.parse(result.out);
    if(!fail&&(result.code!==0||parsed.isError)) {
      await fs.writeFile(path.join(evidence,'last-error.txt'),redact(JSON.stringify(parsed)));
      throw new Error(`Playwright ${args[0]} failed: ${redact(JSON.stringify(parsed))}`);
    }
    return parsed;
  };
  const close=async()=>{
    if(closed)return;closed=true;
    await app.saveEvidence?.(evidence);
    await fs.writeFile(path.join(evidence,'fixture-state.json'),JSON.stringify([...app.states.values()].filter(state=>state.actor.startsWith(run)),null,2));
    for(let i=0;i<2;i++)await captureTrace(i);
    for(let i=0;i<workspaces.length;i++){
      await latch(i,['disconnect','--profile','work','--session','agent']).catch(()=>{});
      await pw(i,['detach']).catch(()=>{});
    }
    if(app.protocolEvidence)await fs.writeFile(path.join(evidence,'protocol-targets.json'),JSON.stringify(await protocolEvents(),null,2));
    await stopBrowser(browser);await setupBrowser?.close().catch(()=>{});
    if(await fs.readFile(hostFile,'utf8').catch(()=>'')===registration)await fs.unlink(hostFile);
    await fs.rm(runtime,{recursive:true,force:true});
  };
  t.after(close);
  const args=[...HEADLESS_ARGS,`--user-data-dir=${profile}`,'--profile-directory=Default','--no-first-run','--no-default-browser-check',
    '--use-mock-keychain','--password-store=basic','--disable-background-networking','--enable-logging=stderr',
    `--disable-extensions-except=${extensions.join(',')}`,`--load-extension=${extensions.join(',')}`,...(app.launchArgs||[]),'about:blank'];
  const log=await fs.open(path.join(temp,'chrome.stderr.log'),'w');browser=spawn(chrome,args,{stdio:['ignore','ignore',log.fd]});await log.close();
  console.log(`${transport} comparison: ${temp}`);
  identity=await eventually(async()=> (await latch(0,['discover'])).profiles[0],20000);
  await latch(0,['pair','--profile','work','--instance',identity.instanceId,'--chrome-profile-dir','Default']);
  await eventually(()=>app.seeds.has(run)&&[...app.states.values()].filter(s=>s.actor.startsWith(run)&&s.role===(app.rootRole||'/root')).length===3);
  const seedInfo=app.seeds.get(run);
  await verifyInbox();
  return {run,temp,profile,evidence,identity,workspaces,env,transport,versions,headless:true,browserPID:browser.pid,nativeStatus,browserInbox,verifyInbox,connectionPageDelivery:deliveryURL?'fixture-only URL delivery shim':'not needed',launchArgs:[...HEADLESS_ARGS,...(app.launchArgs||[])],protocolEvents,tabs:seedInfo.tabs,latch,pw,close,
    connect:async(index,tabId,{background=false}={})=>latch(index,['connect','--profile','work','--transport',transport,
      ...(background&&transport==='native'?['--focus-emulation','on']:[]),'--session','agent','--tab',String(tabId)]),
    states:()=>[...app.states.values()].filter(state=>state.actor.startsWith(run))};
}
