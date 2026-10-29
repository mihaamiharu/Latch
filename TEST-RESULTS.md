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

## Frames and dedicated workers — Gate C, October 28, 2026

Gate C implements related-target lifetimes in both the extension boundary and
native relay model. Each owned top-level page has a parent-linked child graph;
wire identities remain namespaced to the lease. The supported child filter admits
iframe and dedicated-worker targets and preserves caller exclusions. Shared and
service-worker management is outside native support. A rejected paused child is
resumed/detached without adopting its page; failure of both cleanup operations
revokes that lease's debugger attachments while preserving website tabs.

Subtree detach now removes extension and relay descendants, including inspection
aliases. Reused raw identifiers require a fresh target lifetime. Duplicate/late
attachment events cannot replace or detach a newer active route. Retiring a child
cancels its pending browser commands; only known cancelled response IDs may arrive
late without a protocol failure. Unknown responses keep the previous failure
behavior. Limits are 64 active child sessions per top-level tab, 256 per lease,
16 child-target ancestry levels, 1024 retained retirement identities per tab and
256 known cancelled responses per relay. These are distinct from DOM-frame counts
and the existing popup limits. History/response exhaustion fails explicitly.

The new fixture uses three loopback-served test sites with browser-local hostname
mappings and site isolation. Identical frame/worker URLs serve separate actor and
instance markers. Actual iframe targets and a nested child-session relationship
are required by the tests; differing ports alone do not establish OOPIF coverage.
Server observations independently confirm the actor/frame receiving form writes.
Form checks use normal locator fill/click. Lifecycle controls use scoped page or
frame evaluation to isolate insertion, worker start/stop and replacement from
focus-sensitive pointer delivery; no parent-origin DOM bypass is used for frame
form interactions.

The official/native headless comparison verifies same-origin, cross-origin and
nested OOPIF forms; dynamic insertion/removal and rejected stale element actions;
same-site/cross-site navigation and replacement; newly created root and OOPIF
workers, evaluation, message exchange, termination and recreation; frame console,
page-error and request markers; and snapshots/screenshots containing expected frame
results. Both adapters preserve the fixture tabs when disconnected.

W1 has an explicit limitation: workers already running at attachment are visible
as real protocol targets and answer application messages, but are not backfilled
into the pinned CLI's page.workers() inventory in either adapter. The fixture
proves the existing worker is alive through a message round trip and server marker.
The supported contract therefore covers new-worker event/evaluation APIs and
existing-worker application observations, without claiming existing Worker-object
inventory. No application worker is restarted to conceal the limitation. The
shared skill documents this; shared/service-worker APIs remain unsupported.

The native isolation suite uses two sessions named agent in separate workspaces,
with identical frame/worker URLs and distinct actor markers. It verifies concurrent
writes and new-worker observations, rejects another lease's iframe/worker targets,
replaces a frame during an unresolved Runtime.evaluate, rejects the old inspection
session and Frame object, and keeps the parent and peer usable. Releasing one root
retires only its lease and preserves all website tabs, the unrelated root and the
peer's frame operations. Unit coverage separately checks raw retired/foreign
session rejection before Chrome execution, caller filters, duplicates, resource
bounds, bounded retirement history, alias-close notifications and known-late versus
unknown response behavior. These are coordination guarantees between authorized
local agents, not a sandbox against arbitrary programs of the same OS user.

All maintained browser launch paths are now headless, including isolated official
extension authorization. Full Chrome for Testing is used, not headless-shell.
The fixture disables background throttling; its flags are recorded in new reports.
Initial manual headless launches exposed startup throttling and unreliable macOS
connection-page delivery to an already-running headless process. The shared
fixture now supplies a private bounded loopback URL queue through the CLI's
configured test launcher. Fixture provisioning opens the unmodified official
connect page, whose normal token flow and relay perform attachment. The queue
carries only that connection-page URL; no native-messaging, CDP or browser-command
response is substituted. Its credentials and raw daemon/protocol logs stay private.
There is no headed fallback. These results do not establish headed/background
focus parity or modify the installed Work profile.

