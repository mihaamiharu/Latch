# First macOS release: implementation and acceptance plan

Prepared October 30, 2026 (Asia/Jakarta), after checkpoint `dc2535e`.

**Target:** Latch `0.2.0`, macOS only, prepared first as a local internal release
with an explicit support matrix. The owner deferred the repository decision; no
remote, push, GitHub release or upload is authorized. No public project license
has been selected. Windows and Linux follow later.
This is an execution plan, not a claim that the remaining work is implemented.
No publication, credentials, global permission changes or live Work update is
performed by writing this plan.

## Execution checkpoint — November 1, 2026

Software checkpoint `76e8c54` begins RC4 without updating installed Work RC3.
M1 compatibility contracts and M2 native setup/preflight are implemented. Candidate
qualification uses Apple Silicon/macOS 27.0.1, Chrome floor 147.0.7727.15 and current
lane 153.0.8010.12; older OS/Intel qualification remains outside these claims.

The detailed [M1/M2 acceptance record](acceptance/macos-rc4-m1-m2-2026-11-01/README.md)
separates committed-kit headless evidence from real-client/live-Work gates.
RC5 software `fc682a2` implements M3's maintained recorder, reports and selected
exports. Its [M3 acceptance record](acceptance/macos-rc5-m3-2026-11-01/README.md)
contains clean-checkout, packaged, interruption and popup Stop evidence.
RC6 software `1dd3eb2` pins the validated CLI and Node environment in owned setup.
Its [qualification record](acceptance/macos-rc6-runtime-2026-11-01/README.md) covers
minimal-PATH installed cleanup, popup Stop, host recovery, floor/current browser
lanes and retained native update/rollback. This closes the controlled CLI lookup
finding; it is not live Work acceptance. RC6 is staged inactive and Work remains
RC3. M4–M7 and exact final artifact promotion remain open. Publication is deferred
by the owner; local packaging and acceptance continue. No plugin package,
remote, public release or new Work installation is implied by this checkpoint.

The [local qualification procedure](LOCAL-QUALIFICATION.md) provides the release
lane while the repository decision is deferred. Install/recovery tests select
the versioned kit from committed source, so final promotion cannot silently keep
testing a retained RC6 directory. This harness preparation is not final-package
acceptance. The [operator/client handoff](MACOS-LOCAL-RELEASE-HANDOFF.md) retains
the exact staged RC6 artifact and required live gates.

## 1. Architecture and scope decisions

Keep the native architecture already implemented:

```text
Coding agent -> Latch CLI -> private Unix socket -> local host
Chrome Work extension <-> Chrome Native Messaging / stdio <-> local host
Playwright CLI <-> authenticated loopback CDP relay <-> Latch extension
Latch extension -> chrome.debugger -> owned Work tabs / related targets
```

Here, native means Chrome's Native Messaging integration and macOS-local IPC.
The existing native host is a Node program launched by Chrome; this plan does not
require rewriting it in Swift or introducing a permanently running launchd job.
Keep the authenticated loopback WebSocket relay for Playwright's data plane;
large screenshots/response bodies should not be routed through the smaller
native-messaging control channel. Do not expose a LAN/public listener or require
Chrome remote-debugging launch flags.

First-release defaults:

- macOS support only. Apple Silicon has the current evidence; include Intel only
  after its own install/smoke, otherwise label it unverified. Freeze exact tested
  macOS/browser versions before making minimum-version claims.
- Native attachment as the normal selected-profile setup. Keep official mode as
  an explicit legacy/rollback capability, with no silent fallback and no requirement
  to enable the official Playwright extension for native tasks.
- One canonical CLI/runtime and one shared skill. Codex CLI is the required first
  accepted client; Claude/Cursor become supported only after actual client runs.
- Complete versioned ZIP kit plus owned per-user installer for the first beta.
  No global npm installation or system security edit happens implicitly. Node
  22.21.1 and Playwright CLI 0.1.20 remain explicit prerequisites initially;
  changing or bundling them requires its own tested dependency/license decision.
- A signed macOS app/pkg, Chrome Web Store listing and agent marketplace packages
  are distribution extensions after the core beta gates, unless separately chosen
  as requirements for the first public delivery. Their absence must be clear in
  installation instructions.

The extension still uses Chrome's native host registration. The CLI still needs
permission to reach the local socket/relay and write its task state. Native
integration does not override the coding client's sandbox or enterprise policies.

