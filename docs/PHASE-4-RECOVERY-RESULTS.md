# Phase 4 recovery results

Verified October 29, 2026 (Asia/Jakarta), from starting checkpoint `11d4a26`.
The source native preview now implements Phase 4. Native remains opt-in; the
installed Work extension, pairing, registration, permissions and daily default
were not upgraded. Installation/popup integration and Work cutover remain
Phases 5 and 6.

## Implemented contract

- Readiness requires a host-generation/worker-epoch/nonce challenge, extension
  ACK and host confirmation. Discovery performs a controller round trip. Old
  port events and acknowledgments cannot satisfy a replacement connection.
- A control loss fences native automation and coordinates controller claims with
  debugger cleanup. The bridge reconnects; automation never reconnects itself.
  Each fresh lease has a new ID. Operations and delayed callbacks are fenced by
  profile, worker epoch, host generation, lease and canonical task key.
- Real worker termination showed that Chrome can retain this extension's tab
  debugger attachments. Bounded receipts in `chrome.storage.session` record
  attachment intent. Startup verifies an exact target and this extension's own
  debugger access before detaching it. `attached=true` alone does not authorize
  detachment. Foreign attachments are rejected with `DEBUGGER_CONFLICT` and
  preserved.
- There are six failed attempts per retry episode, five-second readiness
  deadlines, and awake retry delays of 1, 2, 4, 8 and 16 seconds. Durable Chrome
  alarms provide a wake fallback at least 30 seconds later. This resolves the
  plan's ambiguous six-delays/six-failures wording in favor of six total failed
  attempts. Explicit retry or browser startup can begin a fresh episode.
- The existing host owns schema-4 journals and connection-bound operation grants.
  Grants have a 60-second monotonic budget and a 16-operation limit. EOF fences
  the grant, not a healthy persistent daemon. The same key remains blocked until
  the old operation's asynchronous tail and cleanup settle. Journal writes and
  tombstone compaction share a host writer queue; compaction cannot erase a
  same-key successor. Shutdown settles writer tails before relinquishing its
  socket. Permission denial and uncertain socket liveness never authorize unlink.
- Journals are at most 64 KiB, mode 0600, in owned 0700 directories beneath
  `native-v4/<instance>/` beside the selected configuration. They contain bounded
  task/lease/target metadata and daemon identity hashes. Endpoint credentials,
  page bodies and executable scripts are excluded. At most 64 completed
  reconciliation tombstones remain. Incomplete temporary files are preserved
  and reported as blockers.
- `reconcile` inspects without writing, including offline. `--apply --expect`
  revalidates the current plan under a grant, revokes old native access, confirms
  owned cleanup, attempts normal CLI detach for the exact recorded task, and
  retires its record. Repeated matching apply is a no-op; a successor invalidates
  the old token. A replaced/unprovable daemon is preserved and reported.
- `doctor --transport native --session` separates bridge/controller, native
  lease/relay and exact daemon identity. `diagnose` retains execution-denial
  details. An installed legacy host is labelled as a legacy host report rather
  than claimed to support native recovery.
- Lost responses leave application outcomes unknown. No application action is
  replayed. A real host-loss test held four calls, independently observed one
  committed request and zero receipts for a command attempted after loss, then
  verified that recovery did not create duplicates. Completed evidence hashes
  remain stable. Existing Gate E partial-output behavior is unchanged.

## Acceptance matrix

“Component” identifies deterministic protocol/state tests; it is not a claim of
an OS/browser fault which was only simulated. Browser evidence uses disposable
profiles, real native messaging, full headless Chrome and unmodified CLI 0.1.20.

