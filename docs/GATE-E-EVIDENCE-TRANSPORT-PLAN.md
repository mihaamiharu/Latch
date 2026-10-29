# Gate E: large evidence, bounded traffic and deadlines

Prepared October 29, 2026 (Asia/Jakarta). Status: implemented; measured dispositions are below. Final regression and
checkpoint details are recorded in `../TEST-RESULTS.md`. Starting checkpoint: `902f30b` on
`feat/latch-native-transport`. Parent: `PHASE-3-COMPATIBILITY-PLAN.md`.

## Outcome and scope

An agent can capture complete evidence at declared sizes, distinguish a transport
limit from an application failure, and clean up its failed session without losing
a peer's session or existing website tabs. Supported artifacts need independently
checked content, not merely a successful command or an existing filename.

Use unmodified Playwright CLI 0.1.20 and official extension 0.4.0, Node 22.21.1 and
full Chrome for Testing 153.0.8010.12. Record actual versions and stop to classify
version drift rather than upgrading to conceal a failure. Reuse actual native
messaging, normal Latch attachment, separate disposable profiles/workspaces and
the documented official connection-page URL-delivery shim.

All browser tests stay **headless**, with mock-keychain flags and recorded launch
settings. There is no headed fallback. Work installation, permissions, pairing,
default transport and global security settings stay unchanged. No push is included.

Gate D's missing normal Playwright Download object and managed retrieval remain
explicit limitations. Gate E tests screenshots, snapshots, response bodies and
transport behavior; it does not introduce a download broker, arbitrary filesystem
reader, Browser/IO fallback, restart recovery or installation cutover.

## E0 — Map each boundary before changing limits

The following are source facts at the starting checkpoint, not measured capacity:

| Boundary | Current behavior | Required check |
| --- | --- | --- |
| Native relay WebSocket input | `maxPayload = 32 MiB`, compression disabled, applied to both authenticated roles | Actual serialized UTF-8 message bytes, not decoded PNG/body size; below/equal/above in each direction. |
| Relay and extension output | Stop/release when existing `bufferedAmount > 8 MiB`, checked before sending | A single send can overshoot the threshold. Measure pre/post-send backlog and message size; do not call this a strict 8 MiB memory cap. |
| Pending native browser calls | Maximum 64; the next call is rejected before dispatch | Accepted/rejected IDs, response settlement, cleanup and surviving peer. |
| Individual native browser call | 10-second timer; timeout stops its relay | Valid slow operation versus stuck operation; late response and lease teardown. |
| Latch `runCLI` wrapper | 2 MiB stdout bound, default 45-second process deadline | Complete JSON byte boundaries, multibyte/chunk behavior, error code and child cleanup. |
| Direct agent CLI use | Does not pass through `runCLI`; the shared test helper currently accumulates stdout | Use a bounded file sink for large results. Do not apply the wrapper's 2 MiB claim to direct CLI invocations. |
| Outer fixture command | 65-second deadline | Preserve the inner structured error before the harness deadline; avoid orphaned children. |
| Native/control framing | Native framed JSON maximum 1 MiB; local client response bound 1 MiB | Keep bulk evidence on the data/file path; validate small diagnostic summaries under load. |
| Existing trace facilities | Relay trace 4096 entries; protocol helper rejects raw logs above 64 MiB | Declare telemetry bounds and avoid recording large protocol bodies. |

Read `src/native-relay.mjs`, `extension/debugger-transport.js`, `src/playwright.mjs`,
`src/framing.mjs`, `src/local.mjs`, `src/native-host.mjs` and the fixture helpers
again during implementation. Identify the exact directional envelope at each hop:
CLI/client, relay, extension/debugger and output file. A response can be below one
limit and exceed another after base64, JSON escaping or tool-result wrapping.

Probe a small file first to establish what the pinned CLI actually saves and what
it returns. Establish screenshot/snapshot filename options and the run-code result
shape without assuming Node filesystem globals exist inside its VM. Determine
which layer truncates or summarizes snapshots, console output or response text.
An intentionally summarized command is not a complete large-artifact interface.

