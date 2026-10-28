# Native transport: normal session workflow (Phase 2)

Implemented on `feat/latch-native-transport`, October 28, 2026. This is an opt-in
preview in source, verified in a disposable Chrome profile. The installed Work
build has not been upgraded and the official adapter remains the default.

## What changed

The normal shared-skill helper and `qa-browser` CLI now route native sessions
through the existing profile alias, canonical workspace, per-session lock and
JSON result contract. A session key is derived from the canonical workspace and
name. Multiple workspaces can use the same name without sharing a CLI registry
or browser lease.

The native host manages a separate authenticated relay for each session. Both
transports share the extension controller's ownership map. Neither adapter may
claim a tab reserved by another task. Native mode does not change tab groups or
move windows. Relay CDP session/inspection IDs are namespaced per connection;
foreign target IDs and session IDs are rejected rather than routed to a default
tab. Browser-level target listings contain only the selected session's target.

The native model and relay now live under `src/`; the original experiment
re-exports them so both integration suites exercise the same implementation.
Upstream adaptation notices remain under `third_party/playwright/`.

## Use in a native-capable build

The extension must declare/grant debugger permission and report native capability
through the native handshake. This phase's integration fixture grants it only in
its disposable generated manifest. Installer/permission cutover remains a later
gate; do not reload the Work extension to enable this source preview.

Use the shared-skill wrapper with the task's actual workspace:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" doctor --profile work --transport native --workspace "$LATCH_WORKSPACE"
node "$LATCH_SKILL_DIR/scripts/latch.mjs" connect --profile work --transport native --session "$LATCH_SESSION" --tab "$LATCH_TAB_ID" --workspace "$LATCH_WORKSPACE"
```

Subsequent Playwright commands still use `-s=<session>` in that same workspace.
Reconnecting the same tab is idempotent. One native session currently owns one
tab; use a different session for another tab. Explicit transport changes or
different focus options require disconnect first. Omitting those flags on an
existing session retains its recorded choices.

Native `release` closes the single-target transport and detaches its CLI while
preserving the website tab. It writes a released record; the usual `disconnect`
then removes that record. Disconnecting one session leaves peers usable.

### Optional focus emulation

For background interactions, an explicitly selected native session may add
`--focus-emulation on`. The default is off. Chrome then simulates an active page
for that debugger target without activating the Chrome tab. Disable emulation
for tests of real focus/visibility/background behavior; simulated activity can
change the application's behavior. The choice is returned in connection JSON,
stored in session state, and cleared before debugger detachment.

This option addresses a failure observed during actual parallel clicks: an
inactive page's actionability check waited in `Runtime.callFunctionOn` until the
relay deadline. The installed CLI uses `noDefaults: true` for CDP attachment, so
it skips Playwright's usual focus override. We kept that behavior as the default
and made emulation explicit rather than activating tabs or weakening click checks.
See [Chrome's protocol definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl)
for `setFocusEmulationEnabled`.

## State and cleanup

Native state is version 2 and includes transport, profile identity/epoch,
workspace, session, selected tab, verified target ID, focus choice and status.
Files remain private (0600); Latch records and reports omit endpoint credentials.
Legacy official records remain readable. Unknown schemas and stale epochs fail
explicitly instead of being reinterpreted or silently removed.

Connecting reserves the tab, bootstraps a relay through native messaging, attaches
unmodified Playwright CLI, and verifies the exact target ID before reporting
success. It does not match only by URL. If a fresh connection fails after its
lease is acquired, cleanup revokes that relay and releases its reservation without
touching peers. Incomplete or uncertain cleanup retains an interrupted record
and returns `NATIVE_CLEANUP_FAILED` for explicit disconnect. There is no automatic
transport fallback or action replay.

The local Playwright subprocess receives a credential-bearing endpoint argument;
its private daemon registry may retain attachment configuration. These are local
capabilities, not isolation from arbitrary software running as the same OS user.
Do not publish raw process/daemon/session directories as test evidence. Latch
errors redact native endpoint paths, and evidence fixtures are under private
temporary parents excluded by Git.

## Verification

```bash
npm ci
npm test
npm run test:native-workflow
```

The opt-in macOS integration test uses Chrome for Testing and the actual
`extension/` and `src/native-host.mjs` code, plus the canonical shared helper.
Fixture-only code creates test pages and a synthetic existing tab group; it does
not replace native messaging or supply a direct browser driver. Mock keychain
flags are applied before startup. No Chrome remote-debugging flag is used.

The test covers concurrent connections and actions on different same-URL tabs,
identical session names in different workspaces, exact target identity,
cross-target rejection, foreign-session unit checks, tab ownership conflicts,
transport mismatch, explicit one-tab limits, injected CLI attach failure and
lease rollback, idempotent reconnection, releasing one task while its peer keeps
working, separate console evidence, and preserved tabs/groups/windows/active-tab
selection plus synthetic sign-in state after cleanup. The persisted extension
inventory confirms that the official extension was absent.

Remaining gates: advanced QA commands and large results, frame/worker/popup
compatibility, browser/host restart recovery and abandoned-lock reconciliation,
installer/permission upgrade, and installed Work-profile verification. The native
preview is not yet the daily default.
