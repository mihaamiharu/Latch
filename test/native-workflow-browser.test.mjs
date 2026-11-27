import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromePath, eventually, command, stopBrowser, HEADLESS_ARGS} from './helpers/native-browser.mjs';
import {request} from '../src/local.mjs';
import {sessionKey} from '../src/redact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = process.env.LATCH_NATIVE_WORKFLOW === '1' && process.platform === 'darwin';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const valueOf = value => { try { return JSON.parse(value.result); } catch { return value.result; } };

test('normal Latch CLI: concurrent native workspaces, exact same-URL tabs, isolation and rollback', {skip: !enabled, timeout: 180000}, async t => {
  const chrome = await chromePath();
  const base = path.join(root, 'work/native-workflow');
  await fs.mkdir(base, {recursive: true});
  const temp = await fs.mkdtemp(path.join(base, 'run-'));
  const runtime = `/tmp/latch-multi-${crypto.randomBytes(5).toString('hex')}`;
  const oldRuntime = process.env.LATCH_RUNTIME_DIR;
  process.env.LATCH_RUNTIME_DIR = runtime;
  const projectA = path.join(temp, 'project-a'), projectB = path.join(temp, 'project-b'), projectC = path.join(temp, 'project-c');
  for (const p of [projectA, projectB, projectC]) await fs.mkdir(p);
  const evidence = path.join(temp, 'evidence'); await fs.mkdir(evidence);
  const extension = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'extension'), extension, {recursive: true});
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
  manifest.permissions = [...new Set([...manifest.permissions, 'debugger'])];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const extensionId = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
  const hostName = `com.latch.multi_${crypto.randomBytes(6).toString('hex')}`;
  const protocol = (await fs.readFile(path.join(extension, 'protocol.js'), 'utf8')).replace("'com.latch.bridge'", JSON.stringify(hostName));
  await fs.writeFile(path.join(extension, 'protocol.js'), protocol);
  const env = {...process.env, LATCH_CONFIG: path.join(temp, 'config.json'),
    PWTEST_DAEMON_SESSION_DIR: path.join(temp, 'daemon'), NO_UPDATE_NOTIFIER: '1'};
  let browser, identity, seed, registration;
  const telemetry = new Map();
  const fixture = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', `chrome-extension://${extensionId}`);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const data = JSON.parse(body);
        if (req.url === '/seed') seed = data;
        else telemetry.set(data.marker, {...data, receivedAt: Date.now()});
        res.end('ok');
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'latch_fixture=signed-in; Path=/; SameSite=Lax');
    res.end(`<title>Same URL fixture</title><h1>Multi-agent fixture</h1>
      <label>Agent <input id="name"></label><button id="save">Save</button><p id="result">Waiting</p><p id="marker"></p>
      <script>const marker=sessionStorage.getItem('marker')||location.hash.slice(1);sessionStorage.setItem('marker',marker);
      history.replaceState({},'',location.pathname);document.querySelector('#marker').textContent=marker;
      localStorage.setItem('latch-fixture-marker','pre-existing');
      document.querySelector('#save').onclick=()=>{document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value;console.error('console-'+marker)};
      setInterval(()=>fetch('/state',{method:'POST',body:JSON.stringify({marker,result:document.querySelector('#result').textContent,signedIn:document.cookie.includes('latch_fixture=signed-in'),stored:localStorage.getItem('latch-fixture-marker')})}),250);</script>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const seedScript = `(async()=>{const a=await chrome.windows.create({url:[${JSON.stringify(origin+'/same#a')},${JSON.stringify(origin+'/same#b')}],type:'normal'});const c=await chrome.windows.create({url:${JSON.stringify(origin+'/third#c')},type:'normal'});const group=await chrome.tabs.group({tabIds:[a.tabs[1].id]});await chrome.tabGroups.update(group,{title:'Existing fixture group'});await fetch(${JSON.stringify(origin+'/seed')},{method:'POST',body:JSON.stringify({a:a.tabs[0].id,b:a.tabs[1].id,c:c.tabs[0].id})})})().catch(e=>console.error('Fixture seed failed',e.message));\n`;
  await fs.writeFile(path.join(extension, 'fixture-seed.js'), seedScript);
  await fs.appendFile(path.join(extension, 'background.js'), "\nimport './fixture-seed.js';\n");
  const launcher = path.join(temp, 'native-host');
  await fs.writeFile(launcher, `#!/bin/sh\nexport LATCH_RUNTIME_DIR=${quote(runtime)}\nexport LATCH_CONFIG=${quote(env.LATCH_CONFIG)}\nexport PWTEST_DAEMON_SESSION_DIR=${quote(env.PWTEST_DAEMON_SESSION_DIR)}\nexec ${quote(process.execPath)} ${quote(path.join(root, 'src/native-host.mjs'))} "$@" 2>>${quote(path.join(temp,'native.stderr.log'))}\n`, {mode: 0o700});
  const hosts = path.join(temp, 'profile/NativeMessagingHosts'); await fs.mkdir(hosts, {recursive: true});
  const hostManifest = path.join(hosts, hostName+'.json');
  registration = JSON.stringify({name: hostName, description: 'Latch workflow fixture', type: 'stdio', path: launcher,
    allowed_origins: [`chrome-extension://${extensionId}/`]});
  await fs.writeFile(hostManifest, registration, {mode: 0o600, flag: 'wx'});
  const wrapper = async (workspace, args, {fail = false, overrides = {}} = {}) => {
    const result = await command(process.execPath, [path.join(root, 'skills/latch/scripts/latch.mjs'), ...args, '--workspace', workspace],
      {cwd: workspace, env: {...env, ...overrides}});
    const data = JSON.parse(result.out || result.err);
    assert.equal(result.code, fail ? 1 : 0, JSON.stringify(data));
    return data;
  };
  const pw = async (workspace, args) => {
    const result = await command('playwright-cli', ['-s=agent', '--json', ...args], {cwd: workspace, env});
    const data = JSON.parse(result.out);
    assert.equal(result.code, 0, JSON.stringify(data));
    assert.ok(!data.isError, JSON.stringify(data));
    return data;
  };
  t.after(async () => {
    if (identity) {
      const final=await request(identity.instanceId,'native-status',{...identity,sessionKey:sessionKey(projectA,'agent')}).catch(()=>null);
      if(final) await fs.writeFile(path.join(evidence,'final-native-status.json'),JSON.stringify(final,null,2));
    }
    if (identity) for (const workspace of [projectA, projectB, projectC]) {
      await request(identity.instanceId, 'native-disconnect', {...identity, sessionKey: sessionKey(workspace, 'agent')}).catch(() => {});
      await command('playwright-cli', ['-s=agent', '--json', 'detach'], {cwd: workspace, env}).catch(() => {});
    }
    await stopBrowser(browser);
    if (await fs.readFile(hostManifest, 'utf8').catch(() => '') === registration) await fs.unlink(hostManifest);
    await new Promise(resolve => fixture.close(resolve));
    await fs.rm(runtime, {recursive: true, force: true});
    if (oldRuntime === undefined) delete process.env.LATCH_RUNTIME_DIR; else process.env.LATCH_RUNTIME_DIR = oldRuntime;
  });
  const args = [...HEADLESS_ARGS, `--user-data-dir=${path.join(temp,'profile')}`, '--profile-directory=Default', '--no-first-run',
    '--no-default-browser-check', '--enable-logging=stderr', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`];
  assert.ok(!args.some(arg => arg.startsWith('--remote-debugging')));
  const log = await fs.open(path.join(temp, 'chrome.stderr.log'), 'w');
  browser = spawn(chrome, args, {stdio: ['ignore','ignore',log.fd]}); await log.close();
  console.log(`Multi-agent fixture: ${temp}`);
  identity = await eventually(async () => (await wrapper(projectA, ['discover'])).profiles[0], 20000);
  assert.equal(identity.capabilities.nativeTransport, true);
  await wrapper(projectA, ['pair', '--profile', 'work', '--instance', identity.instanceId, '--chrome-profile-dir', 'Default']);
  await eventually(() => seed && telemetry.has('a') && telemetry.has('b') && telemetry.has('c'));
  const before = await wrapper(projectA, ['tabs']);
  const a = before.tabs.find(tab => tab.tabId === seed.a), b = before.tabs.find(tab => tab.tabId === seed.b), c = before.tabs.find(tab => tab.tabId === seed.c);
  assert.equal(a.url, b.url);
  assert.ok(b.groupId >= 0);
  const [connectedA, connectedB] = await Promise.all([
    wrapper(projectA, ['connect', '--focus-emulation', 'on', '--session', 'agent', '--tab', String(a.tabId)]),
    wrapper(projectB, ['connect', '--focus-emulation', 'on', '--session', 'agent', '--tab', String(b.tabId)]),
  ]);
  console.log('Both normal CLI sessions connected.');
  assert.notEqual(connectedA.page.targetId, connectedB.page.targetId);
  const observedA = valueOf(await pw(projectA, ['run-code', "async(page)=>({marker:await page.locator('#marker').innerText(),url:page.url()})"]));
  const observedB = valueOf(await pw(projectB, ['run-code', "async(page)=>({marker:await page.locator('#marker').innerText(),url:page.url()})"]));
  assert.equal(observedA.marker, 'a'); assert.equal(observedB.marker, 'b'); assert.equal(observedA.url, observedB.url);
  const [actionA, actionB] = await Promise.all([
    pw(projectA, ['run-code', "async(page)=>{await page.locator('#name').fill('Alpha');await page.locator('#save').click();return await page.locator('#result').innerText()}"]),
    pw(projectB, ['run-code', "async(page)=>{await page.locator('#name').fill('Beta');await page.locator('#save').click();return await page.locator('#result').innerText()}"]),
  ]);
  assert.equal(valueOf(actionA), 'Saved Alpha'); assert.equal(valueOf(actionB), 'Saved Beta');
  const isolation = valueOf(await pw(projectA, ['run-code', `async(page)=>{const browser=await page.context().browser().newBrowserCDPSession();try{const own=await browser.send('Target.getTargets');let rejected=false;try{await browser.send('Target.attachToTarget',{targetId:${JSON.stringify(connectedB.page.targetId)},flatten:true})}catch{rejected=true}return {targets:own.targetInfos.map(t=>t.targetId),rejected}}finally{await browser.detach()}}`]));
  assert.deepEqual(isolation.targets, [connectedA.page.targetId]); assert.equal(isolation.rejected, true);
  const conflict = await wrapper(projectC, ['connect', '--session', 'agent', '--tab', String(a.tabId)], {fail: true});
  assert.equal(conflict.error.code, 'TAB_OWNED');
  const limited = await wrapper(projectA, ['connect', '--session', 'agent', '--tab', String(c.tabId)], {fail: true});
  assert.equal(limited.error.code, 'SESSION_TAB_LIMIT');
  await assert.rejects(request(identity.instanceId, 'native-connect', {...identity, epoch: crypto.randomUUID(), sessionKey: sessionKey(projectC, 'agent'), tabId: c.tabId, expectedUrl:c.url}), {code:'OPERATION_GRANT_REQUIRED'});
  const failingCLI = path.join(temp, 'failing-cli');
  await fs.writeFile(failingCLI, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--version'))console.log(JSON.stringify({version:'0.1.20'}));else if(a.includes('list'))console.log(JSON.stringify({browsers:[]}));else if(a.includes('attach')){console.log(JSON.stringify({isError:true,error:'Injected attach failure'}));process.exitCode=1}else console.log('{}');\n`, {mode:0o700});
  const rollback = await wrapper(projectC, ['connect', '--session','agent','--tab',String(c.tabId)], {fail:true,overrides:{LATCH_PLAYWRIGHT_CLI:failingCLI}});
  assert.equal(rollback.error.code,'PLAYWRIGHT_ERROR');
  const during = await wrapper(projectA, ['tabs']);
  assert.equal(during.tabs.find(t=>t.tabId===c.tabId).owner,null);
  assert.equal(during.tabs.find(t=>t.tabId===b.tabId).owner,sessionKey(projectB,'agent'));
  assert.equal((await wrapper(projectA,['connect','--session','agent','--tab',String(a.tabId)])).alreadyConnected,true);
  assert.equal((await wrapper(projectB,['connect','--session','agent','--tab',String(b.tabId)])).alreadyConnected,true);
  for (const [workspace,name] of [[projectA,'a'],[projectB,'b']]) {
    await pw(workspace,['snapshot',`--filename=${path.join(evidence,name+'.yaml')}`]);
    await pw(workspace,['screenshot',`--filename=${path.join(evidence,name+'.png')}`]);
    const consoleOutput=await pw(workspace,['console','error']);
    assert.match(JSON.stringify(consoleOutput),new RegExp('console-'+name));
    assert.ok(!JSON.stringify(consoleOutput).includes('console-'+(name==='a'?'b':'a')));
    await fs.writeFile(path.join(evidence,name+'-console.json'),JSON.stringify(consoleOutput,null,2));
  }
  const records = await Promise.all([projectA,projectB].map(async workspace=>{
    const p=path.join(temp,'native-v4',identity.instanceId,sessionKey(workspace,'agent')+'.json');
    const raw=await fs.readFile(p,'utf8');
    assert.ok(!raw.includes('/cdp/')&&!raw.includes('/extension/'));
    assert.equal((await fs.stat(p)).mode&0o777,0o600);
    return JSON.parse(raw);
  }));
  assert.notEqual(records[0].workspace,records[1].workspace);
  const released = await wrapper(projectA,['release','--session','agent','--tab',String(a.tabId)]);
  assert.equal(released.sessionClosed,true);
  const peer=valueOf(await pw(projectB,['run-code',"async(page)=>await page.locator('#result').innerText()"]));
  assert.equal(peer,'Saved Beta');
  await wrapper(projectA,['disconnect','--session','agent']);
  await wrapper(projectB,['disconnect','--session','agent']);
  const after=await wrapper(projectA,['tabs']);
  for (const original of [a,b,c]) {
    const preserved=after.tabs.find(t=>t.tabId===original.tabId);
    assert.equal(preserved.owner,null); assert.equal(preserved.url,original.url);
    assert.equal(preserved.groupId,original.groupId); assert.equal(preserved.windowId,original.windowId);
    assert.equal(preserved.active,original.active);
  }
  const detachedAt=Date.now();
  await eventually(()=>['a','b','c'].every(marker=>telemetry.get(marker)?.receivedAt>detachedAt));
  assert.equal(telemetry.get('a').result,'Saved Alpha'); assert.equal(telemetry.get('b').result,'Saved Beta');
  assert.equal(telemetry.get('c').result,'Waiting');
  for(const state of telemetry.values()){assert.equal(state.signedIn,true);assert.equal(state.stored,'pre-existing');}
  const active=await request(identity.instanceId,'native-status',{...identity,sessionKey:sessionKey(projectA,'agent')});
  assert.equal(active.sessions.length,0);
  await stopBrowser(browser);
  const settings={};
  for(const name of ['Preferences','Secure Preferences']) {
    const d=JSON.parse(await fs.readFile(path.join(temp,'profile/Default',name)).catch(()=>'{}'));
    Object.assign(settings,d.extensions?.settings||{});
  }
  assert.ok(settings[extensionId]);
  const report={outcome:'passed',cliVersion:(await command('playwright-cli',['--version'])).out.trim(),
    chromeVersion:(await command(chrome,['--version'])).out.trim(), remoteDebuggingFlags:false,
    sameURL:observedA.url,selectedMarkers:[observedA.marker,observedB.marker],
    targetIds:[connectedA.page.targetId,connectedB.page.targetId],isolation,
    sharedSessionName:'agent',separateWorkspaces:true,focusEmulation:true,conflictCode:conflict.error.code,rollbackCode:rollback.error.code,
    releasePreservedPeer:true,groupsWindowsAndStatePreserved:true,activeNativeSessionsAfterCleanup:0,
    limitations:['one tab per session','Work installation unchanged','advanced browser features and restart recovery not covered']};
  await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(`Multi-agent workflow passed; evidence: ${evidence}`);
});
