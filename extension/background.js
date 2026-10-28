import {HOST} from './protocol.js';
import {createController} from './controller.js';
import {createDebuggerTransport} from './debugger-transport.js';

const nativeTransport = createDebuggerTransport(chrome);

let port;
let controller;
let reconnect;
let epoch;
let lastError = '';
let connecting;

export async function dispatch(request) {
  if (!controller) await connect();
  return await controller.handle(request);
}
export async function status() {
  if (!controller) await connect();
  const {instanceId} = await chrome.storage.local.get('instanceId');
  return {instanceId, epoch, connected: !!port, lastError};
}

async function connect() {
  if (port) return;
  if (connecting) return await connecting;
  connecting = connectOnce().finally(() => { connecting = undefined; });
  return await connecting;
}
async function connectOnce() {
  const stored = await chrome.storage.local.get('instanceId');
  const instanceId = stored.instanceId || crypto.randomUUID();
  if (!stored.instanceId) await chrome.storage.local.set({instanceId});
  epoch ||= crypto.randomUUID();
  controller ||= createController(chrome, {instanceId, epoch, extensionVersion: chrome.runtime.getManifest().version}, {nativeTransport});
  const next = chrome.runtime.connectNative(HOST);
  port = next;
  next.onMessage.addListener(async request => {
    if (request?.type !== 'request') return;
    const response = await dispatch(request);
    try { next.postMessage(response); } catch {}
  });
  next.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'Native bridge disconnected.';
    if (port !== next) return;
    lastError = error;
    port = undefined;
    void nativeTransport.releaseAll();
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, 10000);
  });
  next.postMessage({v: 1, type: 'hello', instanceId, epoch, extensionId: chrome.runtime.id,
    capabilities: {nativeTransport: nativeTransport.available}, extensionVersion: chrome.runtime.getManifest().version});
  lastError = '';
}
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.tabs.onRemoved.addListener(id => controller?.removeTab(id));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (message?.type === 'status') status().then(reply);
  else if (message?.type === 'request') dispatch(message).then(reply);
  else return;
  return true;
});
void connect();