**E0 exit:** a route/limit ledger, measured small samples, supported output commands
and a list of demonstrated gaps. No limit changes until this ledger exists.

## Fixture and finite resource budget

Add `test/fixtures/evidence-app.mjs` and reuse the shared attachment fixture.
The app supplies a seed, actor, operation ID, independent manifest and bounded
server receipts. Both adapters receive the same seed and content at each size.

- **Pixels:** seeded high-entropy opaque canvas, no fonts, animations, scaling or
  timestamps. Fix viewport/DPR. Start with 512 × 1024 and 1024 × 1024; use at most
  2048 × 2048 when needed to reach the larger encoded cases. Measure PNG size;
  dimensions alone do not guarantee a payload size. Generate expected raw pixel
  bytes independently on the server/host and check decoded screenshot pixels.
- **DOM:** deterministic accessible rows with first/last sentinels, ordinal IDs
  and per-row seeded text. Bound generation at 20,000 rows and 16 MiB source text.
  Require the manifest's full row sequence/count in an output claimed complete;
  do not require byte-identical renderer formatting between adapters.
- **Bodies:** deterministic text with non-ASCII/escaping characters and seeded
  binary bytes. Serve 1, 4 and 16 MiB decoded bodies with exact length/SHA-256,
  no compression/cache reuse, and an actor-specific marker. Include an 11-second
  delayed response and an interrupted-body variant.
- **Events:** 512 numbered console messages, at most 256 UTF-8 bytes each, plus
  64 independently receipted requests with bodies at most 4 KiB. Emit in batches
  of 16, then stop. Record any client retention/truncation policy explicitly.

Real browser stress uses two named sessions in distinct workspaces and one
unclaimed outsider tab. Use at most eight concurrent application operations per
session; test the exact 64/65 native pending boundary in a controlled protocol
fixture so unrelated startup commands cannot change the count.

Generate one large case at a time. Limit an encoded CLI result to 64 MiB, a
fixture run's generated payload files to 128 MiB and evidence output to 256 MiB.
Validate repeated benchmark files before removing duplicate temporary copies;
retain their sizes/hashes/timings and selected representative artifacts. Do not
accumulate every large sample. Crossing a harness cap is a named fixture failure,
not a transport pass. These are initial test budgets, not promises of supported
product capacity.

Large stdout is streamed into an exclusive task-local temporary file with a byte
counter, finite deadline and bounded stderr. Parse after completion; publish an
artifact only after the expected wrapper/content/hash is verified. Failed output
stays clearly partial/unverified, never under a successful artifact name. A
standard direct CLI command redirected to a file is distinct from `runCLI`.

Prefer existing screenshot/snapshot file output. For response bodies, first test
standard Playwright Response APIs and direct CLI JSON redirected to a task file;
inspect/decode the returned base64 outside the VM without printing it to the chat.
A completed HTTP response and a saved body are separate observations. If the
pinned command cannot expose complete bytes, classify the limitation. Repair a
baseline-supported native gap; do not replace it with a fixture-server copy and
claim browser capture. Any new production artifact helper needs a separate,
explicitly scoped design in this plan before implementation.

Do not enable raw `DEBUG=pw:protocol` logs for large runs by default. Add bounded
metadata instrumentation where needed: direction, method, serialized byte count,
duration, pending/backlog high-water marks and stop reason. Never retain bodies,
connection tokens or endpoint credentials. Official code stays unmodified; mark
wire measurements unavailable where not observable, rather than calling an
estimate a measurement. Exact native wire boundaries get a separate protocol test.

## Acceptance matrix

All rows start unverified. Functional rows run official first, then native with
identical content/focus policy. Native protocol/resource rows are native-specific
and must not be presented as full browser parity.

