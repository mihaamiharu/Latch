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

## Single-extension compatibility proof — October 28, 2026

Phase 0's bounded protocol contract and Phase 1's experiment are implemented on `feat/latch-native-transport`, outside the installed extension and native-host source paths. The existing Work profile still returns healthy diagnostics with Latch 0.1.2. No global permission setting or Work-profile native registration was changed.

The final `npm run test:native-spike` passed in approximately 10.6 seconds using unmodified Playwright CLI 0.1.20, Node 22.21.1 and Chrome for Testing 153.0.8010.12. It launched a disposable profile without remote-debugging flags and verified from the persisted extension inventory that the official Playwright extension was absent. Chrome itself launched the experimental native host; no test-driver native transport substitution or direct Playwright browser launcher was used.

The test reused synthetic cookie/localStorage state created before attachment; captured before/after snapshots, a screenshot, console errors and network requests; filled/clicked and asserted the page result; and matched the selected Chrome tab's relay target ID to a target ID observed through Playwright's scoped CDP inspection session. Disconnect was followed by independent fixture observations of both pages, showing preserved sign-in markers and unchanged unrelated page content. The debugger was confirmed detached and both tabs retained their IDs, windows and groups before the fixture browser closed.

Evidence: `work/native-spike/run-UqgTSC/evidence/`, including `report.json`, `protocol-methods.json`, `before.yaml`, `after.yaml`, `after.png`, `console.json` and `requests.json`. Traces contain methods and sanitized errors rather than command parameters or endpoint credentials. A user-facing copy is provided in this chat's outputs directory.

Early attempts exposed fixture registration location, no-window startup, keychain initialization and preference-flush timing problems. They also exposed a missing scoped CDP inspection method; that compatibility path was implemented and tested without adding a generic browser-command fallback. These failures are retained in ignored fixture directories rather than described as clean first-run success.

The broader `npm test` run passed 22 checks with no failures, skipping the two opt-in browser integration suites. The new native browser suite was then executed explicitly as above. Focused relay tests verify wrong/missing credentials, forbidden website origins, duplicate clients, foreign targets, global-method rejection and revocation after disconnect. The pinned `ws` 8.22.0 dependency has no reported vulnerabilities in `npm audit --omit=dev` at verification time.

This establishes single-tab transport feasibility only. Production profile/session integration, multi-agent ownership, popups/frames/workers, large-payload coverage, lifecycle recovery, installer cutover and actual Work-profile native-transport verification remain the next gates. The official extension is still required for the installed daily workflow.

## Normal native session workflow — Phase 2, October 28, 2026

The normal CLI and canonical shared-skill helper now support opt-in `--transport native` using the existing paired profile, canonical workspace, session key and lock. The extension shares reservations with the official adapter, and each native session has a separate authenticated relay and namespaced CDP sessions. Native state is versioned, private and excludes endpoint credentials. One tab per named native session is an explicit limit; the official adapter remains the default.

The disposable real-browser workflow test passed through the actual `extension/` controller/debugger module, `src/native-host.mjs`, CLI and shared helper. It used two concurrent CLI sessions named `agent` in different workspaces, selecting different Chrome tab IDs at the same URL. Each observed its intended fixture marker and target ID, performed independent actions, and captured separate snapshots, screenshots and console output. A CDP foreign-target attach was rejected; unit tests also rejected foreign namespaced session IDs. Tab-claim conflicts, transport changes, single-session tab limits and stale epochs failed explicitly.

The test injected a CLI attachment failure on a third tab and confirmed that only that new lease was rolled back. Existing sessions remained usable and could reconnect idempotently. Releasing the first session left its peer working. After both disconnected, native leases were empty and original tabs retained their IDs, windows, groups, active-tab selection, synthetic sign-in state and local storage marker. This tests concurrent command processes representing agents, not independent LLM invocations inside multiple products.

An earlier concurrent-click attempt exposed an inactive-page actionability wait in `Runtime.callFunctionOn`; the relay deadline closed that connection. Inspection of the installed CLI confirmed CDP attachment uses `noDefaults: true`, skipping the normal focus override. The implementation now offers explicit `--focus-emulation on`, off by default. The successful parallel-action test enabled it. It simulates page activity and changes perceived focus/visibility; it is unsuitable for tests depending on real background/focus behavior. It is cleared during debugger cleanup, without activating tabs. Failed fixture attempts are retained under ignored `work/native-workflow/` directories.

Final multi-session evidence: `work/native-workflow/run-XuC1G9/evidence/` (`report.json`, `a.yaml`, `b.yaml`, screenshots and per-session console evidence). The run passed in approximately 20.3 seconds with unmodified Playwright CLI 0.1.20 and Chrome for Testing 153.0.8010.12. Persisted extension inventory showed no official extension, and browser arguments contained no remote-debugging flag. Actual Chrome native messaging was used; generated fixture code only provisioned pages/groups and observed their state. Mock-keychain flags were present from launch.

The final default test run passed 27 checks, with no failures and three opt-in browser suites skipped. All three browser paths were explicitly executed separately: the multi-session native test above; the original single-tab native proof using the graduated shared model/relay (passed in approximately 11.3 seconds); and the original official-extension compatibility integration (passed in approximately 17.0 seconds). The official integration retains its documented test-driver native-pipe substitution; the native proofs use direct Chrome delivery. Skill validation, dependency audit and whitespace checks passed. Installer coverage verifies that the generated native launcher forwards Chrome's caller origin and preserves arguments; the installed launcher was not rewritten in this phase.

