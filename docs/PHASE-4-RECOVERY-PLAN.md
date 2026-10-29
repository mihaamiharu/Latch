# Phase 4: failure, recovery and reconciliation

Prepared October 29, 2026 (Asia/Jakarta). Implemented in the source native preview;
see `PHASE-4-RECOVERY-RESULTS.md` for measured acceptance and implementation
refinements. Installed Work remains unchanged. Starting checkpoint:
`11d4a26` on `feat/latch-native-transport`. Parent: `SINGLE-EXTENSION-PLAN.md`.

## Outcome and boundaries

Latch restores a verified bridge after an interruption, explains what automation
state was lost, and provides an idempotent cleanup path for a named task. It does
not silently resume browser access or repeat an application action.

**Automatic recovery stops at bridge readiness. Automation requires a fresh,
explicit session connection after its authority is lost.** A healthy persistent
Playwright daemon is not abandoned merely because the coding agent or its latest
short CLI process exited. There is no idle-session expiry.

Use pinned Node 22.21.1, CLI 0.1.20, Chrome for Testing 153.0.8010.12 and official
extension 0.4.0. Native remains opt-in. All browser tests use disposable profiles,
actual native messaging and headless full Chrome with mock-keychain flags. No
headed fallback, remote-debugging runtime flags, desktop control, Work restart,
permission/registration/default change, automatic re-pairing or push is included.
Keep the official adapter compatible; its existing independent automation must
not be revoked by a native-only cleanup.

Machine/power-loss recovery, arbitrary same-user hostile programs, managed
download retrieval and installer/UI cutover are outside this phase. Phase 3's
worker-inventory, inspector-cache and file limits remain explicit.

## Starting findings from the current code

- `extension/background.js` reports `connected: !!port`, posts hello and clears
  its error before a host/controller round trip establishes readiness. It retries
  after ten seconds using a worker timer; it has no bounded retry-state contract.
- Worker `epoch` is reused when only the native host reconnects. The controller
  can survive that host loss while its relay manager is a new process. One epoch
  therefore does not identify every automation lifetime.
- Link loss calls `nativeTransport.releaseAll()`; controller reservations and the
  debugger transport are separate maps. Their invalidation must be coordinated,
  including late callbacks from a retired generation.
- The native host already owns per-session relays. Lost transport revokes their
  endpoints, but local records can remain stale, and normal `disconnect` depends
  on first reaching a paired live profile. Epoch mismatch can prevent cleanup.
- `src/state.mjs` uses a directory lock with `owner.json` containing only PID and
  timestamp. It cannot establish process birth identity or safely authorize
  concurrent lock reclamation. Timestamp age and `kill(pid, 0)` are not enough.
- Native schema 3 records carry workspace/session and target metadata but no
  individual lease identity. The same workspace/session key can be reused later;
  an old cleanup must never affect its replacement.
- Gate E already provides finite 10/30-second data-command deadlines, 45-second
  wrapper deadlines, byte/queue bounds and peer-isolation fixtures. Preserve them.

## Decisions to implement

### Separate identity, connection and authority

Keep the stable paired `instanceId` and existing worker `epoch` semantics for
compatibility. Add a native-host generation minted on each host process start and
an opaque lease ID minted for each new native automation lease. The native
recovery authority is:

```text
instanceId + worker epoch + host generation + lease ID + workspace/session key
```

A host reconnect must change native authority even if its worker epoch is
unchanged. Worker/browser restart also invalidates it. Never revive endpoint
credentials, CDP child/session aliases, object handles or ownership from a journal.
Tab IDs, URL/title and a previous target ID are diagnostic hints across a restart,
not sufficient authority to claim a tab. New connect uses fresh discovery and the
normal exact-target verification path.

Fence every mutating native operation and asynchronous callback at both host and
extension boundaries. An old release, detach notification, rollback or delayed
response cannot remove a newer lease with the same key/tab ID. Validate authority
before touching target ownership. Navigation inside a surviving owned tab is not
by itself a new lease; replaced documents/frames still retire their old handles.

### Make the existing native host the native state authority

Use the existing host, not a new daemon, as the sole writer of new native recovery
journals and coordinator of native state mutations. Native clients read snapshots
but request writes/cleanup through it. This avoids promising atomic file
compare-and-replace that Node's separate stat/rename operations do not provide.

Give native mutations a per-key operation grant tied to the caller's open private
control connection and an opaque nonce. EOF ends the grant; PID is diagnostic
metadata. Distinguish this short operation grant from the persistent automation
lease. Normal short CLI completion releases the grant and leaves healthy
attached automation alone. All native state mutations, including reconciliation,
must use this coordinator; do not add a competing client-side recovery writer.

