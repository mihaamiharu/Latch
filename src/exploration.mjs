import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ACTIONS, fault} from '../extension/protocol.js';
import {cliError, resultValue, sessionKey} from './redact.mjs';
import {readConfig, request} from './local.mjs';
import {workspaceBindingPath} from './platform.mjs';
import {ROOT} from './release.mjs';
import {
  LIMITS,
  idPattern,
  regularFile,
  appendCommand,
  appendObservation,
  ledger,
  listRuns,
  boundRun,
  allocateRun,
  loadMeta,
  runPath,
  saveMeta,
  unbind,
  lockRun,
  indexArtifact,
  atomic,
  exclusive,
  bounded,
  digest,
  scrub,
} from './exploration-storage.mjs';
import {
  addStates,
  actionOf,
  describeAction,
  resolveActionInvocation,
  writeHandoff,
  finishIntegrity,
} from './exploration-model.mjs';
import {libraryCommand} from './exploration-library.mjs';
import {handoffFileOf} from './exploration-handoff.mjs';

const PACKAGE_VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

export {libraryCommand};

const id = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
const selected = meta => [...meta.states].reverse().find(s => s.selected && s.frame.id === 'main');
const metaFlags = new Set([
  'record',
  'objective',
  'environment',
  'data-ref',
  'dataRef',
  'note',
  'run',
  'decision',
  'destination',
  'port',
  'annotation-file',
  'annotationFile',
]);

const uncertainCodeRe = /(?:CLI_TIMEOUT|CLI_OUTPUT_LARGE|CLI_RESPONSE_INVALID|CONNECTION|DISCONNECTED|TIMEOUT|BRIDGE_TIMEOUT)/;
const uncertainError = error =>
  uncertainCodeRe.test(error?.code || '') ||
  /TimeoutError|Target.*closed|Session.*closed|Connection closed|interrupted|Execution context was destroyed|frame was detached/i.test(
    error?.message || '',
  );

function cleanInvocation(inv) {
  const flags = {...(inv.flags || {})};
  for (const k of metaFlags) delete flags[k];
  return {...inv, flags};
}

function isActionInvocation(inv) {
  if (inv.command === 'pw') return true;
  if (ACTIONS.has(inv.command)) return true;
  if (inv.action && ACTIONS.has(inv.action)) return true;
  return false;
}

function commandKind(inv) {
  if (['open', 'connect', 'disconnect', 'release', 'finish', 'checkpoint'].includes(inv.command)) {
    return 'infrastructure';
  }
  const {type} = resolveActionInvocation(inv);
  return ['snapshot', 'screenshot'].includes(type) ? 'capture' : 'operation';
}

