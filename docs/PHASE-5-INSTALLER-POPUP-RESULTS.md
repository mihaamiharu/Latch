# Phase 5 local candidate: installer, popup and shared skill

Prepared October 29, 2026. Starting checkpoint `8eb9137`. The local candidate is
**0.2.0-rc.1**, Chrome version **0.1.99.1**, schema **4**, UI control **1**.
Work remains on installed 0.1.2 and the official daily transport. No push,
registration change, profile reload, global skill migration or security-setting
change was performed against the user's installation.

Implementation is ready for review, with a remaining rollout gate: **a real
permission-increase update that preserves open tabs is unverified**. Headless
fixtures proved clean installation and retained actual-0.1.2 rollback using an
explicit browser restart. They did not establish live reload or tab retention
across that restart. Actual human acceptance and terminal-client rollout remain
Phase 6 steps; this is not a claim that every original acceptance row is complete.

## Delivered behavior

Build validates the fixed public identity, required debugger/alarms permission,
relative module/asset inventory, pinned dependency/licenses and reproducible
archives. The complete kit runs from its own installed release directory; Node
22.21.1 and Playwright CLI 0.1.20 remain external validated prerequisites. It does
not ship the official extension, browser fixtures, local profiles or test hooks.
Build changes no installed registration or source launcher.

Setup provides inspect, stage, activate, verify, managed skills, rollback and
uninstall. A dedicated owned runtime contains complete release directories, a
`current` host/CLI selector and a stable physical `extension/` directory. Exact
registration evidence permits migration from the old checkout path. Plan tokens,
maintenance attestations, unreachable-bridge checks and an exclusive transaction
gate prevent accidental concurrent activation. Flags attest operator maintenance;
they are not automatic proof that Chrome unloaded the extension.

Caught failures restore prior owned state. An actual SIGKILL fixture leaves a
journal/gate that subsequent setup inspects and refuses to reclaim by PID/age.
Repeated activation retains the original rollback payload. Actual 0.1.2 rollback
runs old host/CLI code through stable launchers, restores migrated legacy skill
links and preserves new journals/evidence. It does not change registration back
to the original checkout path. Uninstall removes owned integration while retaining
data. Interrupted-machine repair remains outside scope.

The popup shows this exact profile's pairing, readiness, session/workspace labels,
controlled tab titles/origins and connection details. Only its own extension page
can use the bounded negotiated status/revoke RPC. Metadata is escaped, shortened
and excludes URL query strings and relay credentials. Status does not attach tabs.
Native Stop session uses the existing host coordinator, current lease/revision
and generation. Busy/stale requests cannot bypass a grant or revoke a successor.
Host shutdown fences UI grants and drains their journal work before relinquishing
the socket. In-flight application outcomes remain unknown; actions are not replayed.

Real popup-page tests revoked A during a held application request after one server
mutation receipt. B remained usable; website tabs and ownership boundaries were
preserved. Access stopped with unconfirmed CLI cleanup was separately exercised
using an explicit private host fault, not a fabricated OS failure. Explicit Retry
restored readiness after real bounded degradation without resuming automation.

The one canonical skill is packaged with the kit. Managed discovery links select
its active runtime through `current`; the wrapper preserves cwd, arguments,
configuration and `LATCH_HOME`. Private link/wrapper tests and skill validation
passed. Actual Codex/Claude/Cursor runs are not inferred from those tests.

## Upgrade observations and limits

Experiments retained the real 0.1.2 payload from
`ad4819827f0fc994a1df39aed930a2bab8f44972` and the fixed extension key. A stable
physical-directory replacement plus fixture browser restart/enable preserved
stored extension instance, pairing bytes and persistent fixture cookie/storage
state. Old official attachment and subsequent candidate reactivation succeeded.

Symlink switching, disable/enable alone and an explicit private extension-page
reload did not establish reliable live code readiness. Earlier attempts failed;
they remain in the local diagnostic logs. A test that initially selected a tab
using its removed hash was corrected to use the server's fresh seed record after
restart. No claim is made that restarting retained the same physical website tabs,
or that developer-mode fixture enable accepted a real permission-increase dialog.

[SETUP.md](../SETUP.md) documents the concrete conservative maintenance/restart
procedure. For Work, first establish Chrome permission acceptance and retention
of the intended tabs/state during the one-time update. Stop if these cannot be
proven. Normal daily native attachment still needs no browser restart, desktop
control, manual tab dragging or remote-debugging launch flags.

## Acceptance dispositions