An operation has a finite monotonic budget, proposed at 60 seconds. Expiry fences
its token and records an interrupted/unknown outcome; it is not evidence that a
process died. A late holder cannot commit or delete records. Unresolved resource
cleanup remains blocked, rather than freeing a claim prematurely. Reject busy
same-key operations promptly; do not queue unbounded work or evict a healthy lease.
Keep at most 16 native operation grants, consistent with the native session limit.

Use a distinct native schema-4 journal namespace beneath the private configuration
root, derived from `configPath()` so fixture overrides stay private. Scope it by
profile instance and canonical workspace/session hash. Do not reuse legacy lock
paths that older clients can unlink in a finally block. The host derives file
paths; callers do not supply arbitrary paths to delete or rewrite.

Journal only bounded identity, state/version, targets, failure stage and cleanup
status: at most 64 KiB per record, mode 0600 in owned 0700 directories. Persist
intent before granting external authority and commit verified state before
returning an attached result. Use exclusive temporary writes and atomic rename;
retain/quarantine incomplete records instead of inventing success. Keep at most
64 small completed reconciliation tombstones per profile. Never persist relay
credentials, cookies, page bodies, executable user scripts or browser objects.

A replacement host is a single writer only after exclusive socket binding and
verified extension handshake. An existing live/uncertain host is not displaced.
Socket probes must distinguish refusal/absence from EPERM/EACCES, timeout, wrong
ownership and non-socket paths; uncertain liveness must not cause socket unlink.

### Restore the bridge, not sessions

Negotiate recovery support with a host/controller challenge acknowledgment.
Require the exact current host generation, worker epoch and handshake nonce.
Ignore obsolete port callbacks and late acknowledgments. An open native port or
locally cached host identity is not sufficient native readiness.

On control loss, immediately fence native access, stop relays and cancel pending
native commands. Serialize invalidation of both controller claims and debugger
transport ownership for that generation. Release only known native attachments;
preserve ordinary tabs, groups, login state, official sessions and saved evidence.
Do not declare a target available until its owned cleanup is confirmed. Unknown
or foreign debugger ownership is a conflict, not permission to detach it.

Use one reconnect attempt at a time. Initial retry delays are 1, 2, 4, 8, 16 and
30 seconds, with a five-second readiness deadline per attempt. Six consecutive
failures become a visible degraded state; no tight or permanent retry loop. An
explicit retry or browser-start event can start a fresh bounded episode. Report
attempt count, next eligible attempt and the last failure; reset failure count
only after verified readiness. Do not count a late successful port as ready.

R0 must verify durable wake behavior in the pinned MV3 worker. Persist bounded
retry intent/due time, not timer handles. If a Chrome alarm is needed, justify its
permission and scheduling granularity in the disposable fixture first. Timers may
serve short delays while awake; do not promise their exact timing across worker
suspension. Work permission changes remain Phase 5/6 actions.

### Reconcile explicitly and report uncertainty

Implemented native interface (schema-4 preview):

```text
qa-browser reconcile --profile work --session NAME --workspace PATH
qa-browser reconcile --profile work --session NAME --workspace PATH --apply --expect PLAN_TOKEN
qa-browser doctor --profile work --session NAME --workspace PATH --transport native
```

Default reconciliation is inspection only. It returns the record's state/version,
current bridge/lease status, scoped proposed actions, blockers and a plan token.
The token detects changed state; it is neither permission approval nor an
endpoint credential. Apply revalidates it and the lease tuple under the host's
per-key coordinator. If anything changed, return a conflict before modifying
anything. Applying a matching cleanup twice is a bounded no-op; applying an old
token after a new same-key connection is rejected.

Cleanup order: fence old access, revoke/settle its relay, confirm release of its
owned debugger/claims, attempt normal pinned CLI detachment for that exact
workspace/name, then retire/archive its stale journal. Never run close-all,
kill-all, remove an entire Playwright registry, delete evidence, close website
tabs or identify a target/process by URL, filename, PID or age alone.

If the CLI daemon is unreachable or its ownership cannot be established, report
its cleanup as unconfirmed. Browser access can be revoked without claiming the
daemon was killed. Retain a cleanup-incomplete record where needed. A healthy
session's inspection returns no recovery action; explicit normal disconnect is
how its authorized owner releases it.

Offline inspection must work without the current `paired()` live-socket precheck.
It can read configuration and the exact task journal, but performs no cleanup
writes while the native authority is unavailable. Return a concrete offline
blocker and resume reconciliation after verified bridge recovery. Corrupt,
legacy or ambiguous records are preserved and reported; they are not a reason
for automatic rm, re-pairing, browser launch or permission changes.