async function stopRequest(meta) {
  try {
    return JSON.parse(await regularFile(path.join(await runPath(meta.id), 'stop-request.json'), 8192));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function callBridge(profileName, op, payload = {}, timeout = 45000) {
  const config = await readConfig();
  const profile = config.profiles?.[profileName];
  if (!profile) throw fault('PROFILE_UNPAIRED', 'Pair the Chrome extension instance before using this profile alias.');
  const live = await request(profile.instanceId, 'status');
  return request(
    profile.instanceId,
    op,
    {
      instanceId: profile.instanceId,
      epoch: live.epoch ?? profile.epoch,
      hostGeneration: live.hostGeneration ?? profile.hostGeneration,
      ...payload,
    },
    timeout,
  );
}

async function invokeCaptureState(meta, execute) {
  const key = sessionKey(meta.workspace, meta.session);
  if (typeof execute === 'function') {
    try {
      return await execute({
        command: 'session-capture-state',
        op: 'session-capture-state',
        payload: {sessionKey: key, includeScreenshot: true, captureScreenshot: true},
        flags: {
          workspace: meta.workspace,
          session: meta.session,
          profile: meta.profile,
          includeScreenshot: true,
          captureScreenshot: true,
        },
      });
    } catch (error) {
      if (!['INVALID_COMMAND', 'UNKNOWN_COMMAND'].includes(error?.code)) throw error;
    }
  }
  return callBridge(meta.profile, 'session-capture-state', {
    sessionKey: key,
    includeScreenshot: true,
    captureScreenshot: true,
  });
}

async function invokeDisconnect(meta, execute, {closeTabs = false} = {}) {
  const key = sessionKey(meta.workspace, meta.session);
  if (typeof execute === 'function') {
    return execute({
      command: 'disconnect',
      flags: {
        session: meta.session,
        workspace: meta.workspace,
        profile: meta.profile,
        ...(closeTabs ? {'close-tabs': true} : {}),
      },
    });
  }
  return callBridge(meta.profile, 'session-disconnect', {
    sessionKey: key,
    workspace: meta.workspace,
    session: meta.session,
    ...(closeTabs ? {closeTabs: true} : {}),
  });
}

async function capture(meta, execute, {final = false, label = 'capture'} = {}) {
  const step = id(label);
  try {
    const response = await invokeCaptureState(meta, execute);
    const value = Array.isArray(response?.pages) ? response : resultValue(response);
    if (!value || !Array.isArray(value.pages)) throw fault('CAPTURE_INVALID', 'Capture returned no page inventory.');
    const beforePages = new Set(meta.states.map(s => s.page));
    const stateStart = meta.states.length;
    const result = await addStates(meta, value, {final, step});
    const addedMainStates = meta.states.slice(stateStart).filter(s => s.frame?.id === 'main');
    if (addedMainStates.some(s => !s.screenshot)) {
      meta.gaps.push({step, reason: 'PNG screenshot unavailable for one or more captured pages.'});
    }
    if (final) {
      for (const page of beforePages) {
        if (!value.pages.some(p => p.targetId === page)) {
          meta.finals.push({
            page,
            state: [...meta.states].reverse().find(s => s.page === page)?.id || null,
            status: 'unavailable',
            reason: 'Page closed or was unreachable at finish; last observed state retained.',
          });
        }
      }
    }
    if (!value.pages.length) meta.gaps.push({step, reason: 'No owned page could be captured.'});
    return result;
  } catch (e) {
    meta.gaps.push({step, reason: 'State/screenshot capture failed', code: e.code || 'CAPTURE_FAILED'});
    return null;
  }
}

async function writeRawCommandOutput(meta, step, {sensitive = false, result, error}) {
  const dir = await runPath(meta.id);
  const rawName = `raw/${step}.json`;
  const raw =
    JSON.stringify(
      bounded(
        {
          result: sensitive ? {redacted: true, reason: 'Browser storage output is excluded from recorded evidence.'} : result,
          error: error
            ? sensitive
              ? {code: error.code, message: 'Storage command details excluded.'}
              : cliError(error)
            : null,
        },
        LIMITS.textBytes,
      ),
    ) + '\n';
  await atomic(path.join(dir, rawName), raw);
  return indexArtifact(meta, rawName, 'command-output');
}

async function persist(meta) {
  await appendObservation(meta, {
    type: 'summary',
    summary: {
      status: meta.status,
      recording: meta.recording,
      annotations: meta.annotations,
      gaps: meta.gaps,
      notices: meta.notices || [],
      finals: meta.finals,
      cleanup: meta.cleanup,
      finishedAt: meta.finishedAt,
      pending: meta.pending || null,
    },
    artifacts: meta.artifacts,
  });
  await writeHandoff(meta);
}

export async function finishRun(meta, _version, execute, {disconnect = true, closeTabs = false} = {}) {
  // A forced Stop/closed tab can make final capture fail. None of these paths
  // repeat application actions; disconnect is always attempted.
  try {
    await capture(meta, execute, {final: true, label: 'final'});
  } catch (e) {
    meta.gaps.push({reason: 'Final capture failed', code: e.code || 'FINALIZE_FAILED'});
  }

  let result;
  let error;
  const step = id('disconnect');
  const dir = await runPath(meta.id);
  if (disconnect) {
    try {
      await appendCommand(dir, {
        schema: 1,
        event: 'started',
        runId: meta.id,
        step,
        at: new Date().toISOString(),
        command: 'disconnect',
        kind: 'infrastructure',
        argumentCount: 0,
        argumentSHA256: null,
      });
    } catch {}
    try {
      result = await invokeDisconnect(meta, execute, {closeTabs});
    } catch (e) {
      error = e;
    }
    const rawArtifact = await writeRawCommandOutput(meta, step, {result, error}).catch(() => null);
    try {
      await appendCommand(dir, {
        schema: 1,
        event: 'finished',
        runId: meta.id,
        step,
        at: new Date().toISOString(),
        operation: {
          outcome: error ? (uncertainError(error) ? 'unknown' : 'failed') : 'succeeded',
        },
        artifacts: rawArtifact ? [rawArtifact] : [],
        cleanup: {
          confirmed: !error && result?.disconnected === true,
          preservedUserTabs: result?.preservedUserTabs ?? null,
        },
      });
    } catch {}
    meta.cleanup =
      !error && result?.disconnected === true
        ? {status: 'confirmed', preservedUserTabs: result.preservedUserTabs ?? true}
        : {status: error ? 'failed' : 'unconfirmed', preservedUserTabs: result?.preservedUserTabs ?? null};
  }

  meta.finishedAt = new Date().toISOString();
  meta.status = error ? 'interrupted' : meta.gaps.length ? 'partial' : 'finished';
  if (error) meta.gaps.push({reason: 'Disconnect unconfirmed', code: error.code || 'DISCONNECT_FAILED'});
  await persist(meta);
  await finishIntegrity(meta);
  if (!error) await unbind(meta);
  if (error) {
    error.library = {runId: meta.id, directory: dir};
    throw error;
  }
  return {
    ...result,
    library: {
      runId: meta.id,
      directory: dir,
      handoff: path.join(dir, handoffFileOf(meta)),
      status: meta.status,
      screenshots: meta.artifacts.filter(a => a.type === 'screenshot').length,
      cleanup: meta.cleanup?.status,
      integrity: meta.integrity?.verified,
    },
  };
}

async function resolveSession(identity) {
  if (idPattern.test(identity.session || '')) return identity.session;
  try {
    const binding = JSON.parse(await fs.readFile(workspaceBindingPath(identity.workspace), 'utf8'));
    if (idPattern.test(binding.session || '')) return binding.session;
  } catch {}
  return identity.session;
}

export async function runWithExploration(invocation, version = PACKAGE_VERSION, execute) {
  const inv = invocation;
  const flags = inv.flags || {};
  const core = cleanInvocation(inv);
  const actionCommand = isActionInvocation(inv);

  if (
    !['open', 'connect', 'disconnect', 'checkpoint', 'finish', 'release'].includes(inv.command) &&
    !actionCommand
  ) {
    return execute(core);
  }
  if (process.env.LATCH_CAPTURE === 'off') {
    return execute(core);
  }

  for (const [key, max] of [
    ['objective', 500],
    ['environment', 200],
    ['data-ref', 200],
    ['dataRef', 200],
    ['note', 8000],
  ]) {
    if (flags[key] !== undefined && (typeof flags[key] !== 'string' || flags[key].length > max)) {
      throw fault('INVALID_ARGUMENT', `--${key} exceeds its supported length.`);
    }
  }

  const workspace = await fs.realpath(flags.workspace || process.cwd());
  const resolvedSession = await resolveSession({workspace, session: flags.session});
  const identity = {workspace, session: resolvedSession, profile: flags.profile || 'work'};
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(identity.profile)) throw fault('INVALID_PROFILE', 'Use a simple profile alias.');

  if (!idPattern.test(identity.session || '')) {
    if (['finish', 'checkpoint'].includes(inv.command)) {
      throw fault('INVALID_SESSION', 'Specify a simple --session name or have an active workspace session.');
    }
    return execute(core);
  }

  let binding = await boundRun(identity);
  const wantsRecord = Boolean(
    flags.record || (typeof flags.objective === 'string' && flags.objective.trim().length > 0),
  );

  if (!binding) {
    if (inv.command === 'finish') {
      const prior = (await listRuns()).find(
        r =>
          r.workspace === workspace &&
          r.session === identity.session &&
          r.profile === identity.profile &&
          r.cleanup?.status === 'confirmed',
      );
      if (prior) {
        return {
          finished: true,
          alreadyFinished: true,
          library: {
            runId: prior.id,
            handoff: path.join(await runPath(prior.id), handoffFileOf(prior)),
            status: prior.status,
          },
        };
      }
      throw fault('SESSION_UNAVAILABLE', 'No managed exploration is bound to this session.');
    }
    if (inv.command === 'checkpoint') {
      throw fault('SESSION_UNAVAILABLE', 'No managed exploration is bound to this session.');
    }
    if (!['open', 'connect'].includes(inv.command) || !wantsRecord) {
      return execute(core);
    }
  }

  let fresh = false;
  let meta;
  if (!binding) {
    meta = await allocateRun(identity, {objective: flags.objective, environment: flags.environment});
    binding = {id: meta.id};
    fresh = true;
  } else if (['open', 'connect'].includes(inv.command) && wantsRecord) {
    throw fault('EXPLORATION_BUSY', 'This session already has an active exploration run.');
  }

  const operation = async () => {
    meta = await loadMeta(binding.id);
    if (['finish', 'disconnect'].includes(inv.command)) {
      return finishRun(meta, version, execute, {closeTabs: flags['close-tabs'] === true});
    }

    if (inv.command === 'checkpoint') {
      await capture(meta, execute, {label: 'checkpoint'});
      const dataRef = flags['data-ref'] ?? flags.dataRef ?? null;
      const annotationFile = flags['annotation-file'] ?? flags.annotationFile;
      if (flags.note) {
        const last = meta.states.slice(-1)[0];
        meta.annotations.push({
          id: id('note'),
          kind: 'finding',
          text: scrub(flags.note),
          ...(dataRef ? {data_reference: scrub(dataRef)} : {}),
          evidence: [last?.snapshot, last?.screenshot].filter(Boolean),
          provenance: 'agent_supplied',
          at: new Date().toISOString(),
        });
      }
      if (annotationFile) {
        const annotation = JSON.parse(await regularFile(path.resolve(meta.workspace, annotationFile), 16384));
        if (
          !['behavior', 'finding', 'prerequisite', 'test_data', 'question', 'coverage_gap'].includes(annotation.kind) ||
          typeof (annotation.text || annotation.observed || annotation.reference) !== 'string'
        ) {
          throw fault('INVALID_ANNOTATION', 'Use a typed annotation with text, observed behavior or a test-data reference.');
        }
        if (annotation.transition && !meta.actions.some(a => a.id === annotation.transition)) {
          throw fault('INVALID_ANNOTATION', 'Annotation transition does not exist.');
        }
        const defaultEvidence = meta.states.slice(-1).map(s => s.snapshot).filter(Boolean);
        const evidence = annotation.evidence || defaultEvidence;
        if (!Array.isArray(evidence) || evidence.some(p => !meta.artifacts.some(a => a.path === p))) {
          throw fault('INVALID_ANNOTATION', 'Use indexed evidence paths from this run.');
        }
        meta.annotations.push({
          id: id('annotation'),
          kind: annotation.kind,
          text: scrub(annotation.text || null),
          observed: scrub(annotation.observed || null),
          expected: scrub(annotation.expected ?? null),
          reference: scrub(annotation.reference || dataRef || null),
          transition: annotation.transition || null,
          evidence,
          provenance: 'agent_supplied',
          assertion_status: 'not_asserted',
          at: new Date().toISOString(),
        });
      }
      await persist(meta);
      return {
        checkpoint: true,
        library: {
          runId: meta.id,
          handoff: path.join(await runPath(meta.id), handoffFileOf(meta)),
          states: meta.states.length,
          screenshots: meta.artifacts.filter(a => a.type === 'screenshot').length,
        },
      };
    }

    const dir = await runPath(meta.id);
    if (!fresh) {
      const history = await ledger(dir);
      if (history.events.filter(e => e.event === 'started').length >= LIMITS.commands - 2) {
        throw fault(
          'EXPLORATION_LIMIT',
          'Finish this run before issuing more actions; capture capacity is reserved for final state capture and disconnect. No new browser action was sent.',
        );
      }
    }

    const step = flags.step || id(actionCommand ? 'action' : inv.command);
    if (!idPattern.test(step)) {
      throw fault('INVALID_ARGUMENT', 'Use a simple --step ID of at most 60 characters.');
    }
    const startedAt = new Date().toISOString();
    let before = selected(meta);
    if (!fresh && actionCommand && (!before || !before.screenshot)) {
      before = (await capture(meta, execute, {label: 'before'})) || before;
    }

    const resolvedAction = resolveActionInvocation(inv);
    const sensitive = actionCommand && /^(cookie-|state-|localstorage-|sessionstorage-)/.test(resolvedAction.type);
    const argPayload = inv.playwrightArgs || inv.args || (inv.actionArgs ? [inv.actionArgs] : []);

    // Preserve a durable attempt marker and ledger start record before browser work
    // so interruption is visible without trusting a stale screenshot or replaying actions.
    meta.pending = {
      step,
      startedAt,
      command: resolvedAction.type,
      from: before?.id || null,
      action: describeAction(inv, before),
    };
    await saveMeta(meta);
    await appendCommand(dir, {
      schema: 1,
      event: 'started',
      runId: meta.id,
      step,
      at: startedAt,
      command: resolvedAction.type,
      kind: commandKind(inv),
      argumentCount: Array.isArray(argPayload) ? argPayload.length : 0,
      argumentSHA256: argPayload ? digest(JSON.stringify(argPayload)) : null,
    });

    let result;
    let error;
    try {
      result = await execute({...core, flags: {...core.flags, workspace, session: identity.session, profile: identity.profile}});
    } catch (e) {
      error = e;
    }

    const rawArtifact = await writeRawCommandOutput(meta, step, {sensitive, result, error}).catch(() => null);
    await appendCommand(dir, {
      schema: 1,
      event: 'finished',
      runId: meta.id,
      step,
      at: new Date().toISOString(),
      operation: {
        outcome: error ? (uncertainError(error) ? 'unknown' : 'failed') : 'succeeded',
      },
      artifacts: rawArtifact ? [rawArtifact] : [],
    }).catch(e => {
      if (!error) error = e;
    });

    if (fresh && error) {
      meta.status = 'start_failed';
      meta.gaps.push({reason: 'Attachment/open failed; browser outcome may require inspection', code: error.code});
      delete meta.pending;
      await saveMeta(meta);
      try {
        await persist(meta);
      } catch {}
      await unbind(meta);
      error.library = {runId: meta.id, status: 'start_failed'};
      throw error;
    }

    if (fresh) {
      meta.software = {
        latch: version,
        extension: result?.extensionVersion || null,
        playwright_core: result?.playwrightCore || null,
        browser_build: 'not_independently_verified',
      };
      meta.requestedStartURL = scrub(flags.url || inv.args?.[0] || null);
      meta.status = 'active';
    }

    const stateStart = meta.states.length;
    const stopped = await stopRequest(meta);
    const after = stopped ? null : await capture(meta, execute, {label: fresh ? 'initial' : 'state'});
    if (stopped) {
      meta.status = 'interrupted';
      meta.finishedAt = new Date().toISOString();
      meta.gaps.push({step, reason: 'Stop/disconnect interrupted capture; no application action was replayed.'});
      if (stopped.confirmed) meta.cleanup = {status: 'confirmed', preservedUserTabs: true};
    }

    if (actionCommand) {
      const action = actionOf(meta, inv, {step, before, after, error, startedAt});
      action.observed_states = meta.states.slice(stateStart).map(s => s.id);
      await appendObservation(meta, {type: 'action', action});
    }

    delete meta.pending;
    await persist(meta);
    const library = {
      runId: meta.id,
      directory: dir,
      handoff: path.join(dir, handoffFileOf(meta)),
      screenshots: meta.artifacts.filter(a => a.type === 'screenshot').length,
      capture: meta.gaps.length ? 'partial' : 'active',
      gaps: meta.gaps.length,
    };
    if (error) {
      error.library = library;
      throw error;
    }
    return {...result, library};
  };

  // If an application call holds the library gate, disconnect/finish still revokes
  // the browser lease immediately while leaving the bundle inspectable offline.
  if (['disconnect', 'finish'].includes(inv.command)) {
    try {
      // finish may wait briefly for a just-completed command to release the
      // lock; disconnect is the emergency stop and never waits.
      return await lockRun(binding.id, operation, inv.command === 'disconnect' ? {waitMs: 0} : {});
    } catch (e) {
      if (e.code !== 'EXPLORATION_BUSY') throw e;
      const dir = await runPath(binding.id);
      await atomic(
        path.join(dir, 'stop-request.json'),
        JSON.stringify({requestedAt: new Date().toISOString(), confirmed: false}),
      );
      const loaded = await loadMeta(binding.id);
      const result = await invokeDisconnect(loaded, execute, {closeTabs: flags['close-tabs'] === true});
      await atomic(
        path.join(dir, 'stop-request.json'),
        JSON.stringify({requestedAt: new Date().toISOString(), confirmed: result?.disconnected === true}),
      );
      await unbind(loaded);
      return {
        ...result,
        library: {
          runId: binding.id,
          status: 'interrupted',
          finalization: 'Command still in flight; rebuild offline after it exits.',
        },
      };
    }
  }
  return lockRun(binding.id, operation);
}

export const runExploration = runWithExploration;

export async function checkpointCommand(
  {profile = 'work', session, workspace = process.cwd(), note, annotationFile, dataRef} = {},
  version = PACKAGE_VERSION,
  execute,
) {
  return runWithExploration(
    {
      command: 'checkpoint',
      flags: {
        profile,
        session,
        workspace,
        ...(note !== undefined ? {note} : {}),
        ...(annotationFile !== undefined ? {'annotation-file': annotationFile} : {}),
        ...(dataRef !== undefined ? {'data-ref': dataRef} : {}),
      },
    },
    version,
    execute,
  );
}

export async function finishCommand(
  {profile = 'work', session, workspace = process.cwd(), closeTabs = false} = {},
  version = PACKAGE_VERSION,
  execute,
) {
  return runWithExploration(
    {
      command: 'finish',
      flags: {profile, session, workspace, ...(closeTabs ? {'close-tabs': true} : {})},
    },
    version,
    execute,
  );
}
