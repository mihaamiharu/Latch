# Phase 3: browser behavior and attachment compatibility

Prepared October 28, 2026. Status: Gates A/B implemented; final acceptance results are recorded in `../TEST-RESULTS.md`. Gates C–E remain planned. This is not full Phase 3 completion.
Starting checkpoint: `3e6303e` on `feat/latch-native-transport`.

## Acceptance status

- **Gate A passed:** the shared official/native fixture uses actual Chrome
  native messaging, normal helper attachment, matching page assertions and
  preserved-tab cleanup. See `../TEST-RESULTS.md` for evidence and setup limits.
- **Gate B passed:** attributable descendants, concurrent same-URL popups,
  exact child selection/release, redirects and parent/child closure are covered.
  The blocked case uses a sandbox without `allow-popups`. Missing opener and
  capacity limits fail without adopting or closing the affected tab.
- **Gates C–E pending:** dedicated frame/worker behavior, file transfers and
  large-result transport/evidence checks are not established by the popup suite.

## Outcome

An agent can follow an application flow from an existing Work tab into a new tab
or popup, interact with supported frames and file controls, and capture complete
evidence through Latch's native transport. Existing Playwright CLI commands and
page APIs remain the automation interface.

This phase compares official attachment and native Latch on the same controlled
application fixtures. Reuse Playwright's behavior and relevant upstream routing;
implement only the transport and ownership gaps demonstrated by those checks.
No Work-profile installation, default-transport change or new browser permission
grant is part of this phase.

## Baseline and working rules

- Preserve checkpoint `3e6303e`. Continue on the current feature branch.
- Keep CLI 0.1.20, official extension 0.4.0, Node and Chrome versions pinned and
  recorded for both sides of each comparison. Do not upgrade them to mask a gap.
- At the starting checkpoint the native preview supported one tab per session. Its screenshots,
  snapshots, basic interactions, console/network inspection and concurrent named
  sessions already have evidence. Popups, frame compatibility, uploads, managed
  downloads and large results still need their own acceptance evidence.
- The current data path has a 32 MiB WebSocket message limit, an 8 MiB outgoing
  backlog threshold, a 10-second per-browser-command deadline, and a 2 MiB stdout
  bound in the Latch CLI adapter. These are separate limits. Native control
  messages retain their existing smaller limits and must not carry file bodies.
- Focus emulation stays off by default. Record it per scenario. Test normal focus
  behavior separately from native background interactions with explicit emulation.
  Do not compare foreground behavior in one adapter against background behavior
  in the other and call the difference a transport regression.

## Delivery order

### 3A — Establish a genuine side-by-side fixture harness

Build one reusable fixture application with deterministic markers, independent
server-side observations, local test files and private artifact directories.
Run it in separate disposable profiles for official and native attachment using
the normal Latch helper, pairing, workspace and named-session flow.

Use real Chrome native messaging for both runs. The existing official browser
test substitutes its native pipe for part of the harness; keep that regression
test, but do not present it as the final parity comparison. Label any one-time
official-extension fixture authorization separately from the verification path.
Provision authorization only in the disposable profile; never copy Work logins
or tokens. No desktop control or manual tab movement is part of attachment.

Apply mock-keychain flags before launching either fixture browser. Pin the
browser executable explicitly for reproducible comparisons. Configure downloads
to a private fixture directory before browser startup, so test downloads do not
land in the user's Downloads folder or change Work browser settings.

Collect a result per case and adapter: outcome, assertion, environment/focus
settings, versions, relevant protocol methods/errors, cleanup result and evidence
paths. Compare application outcomes rather than volatile tab IDs, timestamps or
byte-identical snapshots. Restrict network evidence to fixture requests and omit
connection pages, endpoint credentials, cookies and authorization headers.

**Gate A:** the same basic navigation/action/evidence case passes through both
real attachment paths, with independently observed state and successful cleanup.

### 3B — New tabs and popups first

Change the native ownership model to **one explicitly selected starting tab plus
tabs whose opener can be attributed to that session**. A child can itself open a
child. Other pre-existing tabs still require their own explicit session; this
does not become profile-wide auto-attachment.

Use Chrome tab/opener metadata and validated CDP target relationships as evidence
of parentage. Do not assign ownership from URL, recency or window membership.
Creation may precede a committed URL: represent an attributable pending child
while it is blank, then attach according to the supported navigation policy.
An unrelated blank tab is never a pending child merely because it appeared nearby.

Keep reservations atomic across native and official sessions. Register a child
with the existing session relay, translate its opener/target/session information,
and expose standard Playwright page/popup events. A popup must be available to a
waiter established before the click, without a second helper connect command or
tab dragging. The agent can inspect, select and capture evidence from the child
through ordinary Playwright APIs and CLI tab commands.