| ID | Case | Required proof |
| --- | --- | --- |
| A1 | Small screenshot/snapshot/body controls | Establish supported command, output path, result shape and independent content oracle. |
| A2 | High-entropy screenshot above 1 MiB, then larger sample | Decode PNG; dimensions and expected pixel content match; record PNG/base64/wire/output sizes where observable. File existence is insufficient. |
| A3 | Large snapshot around 1 and 4 MiB of serialized content | Full expected row sequence/count and both sentinels; report any built-in summary or truncation rather than claiming completeness. |
| A4 | Text and binary response bodies at 1, 4 and 16 MiB decoded | Server manifest, received body length and saved artifact SHA-256 agree; non-ASCII/JSON/base64 expansion is measured. |
| A5 | Interrupted body/output | No completed artifact claim from partial bytes, a process exit or HTTP headers alone; retain a specific error/unknown disposition. |
| W1 | Native WebSocket limits in both input roles | Valid JSON at limit − 1, limit, limit + 1 bytes; under/equal accepted, over rejected or closed according to documented policy. Count the whole envelope. |
| W2 | Fragmentation and escaping | Fragment a valid maximum message and test multibyte/escaped strings; no per-frame bypass or character-count mistake. |
| O1 | Wrapper stdout boundary | Valid JSON at 2 MiB − 1, equal, + 1; ASCII/multibyte/chunk variants. Accepted results parse fully; over-limit returns CLI_OUTPUT_LARGE and settles/reaps the child. |
| O2 | Direct CLI file output | Large complete file can be saved without placing the body in the Latch control response; differentiate this from the wrapper and its stdout limit. |
| Q1 | Pending calls 64 versus 65 | Controlled held replies; 65th is rejected before browser dispatch. Release/cancel accepted calls; all promises settle and pending returns to zero. |
| Q2 | Slow consumer in each direction | Deterministic pre-send queue arithmetic tests plus an actual paused-reader socket stress test. Record threshold, single-frame overshoot, peak backlog and affected-session result. |
| Q3 | Bounded console/network burst | Compare sequence/count/retention with server truth. No silently incomplete artifact; other commands and diagnostics settle after the burst. |
| T1 | Legitimate 11-second awaited response | Compare official/native. Establish whether the current 10-second inner timer interrupts a valid operation and classify it as a native timeout gap if the baseline supports it. |
| T2 | Deliberately stuck command | Bounded failure with method/layer/reason; settle pending work, close the affected endpoint and preserve user tabs. No automatic mutation replay. |
| T3 | Outer CLI deadline and late reply | Wrapper emits its timeout before the fixture kills it; late messages cannot resurrect a retired command/session or be delivered to a new task. |
| I1 | One stressed/failed agent plus healthy peer | Peer actor/action/screenshot/body checks continue during and after overflow, queue failure and timeout. No foreign artifact markers or ownership changes. |
| I2 | Disconnect with pending/queued work | Idempotent scoped cleanup; no pending promises, active endpoint or owned target remains for that lease. Peer and outsider remain usable/unclaimed. |
| P1 | Performance cohort | One warm-up plus five measured official/native pairs for attach, representative snapshot and screenshot; median/range, byte sizes, versions and focus/launch policy. |
| P2 | Resource cohort | Exact fixture process identities; RSS/CPU observations and pending/socket/listener counts before, peak and after five attach/evidence/disconnect cycles. No unresolved retained-session growth. |

Native exact-wire tests use authenticated synthetic peers to create exact sizes
and slow consumers without enormous page scripts. Label these protocol tests.
Browser cases must still traverse the real CLI, extension, debugger and native
messaging bootstrap; synthetic-peer passes cannot substitute for them.

## E1 — Establish artifact integrity and supported sizes

Run A1 first, then A2–A5/O2 with ordinary commands and file outputs. Keep raw,
base64, JSON and stdout sizes as separate fields. Hash comparisons use an
independent server/host manifest. A screenshot PNG hash alone proves only the file
was read; decoding/pixel comparison establishes its content. Snapshot integrity
uses semantic markers/count/order rather than rendering-format equality.

Start below each route's current bound. Grow to the planned sample sizes without
replaying a timed-out mutation. An unsupported 16 MiB case is a declared limit,
not permission to raise every buffer. Investigate official failures as fixture or
baseline behavior first. A native-only failure of an otherwise supported case
must be repaired or left explicitly unresolved; matching failures are not parity.

**E1 exit:** a supported-size matrix for screenshot, snapshot, body and output
route, with complete artifacts at every claimed size and explicit remaining limits.

