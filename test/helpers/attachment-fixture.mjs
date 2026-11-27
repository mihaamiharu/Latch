import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {chromePath, chromeVersion, eventually, command, stopBrowser, control, HEADLESS_ARGS} from './native-browser.mjs';
import {redact, sessionKey} from '../../src/redact.mjs';
import {installedControl} from './installed-control.mjs';
import {
  testHostName, registerTestHost, unregisterTestHost, suspendTestHost, restoreTestHost, sweepStaleTestHosts,
  writeHostLauncher, fixtureEndpoint, fixtureRuntime, realInstallSnapshot, assertRealInstallUnchanged, browserEvidence,
} from './browser-suite.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const valueOf = value => {
  try {
    return JSON.parse(value.result);
  } catch {
    return value.result;
  }
};

export async function attachmentFixture(t, app, transport = 'native') {
  const chrome = await chromePath();
  const run = crypto.randomUUID();
  const realBefore = await realInstallSnapshot();
  await sweepStaleTestHosts();
  const versions = {node: process.version, chrome: await chromeVersion(chrome)};
  const base = path.join(root, 'work/attachment-compat');
  await fs.mkdir(base, {recursive: true});
  const temp = await fs.mkdtemp(path.join(base, transport + '-'));
  const profile = path.join(temp, 'profile');
  const extension = path.join(temp, 'extension');
  const evidence = path.join(temp, 'evidence');
  const browserInbox = app.privateDownloads ? path.join(temp, 'browser-inbox') : undefined;
  if (browserInbox) {
    await fs.mkdir(browserInbox, {mode: 0o700});
    await fs.mkdir(path.join(profile, 'Default'), {recursive: true});
    await fs.writeFile(
      path.join(profile, 'Default/Preferences'),
      JSON.stringify({download: {default_directory: browserInbox, prompt_for_download: false, directory_upgrade: true}}),
      {mode: 0o600},
    );
  }
  const verifyInbox = async () => {
    if (!browserInbox) return;
    const prefs = JSON.parse(await fs.readFile(path.join(profile, 'Default/Preferences'), 'utf8'));
    if (prefs.download?.default_directory !== browserInbox || prefs.download?.prompt_for_download !== false) {
      throw new Error('Private download inbox was not retained; refusing to trigger downloads.');
    }
  };
  const runtime = fixtureRuntime('latch-ab');
  await fs.mkdir(evidence);
  await fs.cp(app.artifactExtension || path.join(root, 'extension'), extension, {recursive: true});
  if (app.recoveryAlarm) {
    const file = path.join(extension, 'bridge-connection.js');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace(
        'timers = globalThis',
        'timers = {setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms === 5000 ? ms : 60000), clearTimeout: id => globalThis.clearTimeout(id)}',
      ),
    );
  }
  if (app.uiUnsupported) {
    const file = path.join(extension, 'background.js');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('uiControl: 1', 'uiControl: 0'));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json')));
  if (!app.artifactExtension) manifest.permissions = [...new Set([...manifest.permissions, 'debugger'])];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const extensionId = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
    .join('');
  const hostName = app.installed ? 'com.latch.bridge' : testHostName();
  await fs.writeFile(
    path.join(extension, 'protocol.js'),
    (await fs.readFile(path.join(extension, 'protocol.js'), 'utf8')).replace("'com.latch.bridge'", JSON.stringify(hostName)),
  );
  const env = {
    ...process.env,
    LATCH_CAPTURE: 'off',
    LATCH_RUNTIME_DIR: runtime,
    LATCH_CONFIG: path.join(temp, 'config.json'),
    // Sessions, journals and the default artifact library stay in the fixture.
    LATCH_HOME: path.join(temp, 'latch-home'),
    NO_UPDATE_NOTIFIER: '1',
  };
  const workspaces = [];
  for (const name of ['a', 'b', 'outsider']) {
    const p = path.join(temp, name);
    await fs.mkdir(p);
    workspaces.push(p);
  }
  if (app.installed) await app.install({temp, profile, env, workspaces});
  let browser;
  let registration;
  let identity;
  let recoveryServer;
  let closed = false;
  const faults = [];
  const acks = new Map();
  let recoveryURL;
  if (app.recovery || app.installed) {
    const route = '/' + crypto.randomBytes(32).toString('hex');
    recoveryServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url !== route) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(faults.shift() || null));
        return;
      }
      let data = '';
      req.on('data', b => {
        data += b;
        if (data.length > (app.popup ? 1024 * 1024 : 16384)) req.destroy();
      });
      req.on('end', () => {
        try {
          const value = JSON.parse(data);
          acks.set(value.id, value);
          res.end('ok');
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });
    await new Promise(r => recoveryServer.listen(0, '127.0.0.1', r));
    recoveryURL = 'http://127.0.0.1:' + recoveryServer.address().port + route;
    t.after(() => new Promise(r => { recoveryServer.close(r); recoveryServer.closeAllConnections(); }));
  }
  const extensionLoad = app.installed ? path.join(app.installedRoot, 'extension') : app.stableExtension ? path.join(temp, 'extension-current') : extension;
  if (app.stableExtension) await fs.symlink(extension, extensionLoad, process.platform === 'win32' ? 'junction' : 'dir');
  const extensions = [extensionLoad];

  let hostSource = path.join(root, 'src/native-host.mjs');
  const journalBarrier = path.join(temp, 'journal-write-reached');
  const popupBarrier = path.join(temp, 'popup-cleanup-reached');
  const popupPause = path.join(temp, 'popup-cleanup-pause');
  if (app.journalCrash || app.popupCleanupFault || app.popupPauseCleanup) {
    const source = path.join(temp, 'runtime-source');
    await fs.cp(path.join(root, 'src'), path.join(source, 'src'), {recursive: true});
    await fs.copyFile(path.join(root, 'package.json'), path.join(source, 'package.json'));
    await fs.cp(path.join(root, 'extension'), path.join(source, 'extension'), {recursive: true});
    const file = path.join(source, 'src/recovery-state.mjs');
    let text = await fs.readFile(file, 'utf8');
    if (app.journalCrash) {
      text = text.replace(
        '    await fs.rename(temp, file);',
        `    if(next.stage==='reserve' && !await fs.stat(${JSON.stringify(journalBarrier)}).catch(()=>null)){await fs.writeFile(${JSON.stringify(journalBarrier)},'exclusive-temp-synced-before-rename');await new Promise(r=>setTimeout(r,60000));}\n    await fs.rename(temp, file);`,
      );
    }
    await fs.writeFile(file, text);
    // Faults go into the private copy of native-sessions.mjs, after the
    // session's relay (its debugger access) has stopped: the v1.1 cleanup path.
    const cleanupAnchor = '      await entry.relay.stop().catch(() => {});\n    }\n    const released = await this.releaseBrowser(entry, p);';
    const injectCleanup = async code => {
      const sessions = path.join(source, 'src/native-sessions.mjs');
      const original = await fs.readFile(sessions, 'utf8');
      if (!original.includes(cleanupAnchor)) throw new Error('native-sessions.mjs cleanup anchor moved; update the fixture.');
      await fs.writeFile(sessions, original.replace(cleanupAnchor, `      await entry.relay.stop().catch(() => {});\n      ${code}\n    }\n    const released = await this.releaseBrowser(entry, p);`));
    };
    if (app.popupCleanupFault) {
      await injectCleanup("if(entry.workspace&&/^[^a-z0-9]a$/i.test(String(entry.workspace).slice(-2)))throw fault('CLEANUP_FAILED','Controlled fixture cleanup failure.');");
    }
    if (app.popupPauseCleanup) {
      await injectCleanup(`{const fs=await import('node:fs/promises');if(entry.workspace&&/^[^a-z0-9]a$/i.test(String(entry.workspace).slice(-2))&&await fs.stat(${JSON.stringify(popupPause)}).catch(()=>null)){await fs.writeFile(${JSON.stringify(popupBarrier)},'accepted-cleanup-after-access-revocation');const end=Date.now()+12000;while(await fs.stat(${JSON.stringify(popupPause)}).catch(()=>null)){if(Date.now()>end)throw fault('FIXTURE_PAUSE_TIMEOUT','Private cleanup pause expired.');await new Promise(r=>setTimeout(r,25))}}}`);
    }
    hostSource = path.join(source, 'src/native-host.mjs');
  }
  if (!app.installed) {
    const launcher = await writeHostLauncher(temp, {hostSource, env, stderrLog: path.join(temp, 'native.stderr.log')});
    registration = await registerTestHost({
      name: hostName,
      profile,
      temp,
      manifest: {description: 'Latch test-only fixture host', type: 'stdio', path: launcher, allowed_origins: [`chrome-extension://${extensionId}/`]},
    });
  }

  const provision = `const w=await chrome.windows.create({url:${JSON.stringify(['a', 'b', 'outsider'].map(name => app.origin + '/root#' + encodeURIComponent(run + ':' + name)))},type:'normal'});await fetch(${JSON.stringify(app.origin + '/__seed')},{method:'POST',mode:'no-cors',body:JSON.stringify({run,tabs:w.tabs.map(t=>t.id)})});`;
  const seed = `(async()=>{${app.recovery ? `if((await chrome.storage.local.get('__fixtureSeed')).__fixtureSeed!==run){${provision}await chrome.storage.local.set({__fixtureSeed:run})}const url=chrome.runtime.getURL('fixture-control.html');` : provision}})().catch(e=>console.error('Fixture provisioning failed',e.message));`;
  if (app.recovery) {
    const injector = path.join(temp, 'fault-injector');
    await fs.mkdir(injector);
    extensions.push(injector);
    await fs.writeFile(
      path.join(injector, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Private recovery fault injector',
        version: '1.0',
        permissions: ['debugger', 'tabs', 'management'],
        background: {service_worker: 'start.js'},
      }),
    );
    await fs.writeFile(path.join(injector, 'start.js'), "chrome.tabs.create({url:chrome.runtime.getURL('fixture-control.html'),active:false});");
    await fs.appendFile(
      path.join(extension, 'background.js'),
      "\nchrome.runtime.onMessageExternal.addListener((m,s,reply)=>{if(m?.fixture==='status'){Promise.all([status(),chrome.storage.local.get('latchLastAlarm')]).then(([s,a])=>reply({...s,lastAlarm:a.latchLastAlarm}));return true}if(m?.fixture==='reload'){reply({issued:true});setTimeout(()=>chrome.runtime.reload(),50)}if(m?.fixture==='detach-native'){chrome.debugger.detach({tabId:m.tabId}).then(()=>reply({detached:true}),e=>reply({error:e.message}));return true}if(m?.fixture==='terminate'){chrome.tabs.create({url:chrome.runtime.getURL('terminate.html')+'#'+m.id+(m.noWake?'!no-wake':''),active:false});reply({issued:true})}});\n",
    );
    if (app.popup) {
      await fs.appendFile(
        path.join(extension, 'background.js'),
        "\nchrome.runtime.onMessageExternal.addListener((m,s,reply)=>{if(m?.fixture!=='popup')return;chrome.storage.local.set({__popupTask:m}).then(()=>chrome.tabs.create({url:chrome.runtime.getURL('popup-driver.html'),active:false})).then(()=>reply({issued:true}));return true});\n",
      );
      await fs.writeFile(path.join(extension, 'popup-driver.html'), '<script type="module" src="popup-driver.js"></script>');
      await fs.writeFile(
        path.join(extension, 'popup-driver.js'),
        `const endpoint=${JSON.stringify(recoveryURL)},task=(await chrome.storage.local.get('__popupTask')).__popupTask;let popup;try{popup=(await chrome.tabs.query({})).find(t=>t.url===chrome.runtime.getURL('popup.html'))||await chrome.tabs.create({url:chrome.runtime.getURL('popup.html'),active:false});await new Promise(r=>setTimeout(r,100));await chrome.debugger.attach({tabId:popup.id},'1.3');if(task.params.key){await chrome.debugger.sendCommand({tabId:popup.id},'Input.dispatchKeyEvent',{type:'keyDown',key:task.params.key,code:task.params.key,windowsVirtualKeyCode:9});await chrome.debugger.sendCommand({tabId:popup.id},'Input.dispatchKeyEvent',{type:'keyUp',key:task.params.key,code:task.params.key,windowsVirtualKeyCode:9})}const response=await chrome.debugger.sendCommand({tabId:popup.id},'Runtime.evaluate',{expression:task.params.expression||'document.body.innerText',awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text);let screenshot;if(task.params.screenshot)screenshot=(await chrome.debugger.sendCommand({tabId:popup.id},'Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:390,height:800,scale:1},captureBeyondViewport:true})).data;await chrome.debugger.detach({tabId:popup.id});await fetch(endpoint,{method:'POST',body:JSON.stringify({id:task.id,result:{value:response.result.value,screenshot}})})}catch(e){await fetch(endpoint,{method:'POST',body:JSON.stringify({id:task.id,error:e.message})})}finally{if(popup)await chrome.debugger.detach({tabId:popup.id}).catch(()=>{});const self=await chrome.tabs.getCurrent();await chrome.tabs.remove(self.id)}`,
      );
    }
    await fs.writeFile(path.join(extension, 'terminate.html'), '<script type="module" src="terminate.js"></script>');
    await fs.writeFile(
      path.join(extension, 'terminate.js'),
      `const [id,noWake]=location.hash.slice(1).split('!'),endpoint=${JSON.stringify(recoveryURL)};try{const target=(await chrome.debugger.getTargets()).find(t=>t.url===chrome.runtime.getURL('background.js'));if(!target)throw new Error('Worker target missing');await chrome.debugger.attach({targetId:target.id},'1.3');const closeResult=await chrome.debugger.sendCommand({targetId:target.id},'Target.closeTarget',{targetId:target.id});const status=noWake?null:await chrome.runtime.sendMessage({type:'status'});await fetch(endpoint,{method:'POST',body:JSON.stringify({id,result:{closeResult,oldTargetId:target.id,status}})})}catch(e){await fetch(endpoint,{method:'POST',body:JSON.stringify({id,error:e.message})})}`,
    );
    await fs.writeFile(path.join(injector, 'fixture-control.html'), '<script type="module" src="fixture-control.js"></script>');
    await fs.writeFile(
      path.join(injector, 'fixture-control.js'),
      `const endpoint=${JSON.stringify(recoveryURL)},run=${JSON.stringify(run)},latchId=${JSON.stringify(extensionId)};const ack=v=>fetch(endpoint,{method:'POST',body:JSON.stringify(v)});let busy=false;setInterval(async()=>{if(busy)return;busy=true;let task;try{task=await(await fetch(endpoint)).json();if(!task)return;const {id,action,params={}}=task;if(action==='status'){await ack({id,result:await chrome.runtime.sendMessage(latchId,{fixture:'status'})})}else if(action==='popup'){await chrome.runtime.sendMessage(latchId,{fixture:'popup',id,params})}else if(action==='close-popup'){const tabs=await chrome.tabs.query({url:'chrome-extension://'+latchId+'/popup.html'});await chrome.tabs.remove(tabs.map(t=>t.id));await ack({id,result:{closed:tabs.length}})}else if(action==='spoof-ui'){try{await chrome.runtime.sendMessage(latchId,{type:'ui',op:'status'});await ack({id,result:{rejected:true}})}catch(e){await ack({id,result:{rejected:true,message:e.message}})}}else if(action==='request-reload'){await chrome.runtime.sendMessage(latchId,{fixture:'reload'});await ack({id,result:{issued:true}})}else if(action==='disable'||action==='enable'){await chrome.management.setEnabled(latchId,action==='enable');await ack({id,result:await chrome.management.get(latchId)})}else if(action==='reload'){await chrome.management.setEnabled(latchId,false);await chrome.management.setEnabled(latchId,true);await ack({id,result:{issued:true,mechanism:'disable-enable-unpacked-extension'}})}else if(action==='terminate'||action==='terminate-no-wake'){await chrome.runtime.sendMessage(latchId,{fixture:'terminate',id,noWake:action==='terminate-no-wake'})}else if(action==='detach-native'){await ack({id,result:await chrome.runtime.sendMessage(latchId,{fixture:'detach-native',tabId:params.tabId})})}else if(action==='compete'){await chrome.debugger.attach({tabId:params.tabId},'1.3');await ack({id,result:{attached:true}})}else if(action==='foreign-check'){const v=await chrome.debugger.sendCommand({tabId:params.tabId},'Target.getTargetInfo');await ack({id,result:{attached:!!v.targetInfo}})}else if(action==='detach'){await chrome.debugger.detach({tabId:params.tabId});await ack({id,result:{detached:true}})}else if(action==='extension-info'){await ack({id,result:await chrome.management.get(latchId)})}else if(action==='provision'){${provision}await ack({id,result:{provisioned:true}})}else throw new Error('Unknown fixture action')}catch(e){if(task)await ack({id:task.id,error:e.message}).catch(()=>{})}finally{busy=false}},100);`,
    );
  }
  await fs.writeFile(path.join(extension, 'fixture-seed.js'), `const run=${JSON.stringify(run)};${seed}`);
  if (app.installed) {
    const seeder = path.join(temp, 'fixture-seeder');
    await fs.mkdir(seeder);
    await fs.writeFile(
      path.join(seeder, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Private installation fixture seeder',
        version: '1',
        permissions: ['tabs', 'management', ...(app.popup ? ['debugger'] : [])],
        background: {service_worker: 'seed.js', type: 'module'},
      }),
    );
    await fs.writeFile(path.join(seeder, 'seed.js'), '' + (await fs.readFile(path.join(extension, 'fixture-seed.js'), 'utf8')));
    await fs.writeFile(path.join(seeder, 'control.html'), '<script type="module" src="control.js"></script>');
    await fs.writeFile(path.join(seeder, 'control.js'), installedControl(recoveryURL, extensionId, app.popup));
    await fs.appendFile(path.join(seeder, 'seed.js'), "\nchrome.tabs.create({url:chrome.runtime.getURL('control.html'),active:false});");
    extensions.push(seeder);
  } else {
    await fs.appendFile(path.join(extension, 'background.js'), "\nimport './fixture-seed.js';\n");
  }

  const progress = (kind, index, operation, event) =>
    fs.appendFile(path.join(temp, 'progress.jsonl'), JSON.stringify({kind, index, operation, event, at: Date.now()}) + '\n');
  const protocolEvents = async () => {
    const events = [];
    for (const dir of await fs.readdir(path.join(temp, 'daemon')).catch(() => [])) {
      const file = path.join(temp, 'daemon', dir, 'agent.err');
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      if (stat.size > 64 * 1024 * 1024) throw new Error('Private protocol log exceeded fixture bound.');
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
        const match = line.match(/pw:protocol.*?RECV.*?(\{.*)/);
        if (!match) continue;
        let m;
        try {
          m = JSON.parse(match[1]);
        } catch {
          continue;
        }
        const p = m.params || {};
        const info = p.targetInfo || {};
        if (['Target.attachedToTarget', 'Target.detachedFromTarget'].includes(m.method)) {
          events.push({daemon: dir, method: m.method, sessionId: m.sessionId, childSessionId: p.sessionId, targetId: info.targetId || p.targetId, type: info.type});
        }
        if (['Page.frameAttached', 'Page.frameDetached'].includes(m.method)) {
          events.push({daemon: dir, method: m.method, sessionId: m.sessionId, frameId: p.frameId, parentFrameId: p.parentFrameId, reason: p.reason});
        }
        if (['Page.fileChooserOpened', 'Page.downloadWillBegin', 'Page.downloadProgress', 'Browser.downloadWillBegin', 'Browser.downloadProgress'].includes(m.method)) {
          events.push({daemon: dir, method: m.method, sessionId: m.sessionId, frameId: p.frameId, guid: p.guid, state: p.state, suggestedFilename: p.suggestedFilename, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes, mode: p.mode, filePathPresent: !!p.filePath});
        }
      }
    }
    if (events.length > 4096) throw new Error('Protocol metadata exceeded fixture bound.');
    return events;
  };
  const nativeStatus = async () =>
    control(fixtureEndpoint(identity.instanceId, runtime), {
      v: 1,
      id: crypto.randomUUID(),
      op: 'native-status',
      payload: {...identity, sessionKey: sessionKey(workspaces[0], 'agent')},
    });
  const captureTrace = async index => {
    if (!identity) return;
    const payload = {...identity, sessionKey: sessionKey(workspaces[index], 'agent')};
    const trace = await control(fixtureEndpoint(identity.instanceId, runtime), {
      v: 1,
      id: crypto.randomUUID(),
      op: 'native-trace',
      payload,
    }).catch(() => null);
    const status = await nativeStatus().catch(() => null);
    if (status?.sessions?.length) await fs.writeFile(path.join(evidence, 'native-status.json'), JSON.stringify(status, null, 2));
    if (trace?.length) await fs.writeFile(path.join(evidence, `trace-${index}.json`), JSON.stringify(trace, null, 2));
  };
  const latch = async (index, args, {fail = false} = {}) => {
    if (args[0] === 'disconnect') await captureTrace(index);
    await progress('latch', index, args[0], 'start');
    const latchArgs = [...args];
    latchArgs.splice(args.includes('--') ? args.indexOf('--') : args.length, 0, '--workspace', workspaces[index]);
    if (!latchArgs.includes('--json')) latchArgs.push('--json');
    const result = app.installed
      ? await command(path.join(app.installedRoot, 'bin/latch'), latchArgs, {cwd: workspaces[index], env})
      : await command(process.execPath, [path.join(root, 'src/cli.mjs'), ...latchArgs], {cwd: workspaces[index], env});
    await progress('latch', index, args[0], 'done');
    const parsed = JSON.parse(result.out || result.err);
    if (result.code !== (fail ? 1 : 0)) throw new Error(`Latch ${args[0]} failed: ${redact(JSON.stringify(parsed))}`);
    return parsed;
  };
  // v1.1 drives pages through Latch's own action commands (bundled
  // playwright-core), not an external playwright-cli daemon. `pw` keeps the
  // suites' call shape: run-code results come back as {result: <json>}.
  const pw = async (index, args, {fail = false, session = 'agent'} = {}) => {
    if (args[0] === 'detach') return {};
    await progress('latch-action', index, args[0], 'start');
    const result = await command(process.execPath, [path.join(root, 'src/cli.mjs'), ...args, '--session', session, '--workspace', workspaces[index], '--json'], {cwd: workspaces[index], env});
    await progress('latch-action', index, args[0], 'done');
    let parsed;
    try {
      parsed = JSON.parse(result.out || result.err);
    } catch {
      if (!fail) throw new Error('Latch action returned invalid output: ' + redact(result.out + result.err).slice(0, 2000));
      parsed = {ok: false, error: {code: 'CLI_RESPONSE_LOST'}, exitCode: result.code};
    }
    if (!fail && (result.code !== 0 || parsed.ok === false)) {
      await fs.writeFile(path.join(evidence, 'last-error.txt'), redact(JSON.stringify(parsed)));
      throw new Error(`Latch ${args[0]} failed: ${redact(JSON.stringify(parsed))}`);
    }
    return parsed.ok === false ? parsed : {...parsed, result: JSON.stringify(parsed.value)};
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.saveEvidence?.(evidence);
    await fs.writeFile(
      path.join(evidence, 'fixture-state.json'),
      JSON.stringify([...app.states.values()].filter(state => state.actor.startsWith(run)), null, 2),
    );
    for (let i = 0; i < 2; i++) await captureTrace(i);
    for (let i = 0; i < workspaces.length; i++) {
      await latch(i, ['disconnect', '--profile', 'work', '--session', 'agent']).catch(() => {});
    }
    if (app.protocolEvidence) await fs.writeFile(path.join(evidence, 'protocol-targets.json'), JSON.stringify(await protocolEvents(), null, 2));
    await stopBrowser(browser);
    if (!app.installed) await unregisterTestHost(registration);
    await fs.rm(runtime, {recursive: true, force: true});
    await assertRealInstallUnchanged(realBefore);
    await fs.writeFile(path.join(evidence, 'browser-evidence.json'), JSON.stringify({...evidenceRecord, realInstallUnchanged: true}, null, 2));
  };
  t.after(close);

  const popupFlags =
    app.installed && app.popup ? ['--silent-debugger-extension-api', '--extensions-on-extension-urls'] : app.recovery ? ['--silent-debugger-extension-api'] : [];
  const args = [
    ...HEADLESS_ARGS,
    `--user-data-dir=${profile}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--enable-logging=stderr',
    `--disable-extensions-except=${extensions.join(',')}`,
    `--load-extension=${extensions.join(',')}`,
    ...(app.launchArgs || []),
    ...popupFlags,
    'about:blank',
  ];
  const browserEnv = () =>
    app.installed ? {...env, ...(app.minimalHostPath ? {PATH: '/usr/bin:/bin', LATCH_PLAYWRIGHT_CLI: undefined} : {})} : process.env;
  const evidenceRecord = browserEvidence({
    chrome, version: versions.chrome, hostName, registryKey: registration?.registryKey,
    launchArgs: args
      .filter(a => !a.startsWith('--user-data-dir=') && a !== 'about:blank')
      .map(a => (a.startsWith('--disable-extensions-except=') || a.startsWith('--load-extension=') ? a.split('=')[0] + '=<fixture extensions>' : a)),
  });
  await fs.writeFile(path.join(evidence, 'browser-evidence.json'), JSON.stringify(evidenceRecord, null, 2));
  const log = await fs.open(path.join(temp, 'chrome.stderr.log'), 'w');
  browser = spawn(chrome, args, {env: browserEnv(), stdio: ['ignore', 'ignore', log.fd]});
  await log.close();
  console.log(`${transport} fixture: ${temp}`);
  identity = await eventually(async () => (await latch(0, ['discover'])).profiles[0], 20000);
  await latch(0, ['pair', '--profile', 'work', '--instance', identity.instanceId, '--chrome-profile-dir', 'Default']);
  await eventually(() => app.seeds.has(run) && [...app.states.values()].filter(s => s.actor.startsWith(run) && s.role === (app.rootRole || '/root')).length === 3);
  const seedInfo = app.seeds.get(run);
  await verifyInbox();
  return {
    run,
    temp,
    profile,
    evidence,
    extension,
    extensionLoad,
    extensionId,
    hostName,
    journalBarrier,
    popupBarrier,
    popupPause,
    get identity() {
      return identity;
    },
    workspaces,
    env,
    transport,
    versions,
    headless: true,
    get browserPID() {
      return browser.pid;
    },
    nativeStatus,
    browserInbox,
    verifyInbox,
    connectionPageDelivery: 'not needed',
    launchArgs: [...HEADLESS_ARGS, '--use-mock-keychain', '--password-store=basic', ...(app.launchArgs || []), ...popupFlags],
    protocolEvents,
    tabs: seedInfo.tabs,
    latch,
    pw,
    close,
    fault: async (action, params = {}) => {
      if (!app.recovery && !app.installed) throw new Error('Not a recovery fixture');
      const id = crypto.randomUUID();
      faults.push({id, action, params});
      const ack = await eventually(() => acks.get(id), 10000);
      acks.delete(id);
      if (ack.error) throw new Error(ack.error);
      return ack.result;
    },
    refreshIdentity: async (timeout = 20000) =>
      (identity = await eventually(async () => (await latch(0, ['discover'])).profiles.find(p => p.instanceId === identity.instanceId), timeout)),
    suspendHost: async () => suspendTestHost(registration),
    restoreHost: async () => restoreTestHost(registration),
    evidenceRecord,
    stop: async () => stopBrowser(browser),
    restartBrowser: async () => {
      await stopBrowser(browser);
      browser = spawn(chrome, args, {env: browserEnv(), stdio: ['ignore', 'ignore', 'ignore']});
      return browser.pid;
    },
    // background: true => --focus-emulation on, false => off, omitted => the
    // v1.1 default (on), which also keeps an existing session's setting valid.
    connect: async (index, tabId, {background} = {}) =>
      latch(index, ['connect', '--profile', 'work', ...(background === undefined ? [] : ['--focus-emulation', background ? 'on' : 'off']), '--session', 'agent', '--tab', String(tabId)]),
    states: () => [...app.states.values()].filter(state => state.actor.startsWith(run)),
  };
}
