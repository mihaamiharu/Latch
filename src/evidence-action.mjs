import {fork} from 'node:child_process';
import {fault} from '../extension/protocol.js';
import {CLI_META, redact} from './playwright.mjs';

export const ACTION_META = Symbol('observed-action-process');

// The recorder observes the ordinary action helper's real exit before writing
// evidence or printing anything. Reporting/expectation failures are separate
// from that child and from its upstream Playwright process.
export function executeEvidenceAction(invocation) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./evidence-worker.mjs', import.meta.url), [], {
      cwd: invocation.flags.workspace || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let response;
    let bytes = 0;
    let output = '';
    let ended = false;
    let failure;
    let kill;

    const terminate = error => {
      failure ||= error;
      child.kill('SIGTERM');
      kill ||= setTimeout(() => child.kill('SIGKILL'), 1000);
    };

    const deadline = Number.isSafeInteger(invocation.captureTimeoutMs)
      ? Math.max(1000, Math.min(120000, invocation.captureTimeoutMs))
      : 120000;
    const timer = setTimeout(
      () => terminate(fault('CLI_TIMEOUT', 'The action helper timed out; its browser outcome may be unknown.')),
      deadline,
    );

    const finish = (error, value) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(kill);
      error ? reject(error) : resolve(value);
    };

    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) terminate(fault('CLI_OUTPUT_LARGE', 'Unexpected helper output exceeded its limit.'));
        else output += chunk.toString('utf8');
      });
    }

    child.once('error', () => finish(fault('CLI_UNAVAILABLE', 'Cannot start the recorded action helper.')));
    child.once('message', message => {
      response = message;
    });
    child.once('close', (code, signal) => {
      const processResult = {exitCode: code, signal: signal ?? null};
      if (failure) {
        failure[ACTION_META] = processResult;
        return finish(failure);
      }
      if (!response || typeof response.ok !== 'boolean') {
        return finish(
          Object.assign(
            fault('CLI_RESPONSE_INVALID', 'The action helper did not return a complete result; its browser outcome is unknown.'),
            {[ACTION_META]: processResult, diagnostics: {upstreamError: redact(output).slice(0, 2048)}},
          ),
        );
      }
      if (response.ok && code === 0) {
        const result = response.result;
        if (response.upstream) result[CLI_META] = response.upstream;
        result[ACTION_META] = processResult;
        return finish(null, result);
      }
      const error = Object.assign(
        fault(response.error?.code || 'CLI_RESPONSE_INVALID', response.error?.message || 'Recorded action helper failed.'),
        response.error || {},
        {[ACTION_META]: processResult},
      );
      finish(error);
    });

    child.send(invocation, error => {
      if (error) terminate(fault('CLI_UNAVAILABLE', 'Cannot deliver the action to its helper.'));
    });
  });
}