## E2 — Enforce queue, pending and wire bounds

Implement W1/W2/O1/Q1 at controlled boundaries and Q2/Q3 through real sessions.
For the queue guard, explicitly choose and test one policy: a strict admission
budget that accounts for the next serialized message, or a backlog threshold with
a finite documented single-message allowance. Either way, specify maximum message
and queued bytes together. A strict 8 MiB policy would conflict with a larger
legitimate evidence message unless the routing/design changes; do not silently
break supported artifact sizes to make a queue assertion pass.

Use a real paused consumer with a finite watchdog and output budget; report
observed kernel/library behavior without relying on exact OS socket-buffer sizes.
Deterministic arithmetic tests prove inclusive/exclusive guard semantics; the
socket test proves bounded settlement and cleanup. Assert stop/reject behavior,
not an exact number of sends before OS backpressure appears.

Any limit/code change needs a reason tied to an observed bottleneck, a finite
replacement bound and negative tests at the new boundary. Reject malformed or
oversized messages predictably. Diagnostic errors stay small and credential-free.
Preserve authentication, target lifetimes, retired-response handling and the
separation between native control messages and bulk WebSocket data/files.

**E2 exit:** boundary semantics are declared and tested; oversize/slow-consumer
failures terminate or reject only their own work and leave no hanging resources.

## E3 — Define deadlines and verify peer survival

Run T1 before proposing a deadline increase. Record the browser operation's own
timeout, native command timer, wrapper deadline, local/control socket deadlines
and outer fixture timer. Distinguish actual elapsed time from configured timeouts.

If T1 demonstrates a native gap, define a finite, validated command-deadline
policy. Existing authenticated clients must not gain an arbitrary unbounded
request timeout. Keep short defaults for ordinary commands; any longer wait needs
an explicit bounded classification/configuration and an outer deadline that can
receive its structured result. Inventory every caller affected by a changed
inner deadline, including local native-host sockets and CLI subprocess cleanup.

Verify that killing a timed-out CLI subprocess is not mistaken for cancelling
the daemon/browser action. Observe final action state and session health; report
unknown mutation outcomes without retrying them. Releasing/reconnecting a failed
fixture session is explicit cleanup/recovery, not a passing continuation of it.
General browser/host restart recovery remains Phase 4.

Run I1/I2 for each failure class: oversized message, backlog exhaustion, pending
limit and stuck-command timeout. Establish waiters before triggers and poll
explicit barriers/events instead of using arbitrary sleeps. Assert each command
settles, pending becomes zero, the failed endpoint is revoked when required,
physical tabs remain, and the peer can perform a fresh actor-specific check.

**E3 exit:** deadlines have a coherent finite contract, legitimate supported waits
work, and failure/cleanup does not cross agent ownership boundaries.

## E4 — Measure performance without confusing setup with runtime

Use stable initialized fixture browsers; exclude official one-time authorization
and fixture provisioning from attach latency. Measure normal helper connect and
explicit disconnect separately. Alternate adapter order across the five measured
pairs. Record cold/warm daemon/session state, artifact sizes, machine/CPU/OS and
exact versions. Run the measured cohort without concurrent stress suites.

Collect one warm-up per adapter, then five paired samples for attach, a fixed
representative snapshot and a high-entropy screenshot. Report median and min/max,
all samples and failures; do not discard slow samples. These small cohorts are
comparisons, not a production throughput/SLA claim.

Sample only identified fixture browser/renderer, native-host, relay and CLI/daemon
processes, including recorded detached daemon PIDs. Do not aggregate the user's
Chrome. RSS sums may double-count shared pages; label the measurement accordingly.
Record warm baseline, peak and a fixed five-second post-cleanup observation for
five cycles. Also assert deterministic counts: zero owned pending calls/relays,
revoked endpoints and no monotonically retained session/socket/listener resources.

Investigate a native median over 2× official or final RSS growth above the larger
of 64 MiB and 25% of warm baseline. After investigating noise/setup, run at most
one fresh confirmation cohort. Persistent unexplained growth or a reproducible
native bottleneck remains unresolved, rather than being averaged away or called
unlimited capacity. Record measured costs and scope any supported-size claims.