| ID | Result and proof |
| --- | --- |
| B1 | Real host TERM/KILL, idle and with four held calls; new generation, zero revived leases, explicit fresh connect. |
| B2 | Actual `Target.closeTarget` worker termination plus extension disable/enable reload; epoch/generation changes and owned attachment cleanup. |
| B3 | Same disposable profile restarted; stable pairing and synthetic auth, old authority rejected; restored metadata recorded separately from explicitly provisioned fresh tabs. |
| B4 | Real missing-host/terminated-worker alarm delivery; component tests exhaust six failed handshakes and retain due/degraded state. |
| B5 | Component tests reject early/wrong/obsolete readiness responses and old disconnects. |
| S1 | Only A's exact fixture daemon killed; B remains usable and tabs remain open. |
| S2 | Normal short CLI completion and grant EOF leave healthy persistent automation usable; no idle TTL. |
| S3 | Real popup/root pending calls cancelled with a child and peer surviving; real OOPIF replacement cancels pending child commands and retires handles. |
| S4 | Real same/cross-site frame navigation, document replacement and stale-handle rejection; no automatic mutation replay. |
| S5 | Real own-attachment detach and separate extension debugger conflict; foreign attachment survives rejection. Headed DevTools UI was not exercised. |
| L1 | Real same-key clients get `SESSION_BUSY`; a different workspace proceeds. Component grant-cap test covers the limit. |
| L2 | Real control EOF during bootstrap, actual host death before journal rename; component barriers fence verify/release completion after owner loss. |
| L3 | PID-reuse/old-timestamp legacy locks stay untouched; access-denial classification and daemon replacement are component-tested. No actual PID reuse or sandbox denial was manufactured. |
| L4 | Same-key grants and stale commits fenced; real host loss during journal write; component compaction race preserves a successor. |
| J1 | Real healthy/stale/absent inspections and offline component snapshots; healthy sessions are not called abandoned. |
| J2 | Real duplicate apply and stale-token-after-successor rejection; successor and peer stay usable. |
| J3 | Real offline inspect/apply rejection and partial-write preservation; corrupt, unsafe and unknown records are component-tested. |
| J4 | Actual installed v1 diagnostic, official regressions, pinned checkpoint schema-3 extension using compatible disconnect, unknown schema rejection. No live migration. |
| U1 | Independent server receipts: one committed mutation, zero never-received requests and zero replays after host/debugger loss. |
| U2 | Real completed screenshot hash preservation and old endpoint rejection; Gate E partial-output and late-response bounds retained. |
| O1 | Real layered native doctor and read-only Work diagnostic; permission error mapping stays specific. |
| O2 | Twenty real fault/recovery cycles, two agents and an unclaimed outsider; zero final native sockets/listeners/sessions, preserved artifact hash. |

## Verification record

There are **94 distinct checks with passing results across recorded runs**.
The final default command ran 63 and skipped 31 opt-in checks; those skipped
checks have passing opt-in results in the combined evidence matrix. This is not
presented as one monolithic all-enabled run.

The serial broad regression initially reported 76 passes, one failure and eight
skips. Its schema-3 filesystem assertion was updated for host-owned schema 4,
and the complete multi-agent regression subsequently passed. Targeted recovery
and lifetime confirmations cover later fixes. Superseded failures remain in the
private logs and the selected-run matrix rather than being counted as passes.

The isolated performance cohort used one warm-up and five alternating pairs:

| Median | Native | Official |
| --- | ---: | ---: |
| Attach | 2.38 s | 3.55 s |
| Snapshot | 196 ms | 212 ms |
| Screenshot | 281 ms | 334 ms |
| Disconnect | 91 ms | 247 ms |

No configured latency/RSS concern threshold fired. An earlier concurrent cohort
found a real daemon fingerprint race when its socket disappeared after native
revocation; registry birth identity and optional live socket identity were
separated, then the isolated cohort passed. These are local observations, not
performance guarantees.

Read-only cleanup audit: **64 fixture roots checked; no remaining owned test
processes, registrations or runtime directories**. Private profiles/raw daemon
logs remain local and are not published as evidence. Final Work diagnostic:
paired/reachable/healthy, installed 0.1.2, native transport false. No Work upgrade
or global security change was performed.

Selected evidence, hashes, combined check matrix and full readable report are in
`/Users/ekkisyam/Documents/Codex/2026-10-28/i/outputs/latch-phase-4/`.
The canonical shared skill was updated and passed skill validation. The checkpoint
is local only; no push is included.

## Reproduction and limits

```bash
npm test
npm run test:recovery
npm run test:recovery-chaos
npm run test:native-workflow
npm run test:evidence-performance
```

All browser commands require the pinned local Chrome/CLI fixtures and stay
headless. The fault fixture alone uses `--silent-debugger-extension-api` so its
own extension page can terminate its worker. The alarm fixture alone delays
short retry timers to 60 seconds while leaving real Chrome alarms unchanged;
it records actual alarm delivery after termination, without an agent wake
message. The journal-write fixture copies the host into its private directory
and pauses after temporary-file sync, before rename. None of these injection
hooks ship in the normal extension.

The worker fault mechanism follows Chrome's
[service-worker termination testing guidance](https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer)
and the [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
The measured lifetime/ownership behavior above comes from this pinned headless
fixture, not an inference that headed focus or every future Chrome build behaves
the same way.

Legacy/PID-only locks, corrupt/partial records and unknown daemon ownership remain
explicit blockers. Recovery does not remove them heuristically. Managed download
retrieval, existing-worker backfill, machine/power loss, cross-machine control,
installer/UI rollout and headed DevTools/focus claims remain outside this gate.
