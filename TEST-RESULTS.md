# Prototype verification — October 28, 2026

Branding rebuild: Latch 0.1.1 updates the extension name, popup, toolbar/management icons and CLI display header. `npm run build` completed; generated icon dimensions, manifest references, ZIP-root manifest and unchanged extension ID were verified. Browser automation tests below describe the earlier prototype/runtime verification, not an additional full browser run for this visual change.

Result: **12 tests passed, 0 failed, 0 skipped**, including the headed Chrome compatibility test. Final suite duration: approximately 15 seconds.

## Runtime

| Component | Version |
| --- | --- |
| Node.js | 22.21.1 |
| Playwright CLI | 0.1.20, unmodified |
| Playwright runtime | 1.64.0-alpha-2026-09-14 |
| Official Playwright extension | 0.4.0, unmodified Chrome Web Store package |
| Chrome for Testing | 153.0.8010.12 |
| Our companion | 0.1.0 |

Official test package SHA-256: `e012b45f6170f627d275588ca1a37dffe5919c2635bbac512f11b74930e63835`.

## Verified in the real-browser test

The test used a disposable Chrome for Testing profile and two local HTTP fixture pages. A fixture sign-in cookie was set before attachment. User Work and Personal profiles were not used.

1. Our companion loaded in its own extension origin alongside the official extension.
2. The CLI discovered tab metadata through the local bridge and companion.
3. A named session launched through the normal `playwright-cli attach --extension=chrome` route with an explicit profile directory.
4. The companion correlated the session using its exact relay locator and grouped an existing target tab using Chrome APIs.
5. Playwright CLI read the existing page and asserted its fixture account text was **signed in** and its total was **100**.
6. A second CLI session claimed a different tab and received a different group.
7. Trying to claim the first session's tab from the second produced `TAB_OWNED`.
8. Reconnecting an already owned tab was idempotent.
9. After the first session's Welcome page closed, the companion could still use the registered group while the target remained open.
10. Release/disconnect preserved both original pages and their sign-in state.

No code was evaluated inside the official extension to discover or group tabs during this workflow. The test's initial authorization token was provisioned in its disposable profile only, as fixture setup.

## Native transport coverage

The real native host process handled framed messages, real Unix socket requests, directory mode 0700, socket mode 0600, and shutdown cleanup. Framing tests covered split headers, bytewise bodies, concatenated frames, Unicode and oversized messages. The default macOS socket path was checked against the platform limit.

In the browser integration test, a test driver replaced Chrome's native-pipe delivery with messages to our own extension's same scoped dispatcher. This avoided changing the user's native host registration. Therefore **direct Chrome `connectNative()` delivery in the installed Work profile is not yet verified**. That is the next deployment smoke check.

## Guard behavior

Tests also verified profile/epoch mismatch rejection, exact session locator validation, internal/incognito inventory exclusion, changed/closed target detection, ownership conflicts, cross-window/group rejection, workspace identity separation and token redaction.

## Bugs found and repaired during verification

- Concurrent extension startup events could initialize different profile instance IDs. Initialization is now serialized.
- Playwright's CLI registry can be shared across folders without a workspace marker. Connections now establish a `.playwright/` directory in the selected canonical workspace.
- Native socket paths built under macOS's long per-user temporary directory could exceed the platform limit. The default uses a short per-user directory under `/tmp` with restrictive permissions.
- Closing the final target after closing its Welcome tab can destroy the group. Forgetting a session now remains possible after that group disappears.

## Remaining deployment/production work

- Install and authorize the companion in the actual Work profile, register the native host, pair the explicit profile directory and perform a read-only check against the existing GitHub tab.
- Validate the installed configuration while Personal is foreground.
- Add automated recovery for browser/worker restarts and abandoned locks before daily unattended use.
- Revalidate when upgrading CLI/extension versions; the CLI adapter currently rejects untested versions.

See `README.md` for the exact environment variables required to run the browser suite and for the installer preview.

## Relocation verification — October 28, 2026

The entire project, build plan, legacy helper and research/browser fixtures were moved to `/Users/ekkisyam/Workspace/qa/qax/work-browser-bridge`. Generated launchers and installer manifests were regenerated at that path, preserving the companion extension ID. Tests now place fixtures under the project's own `work/` directory.

After relocation, the 11 unit/native checks passed. The browser integration check initially hit `BROWSER_TIMEOUT`; a standalone retry passed from the new location in approximately 41 seconds. This records a startup timing failure rather than claiming a clean first-run full suite. All live source/installer paths were checked for references to the original project directory; none remained. Historical browser-fixture records retain their original paths where applicable.

Native host registration and installation into the real Work profile remain pending authorization.

## Direct installed Work-profile check — October 28, 2026

Latch 0.1.1 is installed in the actual Work Chrome profile. Its native host is registered, and the `work` alias is explicitly paired to Chrome's `Default` profile directory. That directory was read once from Chrome's version page during initial setup.