When opener evidence is unavailable, leave the tab unclaimed and report the
unsupported/ambiguous relationship. The agent may explicitly select the observed
tab into a separate session using the existing workflow. It must not guess or
attach every newly opened tab to satisfy a popup wait. Test `noopener` explicitly;
do not assume JavaScript's `window.opener` and Chrome's opener metadata behave
identically.

Proposed initial bounds: 16 owned top-level tabs per session and four generations
of child tabs. Exceeding either leaves extra tabs unclaimed and reports the limit;
it does not close those tabs. Verify limits with controlled tests and document any
adjustment before acceptance.

Required lifecycle behavior within this phase:

- A child that closes itself is removed without closing the parent or its peers.
- If the parent closes, surviving owned children remain usable; report that the
  original parent is gone rather than selecting an unrelated replacement.
- If the final owned tab closes, revoke the relay and allow explicit cleanup of
  the recorded session. Do not turn a normal popup close into a whole-session loss.
- Explicit child close is restricted to owned targets. Normal disconnect detaches
  and preserves all remaining website tabs, including children.
- A newly opened tab may become active through the application's normal browser
  behavior. The bridge must not add extra tab activation, grouping or relocation.

Required cases: `target="_blank"`; `window.open()`; blank-then-navigate;
redirect chains; a cross-origin child; an authentication-style child that returns
a fixture result and closes; nested children; blocked popups; immediate close;
missing opener; a user-created unrelated tab; parent close; and two concurrent
sessions opening the same destination URL. Verify actual Chrome IDs and per-tab
markers, not only page counts.

**Gate B:** attributed children appear only in their owner's Playwright session,
the standard popup wait/click flow completes, and close/disconnect preserves the
correct surviving pages. Ambiguous and blocked cases produce bounded, actionable
outcomes; clicks are never replayed automatically after a timeout.

### 3C — Frames and dedicated workers

Exercise existing Playwright frame locators through the relay: same-origin and
cross-origin frames, nested frames, dynamic insertion/removal, navigation and
frame replacement during observation. Use distinct sites where needed and
confirm an actual out-of-process iframe target/session exists; two URLs on
different ports alone are not proof that OOPIF routing was exercised.

Maintain the hierarchy between an owned Chrome tab and its CDP child sessions.
Keep nested attachment IDs, routing parameters and detachment events consistent
in both directions. Remove descendants on frame detach so stale session IDs
cannot route to a replacement frame or another agent's page.

Include a dedicated worker tied to an owned page. Shared/service workers may span
pages and need a separate ownership policy; inventory their actual behavior and
mark unsupported management explicitly rather than auto-claiming them globally.

**Gate C:** required frame interactions and dedicated-worker observations match
the verified baseline, including cross-session negative tests and cleanup after
frame replacement. Any remaining worker limitation is explicit in the matrix.

### 3D — Uploads and downloads as separate capabilities

For uploads, use existing CLI `upload` and Playwright file-input/file-chooser APIs
where applicable. Test a small file, multiple files, a binary file and filenames
with spaces/Unicode. The fixture server must verify filename, byte length and
SHA-256; an apparently filled input is insufficient. Use task-owned fixture files
and standard APIs before considering any additional file bridge.

For downloads, record two separate outcomes:

1. The browser received the intended file in the private fixture download folder.
2. The agent can identify and save that exact completed file as task evidence
   through a supported attachment workflow.

Test a simple attachment, redirected download, duplicate filenames, cancellation
and two sessions downloading the same URL. Observe bytes independently and
verify hashes. Do not associate a download with an agent from URL/time alone.

The official relay currently treats download configuration as a no-op. Establish
what the pinned baseline actually does before declaring a Latch regression or
promising managed retrieval. A verified upstream limitation remains a documented
limitation, not a successful capability test. A download-specific extension
permission or browser-wide manager is not a default solution: require evidence
of a necessary gap and a reliable session attribution design before adding it.
Any eventual permission grant belongs to the later installation phase.

**Gate D:** uploads preserve the verified baseline's file bytes. Download results
state exactly which of the two capabilities works. Unsupported artifact retrieval
must fail/report clearly; it must not return a guessed path or another task's file.

### 3E — Large artifacts, bounded traffic and deadlines

Test the full data route with deterministic high-entropy screenshots and response
bodies above 1 MiB. Include representative serialized results around 4 MiB and
16 MiB, then exercise exact configured wire-size boundaries and one over-limit
case. Measure UTF-8/JSON/base64 size as well as decoded artifact size; a 32 MiB
wire limit is not a promise of a 32 MiB PNG or response body.

Validate saved files with decoding, expected dimensions/content, byte counts and
hashes. Prefer file artifacts over dumping bodies into CLI stdout; test the
wrapper's stdout limit separately. Do not increase every limit until a large
test appears to pass. Every change must identify the bottleneck, retain a bound
and preserve the control/data separation.