The older official browser test has also been moved onto this actual-native,
headless shared fixture, replacing its historical driver-native-pipe substitution.
Historical results above retain their original setup descriptions. The default
suite passes 41 checks with nine opt-in browser cases skipped; those browser cases
are run explicitly as part of this checkpoint. Skill validation and whitespace
checks pass. Versions remain Node 22.21.1, CLI 0.1.20, Chrome for Testing
153.0.8010.12 and official extension 0.4.0. No dependency or installed permission
upgrade was used to obtain the result.

Other failed fixture attempts included a root-role readiness mismatch, selecting
an OOPIF by frame name, unsupported console filename flags, and pointer-triggered
lifecycle controls after worker focus changes. They are retained under ignored
work paths. They are not presented as transport support or a clean first-run pass.

Gate C leaves Gates D/E (file transfers and large payloads), restart recovery,
installation cutover and actual Work-profile native rollout open. The final read-only Work diagnostic found pairing configured but its socket absent
(ENOENT / PROFILE_UNAVAILABLE). It did not establish current Work connectivity or
its installed capabilities. No Work browser restart, re-pairing or registration
change was attempted; the cause of its offline state is not established.


Final Gate C comparison evidence:
`work/attachment-compat/official-GjSZsL/evidence/` and
`work/attachment-compat/native-NS3X6y/evidence/`. Each includes the support result,
OOPIF graph proof, worker observations, frame events, screenshot/snapshot and
independent fixture state; the native run also retains its live sanitized trace.
Native multi-agent cancellation/isolation evidence is at
`work/attachment-compat/native-gCbqAq/evidence/`.

All nine opt-in browser cases passed headless when executed explicitly: two frame/
worker comparisons, one isolation test, two basic attachment comparisons, the
popup suite, normal native multi-agent workflow, original native proof and the
updated two-session official test. Regression evidence is at
`work/attachment-compat/official-BJoDBj/evidence/`,
`work/attachment-compat/native-z4m338/evidence/`,
`work/attachment-compat/native-eJFlhJ/evidence/`,
`work/native-workflow/run-wRyJ3o/evidence/` and
`work/native-spike/run-J0XERP/evidence/`. The explicit official two-session log is
`work/official-multi-headless-final.log`.

# Gate D — file workflows, October 29, 2026 (Asia/Jakarta)

Gate D implements the approved file plan with byte-verified uploads and explicit
separation of browser download receipt, low-level lifecycle and agent retrieval.
Node 22.21.1, unmodified CLI 0.1.20, full Chrome for Testing 153.0.8010.12 and
unmodified official extension 0.4.0 remain pinned. All browser runs are headless
and use disposable profiles, real native messaging and mock-keychain flags.
The official fixture retains the documented private connection-URL delivery shim.

| Capability | Official / native result |
| --- | --- |
| Single/multiple input files, duplicate basenames, empty, binary, spaces/Unicode | Compatible; independent multipart receiver matches filenames, byte counts and SHA-256. |
| CLI pending chooser (`FileChooser.setFiles`), same-origin and actual OOPIF inputs/choosers | Compatible. No OS picker or synthetic File substitution. |
| Clear/reselect | Compatible; zero or exactly selected files reach the receiver. |
| Missing file / retired iframe | Rejected. Frame negatives wait for the actual detach event before using the old handle. |
| Replaced input | An old detached input handle can still accept files in both adapters. Its fresh replacement remains empty; no unintended request is submitted. Use fresh locators. |
| Basic, redirect, repeated filename, slow downloads | Browser receipts match the independent response hashes in a private inbox configured before Chrome starts. Repeated names retain both distinct contents. |
| Interrupted response | Server interruption is verified and no complete matching artifact is claimed. It does not establish browser API cancellation or a terminal state by itself. |
| Low-level download lifecycle | Page events expose GUID/frame metadata and observed progress/completion. They provide no exact saved path in these tests. |
| Normal Playwright Download event/object, saveAs/path/cancel | Unavailable in both pinned attachment adapters. No task artifact is manufactured from the browser inbox. |
| Concurrent native agents | Same-name uploads preserve actor bytes; identical download URL/suggested name retains both browser receipts. Foreign/retired target attachment and retired frame inputs fail. |
| Frame/popup download and popup retirement | Receipts verified. Native exact-target selection/upload and release during a slow transfer preserve the physical popup and peer session. |