Lost automation makes pending actions **outcome unknown**. Abrupt host/browser
loss may erase knowledge of which commands were pending; do not infer that no
mutation ran from a last-known idle snapshot. A fresh authorized connection can
inspect the application, but no click/save/upload/submission is replayed. Existing
completed artifacts retain their hashes; partial files are never promoted into
the new session's completed evidence merely because they exist.

## R0 — Prove lifecycle and compatibility assumptions

Before integrating runtime recovery, extend the private fixture with owned-process identities
and explicit fault barriers. Probe host TERM/KILL, extension reload, worker
termination, debugger detach/competition and browser restart independently.
Record what Chrome actually preserves: worker epoch, controller state, debugger
attachment, tabs/targets, native registration and synthetic authentication marker.
Do not infer worker-stop behavior from a simple port-disconnect simulation.

Establish a headless mechanism for each real fault. Fixture-only hooks may affect
only the copied Latch extension and its spawned processes. Do not patch the
installed official extension or use desktop control. If a true DevTools-conflict
mechanism cannot be exercised headless, report that case as blocked and revise
its coverage design; a mocked detach reason is not a real-conflict pass.

Freeze compatibility rules before adding commands:

| Combination | Required behavior |
| --- | --- |
| Existing official v1 control / installed 0.1.2 | Existing workflow and permissions remain compatible; do not claim native recovery capability. A controller round-trip can verify its control readiness. |
| New recovery-capable native pair | Advertise native schema 4/recovery capability; require the new authority tuple and host operation coordination. |
| Active native schema 3 | Drain through its compatible normal disconnect path; no live migration or reinterpretation. |
| Offline/ambiguous legacy record or PID-only lock | Inspect/report a legacy blocker; no automatic reclamation. Unknown schemas fail clearly. |

Retain the common control envelope where compatible; negotiate new native fields
and operations explicitly. No installed Work upgrade happens to obtain a pass.
R0 must demonstrate single-writer fencing, including host death during a journal
write and an old client attempting a delayed commit, before relying on it. A small
isolated coordinator/journal prototype may establish this design proof; repeat
those assertions through the normal host/helper in R2/R4 before acceptance.

**R0 exit:** measured fault/identity ledger, proven headless injection methods and
an explicit compatible state/protocol contract.

## Acceptance matrix

The table below preserves the planned acceptance criteria. Verified results and
component-versus-browser scope are recorded in `PHASE-4-RECOVERY-RESULTS.md`. Application/server receipts establish outcomes
independently of connection metadata. Host/worker/browser failures are shared
faults; they may invalidate both sessions. Peer-survival assertions apply to
per-lease/target/client failures, not to an entire browser being restarted.

