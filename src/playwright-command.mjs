import {fault} from '../extension/protocol.js';
import {runCLI} from './playwright.mjs';
import {nativeChannel} from './native-channel.mjs';
import {daemonIdentity} from './daemon-identity.mjs';
import {locked, readSession} from './state.mjs';

// Ordinary session tools only. Latch retains responsibility for attachment and
// cleanup. This is an error-normalizing adapter, not a sandbox for run-code.
const commands = new Set(`goto type click dblclick fill drag drop hover select upload check uncheck snapshot find eval
dialog-accept dialog-dismiss go-back go-forward reload press keydown keyup mousemove mousedown mouseup mousewheel
screenshot pdf tab-list tab-select console run-code requests request request-headers request-body response-headers
response-body route route-list unroute network-state-set recording-start recording-stop tracing-start tracing-stop
video-start video-stop video-chapter video-show-actions video-hide-actions generate-locator highlight
state-load state-save cookie-list cookie-get cookie-set cookie-delete cookie-clear localstorage-list localstorage-get
localstorage-set localstorage-delete localstorage-clear sessionstorage-list sessionstorage-get sessionstorage-set
sessionstorage-delete sessionstorage-clear webmcp-list webmcp-call`.split(/\s+/));

export function validatePlaywrightArgs(args) {
  if (!commands.has(args[0])) throw fault('INVALID_ARGUMENT', 'Use pw -- <ordinary Playwright command>. Use Latch connect/release/disconnect for session lifecycle.');
  if (args.slice(1).some(arg => /^-[a-zA-Z]/.test(arg) || /^--(?:no-)?(?:s|session|json|raw|help|version)(?:=|$)/.test(arg)))
    throw fault('INVALID_ARGUMENT', 'The pw adapter owns the Playwright session and JSON format; do not override them.');
}

export async function runSessionCLI({args, profile, session, workspace, key, legacy, nativeRecord, selection, call, options}) {
  validatePlaywrightArgs(args);
  const recordedTransport = legacy ? legacy.transport || 'official' : nativeRecord?.status !== 'retired' && nativeRecord ? 'native' : null;
  if (recordedTransport && recordedTransport !== selection.transport)
    throw fault('TRANSPORT_MISMATCH', 'The command must use this session\'s recorded transport. Disconnect before changing adapters.');
  const execute = async record => {
    if (!record || record.status && record.status !== 'attached') throw fault('SESSION_UNAVAILABLE', 'Connect this workspace/session before running Playwright commands.');
    if (record.instanceId !== profile.instanceId || record.epoch !== profile.epoch || record.workspace !== workspace || record.session !== session)
      throw fault('SESSION_STALE', 'The recorded session does not match this browser/workspace. Inspect before proceeding.');
    const daemon = await daemonIdentity(workspace, session);
    if (!daemon?.socketExists || record.v === 4 && (daemon.fingerprint !== record.daemonFingerprint || daemon.socketFingerprint !== record.daemonSocketFingerprint))
      throw fault('DAEMON_IDENTITY_UNCONFIRMED', 'The attached Playwright task is absent or replaced. No browser action was sent.');
    const response = await runCLI(session, args, options);
    return {...response, ...selection, session, workspace};
  };
  if (selection.transport === 'native') {
    if (legacy || nativeRecord?.v !== 4) throw fault('SESSION_UNAVAILABLE', 'The pw adapter requires an attached schema-4 native session.');
    const channel = await nativeChannel(profile, {session, workspace, sessionKey: key});
    let record;
    try {
      const plan = await channel.send('inspect');
      if (!plan.healthy) throw fault('SESSION_STALE', 'Native session is not healthy. Inspect/reconcile before running browser actions.');
      record = plan.record;
    } finally { await channel.close().catch(() => {}); }
    // Do not hold a recovery grant over an application call. Popup Stop and
    // normal disconnect must be able to revoke a held/uncertain action.
    // The usual Playwright CLI still resolves the named task after preflight.
    return execute(record);
  }
  return locked(key, async () => {
    const record = await readSession(key);
    if (!record || record.transport && record.transport !== 'official') throw fault('SESSION_UNAVAILABLE', 'No official session is registered for this task.');
    if (record.v !== undefined && ![2, 3].includes(record.v)) throw fault('SESSION_STATE_UNSUPPORTED', 'Unsupported official session record. Preserve and inspect it.');
    const status = await call('status');
    if (!status.sessions?.some(s => s.key === key && s.groupId === record.groupId)) throw fault('SESSION_STALE', 'Official browser registration no longer matches this task.');
    return execute(record);
  });
}