Native `Browser.setDownloadBehavior` now rejects managed configuration with an
explicit unsupported error instead of acknowledging a no-op. No downloads
permission, Browser/IO fallback or arbitrary file broker was added. A Page GUID
without the authoritative file path is insufficient for a safe exact-file copy.
Screenshots, snapshots and existing console/request artifacts remain available.

The receiver bounds the streamed body before using Node's built-in multipart
parser: request 1 MiB + 64 KiB, eight files, 256 KiB per file. This is bounded
buffering rather than a new streaming-parser dependency. Corpus cases total at
most 1 MiB. Inbox observation also has finite count/file bounds. These bounds
are fixture scope, not production size claims; Gate E remains open.

Validation: default suite **44 passed, 12 browser cases skipped** there. The new
file comparisons and isolation suite are enabled separately with `test:files`
and `test:file-isolation`. All nine earlier browser cases were also exercised;
the final frame/worker comparison and isolation rerun passed three of three.
The final file-suite run passes **3/3** with no failures or skips. Across the
explicit runs, all **12** opt-in browser cases pass; the three corrected frame/worker
cases supersede their initial readiness failures. Curated evidence is recorded in
the chat's `outputs/latch-gate-d/` report. Skill validation and whitespace checks pass.

Initial failed fixture attempts are retained under ignored `work/` paths. They
included cloning a selected input, pointer-based concurrent form triggers that
submitted no request, a cross-site DOM-triggered download without a completed
browser file, and requiring an interrupted response to have an immediate canceled
browser state. Final frame download checks use foreground clicks; concurrent
root-download triggers and popup/replacement/removal lifecycle controls use scoped
fixture DOM controls. Uploads always use actual Playwright file APIs and server
bytes. This is not universal background-pointer or headed-focus parity.

Regression testing also exposed an older worker fixture readiness race: actor
initialization was visible before its asynchronous ready response completed, and
a late ready message could overwrite the checked reply. The fixture now publishes
an explicit ready marker after that response; worker polling handles evaluation
before its script initializes. Both adapters and native isolation pass afterward.
An attempted extra official popup CDP inspector was rejected by the official
relay; the final comparison uses the actual Page returned by the standard popup
waiter instead. Native identity/retirement tests retain explicit target checks.

The final read-only Work diagnostic reports a healthy paired bridge, installed
version 0.1.2, with nativeTransport false. It claims no page/tab and makes no setup
changes. No Work restart, re-pairing, registration/permission change, native cutover
or global security change was performed. All source changes are a local checkpoint;
no push is part of Gate D.

Final Gate D file evidence:
`work/attachment-compat/official-1I2MwZ/evidence/`,
`work/attachment-compat/native-kAfI79/evidence/` and
`work/attachment-compat/native-kT6XrI/evidence/`.
Final frame regression evidence:
`work/attachment-compat/official-lj98jX/evidence/`,
`work/attachment-compat/native-Rwyzrd/evidence/` and
`work/attachment-compat/native-rZPrzF/evidence/`.
Validation logs: `work/gate-d-acceptance.log`,
`work/gate-d-default-final.log`, `work/gate-d-frame-regression.log` and
`work/gate-d-regression.log` (the latter retains the two superseded frame failures).
All project fixture browsers are stopped after validation.

# Gate E — large evidence and bounded transport, October 29, 2026

