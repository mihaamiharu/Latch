# Gate D: uploads, downloads and evidence retrieval

Prepared October 28, 2026; execution continued October 29 (Asia/Jakarta).
Status: implemented; final results are recorded in `../TEST-RESULTS.md`.
Starting checkpoint: `be00dca` on
`feat/latch-native-transport`. Parent roadmap: `PHASE-3-COMPATIBILITY-PLAN.md`.

## Outcome and scope

A terminal agent can upload the intended task files into an owned page with
verified bytes. Download support is reported as separate capabilities: the browser
receives a file, Playwright exposes its lifecycle, and the agent retrieves that
exact completed file into its task evidence directory. Each claim needs its own
evidence; none is inferred from a successful click or a visible filename.

Use unmodified Playwright CLI and standard file-input, chooser and Download APIs
first. Repair demonstrated native gaps before inventing a file bridge. Keep all
browser tests headless with full Chrome for Testing, disposable profiles, real
native messaging and the existing documented official URL-delivery shim. Retain
mock-keychain flags. No headed fallback, system Downloads-folder use, Work-profile
installation, global security change or push is included.

Pin the Gate C versions: Node 22.21.1, CLI 0.1.20, Chrome for Testing 153.0.8010.12
and official extension 0.4.0. Record actual versions and stop to classify drift;
do not upgrade a dependency to hide a failure. Gate E retains large-payload,
backpressure and performance work. Directory uploads, native OS picker automation,
remote-browser file transfer and browser/host restart recovery are outside D.

## Starting facts and unknowns

- Installed CLI help confirms `upload <files...>` accepts absolute file paths.
  Its interaction with a pending chooser still needs a baseline test.
- The pinned Playwright implementation routes local file-input paths through
  `DOM.setFileInputFiles`. Native mode permits the DOM domain, but that alone does
  not prove Chrome's debugger transport accepts the operation or preserves bytes.
- Native and pinned official relays currently acknowledge
  `Browser.setDownloadBehavior` without implementing managed configuration.
  Native has no Browser download-event/cancellation implementation and does not
  permit arbitrary IO-domain forwarding. Do not advertise these as working APIs.
- Standard Playwright documents waiting for a download before the action and
  saving it through `Download.saveAs`. Launched-browser examples do not prove
  that the existing-tab attachment adapters support that lifecycle.
- Chrome's downloads API needs a downloads permission. A permission alone does
  not establish initiating-tab identity, safe retrieval or multi-agent attribution.

