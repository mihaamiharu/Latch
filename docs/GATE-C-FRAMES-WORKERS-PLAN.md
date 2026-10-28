# Gate C: frames and dedicated workers

Prepared October 28, 2026. Status: implemented; headless comparison and isolation
evidence are recorded in `../TEST-RESULTS.md`. The original execution plan follows.
Starting checkpoint: `2e1ee34`, branch `feat/latch-native-transport`.
Parent roadmap: `PHASE-3-COMPATIBILITY-PLAN.md`.

## Outcome and boundaries

A local terminal agent can use unmodified Playwright CLI to inspect and interact
with frames and observe dedicated workers inside a Latch-owned tab. The correct
agent retains its page through frame navigation, replacement and worker shutdown.
Sibling sessions never receive that page's child sessions or events.

Use the existing helper, Work-profile pairing contract, workspace isolation and
named sessions. Keep the official adapter as the daily default. All browser tests
use disposable profiles and synthetic data; no Work installation, permission
grant, native-host registration update, global security change or push is included.
The Work installation remains unchanged by this implementation.

## Implementation dispositions

Browser tests now run headless, including isolated official authorization setup.
The macOS official headless fixture uses a private connection-page URL-delivery
shim; no official extension or CLI code is modified and actual native messaging
is retained. Background-throttling flags and test-only hostname/site-isolation
settings are documented in evidence. Headed focus behavior is not inferred.

W1 is limited in the pinned CLI: already-running workers are attached at the
protocol level and answer application messages, but are not backfilled into
`page.workers()`. The explicit disposition is to retain that limitation and verify
new dedicated-worker events/evaluation instead of forcing a worker restart or
changing Playwright. Shared/service-worker management remains unsupported.

Lifecycle fixture controls use scoped page/frame evaluation to isolate target
lifetime behavior from focus-sensitive pointer delivery. Frame forms use ordinary
locator fill/click, including cross-origin/nested targets. The report labels these
different triggers. Unknown/foreign/retired routes, limits, inspection aliases and
in-flight detach cancellation have focused unit coverage as well as real-browser
isolation evidence. Child retirement history is bounded at 1024 identities per tab.

Uploads/downloads and large-payload work remain Gates D/E. Browser/worker restart
recovery remains Phase 4. Shared/service-worker management, profile-wide worker
discovery and universal background input behavior are outside Gate C. Observe and
document unexpected worker types without silently adopting global targets.

## Starting evidence and design risks

Gates A/B established actual native messaging, normal helper attachment,
multi-agent ownership and popup lifecycle. Reuse those fixtures and assertions.
Pin the current Node 22.21.1, CLI 0.1.20, Chrome for Testing 153.0.8010.12 and
official extension 0.4.0; record actual versions before testing and report drift.
Do not upgrade dependencies to make a failing case disappear.