The Work bridge still returned healthy diagnostics on 0.1.2 with native capability unavailable, as expected without an upgraded debugger-capable manifest/launcher. Work registration, browser permission grants and global agent security configuration were not changed. No fixture browsers remained after cleanup. Installer cutover, advanced QA command/frame/popup coverage, large payloads, restart recovery and actual Work-profile native verification remain later gates.

## Attachment comparison and popup ownership — Phase 3 A/B, October 28, 2026

The shared comparison harness now runs the normal skill helper, pairing, native
host and CLI in separate disposable profiles for official and native transport.
Both paths use actual Chrome native messaging. Official authorization is
provisioned once in its disposable profile with Playwright; that setup context
closes before the runtime browser starts. Runtime browsers have no remote-debugging
flags. Native runs do not install the official extension. Mock-keychain flags
are applied at every fixture-browser launch. The Work profile is not a fixture.

The final side-by-side basic QA/popup comparison passed for both adapters:
`work/attachment-compat/official-hnEebO/evidence/` and
`work/attachment-compat/native-j6kqwX/evidence/`. It filled/clicked and asserted the
same fixture result, captured snapshots/screenshots, used a standard popup waiter
before clicking, checked the child's actor/role against independent server state,
and disconnected with root, child and unrelated tabs preserved. Versions were
Node 22.21.1, Playwright CLI 0.1.20, Chrome for Testing 153.0.8010.12 and official
extension 0.4.0. Both comparison paths explicitly bring the test page forward;
these results are not a performance comparison.

The original multi-agent native workflow also passed again at
`work/native-workflow/run-NPqeXe/evidence/`, including claim conflicts, target
isolation, failed-attachment rollback and preserved active tabs/groups/state.

Native sessions now own one selected starting tab and verified popup descendants.
Chrome tab/opener metadata nominates a candidate, then the debugger transport
reads that candidate's target identity and validates its actual opener before
exposing page domains to the agent. A corrected opener can route the candidate
to its actual session; missing opener evidence leaves it unclaimed. It does not
infer ownership from URL, timing or window. Metadata-only provisional attachment
is detached if verification fails. Each owned page and nested CDP session has
its own route and bounded identity. Explicit release detaches one page; parent
closure preserves surviving children. Exact target-ID selection disambiguates
identical URLs. An already selected page is not brought forward again by connect.

The browser popup suite passed through two concurrent named sessions in separate
workspaces. Final evidence is at
`work/attachment-compat/native-hlCD1a/evidence/`, including live sanitized
per-session protocol traces, the surviving child's screenshot/snapshot and
independent fixture observations. It covered same-URL children with different actor markers, conflict
rejection, explicit child selection/release, target=_blank, window.open,
blank-then-redirect, cross-origin, noopener, authentication-style self-close,
immediate close and nested children surviving both parent and root closure.
The controlled blocked case uses a sandboxed fixture frame without allow-popups;
it checks no popup event or ownership change and a still-usable parent. This is
not a claim that every site-specific popup-blocker setting has been covered.
Chrome supplied attributable opener metadata for noopener in the passing run;
missing metadata remains an explicit limitation, with unit coverage ensuring it
stays unclaimed. Limits are 16 active top-level targets, four popup generations,
256 known tab identities and 32 retained warnings per session. Unit checks cover
active/depth limits, actual-opener correction, explicit-release protection,
foreign target/session rejection and parent survival.

Focus emulation is enabled for the concurrent opening check. Sequential popup
cases explicitly foreground the parent. Removing an unnecessary helper tab
activation exposed a popup timeout after child release; the test must not rely
on that accidental focus change. This checkpoint does not claim universal
background popup/input behavior. Agents can request foreground behavior through
ordinary Playwright APIs, and must inspect ownership after a timeout rather than
replay a possibly completed action blindly.

Earlier runs exposed two actual initialization races: lifecycle history and
execution contexts could reach Playwright before its frame-tree response. Startup
ordering now waits for that response before enabling those domains; a regression
check covers both. Other failed fixture runs included an unsupported URL global
inside CLI run-code, slow cleanup from polling pages, and an official popup
wait expiring before its action completed. The fixture now closes browser
connections before its server, uses supported code, explicitly activates the page
before the comparison action and uses a 30-second popup wait within the existing
45-second command deadline. Failed attempts are retained in ignored work folders.

A default native-host test also caught the socket appearing before asynchronous
chmod completed. Its creation now uses a process-local restrictive mask, restored
after binding, so it starts at mode 0600. This changes no global security setting.
The final default run passed 32 checks, with six opt-in browser cases skipped.
Shared-skill validation and whitespace checks passed. The Work diagnostic remained
healthy on installed 0.1.2 with native capability unavailable, as expected; browser
permissions, host registration and daily default were not changed.

Gates C–E (frames/workers, uploads/downloads and large evidence payloads), recovery,
installer cutover and actual Work native rollout remain open. This checkpoint
establishes Gates A/B only; it does not mark all of Phase 3 complete.