| ID | Scenario | Required proof |
| --- | --- | --- |
| B1 | Native host graceful exit and SIGKILL, idle and in-flight | Old native endpoints become unusable; controller/debugger cleanup is accounted for; replacement host has new generation; no automatic reattach. |
| B2 | Extension reload and genuine worker termination | Actual generation/readiness changes observed; old handles/claims cannot revive; no stale acknowledgment satisfies readiness. |
| B3 | Browser exit/restart with the same disposable profile | Pairing identity remains valid; old authority fails. Observe actual tab restoration separately from an explicitly opened new fixture tab. Never rebind from a restored/reused numeric ID or URL. |
| B4 | Missing/unresponsive host and handshake flapping | At most six attempts per episode, finite deadlines, one active attempt, durable retry intent and accurate degraded state. Missing setup is not repaired automatically. |
| B5 | Obsolete port events and readiness responses | Late disconnect/hello/ACK from old generations cannot affect the current bridge or clear its error incorrectly. |
| S1 | Kill only agent A's exact fixture CLI daemon | A's relay/claims retire; B remains usable with exact actor evidence; tabs are preserved. |
| S2 | Normal short CLI exit; coding-agent exit with healthy daemon | No false abandonment or idle-session revocation. Persistent session remains healthy until explicit disconnect or real transport loss. |
| S3 | Root, popup and iframe removal during a pending call | Correct lifetime retirement; surviving owned pages/peer stay usable; no old alias routes to a replacement. |
| S4 | Same/cross-site navigation and document replacement | Supported navigation continues on the correct lease; stale contexts fail; no blanket recovery or mutation replay. |
| S5 | Debugger detach/competing debugger or target failure | Record actual Chrome behavior/reason; never force ownership from attached=true alone. Report conflict and preserve foreign access. Fresh connect succeeds only when the conflict is actually gone. |
| L1 | Two live same-key mutation clients | Second operation gets busy/conflict promptly; no live grant stolen. Distinct workspace keys can continue. |
| L2 | Operation-owner death at reserve/connect/verify/release stages | Control EOF/fencing ends only that operation grant; durable stage/unknown outcome retained and scoped rollback verified. |
| L3 | PID reuse, old timestamp, permission denial and legacy lock | None alone authorizes removal. Ambiguous/legacy state remains untouched with a specific blocker. |
| L4 | Concurrent apply/connect and host loss during reconciliation | At most one valid writer/lease transition. Old-generation delayed filesystem/cleanup commits are rejected and cannot erase a successor. |
| J1 | Inspect a stale, healthy and already-absent session | Read-only plan is accurate, task-scoped and credential-free; healthy session is not called abandoned. |
| J2 | Apply twice, stale plan token and same-key successor | Matching repeat is a no-op; changed identity/version is rejected before side effects. New lease and peer remain usable. |
| J3 | Offline bridge, corrupt journal and partial write | Inspection works offline, apply is blocked, evidence/state is preserved and errors distinguish inaccessible from missing. No global cleanup. |
| J4 | Official/v1, schema-3 and unknown-schema compatibility | Existing official behavior passes; native contract is negotiated; no active legacy migration or unsafe lock reclamation. |
| U1 | Mutation committed before response/transport loss, plus request never received | Independent server counter proves the two outcomes. Agent reports uncertainty after loss and never automatically sends a duplicate; fresh inspection is a separate action. |
| U2 | Completed and interrupted evidence plus late responses | Complete artifacts retain hashes. Partial/old results are not attributed to a replacement lease; old credentials cannot deliver a successful new-session result. |
| O1 | Layered doctor/diagnose and execution denial | Distinguish config/pairing, host reachability, controller readiness, native lease/relay, daemon and debugger conflict. EPERM/EACCES stays access denial. No page content/claim is needed for health. |
| O2 | Twenty bounded fault/recovery cycles with two agents | No native session/socket/listener accumulation, endpoint reuse or unbounded retry. Correct scope of global versus per-session failure and preserved synthetic authentication/evidence. |

## R1 — Implement readiness, invalidation and bounded reconnect

Add acknowledged generation-aware readiness and explicit states such as
connecting, ready, degraded and offline. On loss, fence old native authority
before making fresh access available. Coordinate transport and controller map
cleanup, including callbacks already in flight. Keep official state separate.
Implement the retry budget, durable wake mechanism and obsolete-event rejection.
Diagnostics show last verified readiness and its generation/freshness, rather
than equating a cached Boolean with a current round trip.

**R1 exit:** B1/B2/B4/B5 and readiness parts of O1 pass with no revived sessions.

## R2 — Implement native journals, grants and recovery inspection

Move native recovery mutations to the existing host's single-writer coordinator,
with connection-bound grants and schema-4 fencing. Preserve legacy/official paths.
Validate canonical workspace/key, record version and exact authority before each
commit. Implement durable stage transitions and bounded journal/tombstone storage.
Add read-only session diagnostics and offline reconciliation inspection before
adding apply. No broad PID scanning or client-side stale-lock deletion is added.

**R2 exit:** L1–L3, J1/J3/J4 and host-death delayed-commit tests pass. Live ownership
and ambiguous legacy state remain protected.

## R3 — Implement scoped apply and verify uncertain outcomes

Implement the plan-token check and ordered cleanup. Proposed apply budget: 30
seconds, with controller/debugger cleanup and exact CLI-detach substeps bounded
to ten seconds each. Caller native RPC remains above it (35 seconds), host socket
above that (40 seconds). Return partial cleanup truthfully if a substep fails.
New long-lived operation-coordination channels need their own bounded lifetime;
do not inherit a short request socket timer that silently kills a valid grant.
Normal operations retain Gate E data/output bounds. A high-level 60-second grant
budget must be fenced before expiry is reported; recovery-specific fixture
watchdogs can allow 75 seconds to receive that structured result. Do not raise
all existing command deadlines.

Verify failures before dispatch, after reservation, after browser attachment,
after application commit and during cleanup. Use server barriers/receipts, not
click counts or sleep-based guesses. Do not add idempotency keys to arbitrary
real applications to make replay appear safe. Test stale plan tokens and old
cleanup callbacks against a newly created same-key lease. Apply within already
authorized scoped recovery work does not introduce a universal user-approval
prompt; it remains a concrete checked mutation rather than implicit repair.