**E4 exit:** reproducible samples, explained performance differences, and no
unresolved resource leak from the measured workflow.

## E5 — Regression, evidence and local checkpoint

Proposed implementation files; add commands only once their suites exist:

| File / command | Responsibility |
| --- | --- |
| `test/fixtures/evidence-app.mjs` | Deterministic pixels/DOM/bodies, bounded events, gates and independent manifests. |
| `test/helpers/evidence-capture.mjs` | Bounded CLI file sink, artifact validation and sanitized size/timing metadata. |
| `test/evidence-compat.test.mjs` / `npm run test:evidence` | Official/native functional artifacts and delayed-body baseline. |
| `test/evidence-isolation.test.mjs` / `npm run test:evidence-isolation` | Real native two-agent stress, failure and cleanup. |
| `test/evidence-performance.test.mjs` / `npm run test:evidence-performance` | Opt-in serial performance/resource cohort. |
| Focused relay/debugger/wrapper tests | Exact native sizes, pending/queue guards, chunking, errors and deadlines; default browser-independent coverage. |
| Existing transport modules | Only demonstrated runtime gaps; no unrelated ownership or permission expansion. |

Run default checks and all new suites. Rerun the affected existing headless
attachment, official multi-agent, native workflow, popup, frame/worker and file
suites against the final runtime/helper changes. Keep version pins. Count opt-in
skips separately; only actual explicit runs establish browser support. Stop only
fixture-owned processes and verify no owned browser, socket or registration is
left. Capture a read-only Work diagnostic at the end; do not repair it as part of E.

Each case records outcome/classification, adapter, versions/settings, seed/actor,
operation/target, expected/observed bytes/hash or marker counts, raw/base64/JSON
sizes, saved path/status, elapsed/deadline values, high-water metrics, error/stop
reason, peer result and cleanup. Publish a readable support matrix, selected
artifacts, validation logs, performance samples and SHA-256 manifest under the
chat's `outputs/latch-gate-e/`. Keep bulk fixtures, failed partials, profiles,
raw credentials and any private logs in ignored `work/` directories.

Update README, TEST-RESULTS, Phase 3 status and shared skill only with measured
support and actual command examples. Validate the skill if changed. Save a local
Git checkpoint after verification; do not push or change the installed extension.

## Completion rule and execution order

Execute **E0 → E1 → E2 → E3 → E4 → E5**. Earlier stages expose the route and
bottleneck before later stages change limits or interpret benchmark results.

Gate E completes when every matrix row has a verified disposition, supported
sizes yield complete artifacts, oversize/backpressure/deadline failures stay
bounded and preserve peers, and performance/resource findings are accounted for.
A baseline-supported native correctness gap, silently truncated artifact,
unsettled command or unexplained retained-session leak prevents completion.
Shared baseline limitations remain limitations, not successful capabilities.

Finishing E completes Phase 3 only within its declared support matrix. Restart
recovery (Phase 4), extension/installation cutover (Phase 5) and actual Work native
rollout (Phase 6) retain their own acceptance gates.


## Execution dispositions — October 29, 2026

