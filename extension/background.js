import {HOST, fault, safeError} from './protocol.js';
import {createController} from './controller.js';
import {createDebuggerTransport} from './debugger-transport.js';
import {createBridgeConnection} from './bridge-connection.js';

let controller, connection, identity;
const nativeTransport = createDebuggerTransport(chrome, {
  onTargetGone: (key, id, leaseId) => { void controller?.nativeDetached(key, id, leaseId); },
  onWarning: (key, warning, leaseId) => { void controller?.nativeWarning(key, warning, leaseId); },
});
const initialized = (async () => {
  const stored = await chrome.storage.local.get('instanceId');
  const instanceId = stored.instanceId || crypto.randomUUID();
  if (!stored.instanceId) await chrome.storage.local.set({instanceId});
  identity = {instanceId, epoch: crypto.randomUUID(), extensionVersion: chrome.runtime.getManifest().version};
  controller = createController(chrome, identity, {nativeTransport, nativeRecovery: true});
  connection = createBridgeConnection(chrome, {host: HOST,
    hello: {v: 1, type: 'hello', ...identity, extensionId: chrome.runtime.id, capabilities: {nativeTransport: nativeTransport.available, nativeSessionSchema: 4, uiControl: 1}},
    invalidate: async () => { await controller.invalidateNative(); await nativeTransport.recoverOwned(); },
    activate: generation => controller.activateNative(generation),
    dispatch: (request, generation) => {
      // The host may only forward requests for its own verified lifetime.
      if (request.op.startsWith('native-') && request.payload.hostGeneration !== undefined && request.payload.hostGeneration !== generation)
        return {v: 1, id: request.id, ok: false, error: safeError(fault('AUTHORITY_STALE', 'Native host generation changed.'))};
      return controller.handle(request);
    }});
  await connection.start();
})();
export async function dispatch(request) { await initialized; return controller.handle(request); }
export async function status() { await initialized; return {...identity, ...connection.status()}; }
chrome.runtime.onInstalled.addListener(() => { void initialized; });
chrome.runtime.onStartup.addListener(() => { void initialized.then(() => connection.start({reset: true})); });
chrome.tabs.onRemoved.addListener(id => { void controller?.removeTab(id)?.catch(() => {}); });
chrome.tabs.onCreated?.addListener(tab => { void controller?.observeTab(tab)?.catch(() => {}); });
chrome.tabs.onUpdated?.addListener((id, change, tab) => { void controller?.observeTab(tab)?.catch(() => {}); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if(message?.type==='ui'){
    if(sender.url!==chrome.runtime.getURL('popup.html'))return;
    initialized.then(()=>connection.ui(message.op,message.payload)).then(result=>reply({ok:true,result}),error=>reply({ok:false,error:safeError(error)}));
  } else if (message?.type === 'status') status().then(reply);
  else if (message?.type === 'retry') initialized.then(() => connection.start({reset: true})).then(status).then(reply);
  else if (message?.type === 'request') dispatch(message).then(reply);
  else return;
  return true;
});