Gate E implements the approved plan from checkpoint `902f30b`. Versions remain
Node 22.21.1, unmodified CLI 0.1.20, full Chrome for Testing 153.0.8010.12 and
unmodified official extension 0.4.0. All browser validation is headless with
private profiles, real native messaging and the existing official URL-delivery
shim. Work installation/default transport/permissions remain unchanged.

| Case | Verified result |
| --- | --- |
| Screenshot content | Controls and high-entropy 512×1024, 1024×1024 and 2048×2048 PNGs decode to every expected pixel in both adapters. Largest PNG 12,623,891 bytes; PNG hashes match across adapters. |
| Snapshot content | All 1024/4096 rows plus sentinels and ordering survive in approximately 1.17/4.70 MB files. Reference IDs may differ; no semantic truncation. |
| Response-body files | Text and binary save exactly at 1/4 MiB with independent server SHA-256/length. Both 16 MiB variants are evicted from inspector cache. Page fetch reads 16 MiB, but that is not a saved artifact. |
| Missing/partial capture | The pinned body command can return `{}` after capture failure. The harness detects a missing artifact and verifies standard Response.body cache-eviction errors. Interrupted bodies and over-limit output producers are never claimed complete. |
| Direct CLI versus wrapper | Filename commands return small metadata. Direct CLI output above 2 MiB is streamed and verified separately. Latch's internal collector accepts raw stdout up to 2 MiB, rejects one byte above and preserves split UTF-8 sequences. |
| Wire and pending limits | Actual authenticated sockets accept 32 MiB − 1/equal and reject +1 in both input roles, including text fragmentation inside a UTF-8 character. The 65th pending call is rejected before dispatch; accepted calls settle and pending returns to zero. |
| Backpressure | Shared guard permits at most 8 MiB existing backlog plus one 32 MiB message. Actual paused readers exhaust each direction without losing a peer relay. This is a finite admission policy, not a process-memory cap. |
| Deadlines | Original native timer killed a valid 11-second fetch while official succeeded. Awaited Runtime.evaluate/callFunctionOn now have 30 seconds; ordinary calls retain 10. Both adapters complete the expected delayed body. Stuck work still times out. |
| CLI cleanup | Timeout/oversize sends TERM, then KILL if needed, and reaps the wrapper child before returning. It does not claim to cancel daemon/browser mutations. |
| Events and ownership | Pre-established listener receives all 512 events and 64 requests match receipts. CLI console history retains at most 200 (192 fixture entries observed), explicitly partial. Real peers survive pending rejection, oversized result, timeout and four-command disconnect. |
| Cleanup resources | Five real native-host cycles return from three TCP sockets/one listener to zero. No pending session remains; physical tabs and outsider ownership are preserved. |

The output collector previously decoded individual pipe chunks, corrupting split
UTF-8 characters and causing a false output-limit failure. It now counts raw
bytes before retaining data and decodes after process close. The evidence sink
uses one bounded stream reader, completes partial filesystem writes, verifies
written byte count and keeps failed output explicitly partial.

Native metadata counters expose message/queue/pending high-water values, timeout
method/deadline and socket-server resource state without payloads or credentials.
Both relay and extension reject an oversized serialized message before sending.
Browser JavaScript uses a valid application close code (4009); real-browser
coverage caught and corrected an initially invalid close-code attempt before
checkpoint. Neither error handling nor evidence capture requires a new permission
or download broker.

Validation includes the full serial suite: **71 passed, 0 failed, 1 skipped** out
of 72 cases. The skipped performance cohort runs separately. The final artifact
comparison also passes **2/2** after strengthening file-write and delayed-body
assertions. Focused output/sink/extension checks and skill validation pass. Exact
protocol tests are labeled separately from real-browser attachment; actual paused
consumers use synthetic authenticated peers over real sockets. Existing popup,
frame/worker, file, native workflow and official multi-agent cases all pass.