Chrome distinguishes same-process frame execution contexts from child targets.
Cross-origin URLs alone do not prove an out-of-process iframe (OOPIF) was tested.
Flat debugger sessions carry child session IDs, and nested auto-attachment needs
to be propagated through the hierarchy; it is not recursive automatically.
[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

The inspected source already translates child session IDs in
`src/native-browser-model.mjs`. It also prunes model descendants on detach. The
extension's `debugger-transport.js` currently tracks raw child IDs without parent
links and deletes only the named child on a detach event. These are investigation
targets, not proof of a browser regression. Existing frame-tree startup ordering
was established for top-level targets; child-target initialization needs evidence.

## C0 — Establish a real comparison fixture

Create `test/fixtures/frame-worker-app.mjs` and extend
`test/helpers/attachment-fixture.mjs` only as necessary. Keep popup fixtures working
and share lifecycle/launch code rather than duplicating native registration.

Provide two controlled sites served locally, with a third site if needed to prove
nested target routing. Use browser-local hostname mappings for test domains if
necessary, with identical arguments for both adapters. Do not modify the system
hosts file, DNS settings or Work browser. Different localhost ports may test
cross-origin access but are not sufficient OOPIF proof. If test-only isolation
flags are required, record them and the resulting fidelity limit.

Each root, frame and worker gets a distinct run/actor/instance marker. Forms post
small deterministic results to the fixture server. Server observations establish
which actor and frame changed; matching URLs or page counts are insufficient.
Generate fixture identity server-side where test origins lack secure-context APIs.

Include frames/workers already present before attachment and controls to create,
navigate, replace, remove, terminate and recreate them after attachment. Reuse
identical iframe names, selectors and worker script URLs in the two agent roots,
while keeping their actual instance markers different.

Both adapters use the normal shared-skill helper and actual Chrome native
messaging. Preserve the existing isolated official authorization setup, which
closes before the runtime browser starts. Runtime browsers use no remote-debugging
connection; every fixture launch retains mock-keychain flags. No manual tab
movement or desktop automation enters verification.

First run the official baseline for each case, then native with the same fixture,
assertion and focus policy. Record pass, fail, unsupported or blocked, with the
observed reason. Two failures do not establish support. A baseline limitation
requires an explicit support-matrix decision, not silent removal of the case.

**C0 exit:** reproducible fixture markers and an actual child `iframe` target/session
are recorded. The target is tied to its owned top-level tab; a screenshot alone
does not establish this relationship.

## Acceptance matrix

All rows start unverified. Run functional rows through both adapters; run direct
route-boundary assertions against native plus its unit tests.

| ID | Scenario | Required observation |
| --- | --- | --- |
| F1 | Same-origin iframe present before connect | `frameLocator` locates, fills and clicks the intended form; server confirms actor/frame/result. |
| F2 | Cross-origin iframe | Standard frame API interaction succeeds without using parent DOM access to bypass origin separation. |
| F3 | Actual OOPIF | Same interaction passes and a distinct iframe target plus child session is observed. |
| F4 | Nested frames across target boundaries | Deepest form result and frame ancestry match; recursive child-session routing is exercised. |
| F5 | Dynamic insertion/removal | New frame becomes usable; removal is observed; parent and peer frames remain usable. |
| F6 | Same-site/cross-site navigation and frame replacement | Fresh locators reach the new instance, including transitions between shared and separate process targets when observed. |
| F7 | Stale objects and a detached subtree | A retained Frame/handle and raw retired session IDs cannot reach a replacement or another page; unaffected siblings still work. |
| F8 | Frame evidence and events | Snapshot records the expected content or an explicit baseline limit; screenshot/locator screenshot shows it; small console, error and request markers reach the correct owner. |
| W1 | Dedicated worker present before connect | Inventory/evaluation identifies the actual existing worker and its actor marker. |
| W2 | Dedicated worker created after connect | A waiter established before creation receives the worker; evaluation and a message round trip give the expected result. |
| W3 | Worker terminated and recreated at the same URL | Close is observed, the old object/session cannot execute, and a new worker identity is distinct and usable. |
| W4 | Dedicated worker owned by an iframe | Exercise a worker under the frame hierarchy, including an OOPIF if the baseline supports it; report any limitation explicitly. |
| I1 | Two sessions with matching frame and worker URLs | Results, events and target/session identities remain with the correct actor/workspace. Foreign IDs are rejected at relay and extension boundaries. |
| I2 | Remove/release one agent's root or child page | Its descendants retire; the peer session and unrelated tabs remain usable. |
| L1 | Capacity and unknown/late events | Limits give explicit outcomes; duplicate, stale and out-of-order events do not revive retired routes or release an unrelated lease. |

Use the ordinary `frameLocator`, `page.frames`, worker inventory/events and
`worker.evaluate` APIs exposed by the pinned CLI's `run-code` environment. Check
actual pinned API behavior before writing assertions. Public references:
[Playwright frames](https://playwright.dev/docs/frames) and
[Worker API](https://playwright.dev/docs/api/class-worker).

A snapshot, console or worker API limitation in the official baseline must be
reported separately from the main interaction result. Do not promise complete
worker network tooling based only on a successful worker evaluation.

## C1 — Correct native child-session routing where evidence requires it

Work primarily in `extension/debugger-transport.js` and
`src/native-browser-model.mjs`. Change `src/native-relay.mjs` only if cancellation,
diagnostics or event ordering requires it. Keep the public connect/release contract
and schema 3 unless an externally visible compatibility change proves necessary.

Maintain a consistent graph containing the owning lease, top-level tab, parent
session, child target type/identity, raw Chrome session, translated wire session
and lifetime. Associate same-process execution contexts with their real frame;
do not invent separate targets for them.

Route commands and events through the same graph in both directions. Propagate
Playwright's scoped auto-attachment through nested targets as required; do not add
an independent browser-wide discovery fallback. Preserve target-type and startup
pause semantics. Prevent duplicate attachment/initialization, and validate any
child-specific startup ordering fix against the recorded failure.

On subtree detach, retire all descendants in both maps, including inspection
aliases. New instances receive fresh wire identities even if URLs, names or raw
IDs are reused. Foreign/unknown sessions remain errors. Late events from a
retired route cannot recreate it or update a replacement.

Test detach during an in-flight command. If Chrome leaves a retired target's
command pending, add targeted cancellation rather than waiting for it to kill a
healthy parent relay. Any ignored late response must match a bounded, known
cancelled request; unknown responses keep the existing failure behavior.

Proposed initial bounds: 64 active child debugger sessions per owned top-level
tab, 256 per named native lease and 16 child-target ancestry levels. These are
separate from the existing 16 top-level tabs/four popup-generation limits. Verify
at the boundary and one above. Adjust only with recorded fixture evidence and
document the chosen constants before acceptance. Keep limits consistent at both
transport boundaries; exceeding them must not leave newly paused targets hanging
or close unrelated tabs.

Shared/service workers may outlive or be shared across pages. Characterize actual
baseline events without treating related-target appearance as authorization for
global management. Ensure unsupported targets are not left paused by attachment;
if safe filtering/resume/detach cannot be demonstrated within scope, record an
explicit blocker for that scenario.

**C1 exit:** native passes every required baseline-supported frame interaction and
dedicated-worker observation, with focused regressions for each routing fix.

## C2 — Prove lifecycle and multi-agent boundaries

Use two native sessions named `agent` in different canonical workspaces. Assign
different starting tabs and identical frame/worker URLs with different actors.
Attach only through Latch, then exercise matching operations concurrently.

Direct negative tests submit another session's child/inspection ID and a retired
ID. Assert rejection before browser execution, not merely an empty result. Remove
a nested frame while a sibling or peer continues, terminate a worker and recreate
it at the same URL, then release one owned page while the other lease stays live.

Use real foreground behavior for the primary parity matrix: the test explicitly
brings the intended parent forward before input. Read-only concurrent observations
and any background-input probe are separate, labeled results. Do not assume focus
emulation establishes all background behavior or retry a timed-out mutation.

**C2 exit:** stale/foreign routes cannot execute, descendant retirement is complete,
and parent/sibling/peer operations still succeed where their pages remain live.

## C3 — Verification and evidence

Planned test entry points:

```bash
npm run test:frames-workers
npm run test:frame-isolation
```

Add scripts only when their tests exist. Suggested files are
`test/frame-worker-compat.test.mjs`, `test/frame-worker-isolation.test.mjs` and
`test/native-child-sessions.test.mjs`. Default tests must continue to skip real
browser runs unless explicitly enabled. Keep case budgets within the existing
command deadlines; split scenarios rather than raising all timeouts or hiding
failures with automatic retries.

Collect actual child attachment type/identity and parent relationships for both
adapters. Use a bounded native metadata trace. If official baseline proof requires
CLI protocol logging, keep its raw log private and export only an allowlist of
event names, types and run-scoped identities. Never copy raw protocol bodies,
cookies, auth headers, tokens or endpoint URLs into deliverable evidence. Capture
traces before disconnect, preserving the Gate B teardown fix.

For every case record adapter, versions, launch/focus settings, expected/actual
outcome, independent fixture observation, ownership relationships, cleanup result
and evidence paths. Use unique artifact names per adapter/case/agent. Retain small
snapshots/screenshots and worker/event summaries; file transfer and payload-volume
testing remain later gates.

After fixes, run `npm test` plus the two new opt-in suites. Rerun the existing
attachment comparison, popup and native multi-agent suites once against the final
runtime changes. Failures get a focused repair and appropriate recheck; do not
keep repeating successful browser runs without a new reason. Verify no owned
fixture browser remains and run the read-only Work diagnostic, which claims no tab.

## C4 — Document and checkpoint

Update `TEST-RESULTS.md`, the Phase 3 acceptance status and README with the actual
support matrix and limits. Update the canonical shared skill only with behavior
proven by these tests, including fresh frame locators after replacement and worker
limitations; validate that skill. Do not publish test-only startup flags as Work
setup instructions.

Save a readable report and curated evidence in this chat's `outputs/latch-gate-c/`
directory. Keep private browser profiles, raw daemon logs and session credentials
in ignored `work/` folders. Save a local Git checkpoint after validation; do not
push or upgrade the installed Work extension.

## Gate C completion rule

Gate C passes only when the matrix has evidence for required frame interactions,
actual OOPIF/nested routing, dedicated-worker observation, lifecycle retirement,
cross-session rejection and preserved-page cleanup. Required cases cannot remain
silently skipped. Baseline failures and unsupported worker cases stay visible and
require an explicit disposition before calling the gate complete.

The final report must distinguish functional parity from native coordination
guarantees, state which focus modes were tested, identify remaining limitations
and link artifacts. It advances only Gate C. Gates D/E, restart recovery and Work
rollout remain open.

Implementation order: C0 fixture/baseline, C1 demonstrated routing fixes, C2
isolation/lifecycle proof, C3 final regression/evidence, C4 documentation/checkpoint.
