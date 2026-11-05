#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {WebSocket} from 'ws';
import {readConfig, request} from './local.mjs';
import {nativeChannel} from './native-channel.mjs';
import {sessionKey, workspaceAt, cliError} from './playwright.mjs';
import {fault} from '../extension/protocol.js';

export function viewOptions(argv) {
  const flags = {};
  while (argv.length) {
    const key = argv.shift();
    if (key === '--help') return {help: true};
    if (!['--profile', '--session', '--workspace', '--renderer'].includes(key) || flags[key.slice(2)])
      throw fault('INVALID_ARGUMENT', 'Use --profile, --session, --workspace and --renderer chafa|kitty.');
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw fault('INVALID_ARGUMENT', `Missing ${key}.`);
    flags[key.slice(2)] = value;
  }
  flags.profile ||= 'work'; flags.workspace ||= process.cwd(); flags.renderer ||= 'chafa';
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(flags.profile) || !/^[a-zA-Z0-9_-]{1,60}$/.test(flags.session || '') ||
      !['chafa', 'kitty'].includes(flags.renderer)) throw fault('INVALID_ARGUMENT', 'Specify a simple --session and --renderer chafa|kitty.');
  return flags;
}

export function pngFrame(raw) {
  const value = JSON.parse(raw.toString());
  if (value.type !== 'frame' || value.format !== 'png' || typeof value.data !== 'string' ||
      value.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data))
    throw fault('VIEW_FRAME_INVALID', 'Invalid browser frame.');
  const png = Buffer.from(value.data, 'base64');
  if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw fault('VIEW_FRAME_INVALID', 'Expected a PNG browser frame.');
  return png;
}

export function kittyFrame(png, columns, rows) {
  const data = png.toString('base64'), chunks = [];
  for (let i = 0; i < data.length; i += 4096)
    chunks.push(`\x1b_G${i === 0 ? `a=T,f=100,t=d,i=31,q=2,c=${columns},r=${rows},` : ''}m=${i + 4096 < data.length ? 1 : 0};${data.slice(i, i + 4096)}\x1b\\`);
  return '\x1b_Ga=d,d=I,i=31,q=2\x1b\\' + chunks.join('');
}

export async function viewEndpoint({profile: alias, workspace, session}) {
  const configured = (await readConfig()).profiles?.[alias];
  if (!configured) throw fault('PROFILE_UNPAIRED', 'Pair this profile before viewing.');
  const profile = {...configured, ...await request(configured.instanceId, 'status')};
  const channel = await nativeChannel(profile, {workspace, session, sessionKey: sessionKey(workspace, session)});
  try {
    const plan = await channel.send('inspect');
    if (!plan.healthy) throw fault('SESSION_STALE', 'Connect a healthy native Latch session before viewing.');
    try { return await channel.send('view'); }
    catch (error) {
      if (error.code === 'INVALID_REQUEST') throw fault('VIEW_HOST_UPDATE_REQUIRED', 'The running host predates live view. Stage and activate the updated Latch kit before using view.');
      throw error;
    }
  } finally { await channel.close().catch(() => {}); }
}

export async function liveView(options, {input = process.stdin, output = process.stdout} = {}) {
  if (!input.isTTY || !output.isTTY) throw fault('VIEW_TTY_REQUIRED', 'Run live view in an interactive terminal pane.');
  if (options.renderer === 'chafa' && spawnSync('chafa', ['--version'], {stdio: 'ignore'}).status !== 0)
    throw fault('VIEW_RENDERER_MISSING', 'Install chafa for ANSI rendering, or use --renderer kitty in a compatible terminal with Herdr kitty_graphics enabled.');
  const workspace = await workspaceAt(options.workspace);
  const {endpoint, tabId} = await viewEndpoint({...options, workspace});
  const ws = new WebSocket(endpoint, {maxPayload: 6 * 1024 * 1024, perMessageDeflate: false});
  let latest, worker, drawing = false, done = false, failure;
  const wasRaw = !!input.isRaw;
  output.write('\x1b[?1049h\x1b[?25lWaiting for Chrome frames... (q quits)'); input.setRawMode(true); input.resume();
  const finish = () => { done = true; ws.terminate(); worker?.kill(); };
  const key = data => { if (/[q\x03\x1b]/.test(data.toString())) finish(); };
  input.on('data', key); process.once('SIGTERM', finish); process.once('SIGINT', finish);
  async function render() {
    if (drawing || done || !latest) return;
    drawing = true; const frame = latest; latest = undefined;
    const columns = Math.max(1, output.columns || 80), rows = Math.max(1, (output.rows || 24) - 2);
    try {
      let pixels;
      if (options.renderer === 'kitty') pixels = kittyFrame(frame, columns, rows);
      else pixels = await new Promise((resolve, reject) => {
        worker = spawn('chafa', ['--format=symbols', '--colors=full', `--size=${columns}x${rows}`, '-'], {stdio: ['pipe', 'pipe', 'pipe']});
        const chunks = []; let bytes = 0;
        worker.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) worker.kill(); else chunks.push(chunk); });
        worker.stdin.on('error', () => {}); worker.stderr.resume();
        worker.once('error', reject);
        worker.once('close', code => { worker = undefined; code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(fault('VIEW_RENDER_FAILED', 'Chafa could not render the frame.')); });
        worker.stdin.end(frame);
      });
      if (done) return;
      // No page-provided text is ever interpreted as terminal control sequences.
      const header = `Latch | ${options.session} | tab ${tabId} | view only | q quit`.slice(0, columns);
      const painted = output.write(`\x1b[H\x1b[2K${header}\x1b[2;1H\x1b[J${pixels}`);
      if (!painted) await new Promise(resolve => {
        const settle = () => { output.off('drain', settle); ws.off('close', settle); resolve(); };
        output.once('drain', settle); ws.once('close', settle);
      });
    } catch (error) { if (!done) { failure = error; finish(); } }
    finally { drawing = false; }
  }
  const timer = setInterval(() => { void render(); }, 160);
  try {
    await new Promise(resolve => {
      ws.on('message', raw => { try { latest = pngFrame(raw); } catch (error) { failure = error; finish(); } });
      ws.once('error', () => { failure = fault('VIEW_CONNECTION_FAILED', 'Viewer unavailable. The host must include live-view support; another viewer may already be open.'); finish(); resolve(); });
      ws.once('close', (code) => { if (!done && code !== 1000) failure = fault('VIEW_ENDED', 'The browser view ended. The selected tab or native session may have closed.'); resolve(); });
    });
  } finally {
    finish(); clearInterval(timer); input.off('data', key); input.setRawMode(wasRaw); input.pause();
    process.off('SIGTERM', finish); process.off('SIGINT', finish);
    output.write('\x1b_Ga=d,d=I,i=31,q=2\x1b\\\x1b[?25h\x1b[?1049l');
  }
  if (failure) throw failure;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = viewOptions(process.argv.slice(2));
    if (options.help) console.log('node src/live-view.mjs --profile work --session NAME --workspace /project [--renderer chafa|kitty]\nView-only native session stream. q quits the viewer and preserves Chrome and the agent session.');
    else await liveView(options);
  } catch (error) { console.error(JSON.stringify({ok: false, error: cliError(error)})); process.exitCode = 1; }
}