## 2. Starting state and evidence we retain

- Installed RC3 is software revision `b0891c1`; the local documentation/acceptance
  checkpoint is `dc2535e`. Keep the exact RC3 artifacts and RC2 rollback payload.
- Work explicitly defaults to native, keeps its paired instance, and has the
  official extension disabled. This does not configure a fresh user's profile.
- Actual Codex CLI native browser smoke passed under per-session Full Access.
  Restricted workspace-write browser acceptance is not established. A successful
  approved diagnostic alone is not an approved attachment or browser workflow.
- Automated RC3 preparation has 92 distinct selected passes, with other optional
  cohorts not rerun. The exact RC3 artifact also passed a disposable install smoke.
- The [portable acceptance bundle](acceptance/codex-native-rc3-2026-10-30/README.md)
  records the real client policy, expected error/exit and confirmed cleanup.
- One historical interrupted Work record, `gherkin-msg-v2`, was preserved during
  upgrade because its daemon was absent. Inspect/reconcile it deliberately if it
  still exists; never delete it or assume the old application outcome.

## 3. Work packages and gates

### M1 — Freeze platform compatibility and release contracts

**Primary files:** `src/release.mjs`, `src/setup.mjs`, release/setup tests,
`package.json`, compatibility documentation.

1. Set a truthful native Chrome minimum. The current source/build advertise 120,
   while child-frame routing uses debugger sessions introduced in Chrome 125.
   The native release generator must require at least 125; advertise a higher
   floor if that is the oldest version we can actually validate. Preserve the
   retained legacy payload rather than rewriting its compatibility manifest.
2. Validate macOS/platform/architecture and required Node/CLI versions before any
   installer mutation. Errors must identify the unsupported prerequisite and leave
   installation/configuration unchanged. Make package engines, installer checks
   and support documentation describe the same supported range.
3. Pin actual browser binaries used in CI and record their versions/test flags.
   Validate the advertised browser floor and one current supported browser build.
4. Check clean-checkout packaging: all referenced extension/skill assets are
   tracked and included; no dependency on private work/ignored generated files.

**Gate M1:** supported matrix is explicit, the minimum-browser mismatch is fixed,
unsupported installs fail before changes and a clean checkout builds a complete
kit. Native contract/schema changes, if any, are separately versioned and tested.

### M2 — Native-first setup and actionable permission preflight

**Primary files:** `src/install.mjs`, `src/setup.mjs`, `src/transport.mjs`,
`src/diagnostics.mjs`, `src/cli.mjs`, shared skill and setup tests.

1. Provide a clear sequence using the existing owned installer:
   inspect prerequisites -> stage -> operator unload -> activate -> operator
   enable -> verify identity/readiness -> confirm/pair intended profile ->
   explicitly select native for that profile -> install/verify skill links.
   Add a setup command/wizard only where it removes real repeated steps; it must
   retain reviewable paths, fresh inspection tokens and ownership checks.
2. Configure native only after exact paired-instance/schema-4 readiness is proven.
   Check a fresh task without a transport flag. Preserve existing recorded session
   adapters and deliberate legacy overrides; no timeout-driven fallback.
3. Distinguish layers: configuration, OS/socket access, controller round trip,
   native capability, CLI registry, attachment and application verification.
   Permission denial is not an offline bridge or a missing pairing. Unreachable
   capabilities are unknown, not a false unsupported result.
4. Preflight task-local writes and exact CLI daemon-cache needs. Give each claimed
   client a tested permission path. Check actual tool availability before suggesting
   a permissions tool; distinguish command approval from permission-profile grants.
   If neither route exists, stop with one actionable blocked result instead of
   repeatedly asking the agent to retry browser steps.
5. Do not require or silently enable Full Access. Record it truthfully when a user
   selected it. Never edit global policies, relax socket modes, switch OS users or
   alter enterprise controls to make the smoke pass.
6. Preserve pairing/identity across stable-path updates. A changed instance requires
   explicit inspection and repair; it is not a preservation pass. Keep owned backup,
   update, uninstall and rollback paths, and preserve unrelated links/installations.

**Gate M2:** a fresh supported setup reaches a native task without the official
extension. Same-context preflight explains denied access correctly, no forbidden
fallback occurs, and update/uninstall/rollback preserve unrelated configuration.

