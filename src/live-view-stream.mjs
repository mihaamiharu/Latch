import {WebSocket} from 'ws';

// A viewer receives pixels only; it never gets a CDP command channel. The
// automation client's connection and lease outlive the viewer.
export function liveViewStream({call, rootTab, isStopped}) {
  let viewer, busy = false, started = false, ending = Promise.resolve(), framesSent = 0, streamFrames = 0;
  let latest, flushTimer;
  function flush() {
    flushTimer = undefined;
    const data = latest; latest = undefined;
    if (data && viewer?.readyState === WebSocket.OPEN && viewer.bufferedAmount < 1024 * 1024) {
      viewer.send(JSON.stringify({type: 'frame', format: 'png', data})); framesSent++;
    }
  }
  function frame(data) {
    if (viewer?.readyState !== WebSocket.OPEN || typeof data !== 'string' || data.length > 4 * 1024 * 1024) return;
    latest = data;
    if (!flushTimer) flushTimer = setTimeout(flush, 160);
  }
  async function end(ws) {
    if (viewer !== ws) return;
    viewer = undefined;
    clearTimeout(flushTimer); flushTimer = undefined; latest = undefined;
    ending = ending.then(async () => {
      if (started && !isStopped()) await call('command', {tabId: rootTab(), method: 'Page.stopScreencast', params: {}}).catch(() => {});
      started = false; busy = false;
    });
    await ending;
  }
  return {
    available: () => !busy && !isStopped(),
    active: () => busy,
    status: () => ({active: busy, framesSent, streamFrames}),
    async attach(ws) {
      busy = true; viewer = ws;
      ws.on('error', () => ws.terminate());
      ws.on('message', () => ws.close(1008, 'View-only connection.'));
      ws.once('close', () => { void end(ws); });
      try {
        // One initial frame also makes a static page visible immediately.
        const shot = await call('command', {tabId: rootTab(), method: 'Page.captureScreenshot', params: {format: 'png', captureBeyondViewport: false}});
        if (viewer !== ws) return;
        frame(shot.data);
        started = true;
        await call('command', {tabId: rootTab(), method: 'Page.startScreencast', params: {format: 'png', maxWidth: 1280, maxHeight: 800, everyNthFrame: 1}});
        if (viewer !== ws) await ending;
      } catch { ws.close(1011, 'Browser view unavailable.'); }
    },
    event(event) {
      if (event.source?.tabId !== rootTab() || event.source?.sessionId || event.method !== 'Page.screencastFrame') return false;
      if (!busy) return false;
      streamFrames++;
      frame(event.params?.data);
      // Never make Chrome wait for terminal rendering or a slow viewer.
      void call('command', {tabId: rootTab(), method: 'Page.screencastFrameAck', params: {sessionId: event.params?.sessionId}}).catch(() => {});
      return true;
    },
    stop() { clearTimeout(flushTimer); flushTimer = undefined; latest = undefined; if (viewer) viewer.close(1001, 'Session or selected tab ended.'); },
  };
}
