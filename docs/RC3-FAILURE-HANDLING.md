# RC3 attachment and action failure handling

This is the preparation record before Work activation. For the later RC3 update,
native Work preference and actual terminal-client result, see the
[current release review](RELEASE-READINESS-2026-10-30.md).

Prepared October 30, 2026, Asia/Jakarta. Candidate: `0.2.0-rc.3`; Chrome version
`0.1.99.3`. The active Work installation remains RC2. This work changes no live
pairing, transport preference, browser permission or client security setting.

## Report and diagnosis

The reported Work bridge was healthy and native attachment worked. The profile
had no transport preference, so a connect without an override selected the legacy
official adapter. Its 30-second extension handshake failed. This is distinct from
a missing pairing or inaccessible Unix socket. The earlier pilot observed the
official extension disabled; its state during the reported failure is not proven.
RC3 does not automatically select another adapter after a failed attach.

The native CodeMirror click found its locator but stalled before Playwright
completed visible/enabled/stable checks. Focus emulation was off. Background
animation-frame scheduling is a possible contributor, not a confirmed cause of
this specific editor failure. Accessibility-tree presence alone does not prove
[click actionability](https://playwright.dev/docs/actionability). The separately
reported `Save` locator was wrong for a button named `Update Test Case`.

The reported direct Playwright action returned `isError: true` with exit zero.
The pinned CLI can return tool errors independently of process status; Latch's
internal subprocess adapter already checked both, but direct commands bypassed
that normalization. The exact zero-exit case is covered with a controlled CLI
fixture; it must not be claimed as reproduced in the real browser unless observed.

## Changes

- Preserve a bounded, redacted upstream error, command, exit status and elapsed
  time. Official attach failures also report selected transport/source, profile,
  native availability and `attachmentVerified: false`. Connection URLs, WebSocket
  endpoints and extension token assignments are redacted; raw stdout is omitted.
- Doctor and diagnose explicitly distinguish bridge readiness from the separate
  official extension handshake. A healthy bridge is not an attachment pass.
- Native connect returns `FOCUS_EMULATION_DISABLED` when focus emulation is off.
  The default remains off. Ordinary background QA can explicitly choose on;
  real focus/visibility checks must keep it off and report limitations.
- Add `qa-browser pw --profile work --session <name> --workspace <path> --
  <command> [args...]`. It invokes the unmodified pinned CLI and maps tool errors
  to structured stderr plus exit 1. It does not attach, retry, force-click or
  silently change adapters. It checks existing workspace/session and daemon
  identity; native commands also preflight live schema-4 ownership.
- Reject lifecycle commands and session/output overrides in `pw`. Native
  inspection ends before an application call so Stop/disconnect can revoke held
  actions. This preflight is not an atomic reservation through the ordinary CLI;
  use unique task sessions and do not reconnect the same task concurrently.
- Update the canonical shared skill to choose transport explicitly, select an
  appropriate focus policy before interaction, use `pw` when available and
  inspect `isError` on older direct CLI workflows. A timeout requires independent
  outcome inspection before any new mutation.

## Verification and rollout boundary

All automated browser checks use full headless Chrome for Testing, disposable
profiles and private native registrations. Test-only flags are recorded with
each fixture. No headed/desktop fallback or live Work application test is used.
The first unattended extended run timed out with wall-clock gaps far exceeding
its deadlines; that failed evidence is retained. The rerun uses command-scoped
`caffeinate -i`, without changing system settings.

The focused subprocess/transport/diagnostic/skill checks pass 26/26. The final
default suite passed 83 and skipped 41 of 124 registered checks. Nine selected
headless checks passed, covering action diagnostics, clean installation, actual
legacy upgrade/rollback, concurrent native workspaces and popup lifecycle/Stop.
Together these runs cover 92 distinct current passing checks; focused reruns are
not added to that total. Exact
installed-artifact and checkpoint results are recorded in the task's
`outputs/latch-rc3-failure-fixes/report.md`; earlier attempts are not substituted
for final-candidate evidence.

The new action fixtures deliberately fail official authorization while bridge
health/native capability remain available, then complete authorized attachment.
They distinguish a wrong button label from the actual button, assert one save
using independent HTTP receipts, capture evidence and preserve tabs on cleanup.
Focus-off trials are observations, not a requirement that headless scheduling
reproduce the user's headed failure. Separate popup coverage exercises Stop
against a held `pw` action and verifies a peer session survives.

RC3 is a local candidate, not a stable-release promotion or automatic Work update.
Actual coding-client discovery/application checks, real Work focus/Stop/staging
observations, accepted migration limitations, native-default cutover and final
release/rollback acceptance retain their separate Phase 6 status. The original
CodeMirror failure is not claimed fixed without an application-specific retest.