| ID | Disposition and evidence scope |
| --- | --- |
| A1 | Pass: fixed identity/version, permissions, full hashed module/assets inventory; missing identity and tampering rejected. |
| A2 | Pass: actual installed kit host/CLI, no source-checkout runtime paths, bundled ws/licenses, explicit external prerequisites. This is path/runtime proof, not an OS-denied-checkout experiment. |
| A3 | Pass: two-build ZIP hashes match, inventory scanned, source manifest/installed integration not changed by build. |
| I1 | Pass: private clean install, pairing, normal CLI smoke and two native agents without the official extension. |
| I2 | **Partial:** retained actual 0.1.2 payload, registration ownership/path migration, instance/pairing/auth state verified. Live tab-preserving permission update remains unverified. |
| I3 | Pass: wrong Node/CLI, foreign registration/skill, changed plan and payload rejected without partial activation. |
| I4 | Pass: missing attestations and a real reachable bridge block activation; no forced global disconnect. Chrome unload is separately operator-attested. |
| I5 | Pass: idempotence/retained rollback, caught filesystem failure restoration, real installer SIGKILL leaves inspectable gate/journal. |
| I6 | Pass within restart scope: actual old host/CLI official smoke, RC reactivation, migrated legacy links restored, journals/data retained and owned-only uninstall. Physical tab retention across restart unverified. |
| U1 | Pass: exact own pairing, empty/multiple/native/unsupported states under the real extension origin. |
| U2 | Pass: bounded escaped labels/titles, origins exclude queries; foreign sender and obsolete generation rejected. |
| U3 | Pass: pending A revoked, one independent mutation receipt, B/tabs preserved, unknown outcome surfaced, no replay. |
| U4 | Covered: real busy/stale/successor and cleanup-unconfirmed popup paths; component duplicate/stale-generation/host-loss fencing. Popup-closure during accepted cleanup is not separately browser-tested. |
| U5 | Pass: finite retry/degraded behavior and actual popup Retry restore only readiness. |
| U6 | Pass within headless page scope: screenshots, 320px long content, keyboard focus and live announcements. Headed toolbar/focus excluded. |
| S1 | Pass: private managed links, actual legacy migration/rollback, installed wrapper/separate cwd; unrelated skills preserved. |
| S2 | Pass: release/schema/UI version reporting and strict installed verify; docs preserve explicit native opt-in and unknown outcomes. |
| R1 | Combined regression/check inventory, isolated performance and cleanup audit are in the evidence report. |
| R2 | Scope recorded: real human permission acceptance and Work update remain unverified Phase 6 prerequisites. |
| R3 | Final read-only Work diagnostic healthy on installed 0.1.2/native false; local checkpoint only. |

## Verification and evidence

There are **112 distinct checks with passing results across selected runs**,
including all **94 prior checks** and **18 new checks**. The final default run
passed 75 and skipped 37 opt-ins, with no failures; separate recorded opt-in runs
supply those passes. This is not one all-enabled run. Earlier failed reload,
restart/tab-selection and fixture attempts remain in the run index.

The isolated performance cohort used one warm-up and five alternating pairs:
native/official median attach 2.40/3.77 s, snapshot 201/211 ms, screenshot 280/349 ms
and disconnect 252/313 ms. No configured latency/RSS concern fired. These are local
fixture observations, not performance guarantees or installed-client benchmarks.

Cleanup checked **63 Phase 5 fixture roots** and **82 private daemon-log descriptors**:
no remaining owned processes, private host registrations or runtime directories.
The final Work diagnostic was healthy, paired and reachable on 0.1.2, native false.

The selected-run matrix, exact counts, artifact hashes, popup screenshots,
installed receipts, recovery/performance observations and cleanup audit are saved
under `/Users/ekkisyam/Documents/Codex/2026-10-28/i/outputs/latch-phase-5/`.
Skipped opt-ins are not counted as passes; superseded failures are retained and
identified. Browser tests use full headless Chrome for Testing 153.0.8010.12,
Node v22.21.1 and unmodified Playwright CLI 0.1.20. Official comparisons use
extension 0.4.0 with a fixture-only connect-URL delivery shim. Popup/fault fixtures
alone use `--silent-debugger-extension-api`; normal artifacts do not.

Reproduce focused candidate checks with `npm run test:release`,
`npm run test:installed-kit`, `npm run test:popup-ui`, `npm run test:recovery` and
`npm run test:recovery-chaos`. Keep performance isolated using
`npm run test:evidence-performance`. Fixtures need the pinned local dependencies
and stay disposable/headless. The Work installation is not a test fixture.