**M2/M5 finding and closure (November 1):** a version-only probe finds CLI 0.1.20
under the terminal PATH and `CLI_UNAVAILABLE` under `/usr/bin:/bin`. Setup captures
Node's executable but host-side detach still resolves Playwright CLI from PATH.
Pin the validated CLI executable and its Node execution environment in owned
runtime setup; verify normal disconnect, popup Stop and recovery under a minimal
host PATH. Preserve pairing, unrelated settings and retained rollback payloads.
RC6 implements this pin and passes the installed minimal-PATH cleanup/recovery
and retained native update/rollback checks in its qualification record. The
original finding was controlled probe evidence, not an observed failure in the
live Work GUI. Live Work remains a separate gate.

### M3 — Maintained evidence runner and human/agent reports

**Primary areas:** new local evidence/runner modules, CLI command wiring, shared
skill/reference and focused artifact tests. Keep evidence metadata separate from
host-owned lease journals and version its schema independently.

Implemented in the RC5 development candidate (installed Work remains RC3):

```text
connect ... --evidence-dir <directory>
pw ... --evidence-dir <directory> --step <id> -- <ordinary Playwright command>
disconnect ... --evidence-dir <directory>
report --evidence-dir <directory>     # offline rendering / verification
export --evidence-dir <directory> --export-dir <new-directory> --include <artifact-path,...>
```

Pass the same evidence directory explicitly on every recorded command; the
recorder does not maintain a hidden session-to-directory registry. See the
[maintained evidence workflow](../skills/latch/references/evidence.md).

Use one recorder in the CLI rather than having each agent invent shell wrappers.
Capture actual process exits and outputs before printing/piping. Preserve the
existing `pw` error contract and normal Playwright behavior. Do not hold a recovery
grant for the duration of an application call: popup Stop must remain usable.

Required artifact layout:

```text
work/latch/<session>/
  report.md
  result.json
  commands.jsonl
  screenshots/
  raw/
```

Required result schema:

- Schema version, run/session/workspace identity, timestamps and software versions.
- Selected target, confirmed transport and focus policy; bounded artifact index
  with relative paths, type, size and hash.
- Checks with stable IDs, expected/observed values, pass/fail/blocked/unknown and
  evidence references. CLI success alone never becomes an application PASS.
- Actual process status separate from QA expectations. An intentional negative
  test can pass its assertion while the tool still correctly exits 1.
- Cleanup status independent of test outcome. Partial evidence and unconfirmed
  cleanup survive a failed/interrupted run.
- Client/permission metadata with provenance: directly observed, client-reported,
  supplied by the agent or unverified. Do not infer the client policy from the
  local launcher binary or silently crawl unrelated agent session histories.
- Reporting failure separate from browser outcome. If evidence writing fails
  after a successful action, record the known/unknown operation outcome and never
  replay that action to regenerate evidence.

Human report defaults to a concise check table, actual context/limitations,
before/after/failure images as appropriate and clickable relative evidence links.
Agent defaults to the compact result and requested evidence only. Full snapshots,
network bodies and traces remain on disk/on demand; no automatic context dump.
Use focused snapshots where sufficient, retaining full originals when captured.

Bound command logs/capture sizes and make truncation explicit. Redact connection
credentials and sensitive headers; export only selected evidence. Screenshots/page
content can contain private data, so an exporter must not promise automatic visual
redaction. Retain failures and original evidence; deletion/retention is explicit.
Default collection stays within owned target tabs.

**Gate M3:** normal, expected-error, assertion-failure, timeout, interrupted action,
disk-write failure and cleanup-failure fixtures generate truthful durable results.
Hashes/links verify, two tasks cannot mix evidence, and a reviewer can understand
the run without an agent transcript. Original screenshots are not duplicated merely
because an output filename option was misused; invocation syntax is tested.

### M4 — Client skill integration and explicit support matrix

**Primary areas:** `skills/latch/`, `src/install-skills.mjs`, setup link tests and
client smoke prompts/results.

1. Keep one canonical skill; make its main path short: preflight, connect, scoped
   `pw`, report, disconnect. Put detailed recovery/large-payload guidance in the
   existing operations reference. Validate packaged icons and all supporting links.
2. Fresh sessions test actual skill discovery as well as explicit-path loading.
   Verify matching installed runtime, cwd preservation and a non-Git workspace
   where branch is N/A rather than a browser-testing blocker.
