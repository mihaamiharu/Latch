import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {attachmentFixture, valueOf} from './helpers/attachment-fixture.mjs';
import {evidenceApp, hash} from './fixtures/evidence-app.mjs';
import {eventually, command} from './helpers/native-browser.mjs';
import {pngFrame} from '../src/live-view.mjs';
import {pngDecoder} from './helpers/evidence-capture.mjs';

test('headless native live view streams changed pixels while agent/peer/auth survive viewer exit', {
  skip: process.env.LATCH_LIVE_VIEW !== '1' || process.platform !== 'darwin', timeout: 150000,
}, async t => {
  const app = await evidenceApp(); app.recovery = true;
  let f; t.after(async () => { await f?.close(); await app.close(); });
  f = await attachmentFixture(t, app, 'native');
  await f.connect(0, f.tabs[0], {background: true});
  await f.connect(1, f.tabs[1], {background: true});
  await f.pw(0, ['run-code', 'async(page)=>{await page.bringToFront();await page.evaluate(()=>localStorage.setItem("view-auth","synthetic-login"))}']);
  const moduleURL = new URL('../src/live-view.mjs', import.meta.url).href;
  const opts = {profile:'work', workspace:f.workspaces[0], session:'agent', renderer:'kitty'};
  async function endpoint() {
    const r = await command(process.execPath, ['--input-type=module', '-e',
      `import {viewEndpoint} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(await viewEndpoint(${JSON.stringify(opts)})))`], {env:f.env});
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out).endpoint;
  }
  const viewer = new WebSocket(await endpoint()), frames = [];
  t.after(() => viewer.terminate());
  viewer.on('message', raw => frames.push(pngFrame(raw)));
  await once(viewer, 'open');
  await eventually(() => frames.length >= 1, 12000);
  const before = frames.length;
  const previous = hash(frames.at(-1));
  const PNG = await pngDecoder();
  await f.pw(0, ['run-code', 'async(page)=>page.evaluate(()=>{document.body.style.background="rgb(0,160,80)";document.querySelector("#result").textContent="LIVE FRAME CHANGED"})']);
  await eventually(() => {
    if (frames.length <= before || hash(frames.at(-1)) === previous) return false;
    const image = PNG.sync.read(frames.at(-1));
    const offset = ((image.height - 20) * image.width + image.width - 20) * 4;
    return image.data.subarray(offset, offset + 4).equals(Buffer.from([0,160,80,255]));
  }, 10000);
  const liveStatus = await f.nativeStatus();
  assert.ok(liveStatus.sessions.some(s => s.view?.streamFrames > 0));
  await fs.writeFile(path.join(f.evidence, 'live-view.png'), frames.at(-1));
  const closed = once(viewer, 'close'); viewer.close(); await closed;
  await eventually(async () => (await f.nativeStatus()).sessions[0]?.pending === 0);
  assert.equal((await f.latch(0, ['reconcile','--session','agent'])).healthy, true);
  const read = i => f.pw(i, ['run-code', 'async(page)=>({actor:await page.locator("#actor").innerText(),auth:await page.evaluate(()=>localStorage.getItem("view-auth"))})']).then(valueOf);
  assert.equal((await read(0)).auth, 'synthetic-login');
  assert.equal((await read(1)).actor, f.run+':b');

  // Exercise renderer startup/frame/quit/terminal restoration through a fake
  // TTY; actual Herdr/outer-terminal display remains a separate manual check.
  const render = await command(process.execPath, ['--input-type=module','-e', `
    import {PassThrough,Writable} from 'node:stream';
    import {liveView} from ${JSON.stringify(moduleURL)};
    const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=v=>{input.isRaw=v};
    let text='',quit=false;const output=new Writable({write(chunk,enc,cb){text+=chunk.toString();if(!quit&&text.includes('a=T,f=100')){quit=true;setTimeout(()=>input.write('q'),10)}cb()}});
    Object.assign(output,{isTTY:true,columns:80,rows:24});
    const limit=setTimeout(()=>{console.error('No terminal frame');process.exit(1)},12000);
    await liveView(${JSON.stringify(opts)},{input,output});clearTimeout(limit);
    console.log(JSON.stringify({frame:quit,restored:text.includes('\\x1b[?1049l'),raw:input.isRaw}));
  `], {env:f.env});
  assert.equal(render.code, 0, render.err);
  assert.deepEqual(JSON.parse(render.out), {frame:true,restored:true,raw:false});
  assert.equal((await f.latch(0,['reconcile','--session','agent'])).healthy,true);
  const second = new WebSocket(await endpoint()); await once(second,'open');
  const gone = once(second,'close'); await f.latch(0,['disconnect','--session','agent']); await gone;
  assert.equal((await read(1)).actor,f.run+':b');
  await fs.writeFile(path.join(f.evidence,'live-view-result.json'), JSON.stringify({
    headless:true, launchArgs:f.launchArgs, versions:f.versions, frames:frames.length,
    changedPixels:true, agentSurvivesViewer:true, peerSurvivesDisconnect:true,
    syntheticLoginPreserved:true, kittyWireAndTerminalRestoration:true,
    actualHerdrRendering:'not tested',
  },null,2));
  console.log('Live view evidence: '+f.evidence);
});