**R3 exit:** J2/L4/U1/U2 pass; every reported clean resource is actually released,
and uncertain cleanup remains visible without stealing a healthy session.

## R4 — Real faults, compatibility and bounded cycling

Run all matrix faults through actual headless Chrome/native messaging and the
normal helper wherever the behavior is browser-facing. Mocks cover schedules,
process-identity ambiguity and protocol races, labeled separately. Killing or
pausing a fixture process requires its proven fixture provenance; never trust a
stale journal PID or use kill-all. Restart only the spawned browser with its own
private profile. Never copy Work cookies or storage into a fixture.

Use two agents and one unclaimed outsider; preserve exact actor/target markers.
Browser restart tests distinguish restored tabs from new explicitly provisioned
tabs. Simulated tab-ID reuse and stale same-URL identities get focused controller
and journal tests; do not wait for Chrome to happen to reuse an ID.

Cycle at most twenty failures, one fault at a time, with finite server barriers
and bounded waits. Keep Gate E payload limits, at most four held calls per normal
fault scenario, small control messages and bounded telemetry. Full recovery-fault
runs may have a 15-minute suite watchdog; each stage still has its own deadline.
Record exact processes, retry counts, commands settled, resources before/after,
identity transitions and peer results. Do not claim endurance or crash safety
from a small cohort.

**R4 exit:** all 22 rows have verified dispositions with no unaccounted owned
access or pending request. A missing headless fault mechanism is a blocker to
that claim, not permission to count a synthetic event as a browser pass.

## R5 — Regression, evidence and checkpoint

Planned boundaries; create modules/commands only when implementing them:

| Area | Responsibility |
| --- | --- |
| `extension/background.js` and a focused lifecycle helper | Acknowledged readiness, retries/wake state, generation changes and obsolete-event fencing. |
| `extension/controller.js`, `extension/debugger-transport.js` | Native-only invalidation, lease-aware callbacks, conflict handling and verified release. |
| `src/native-host.mjs`, `src/native-sessions.mjs`, `src/native-relay.mjs` | Host generation, operation coordination, authority validation and scoped terminal cleanup. |
| `src/state.mjs` and a native recovery/journal module | New host-owned namespace, atomic bounded writes, versions, plan tokens and tombstones; preserve legacy compatibility. |
| `src/cli.mjs`, `src/native-workflow.mjs`, `src/diagnostics.mjs` | Offline inspect, guarded apply, explicit reconnect and layered truthful diagnostics. |
| Recovery fixture/helper and `test/recovery-browser.test.mjs` | Actual host/worker/browser/daemon faults, independent mutation receipts and tab preservation. |
| Focused journal/coordinator/lifecycle tests | Duplicate apply, live holder, generation/token races, PID ambiguity, retry schedules and partial writes. |
| `test/recovery-chaos.test.mjs` | Opt-in twenty-cycle resource/fault cohort. |

Proposed opt-in commands: `test:recovery` and `test:recovery-chaos`; add them only
when suites exist. Run default checks plus recovery tests and relevant real
browser regressions: official/native attachment, multi-agent workflow, popups,
frames/workers, files and evidence. Rerun the Gate E performance cohort if the
new coordination/journal path changes normal attach/command costs. Keep all tests
headless; count skipped cases separately from actual runs.

Publish a readable recovery matrix and selected sanitized evidence under the
chat's `outputs/latch-phase-4/`: fault/barrier receipts, state/authority transitions,
health layers, server mutation counts, plan/apply results, artifact hashes, retry
schedules and resource cleanup. No endpoint credentials, profiles, raw CLI
registries or page secrets. Verify cleanup of every fixture-owned process,
registration and runtime directory; run a final read-only Work diagnostic without
repairing it.

Update README, TEST-RESULTS, migration status and the canonical shared skill with
only proven commands and error recovery. Validate the skill. Save a local Git
checkpoint after acceptance; no push or installed Work cutover is included.

## Completion rule

Execute R0 → R1 → R2 → R3 → R4 → R5. Phase 4 completes when the bridge can recover
with verified readiness, lost automation remains fenced until explicit fresh
connection, stale native resources can be reconciled idempotently under a proven
single-writer contract, and interrupted outcomes are never silently replayed.
A leaked owned debugger attachment, live old credential, unsettled request,
successor-erasing cleanup or unproven lock reclamation prevents completion.

Legacy blockers and external debugger conflicts may remain explicit unsupported
recovery conditions; they must leave no newly acquired access or fabricated pass.
Healthy peers survive per-session faults. Global host/worker/browser faults report
their real blast radius. Installation/UI cutover and actual Work native rollout
remain Phases 5 and 6.