3. Required Codex acceptance: same-context approved diagnostic, discovery, native
   connect, observed assertion, before/after evidence, expected error, normal
   disconnect and a generated report. Record the real execution policy throughout.
4. Repeat through actual Claude Code and Cursor CLI when available. Do not infer
   client support from symlinks or execute one agent on behalf of another and count
   that as a client run. Leave unavailable clients explicitly unverified and limit
   first-release claims accordingly.
5. Validate simultaneous agents in separate workspaces/sessions, including one
   stopping while the other remains usable. Within one session, serialize task
   commands; Latch is not an agent scheduler or sandbox for arbitrary JavaScript.

**Gate M4:** every claimed supported client/mode has actual evidence. At least
Codex completes the supported permission path; Full Access alone cannot be
marketed as a restricted-sandbox pass. If narrower access cannot be established,
make an explicit beta-scope decision rather than silently weakening permissions.

### M5 — Recovery, installed Work behavior and clean-user beta acceptance

**Primary areas:** existing installed-kit/recovery/popup/compatibility fixtures,
operator runbook and acceptance records.

1. Re-run meaningful changed-path cohorts headlessly: native connect/ownership,
   frame/popup routing, error normalization, evidence bounds, recovery, popup Stop
   and packaged installation. Reuse existing tests; do not turn every old cohort
   into a mandatory rerun unless a change/risk justifies it. Performance reruns
   are needed if the recorder/transport changes introduce a performance concern.
2. Cover daemon/host/extension interruption, exact-session cleanup, stale tokens,
   partial records and no mutation replay. Preserve unknown outcomes and peer tabs.
   Inspect the historical interrupted record before any scoped reconciliation.
3. In an authorized installed Work pilot, verify Stop during a bounded held fixture
   action, a peer surviving, popup closure and final unowned tabs. Separately verify
   a Work fixture while the user foregrounds Personal; inspect no Personal content.
4. Verify an intended already signed-in test app read without collecting cookies
   or submitting a form. Navigation on a public homepage alone does not prove
   signed-in session reuse.
5. Rehearse clean install, update, rollback and reactivation using exact artifacts
   and disposable data. Add a second clean Mac/account beta test when available;
   simulated profiles on one machine must not be reported as a second machine.
6. All automatic browser fixtures remain headless/disposable under AGENTS.md.
   Work changes and real focus/Chrome UI observations use the explicit operator
   procedure and applicable authorization. Chrome enable/permission acceptance
   remains user-operated; daily tasks need no dragging or desktop automation.

**Gate M5:** the supported end-to-end installed workflow and rollback are evidenced;
headless tests and operator observations remain separately labelled. No live lease
or cleanup ambiguity from the release acceptance run is concealed.

### M6 — Distribution, configuration and release engineering

**Primary areas:** build/release/installer scripts, selected CI workflow,
README/SETUP, release notes, license/privacy/support documentation.

1. Owner decision: keep the first delivery local and internal; repository/home
   and hosted CI are deferred. Add a remote only when the owner later supplies
   and authorizes it. Keep publication credentials out of source and
   release kits. Existing no-push direction remains in force until changed.
2. Owner decision: no public project license yet. State internal status without
   inventing a public license grant; public support/privacy URLs are deferred.
   Local PRIVACY/SUPPORT documents accompany the kit. Retain upstream licenses
   and document local artifact retention, browser access, actual telemetry/egress
   behavior and the coding agent/provider's data handling. A local Latch bridge
   does not imply that content viewed by a cloud-backed agent stays on the Mac.
3. Build complete versioned kits, extension ZIP, checksums and machine-readable
   descriptor from a committed clean checkout. Include required project notices
   and skill/report resources; exclude user profiles, raw private acceptance data,
   local credentials and development-only files.
4. Local qualification (and future CI) uses disposable macOS profiles/registrations
   and pinned prerequisites,
   selected headless checks, clean-checkout builds and package verification. Publish
   no raw signed-in browser evidence as CI artifacts. Record opt-in skips honestly.
5. Native host name, extension ID/key, installed `allowed_origins` and selected
   runtime/Node paths must agree. Keep host/skill paths application-owned and
   stable across upgrades; prove the uninstall boundary.
6. Make a new candidate (RC4 or later) for implementation changes. Do not patch or
   overwrite the frozen installed RC3 payload. Update stale entry-point docs while
   preserving historical observations and supported-mode qualifications.