The subsequent verification ran entirely from terminal commands: launch a temporary localhost fixture in the pinned profile, discover its existing tab through Latch, connect it to a named Playwright CLI session, read its title/status and pre-existing localStorage marker, verify that Chrome tab ID/group membership agree, close the temporary fixture and disconnect the CLI session. It passed through the installed extension's actual `connectNative()` transport, with no test-driver substitution. Existing mail/chat content was not inspected for this verification.

A final `doctor --profile work` returned healthy profile/native-host connectivity with CLI 0.1.20. Browser/worker restart recovery and abandoned-lock cleanup remain prototype limitations; installation and direct native delivery are now verified.

## Shared agent skill — October 28, 2026

The canonical skill is `skills/latch/`, with a CLI forwarding helper, a focused recovery/evidence reference, and Latch UI metadata/icon. It is globally linked at `~/.agents/skills/latch` for Codex/Cursor discovery and `~/.claude/skills/latch` for Claude Code. Both links resolve to the same canonical directory. No agent permission configuration, AGENTS.md or CLAUDE.md was modified.

The skill-creator validator passed. Metadata icon paths and the default prompt were checked. Four focused tests passed: idempotent install/uninstall preserving source; collision rejection preserving an existing unrelated skill and avoiding partial installation; helper preservation of working directory/argument boundaries/nonzero exit status; and a structured error for missing runtime dependencies.

Both installed skill paths successfully executed `doctor --profile work --workspace .` from a separate task directory. They returned the actual connected Work profile and preserved that task directory as workspace. This validates local discovery links and runtime delegation; it does not claim an independent model-invocation run inside each client. Codex and Claude CLI executables were present on PATH; Cursor CLI was not found on PATH in this shell. Cursor's documented common skill location is configured for its next local session.

## Cross-client diagnostics — October 28, 2026

The first reported run returned an empty discovery list and `PROFILE_UNAVAILABLE`. The user subsequently clarified that the client was Codex CLI; the original report directory retained its `cursor-smoke` name. Its initial report did not retain the operating-system socket error. A contemporaneous local check confirmed that the Work alias was configured and the native bridge was reachable; the failure cannot therefore be classified as a missing pairing solely from the original report.

The CLI now exposes read-only `diagnose --profile work`, preserving execution identity, config/runtime/socket paths, pairing state, socket metadata and connection outcomes. Socket errors distinguish access denial (EPERM/EACCES) from absent/refusing endpoints (ENOENT/ECONNREFUSED). Discovery retains unreachable-socket warnings, and the shared skill now requires diagnostics before describing such failures. No client security settings were changed.

Eleven focused diagnostics/native/skill tests passed, including an actual mode-000 Unix socket denial and configured-but-absent socket classification. Skill validation passed. The diagnostic succeeded from the same testsaurus project directory used for the reported run; a local baseline was saved alongside the original report as `diagnostics-codex.json`.

The user's diagnostic then confirmed configured pairing, an existing UID-501 socket with mode 0600, and `BRIDGE_ACCESS_DENIED` with `EPERM`. Running the read-only diagnostic through `codex sandbox -- node ... diagnose --profile work` reproduced that exact denial. The same diagnostic succeeded in the ordinary local shell immediately beforehand. This isolates a Codex command sandbox boundary; the failing agent's approved retry remains pending.

## Connection status fix — Latch 0.1.2

Successful native reconnection now clears an earlier error, and a late disconnect callback from an obsolete port cannot overwrite the current connection state. The popup shows a plain connection label with technical details collapsed. A regression test exercises failure, timed reconnect and an obsolete-port callback against the actual background module.

All 12 focused connection-status/diagnostics/native/skill tests passed. The unpacked extension and `dist/latch-0.1.2.zip` were rebuilt. The installed Work profile still reported 0.1.1 during the read-only diagnostic; it must reload the extension before the popup fix is active.

## Local checkpoint — October 28, 2026

A subsequent read-only Work-profile diagnostic succeeded and reported installed extension version 0.1.2. No permission configuration was changed.

The user reported a successful browser verification from a separate Codex CLI session against Testsaurus issue #194: an invalid Scenario Outline was saved with HTTP 201, the temporary case was deleted with HTTP 204, evidence was captured, and the Latch session disconnected with existing tabs preserved. No test run was created; the separate run-creation failure remains unverified. This is user-reported end-to-end verification, rather than an independently rerun application test. Its report remains in the Testsaurus workspace under `work/latch/cursor-smoke-issue194-20261028-01/report.md` (the directory name predates the client clarification).

Before the initial Git checkpoint, `npm test` passed 20 checks with no failures. The separate real-Chrome integration test was skipped because its fixture environment variables were not supplied. Generated installers, build outputs, local browser fixtures and session data are excluded from Git.