Performance uses one warm-up and five alternating pairs, with samples retained.
A single confirmation cohort explicitly starts measured attaches with the target
tab active and records visible/focused capture pages, with native focus emulation
off. The initial exploratory cohort is retained separately, not pooled into the
confirmed comparison. RSS/CPU includes identified fixture browser descendants
and exact CLI daemons found through private stderr descriptors. Summed RSS may
double-count shared pages; five cycles are not a long-run leak or SLA claim.
Confirmed numbers and all samples are in the curated Gate E report.

Initial UTF-8, fixture-row, inspector-cache and overflow close-code failures are
retained under ignored work paths. They are not presented as clean first-run
passes. The Work diagnostic is read-only; it claims no tab and reads no page
content. Restart recovery, installation/permission cutover and actual Work-profile
native rollout remain separate phases. No push is part of this checkpoint.

Confirmed medians (five samples per adapter): attach
2.39s native / 3.61s official; snapshot
208ms / 213ms; screenshot
292ms / 374ms. No latency or RSS concern threshold was crossed.
The standalone default run passes **51** checks, with **21** opt-in cases skipped;
the final protocol rerun passes **6/6**, including the stopped producer/peer check.
A protocol resource assertion initially sampled before asynchronous WebSocket close
callbacks completed; it now waits for the bounded zero-client condition. It did
not require a runtime limit change. The full serial validation remains 71 passes
plus the separately passed performance case: **72 unique verified checks**,
including **16 headless browser cases** and five opt-in protocol cases.

Final artifacts: `work/attachment-compat/official-oyN3wE/evidence/` and
`work/attachment-compat/native-iWeeUP/evidence/`; isolation/resources:
`work/attachment-compat/native-oXzPNX/evidence/`. Confirmed performance:
`work/attachment-compat/official-kcb0ES/evidence/` and
`work/attachment-compat/native-lXwyAZ/evidence/`. Validation logs:
`work/gate-e-final-validation.log`, `work/gate-e-artifacts-final.log`,
`work/gate-e-default-final.log`, `work/gate-e-limits-confirmed.log` and
`work/gate-e-performance-confirmation.log`.

The final read-only Work diagnostic reports healthy pairing, installed 0.1.2 and
`nativeTransport: false`. No fixture browser remains running; private fixture
registrations and short native runtime directories are removed. Curated report,
selected complete artifacts and hashes are in the chat's `outputs/latch-gate-e/`.

The final targeted abort/sink rerun passes 4/4, including a TERM-resistant CLI
and a CLI that exits while its descendant retains inherited pipes. After the
forced-exit grace period, owned pipes are closed so that case cannot leave the
wrapper waiting indefinitely. This still does not claim to cancel an application
action or kill a real daemon/descendant. Only the explicit fixture descendant is
removed by test cleanup.


## Phase 4 — October 29, 2026

The native source preview now has acknowledged readiness, generation/lease
fencing, bounded durable retries, host-owned schema-4 journals and explicit
reconciliation. [The recovery results](docs/PHASE-4-RECOVERY-RESULTS.md) distinguish
real browser faults from component coverage for all 22 acceptance rows.

94 distinct checks have passing results across the recorded default, serial
opt-in and targeted confirmation runs. Final default: 63 passed, 31 opt-in
skipped, zero failed. All 31 opt-ins also have a passing run in the combined
evidence matrix. Twenty real fault/recovery cycles passed with two agents,
an untouched outsider and zero final native sockets/listeners/sessions.

All new browser verification was headless. The isolated five-pair cohort had no
configured performance concerns: median native attach 2.38 s, snapshot 196 ms,
screenshot 281 ms and disconnect 91 ms. Fixture audit: 64 roots, no leftover
owned processes/registrations/runtime directories. Work remains paired and
healthy on installed 0.1.2 compatibility mode; no rollout or security change.

Evidence: `/Users/ekkisyam/Documents/Codex/2026-10-28/i/outputs/latch-phase-4/`.