7. If later adding Chrome Web Store distribution, prepare its ID/public key,
   listing, permission disclosures/privacy/support URLs and compatible native-host
   distribution together. If adding an app/pkg, add Developer ID signing,
   notarization and its update strategy for that format. A plugin/store extension
   does not replace installing the local host.

**Gate M6:** a new supported internal user can follow the exact local-kit procedure without
the maintainer's checkout or private machine paths; identity/integrity and rollback
are verified. Local-release metadata and required owner decisions contain no placeholders.
Hosted CI, repository setup and public license/URLs are deferred by the owner,
not represented as completed publication work.

### M7 — Exact artifact promotion and first-release sign-off

1. Freeze the supported OS/architecture/browser/client/version/permission matrix,
   explicit limitations and remaining exclusions. Managed download retrieval,
   already-running worker backfill, remote/cloud browser access and other OSes
   remain outside first-release claims.
2. Resolve all M1–M6 release-required findings. Validate every supported-mode claim
   against evidence; mark anything else unavailable/unverified rather than PASS.
3. Build the final `0.2.0` identity from its committed source, verify the complete
   inventory/checksums and run clean install plus native app/evidence/cleanup smoke
   on that exact package. Rehearse update/rollback against the retained release.
   Passing an RC does not automatically pass the final package.
4. Prepare a concrete release bundle, notes, checksums, instructions, support matrix
   and rollback instructions for review. Only then obtain final authorization to
   push/publish/upload. Do not create a public release merely to inspect readiness.

**Gate M7:** exact final artifact, documented supported modes, generated human/agent
evidence and rollback are reviewable; publication is a separate authorized action.

## 4. Dependencies and first implementation slice

```text
M1 compatibility -> M2 native setup -> M3 reporting -> M4 client acceptance
                                      |                  |
                                      +-----> M5 live/recovery acceptance
M1/M2/M3 -------------------------------> M6 release packaging
M4 + M5 + M6 ---------------------------> M7 final artifact / publication gate
```

Start with **M1 plus M2 preflight/native-default work** in a new candidate. Those
address the concrete browser-minimum mismatch and the permissions/default loops
already observed. Then implement M3 before another large client test campaign so
each following run produces reliable evidence without hand-written shell/reporting.

No installed Work update is needed to begin these implementation/headless phases.
Do not rebuild the current RC3 identity to pick up source documentation changes.

## 5. Owner decisions needed before publication

| Decision | Default proposal | When needed |
| --- | --- | --- |
| First delivery | **Local internal** complete ZIP kit + owned per-user native installer | Before beta packaging; no signing account required for the current script-kit format |
| Public repository/release destination and visibility | **Deferred by owner; keep local** | Before remote setup / CI publication |
| Project license and support/privacy URLs | **Internal; no public license yet.** Local PRIVACY/SUPPORT docs included; public URLs deferred | Before public bundle/listing |
| Hardware and OS minimum | Exact tested matrix; Apple Silicon first until Intel has evidence | Before beta claims |
| Claimed agents | Codex required; add Claude/Cursor only when validated | Before release notes |
| Store/app/pkg/agent marketplaces | Deferred from core beta | Before provisioning distribution identities/credentials |

These decisions do not block local M1–M5 implementation. They cannot be invented
or silently provisioned during development.

## 6. After the first macOS release

- Thin Codex/Claude/Cursor plugin/marketplace packages around the same canonical
  skill, with real install/update/removal/discovery checks for each selected client.
- Signed/notarized app/pkg and store distribution if the audience needs them.
- Intel qualification if absent from the first support matrix.
- Windows/Linux installation, IPC, permissions, packaging and CI as separate work.
- Broader features only from concrete user cases; do not rebuild Playwright's
  automation engine or add an agent orchestrator merely for packaging.

## References and supporting records

- [Release-readiness review](RELEASE-READINESS-2026-10-30.md)
- [Actual Codex acceptance](acceptance/codex-native-rc3-2026-10-30/README.md)
- [Phase 6 observations](PHASE-6-IMPLEMENTATION-RESULTS.md)
- [Chrome debugger sessions](https://developer.chrome.com/docs/extensions/reference/api/debugger#attach-to-related-targets)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension identity](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Chrome Web Store privacy requirements](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [macOS distribution](https://developer.apple.com/macos/distribution)