| IDs | Final disposition |
| --- | --- |
| A1–A2 | Compatible: 64×64 control and high-entropy 512×1024, 1024×1024, 2048×2048 screenshots decode to the independently generated pixels. Largest PNG 12,623,891 bytes; matching PNG hashes across adapters. |
| A3 | Compatible: every row and both sentinels retained in approximately 1.17 MB / 4.70 MB snapshots (1024/4096 rows). Volatile reference IDs are excluded from the semantic oracle. |
| A4 | Compatible at 1/4 MiB text and binary. Both 16 MiB variants are unavailable from the inspector cache in both adapters; explicit standard Response.body diagnostics report eviction. They are unsupported captures, not complete artifacts. |
| A5 | Interrupted fixture body returns a failed fetch and no completed artifact. The bounded output sink also rejects/reaps an over-limit producer and leaves only an explicitly partial file. |
| W1–W2 | Actual authenticated native sockets accept complete 32 MiB − 1 and equal messages in both roles, including fragmented text split inside UTF-8 characters. 32 MiB + 1 closes the affected relay. Serialized envelope bytes are counted. |
| O1 | Raw-byte wrapper boundaries pass below/equal/above 2 MiB for ASCII and split UTF-8 chunks. TERM-resistant subprocesses are forcibly reaped before timeout returns. |
| O2 | Normal screenshot/snapshot/response-body filename options return small metadata. A direct CLI result above 2 MiB is also streamed to a file and verified; it does not use the Latch wrapper collector. |
| Q1 | Synthetic protocol and real-browser 64/65 debugger-await cases reject the extra call before dispatch and settle all 64 accepted calls. The real case gates one application fetch, rather than saturating shared HTTP connections. |
| Q2 | Both relay/extension guards use the same finite message/backlog policy. Actual paused WebSocket readers exhaust each direction, stop their own relay and leave a peer relay responsive. These are labeled protocol tests with synthetic authenticated peers, not browser attachment substitutes. |
| Q3 | Actual pre-established browser listener receives 512 unique events and 64 requests match server receipts. The pinned CLI console history is capped at 200, trimmed in batches; 192 fixture messages remained when queried. History is explicitly partial. |
| T1 | Original native 10-second timeout failed the valid 11-second fetch; official succeeded. Both now complete and report the expected 1024 received bytes with the bounded 30-second awaited-evaluation policy. |
| T2 | A real stuck awaited evaluation stops at approximately 30 seconds; status records method/deadline, pending becomes zero, and its endpoint/claims are revoked. Peer checks continue. |
| T3 | Wrapper timeout has bounded TERM/KILL cleanup and reports potentially unknown browser outcome. Existing retired-child late-response regression passes; stopped relays revoke credentials rather than reassigning a late response to a new lease. |
| I1–I2 | Real native peers survive pending-limit rejection, oversized result, command timeout and disconnect with four pending evaluations. Slow-consumer peer coverage uses actual sockets in the protocol suite. All fixture website tabs are preserved and ownership stays scoped. |
| P1 | One warm-up/five alternating measured pairs plus one retained confirmation cohort to explicitly align foreground conditions and the final file sink. Confirmation samples start with the target active and record visible/focused pages. All samples remain available; no slow samples discarded. |
| P2 | RSS/CPU observations use exact fixture browser descendants and private-daemon descriptors. A separate five-cycle native-host audit returns from three TCP sockets/one listener to zero each time, with no remaining sessions/pending work. RSS is a sum that may double-count shared pages, not a long-run leak or SLA proof. |

The selected policy preserves an **8 MiB existing-backlog threshold plus one
32 MiB message**, not a strict 8 MiB total queue. Admission is bounded to 40 MiB
application bytes before another send is rejected; framing/kernel/object memory
are separate. Both senders reject oversized serialized messages before dispatch.
Browser JavaScript closes use application code 4009 with a fixed reason; the real
browser test caught and corrected an initially browser-invalid close code.

Awaited Runtime.evaluate/callFunctionOn calls get a finite 30 seconds; ordinary
calls retain 10. No arbitrary client-selected transport timeout or global timer
increase was added. The wrapper remains 45 seconds plus at most one second of
forced-exit cleanup; outer fixtures remain 65 seconds. Wrapper termination is not
proof that a daemon/browser mutation was cancelled.

Large evidence uses the pinned CLI's existing filename interfaces. No production
artifact broker or download functionality was added. Native metadata counters
record sizes, pending/backlog high-water values, timeout method and resource state
without storing payloads or credentials. Output capture counts bytes before UTF-8
decoding, verifies every received byte was written and keeps failed output partial.
All measured fixture evidence remains inside the stated output/payload budgets.

The route probe, first UTF-8 failure, inspector-cache failures, initial overflow
close-code failure and exploratory performance cohort are retained under ignored
work paths and represented in curated evidence. These are not clean first-run
claims. See `GATE-E-ROUTE-LEDGER.md` for the starting observations and repair ledger.
Work installation/default transport/security settings remain unchanged; recovery
and actual native Work rollout retain their separate phases.