Exercise a bounded burst of console/network events, a slow consumer, a pending
request limit and a deliberately oversized message. The affected task must get a
clear result and cleanup; the other task must remain responsive. Check queues,
pending promises and target ownership after the failure. No successful report may
contain a silently truncated artifact.

Review the current 10-second browser-command deadline against legitimate async
Playwright operations. Define per-command and whole-operation bounds with clear
timeout diagnostics; never treat a timed-out click as safe to replay. General
browser/host crash recovery stays in Phase 4, but failures caused by this phase's
own size/backpressure tests are part of this gate.

Collect one warm-up and five measured pairs for representative attach, snapshot
and screenshot operations. Report median/range, sample count, CPU/browser versions
and peak/after-cleanup memory observations. Investigate a native median over twice
the baseline or memory growth that persists across cleanup; distinguish machine
noise from a reproducible regression. This is a comparison, not a production
capacity claim.

**Gate E:** declared supported sizes produce complete artifacts; over-limit and
slow-consumer cases stay bounded and preserve peers. Record supported limits and
remaining performance concerns rather than advertising unlimited evidence.

## Outcome classification

| Result | Meaning and action |
| --- | --- |
| Compatible | Both adapters meet the fixture's independent assertions. |
| Latch gap | Official attachment passes; native fails. Repair and rerun the affected case and ownership checks. |
| Baseline failure | Official attachment fails. Investigate fixture/setup/version behavior before calling it an upstream limit. |
| Verified upstream limit | Reproduced baseline constraint with evidence. Document the unsupported behavior; do not count matching failures as a pass. |
| Native extension | Native provides a scoped capability beyond the baseline. Label it separately and test its boundaries. |
| Blocked / untested | Missing prerequisite or case not executed. Record why; never convert a skip into a pass. |

## Implementation boundaries

| Area | Expected responsibility |
| --- | --- |
| `extension/controller.js`, `extension/debugger-transport.js`, `extension/background.js` | Opener attribution, atomic child ownership, tab lifecycle and scoped event forwarding. |
| `src/native-browser-model.mjs`, `src/native-relay.mjs` | Multiple owned top-level targets, opener metadata, standard popup events, nested CDP sessions and bounded data. |
| `src/native-sessions.mjs`, `src/native-workflow.mjs`, `src/cli.mjs` | Session target inventory, exact-ID selection/verification and cleanup with surviving children. |
| `src/state.mjs`, protocol/diagnostics | Versioned root-plus-children records and specific unsupported/limit outcomes; no credentials or durable CDP session IDs. |
| Shared fixture helpers and new compatibility suites | The same application assertions on official/native attachment, plus independent file/state observations. |
| Skill operations reference and docs | Verified behavior, focus choice, popup workflow, file support and evidence limits. |

Use a new native state schema for root-plus-children records; preserve legacy
official records and safe cleanup of Phase 2 native records. Never reinterpret an
unknown schema or silently migrate a live lease. Keep the existing explicit
transport choice and focus setting. A session may select an already owned child
by exact target identity; this does not authorize adding unrelated existing tabs.

## Deliverables and completion

Deliver a compatibility matrix, readable report, selected screenshots/snapshots,
file hashes/byte counts, sanitized method/error traces, cleanup assertions and
versioned support limits. Keep bulky fixture data, profiles and credentials under
ignored `work/` paths. A result must identify the scenario, adapter and focus
policy so its artifacts can be interpreted correctly.

The new entry points are `npm run test:popups` and
`npm run test:attachment-compat`, alongside the existing default, native-workflow
and official regression tests. Frame, file and large-payload fixtures remain to
be added for Gates C–E.

Phase 3 is complete when gates A–E have evidence, required baseline-supported
cases have no unresolved Latch gaps, popup ownership/cleanup tests pass under
concurrent sessions, and any unsupported file/worker behavior is stated precisely.
Keep restart recovery (Phase 4), installation/permissions and UI cutover (Phase 5),
and actual Work-profile rollout (Phase 6) separate.

The first implementation milestone establishes Gates A/B. Continue with Gate C
before broadening to file transfers and large traffic. Work-profile installation
and the daily transport default remain separate migration gates.

## References

- [Chrome tab/opener metadata and creation events](https://developer.chrome.com/docs/extensions/reference/api/tabs).
- [Playwright pages and popup events](https://playwright.dev/docs/pages#handling-popups).
- [CDP attachment options and fidelity](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).
- [Pinned official relay, including download configuration](https://github.com/microsoft/playwright/blob/f9a841f968dd9a4e315df2ec2930da1952971667/packages/playwright-core/src/tools/mcp/cdpRelay.ts).
- [Pinned upstream target/session model](https://github.com/microsoft/playwright/blob/f9a841f968dd9a4e315df2ec2930da1952971667/packages/playwright-core/src/tools/mcp/browserModel.ts).