References: [Playwright uploads](https://playwright.dev/docs/input#upload-files),
[downloads](https://playwright.dev/docs/downloads), and
[Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).

## D0 — Build the fixture and establish capabilities

Add `test/fixtures/file-app.mjs` and reuse the attachment fixture. Extend its launch
setup to configure a private browser download inbox **before** either authorization
setup or runtime Chrome starts. Preserve other disposable-profile preferences.
Both adapters use the same settings, and the test verifies that files land there.
If the inbox cannot be established, stop that download case before triggering it;
never let it fall back to the user's Downloads directory.

Use this layout inside each private fixture:

```text
inputs/<agent>/          Generated, immutable upload sources
browser-inbox/          Browser-owned receipts; observer access only
<workspace>/evidence/   Files actually saved by the agent workflow
evidence/               Assertions, receipts, hashes and sanitized traces
```

Generate deterministic UTF-8 text, an empty file, a binary fixture containing NUL
and high-byte values, and filenames with spaces/Unicode. Include two agents' files
with the same basename and different bytes. Start with small fixtures up to
256 KiB each and at most 1 MiB total per case; these are test-corpus bounds, not
advertised production size limits.

The local fixture provides real file-input and custom-chooser controls, a real
multipart upload receiver, same-origin/cross-site iframe controls and an owned
popup flow. The server parses actual uploaded files and records actor, operation,
filename, MIME type, byte count and SHA-256. Browser-provided checksums alone do
not establish upload success. The implemented receiver bounds the streamed request before parsing with Node's
built-in multipart parser (1 MiB + 64 KiB request, eight files, 256 KiB/file).
It buffers only that bounded body and adds no parser dependency.

Download responses provide known bytes and Content-Disposition metadata, plus
redirect, slow-stream, interrupted-response and repeated-name variants. The server
records independent operation receipts and response hashes. It can identify
fixture truth without modifying real application URLs or adding authorization
tokens. Include a concurrent endpoint with the same URL and suggested filename
for both agents but different response bytes, associated server-side with the
fixture actor. The agent must not use that observer bookkeeping as its ownership
mechanism.

Probe official first, then native, using identical actions and headless policy.
Record file-input/chooser behavior, upload protocol methods, download-event
availability, completion/failure reporting, browser receipt, saveAs/path behavior
and cancellation separately. No browser configuration acknowledgement is a pass.

**D0 exit:** a capability matrix backed by actual bytes and lifecycle observations.
Baseline failures are investigated before being classified as upstream limits.

## Acceptance matrix

The following matrix defines acceptance; execution dispositions follow below.
Run functional rows against both adapters and native
ownership negatives at both transport boundaries where the capability exists.

| ID | Scenario | Required proof |
| --- | --- | --- |
| U1 | Single local text file | Input API succeeds and server receives exact filename, length and SHA-256. |
| U2 | Multiple files, including duplicate basenames | Exact count and per-file hashes; preserve application ordering where its contract requires it. |
| U3 | Empty/binary/space/Unicode cases | Exact bytes and decoded names; no text/base64 conversion damage. |
| U4 | Custom chooser using CLI upload | Establish the chooser before setting files; no native OS dialog interaction. |
| U5 | Same-origin and actual OOPIF input/chooser | Operate through the correct FrameLocator/chooser and verify server actor/frame markers. |
| U6 | Missing file, replaced input and detached frame | Clear failure; no wrong-frame upload or accidental successful submission. |
| U7 | Clear selection and reselect | Application sees the expected selection and receiver gets only the submitted files. |
| B1 | Basic attachment download | Completed bytes arrive in the configured private inbox and match server hash. |
| B2 | Redirected download | Follow actual response/lifecycle; final bytes and filename match independently. |
| B3 | Repeated suggested filename | Both completed files retain their bytes; no overwrite or latest-file guessing. |
| B4 | Slow, cancelled or interrupted transfer | Report completed, cancelled, failed or unobservable precisely; partial bytes are not a completed artifact. |
| R1 | Standard Playwright retrieval | Save the exact Download object through saveAs; the saved task artifact matches its expected bytes. |
| R2 | Unsupported retrieval | Report an explicit limitation; a harness-read inbox path is not returned as agent success. |
| I1 | Two agents, same upload basename and download URL/name | Receiver and artifact hashes remain with the correct actor and lease. |
| I2 | Frame/popup-originated download and ownership retirement | Bind the initiating owned target; handle close/release without reassignment to another agent. |
| P1 | Conditional retrieval broker boundaries | Unknown/foreign/retired handles, partial files and destination escape/overwrite attempts fail before copying. |

Directory pickers and drag/drop-specific widgets may be added later as separate
capabilities. Do not substitute a synthetic File/DOM injection and label it as a
passing native file-input or chooser operation.

## D1 — Upload compatibility first

Exercise `locator.setInputFiles`, pending file-chooser APIs and CLI upload as
distinct entry points supported by the pinned client. Inspect its actual run-code
environment; do not assume Node globals such as Buffer or filesystem imports are
available there. Keep input fixtures under the calling task's workspace.

For every failure, retain the relevant method/error and independent receiver
state. If official passes and native fails, repair only the demonstrated path:
likely file-input DOM commands, chooser events or routing to a child target.
Preserve Gate C lifetime checks. Add a regression for a replaced/detached input
and a cross-lease target rejection before execution.

Normal Playwright local-file access retains its existing permission semantics.
Latch ownership is not a filesystem sandbox between programs of the same OS user.
The concurrent test proves correct intended file/target selection, not isolation
of arbitrary local files from a privileged agent.

**D1 exit:** baseline-supported upload paths preserve server-verified bytes and
leave the parent/peer usable after a rejected operation.

## D2 — Browser download receipt and lifecycle

First prove browser receipt independently, including cases where the standard
Download event or artifact API is missing. The fixture observer may inspect its
private inbox and compare hashes, but that proves B1–B4 only. Keep observer access
separate from the commands used by the agent under test.

Then establish which real events identify the initiating target and download
lifetime. Test root, owned popup and iframe initiation. Carry trusted target/frame
ancestry and an authoritative download identifier, rather than assigning a file
from URL, timing, filename, active tab or directory order.

Maintain explicit lifecycle states such as observed, in-progress, completed,
cancelled, failed and unknown. Test cancellation only through a verified supported
API. A fixture-interrupted HTTP response is a transfer failure, not proof that
browser download cancellation works.

**D2 exit:** receipt and lifecycle results are independently classified. Where the
adapter cannot expose the lifecycle, report that limitation even if bytes arrived.

## D3 — Agent retrieval decision

Prefer ordinary Download objects and saveAs if the baseline supports them. Confirm
the artifact saved by that operation, not only the browser inbox. Never manufacture
a Download object or file path to make an unsupported adapter appear compatible.

Use this decision order:

1. If both adapters support standard retrieval, keep that interface.
2. If official supports it and native does not, fix the scoped native gap and
   rerun the affected ownership/lifecycle cases.
3. If neither supports it, record the shared limitation. Consider a separate
   Latch retrieval helper only if actual browser metadata can bind an exact
   completed file to a lease. Label that helper distinctly from Playwright saveAs.
4. If reliable attribution is unavailable, retrieval stays unsupported. Do not
   export a guessed path or pick a file from a broad downloads search.

A conditional broker design must bind an opaque file handle to the browser
instance/epoch, workspace/session, initiating owned target lifetime, authoritative
download identity, completion state and known source file. Resolve an output
inside the explicitly chosen task evidence root, treat suggested names as metadata,
avoid symlink/path traversal escapes and refuse silent overwrite. Return saved
path, original suggested filename, byte count and SHA-256 only after the copy is
complete. Do not introduce an arbitrary read-any-path endpoint.

This is a same-Mac workflow. A local copy may avoid transferring file bodies
through the protocol entirely. If transfer is required, use the bounded data
channel; never carry file bodies in native control messages or CLI stdout.
Declare finite size, concurrency, handle-retention and cleanup bounds before
implementing that branch. Gate E remains responsible for expanding/measuring
large-file capacity rather than raising every transport limit during D.

If a downloads permission appears necessary, document the concrete missing
capability and attribution design first. Validate it only in a disposable test
manifest. A profile-wide download list without initiating-target identity is not
sufficient justification. Work permission grants remain a later rollout action.
No global Browser/IO command forwarding is added as an automatic fallback.

On tab/lease retirement, revoke new broker file operations for its handles and
do not reassign a continuing browser download. Disconnect preserves existing
website tabs and does not generically cancel/delete user downloads. Task artifacts
already saved remain usable. Finish required retrieval before normal disconnect;
browser/host restart recovery is not implemented here.

**D3 exit:** either proven exact-file retrieval with a stated interface and bounds,
or an explicit unsupported result backed by the baseline. A baseline-supported
native regression cannot be dismissed as an accepted shared limitation.

## D4 — Regression, evidence and checkpoint

Planned test files: `test/fixtures/file-app.mjs`,
`test/file-transfer-compat.test.mjs`, `test/file-transfer-isolation.test.mjs` and
focused native file-routing tests if runtime code changes. Planned opt-in commands
are `npm run test:files` and `npm run test:file-isolation`; add scripts only when
the suites exist. Reuse the headless attachment helper and keep default tests
browser-independent.

Each result records adapter/version/settings, API used, actor/operation/target,
expected and observed filename/bytes/hash, lifecycle, browser receipt, agent
artifact, limitations and cleanup. Retain separate input manifests, server upload
receipts, observer download receipts and agent-save receipts. Publish curated
small fixture files and sanitized method/event traces, never raw daemon logs,
tokens or unrelated local files. Preserve evidence before disconnect/teardown.

Run the default suite plus the two new suites. Rerun affected attachment, popup,
frame/worker and multi-agent suites once against final runtime changes. Split
cases within existing deadlines; a timed-out upload/click/download is not safely
replayed automatically. Verify cleanup and no remaining owned fixture browser.
Run a read-only Work diagnostic without repairing its previously absent socket
or conflating it with fixture test outcomes.

Update README, TEST-RESULTS, the Phase 3 matrix and canonical shared skill with
only verified behavior. Save a readable report and selected evidence under this
chat's `outputs/latch-gate-d/`, and save a local Git checkpoint after validation.
Do not push or upgrade the installed Work extension.

## Completion rule

Gate D completes when baseline-supported uploads preserve actual received bytes;
browser receipt, download lifecycle and agent retrieval have distinct outcomes;
supported file operations retain correct ownership under concurrency and
retirement; and unsupported retrieval fails clearly instead of guessing.

Every required row has an explicit disposition. A browser-received file alone is
not a managed-evidence pass. Large payloads/performance, restart recovery and Work
rollout remain open. Implementation order: D0 baseline, D1 uploads, D2 receipt and
lifecycle, D3 retrieval decision, D4 regression/evidence/checkpoint.


## Gate D execution dispositions — October 29, 2026

| IDs | Disposition |
| --- | --- |
| U1–U3 | Compatible: server-parsed filenames, counts, byte lengths and SHA-256 match local text, empty, Unicode and binary sources, including duplicate basenames. |
| U4–U5 | Compatible: normal input APIs and CLI pending chooser (`FileChooser.setFiles`) work in roots, same-origin frames and actual cross-site OOPIFs. |
| U6 | Missing paths and retired frames fail. A replaced input's old detached handle can accept files in both adapters; it cannot populate the new empty input or submit a request. This baseline behavior is an explicit adjustment to the planned universal stale-input rejection. Frame negatives wait for the actual detach event before attempting the old handle. |
| U7 | Compatible: clearing uploads zero files; reselecting submits only the selected file. |
| B1–B3 | Compatible browser receipt: basic, redirect and repeated-name files retain independently verified bytes in a private preconfigured inbox. |
| B4 | Slow transfer completes with matching bytes. An interrupted HTTP response yields no complete matching artifact. Low-level page events establish completed transfers; the server interruption alone does not establish a terminal browser state. API cancellation remains unavailable; server interruption is not its substitute. |
| R1–R2 | Unsupported in both pinned adapters: the normal Playwright Download event/object is absent. Consequently saveAs/path/cancel cannot be used through that object. No guessed task artifact or successful retrieval is returned. |
| I1 | Native concurrent same-basename uploads reach the intended actors with distinct source hashes. Same-URL/same-suggested-name downloads retain both exact byte sets as browser receipts. That observer result is not managed download attribution. |
| I2 | Frame and attributed-popup download receipt is exercised. Native exact-target popup selection/upload and release during an active slow transfer preserve the popup tab and peer session; foreign/retired targets and detached frame inputs are rejected. |
| P1 | Not applicable: no retrieval broker or downloads permission was added. |

`Page.downloadWillBegin` supplies frame/GUID metadata and `Page.downloadProgress`
supplies low-level states. Neither supplies the exact filesystem path in this
baseline. Chromium's default download names may differ when filenames collide.
These page events are not the root Browser events used by the pinned client's
normal Download implementation. A GUID alone does not justify copying a file
from an inbox. Native mode now rejects managed `Browser.setDownloadBehavior`
explicitly instead of acknowledging a no-op; cancellation remains unsupported.

Two agents' concurrent download triggers use scoped fixture DOM form controls,
while uploads use actual file APIs and receiver bytes. Frame download receipt uses
foreground pointer input. Fixture popup/removal/replacement controls use scoped
DOM triggers. These headless tests do not claim universal background pointer or
headed focus parity. Initial pointer-based concurrent probes submitted no request;
a DOM-triggered cross-site frame request reached the server without a completed
browser file. The final foreground-frame variant is reported separately.

Test profiles, registrations, browser inboxes and native sockets are disposable.
The observer inbox is never an agent-save path. Screenshots/snapshots remain
ordinary evidence artifacts. Native control messages and CLI stdout carry file
metadata, not file bodies. The retained corpus bounds are not production size
limits; Gate E remains open. Work installation, default transport and global
security settings remain unchanged. No push is part of this checkpoint.
