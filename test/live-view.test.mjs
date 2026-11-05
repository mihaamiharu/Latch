import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {relayFixture} from './helpers/relay-fixture.mjs';
import {eventually} from './helpers/native-browser.mjs';
import {viewOptions, pngFrame, kittyFrame} from '../src/live-view.mjs';
import {redact} from '../src/playwright.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i8AAAAASUVORK5CYII=', 'base64');
async function refused(url, options) {
  const ws = new WebSocket(url, options);
  await assert.rejects(once(ws, 'open'), /403/);
}
test('view validates options/frames and chunks PNG Kitty payloads', () => {
  assert.throws(() => viewOptions([]), /session/);
  assert.throws(() => viewOptions(['--session','a','--renderer','html']), /renderer/);
  assert.throws(() => viewOptions(['--session','a','--session','b']), /Use/);
  assert.equal(viewOptions(['--session','a']).renderer, 'chafa');
  assert.deepEqual(pngFrame(JSON.stringify({type:'frame',format:'png',data:png.toString('base64')})), png);
  assert.throws(() => pngFrame('{"type":"frame","format":"png","data":"<script>"}'), /Invalid/);
  assert.throws(() => pngFrame(JSON.stringify({type:'frame',format:'png',data:Buffer.from('not png').toString('base64')})), /PNG/);
  const wire = kittyFrame(Buffer.alloc(10000), 80, 22);
  assert.match(wire, /c=80,r=22/); assert.match(wire, /m=1/); assert.match(wire, /m=0/);
  assert.equal(redact('/view/'+'a'.repeat(64)), '/view/[redacted]');
});
test('pixel-only viewer rejects foreign origins/duplicates; quit preserves agent; frames stay scoped', async t => {
  const f = await relayFixture(t), commands = [], agentFrames = [];
  f.cdp.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Page.screencastFrame') agentFrames.push(m); });
  f.handle((m, respond) => {
    commands.push(m.params?.method);
    if (m.params?.method === 'Page.captureScreenshot') f.ext.send(JSON.stringify({id:m.id,result:{data:png.toString('base64')}}));
    else respond(m);
  });
  await refused(f.relay.viewEndpoint, {origin:'https://page.example'});
  await refused(f.relay.viewEndpoint.replace(/.$/,'z'));
  const viewer = new WebSocket(f.relay.viewEndpoint), frames = [];
  viewer.on('message', data => frames.push(JSON.parse(data)));
  await once(viewer,'open');
  await eventually(() => frames.length && commands.includes('Page.startScreencast'));
  await refused(f.relay.viewEndpoint);
  assert.match((await f.request('Page.startScreencast', {}, f.root)).error.message, /Close the viewer/);
  const emit = tabId => f.ext.send(JSON.stringify({method:'event',params:{source:{tabId},method:'Page.screencastFrame',params:{data:png.toString('base64'),sessionId:7}}}));
  emit(99); await new Promise(r => setTimeout(r,30)); assert.equal(frames.length,1);
  emit(42); await eventually(() => frames.length===2 && commands.includes('Page.screencastFrameAck'));
  assert.deepEqual(pngFrame(JSON.stringify(frames[1])),png);
  assert.equal(agentFrames.length,0,'Viewer PNGs must not consume agent socket backlog');
  const closed=once(viewer,'close');viewer.close();await closed;
  await eventually(() => commands.includes('Page.stopScreencast'));
  assert.equal(f.relay.status().stopped,false);
  assert.ok((await f.request('Browser.getVersion')).result.product);
  await f.request('Page.startScreencast',{},f.root);
  await refused(f.relay.viewEndpoint);
  await f.request('Page.stopScreencast',{},f.root);
  const second=new WebSocket(f.relay.viewEndpoint);await once(second,'open');
  const secondClosed=once(second,'close');second.send(JSON.stringify({method:'Input.dispatchMouseEvent'}));
  assert.equal((await secondClosed)[0],1008);
  assert.ok(!commands.includes('Input.dispatchMouseEvent'));
  assert.equal(f.relay.status().stopped,false);
});
