# Phase 5: installer, popup and shared skill

Prepared October 29, 2026 (Asia/Jakarta). **Approved implementation plan.** Implementation evidence and remaining rollout
gates are recorded in `PHASE-5-INSTALLER-POPUP-RESULTS.md`. Starting checkpoint:
`8eb9137f6153f6887a1bb46b512f10ea9153b708`, Phase 4 complete in the native
source preview. Parent: `SINGLE-EXTENSION-PLAN.md`.

## Outcome and boundaries

Produce a locally installable Latch release candidate with its native permission,
runtime dependencies, useful session popup, safe upgrade/rollback procedure and
one canonical agent skill. A clean install and an upgrade from the actual 0.1.2
compatibility checkpoint must work in disposable profiles using the built kit.

**Phase 5 prepares and verifies the upgrade. Phase 6 applies it to Work.**
Keep the installed Work/Personal profiles, live registration, pairing, existing
skill links and transport default unchanged during this phase. Do not disable
or uninstall the user's official extension. No push, publication, browser-store
submission, global agent-security change or automatic global dependency update.

All browser tests use full headless Chrome for Testing, disposable user-data
directories and private host registrations. Preserve Phase 4's fencing, journal,
retry and unknown-outcome contracts. No headed fallback, desktop control or
remote-debugging flags in normal runtime. A successful fixture permission setup
does not establish that a human accepted a real Work upgrade dialog.

## Current gaps confirmed in source

| Area | Current behavior | Required result |
| --- | --- | --- |
| Manifest | Generated permissions include alarms but omit debugger; native fixtures add debugger themselves. | The native candidate includes debugger without fixture edits. |
| Identity | Installer generates a new public key if the existing key is missing. | Release preparation fails on missing/unexpected identity; never silently changes the Latch ID. |
| Build | Calls installer preparation, mutates source/generated launchers, copies the extension, checks a short file list and creates a ZIP. | Build is separate from installation, validates the full module graph and emits a complete kit from an allowlist. |
| Runtime | Launchers point into the working checkout and a specific NVM executable. | Installed code lives in versioned release directories; preparation validates the explicit Node executable and CLI prerequisites. |
| Upgrade | Apply accepts only an identical existing registration; no owned upgrade receipt, staged activation or rollback. | Reviewable owned migration, preserved identity/configuration, bounded failure handling and a retained previous release. |
| Popup | A connection sentence plus raw JSON; no pairing truth, sessions, tabs or revoke control. | Clear connection/capability states, native task rows and host-authoritative scoped revoke. |
| Popup transport | The persistent port supports handshake, host requests and replies; there is no bounded popup-to-host control RPC. | A capability-negotiated, authenticated UI control path through the existing port. |
| Skill | Links resolve to the checkout; unrelated links are protected. | Packaged skill resolves its matching runtime; managed link migration and rollback preserve that protection. |
| Versions/docs | Package and CLI display still say 0.1.2; README mixes installed behavior and preview behavior. | One release descriptor and explicit installed/candidate/protocol capability reporting. |

## Decisions to freeze before implementation

### Candidate, identity and dependencies

Target the local kit as `0.2.0-rc.1`. Use Chrome manifest version `0.1.99.1` and
`version_name: 0.2.0-rc.1`; subsequent RCs increment the fourth component. This
keeps final `0.2.0` newer than the RCs. Validate the mapping in code rather than
passing a SemVer prerelease directly to Chrome. Chrome compares numeric version
components and supports a separate display version.
[Chrome version reference](https://developer.chrome.com/docs/extensions/reference/manifest/version).

Keep extension ID `dlkpkeiejlgggeoibejpoajedoelfcli`, the checked-in public key,
host name `com.qa_browser.bridge`, `qa-browser`, configuration location, profile
aliases and stored instance IDs. Native session schema remains 4; negotiate any
new UI-control capability separately. Keep official/v1 and schema-3 compatibility
where Phase 4 already supports it; unknown combinations fail clearly.

The native candidate requires `tabs`, `tabGroups`, `storage`, `nativeMessaging`,
`alarms` and `debugger`. Do not add website host permissions, content scripts,
external-message access or suppression of Chrome's debugger notice. Required
debugger permission is obtained during one-time setup, not through a terminal
agent trying to manufacture a browser user gesture.

New warning-producing permissions can disable an extension until accepted.
Document this honestly and distinguish it from a disconnected native host.
[Chrome permission-update guidance](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings).

Validated prerequisites remain Node 22.21.1 and unmodified Playwright CLI 0.1.20.
For this RC, validate these before activation. Node and Playwright remain external
prerequisites; the kit does not bundle their binaries or silently install/upgrade
them globally. Include the pinned production `ws` dependency and its license,
existing Playwright attribution/license material, lockfile and dependency inventory.
Keep distribution private/local; do not invent a new license for the user's code.

### Release layout and stable paths

Build a full kit containing `extension/`, `src/`, production dependencies,
`skills/latch/`, setup entry point, documentation, licenses and a release descriptor
with source revision, versions, capabilities and file hashes. Keep the existing
relative imports and skill-wrapper resolution valid within that layout.

Install beneath the existing application-support root in owned versioned release
directories, with stable CLI/native-host launchers and stable extension/skill
paths. Resolve the selected immutable release once per process so a running host
cannot import a mixture of versions after a pointer change. A built kit contains
no user-specific Node path, paired instance, host registration destination or token;
generate those installation-specific files during setup.

P0 must prove Chrome's behavior when an unpacked extension is loaded through the
chosen stable path and its backing release changes. If symlink-backed loading is
not reliable in the pinned browser, use an owned stable extension directory with
replacement only while that extension is unloaded. Do not ship two competing
loading strategies or infer the user's currently loaded directory from protected
Chrome profile files. Record the tested choice in the installation receipt.

### Registration, activation and rollback

Separate **build → inspect/preflight → stage → activate → verify**. Build and stage
do not register a host, move skill links, pair profiles, reload Chrome or change
the daily transport. A setup plan lists exact owned paths, prerequisite results,
old/new versions, permission delta and registration/link changes.

Preserve the native host's name, manifest location and exact allowed origin. A
legacy registration may need its absolute executable path migrated from the
checkout to the stable installed launcher. Show that path change explicitly,
back up the exact old manifest and recognize it using an owned installation
receipt or exact verified legacy installation data. Matching the host name or
filename alone is insufficient; preserve foreign/ambiguous registrations.
Native-host executable paths on macOS must be absolute.
[Native messaging reference](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

Activation requires a maintenance window: existing native and official tasks are
drained, and the target extension is unloaded before its files/runtime selection
change. Phase 5 automates that sequence only in disposable profiles. For legacy
0.1.2, do not pretend a new maintenance RPC can exclude old clients that do not
implement it. Without proof that the fixture extension is unloaded and its owned
host has exited, stage the candidate and return an activation blocker. Do not
terminate unrelated browsers, agents or native hosts.

Use a short exclusive installer transaction gate and an owned receipt/journal.
An existing gate is busy even if its PID is gone or timestamp is old; do not add
another PID-based stale-lock reclaimer. Ordinary caught failures restore the
prior owned registration, release selection and managed links. Abrupt process
loss leaves an explicit inspectable interrupted transaction; preserve its gate
and state rather than guessing that rollback finished. Machine/power-loss repair
and automatic abandoned-installer reclamation are outside this phase.

Because multiple filesystem paths and Chrome activation are involved, do not call
the entire upgrade atomic. Stage complete immutable payloads first; record each
activation step and the exact prior values. Do not claim success until the reloaded
fixture reports the expected ID, retained instance, candidate version, native
schema, verified readiness and a normal CLI smoke result.

Rollback is explicit, task-drained and extension-unloaded as well. Restore the
retained complete previous release, its extension directory, receipt-managed
links and registration. A pre-`ws` 0.1.2 host is not the current host with an old
extension placed beside it: retain/test the actual compatibility payload. Preserve
schema-4 journals and evidence; old clients must not reinterpret them. A previous
RC without a candidate CLI/version capability must use its documented interface.

### Popup and local revocation

The popup belongs to the profile where it is installed. Get its pairing label
from the host's configuration match for this exact instance; do not label every
instance “Work” or enumerate other profiles to fill the UI.

Show connection state, pairing state, native readiness and task rows separately.
Rows use session name, a short workspace label, transport, state and controlled
tab count. Show useful tab title/origin metadata with long text bounded and query
strings omitted from the default display. Technical details contain versions,
capabilities, diagnostic codes and identity fields, with endpoint credentials,
cookies, executable scripts and page content excluded.

Use a small capability-negotiated UI request/reply channel over the existing
native port. Allow only status and scoped native revocation, bounded request IDs,
pending count, payload sizes and deadlines. Bind it to the verified port,
instance, epoch, generation and nonce. Check the exact own popup sender in the
background; websites and other extension pages do not gain a new generic native
operation proxy. Status must not claim/attach a tab. Permit host-to-controller
callbacks while a UI request is waiting; avoid a request/response deadlock.

Native revoke goes through the host's existing recovery coordinator and sole
journal writer. The host derives workspace/session metadata from the recorded
lease. Revalidate the displayed generation, lease ID and record revision before
side effects. Stop that relay, settle pending calls, confirm owned debugger and
claim cleanup, then attempt normal detach of the exact proven CLI task. Preserve
physical tabs, groups, logins, other agents and saved evidence. Report interrupted
application outcomes as unknown; never replay an action.

Do not bypass a live operation grant to implement the button. A connecting or
otherwise busy task returns a clear busy result without falsely claiming access
was revoked. Normal in-flight Playwright data calls do not hold that short grant,
so a healthy attached task must be revocable while its application call is pending.
Duplicate clicks cannot affect a successor lease. Closing/reopening the popup
does not cancel a host-accepted bounded cleanup or repeat it blindly.

Distinguish “access stopped; CLI cleanup unconfirmed” from complete disconnect.
Keep an interrupted journal when cleanup cannot be proven. Official/legacy rows
remain visible where metadata is known, with normal task-CLI disconnect guidance;
this first popup revoke operates on schema-4 native leases only.

An explicit Retry button starts the existing bounded reconnect episode; it does
not repair registration, change permissions or reattach automation. Disable
revocation when offline, stale or unsupported. Default popup display is product
language; raw JSON remains a diagnostic detail.

## Execution stages

### P0 — Freeze and prove release/upgrade assumptions

Record current release identity, key, host/config paths, dependency versions,
capability combinations and baseline hashes. Use the actual 0.1.2 checkpoint
`ad4819827f0fc994a1df39aed930a2bab8f44972`, schema-3 checkpoint `11d4a26` and
Phase 4 checkpoint `8eb9137` for their respective compatibility fixtures.

Probe stable-path loading, in-place version update versus disable/enable,
instance preservation, permission availability and rollback in headless Chrome.
Record the lifecycle event actually observed; do not call disable/enable an
`onInstalled(reason=update)` test. Establish whether a true permission-increase
update/denial can be exercised with the permitted headless tools. If not, record
that browser-UI acceptance as unverified and retain it as an explicit Phase 6
prerequisite; a mocked denial is not a real Chrome permission-dialog pass.

**Exit:** one tested installation-path strategy, fixed version mapping, ownership
rules, permission test scope and build/install/UI-control contracts. Do this
before rewriting the production installer.

### P1 — Build the native release kit

Separate manifest generation from native registration preparation. Make build
fail on identity mismatch, missing modules/assets, unexpected permissions, bad
version mapping or dependency/license omissions. Generate the Chrome directory
and ZIP plus the complete runtime kit using explicit input/output inventories.

Verify two builds from the same clean source/lockfile have matching payload hashes;
normalize archive order/metadata where archive reproducibility is claimed. Scan
the package inventory for test hooks, fixture profiles, runtime sockets, raw logs,
credentials, private keys, `.git`, task evidence and local configuration. Do not
ship the official extension or a test-only native host/Chrome launcher.

**Exit:** native-capable artifact with complete imports and dependencies; build
has no registration/Work/source-launcher side effects. Tests load the artifact's
manifest unchanged, rather than adding debugger to make it pass.

### P2 — Implement installation, owned upgrade and rollback

Add explicit setup inspect/stage/activate/verify/rollback operations with structured
results. These command names are proposed until implemented and tested. Cover
spaces in paths, executable arguments, missing Node/CLI/dependencies, wrong CLI
version, conflicting registration/links and partially completed staging.

Introduce private installation-root/registration-root fixtures rather than
redirecting the real user's HOME. Preserve pairing bytes and instance identity
on upgrade; no automatic pair command or transport-default change. Validate the
selected runtime and registration after fixture activation. Uninstall removes
only receipt-owned integration, leaving pairing, journals, browser state and
evidence unless a separate data-removal task is authorized.

**Exit:** clean install, 0.1.2 upgrade, repeat activation, caught-failure rollback
and interrupted-transaction inspection pass from the packaged kit without access
to the source checkout. Foreign files remain unchanged.

### P3 — Implement popup status and scoped revoke

Add the bounded UI-control protocol, authoritative sanitized host status and
pairing resolution. Build a readable popup with native session/tab summaries,
technical details, explicit retry and per-native-session revoke results.

Exercise actual popup HTML/JS under its own extension origin in headless Chrome;
mock-only rendering is insufficient. Capture screenshots for ready/empty,
multiple agents, disconnected/degraded, unpaired, unsupported version, busy,
cleanup-incomplete and revoked states. Inspect narrow layouts, long names/URLs,
keyboard access and status announcements. Do not claim a real toolbar-bubble or
headed-focus test from a headless extension-page screenshot.

**Exit:** A can be revoked while its application call is pending, B remains
usable, all website tabs remain, old access is unusable, and a stale popup row
cannot revoke A's successor. Malicious page messages and delayed old replies fail.

### P4 — Integrate the canonical skill and user documentation

Package the one canonical `skills/latch/` tree. Support managed existing links
and explicit link installation for a clean local setup. A versioned deployment
must keep `.agents/skills/latch` and `.claude/skills/latch` resolving to the active
matching skill/runtime, not freeze their realpath to an obsolete release.
Preserve `LATCH_HOME` behavior, task cwd, explicit session and argument boundaries.
Update only provably managed links; collisions cause no partial migration.

Explain setup versus daily automation, permission-update steps, popup revoke,
evidence locations, version/capability mismatches and normal rollback. Keep
official as the existing daily default until Phase 6; native tests/tasks use
explicit `--transport native`. Do not fall back to a different adapter or browser
after failure. Retain the Phase 4 unknown-outcome and no-global-security-change
guidance.

Validate skill structure and wrapper/link behavior in private fixture homes. Do
not claim actual Codex CLI, Claude Code or Cursor end-to-end verification merely
because all links resolve. Actual client smoke runs remain Phase 6 evidence.

**Exit:** one maintained skill works from the installed kit and a separate task
workspace; version errors and unsupported capabilities are actionable.

### P5 — Run acceptance, collect evidence and checkpoint

Run the 94 existing checks with their opt-ins plus focused new installer/build/
popup tests. Re-run real official/native attachment, multi-agent/lifetime and
recovery cohorts where installation or UI control changes those paths. If status
polling or new coordination changes normal command/attach costs, repeat the
isolated performance cohort. Count distinct checks and opt-in skips separately;
retain failed attempts and their successful confirmations.

Publish artifact inventories/hashes, installation receipts/deltas, upgrade and
rollback observations, popup screenshots, revoke/server receipts, cleanup audit
and honest permission/client coverage under the chat's `outputs/latch-phase-5/`.
Publish no raw profiles, endpoint credentials or task data. Confirm fixture-owned
processes, host registrations and runtime directories are cleaned up. Finish with
a read-only Work diagnostic, skill validation and a local Git checkpoint; no push.

## Acceptance matrix

All rows start **unverified**. Component coverage and actual browser/update tests
must be labelled separately in the results.

| ID | Required proof |
| --- | --- |
| A1 | Native artifact contains debugger/alarms, full module/assets graph, fixed key/ID and valid RC/final version ordering; missing identity fails. |
| A2 | Complete kit starts outside the checkout with pinned production dependency and licenses; no implicit global dependency installation. |
| A3 | Repeat-build inventory/hashes match; excluded private/fixture material absent; build leaves installed integration unchanged. |
| I1 | Clean installation in private roots, pairing and normal native CLI smoke succeed using the unmodified artifact. |
| I2 | Actual 0.1.2 fixture upgrades with stable ID/instance, retained pairing/auth/tabs and reviewed owned registration-path migration. |
| I3 | Missing/wrong prerequisites, unknown registration, unrelated skill and changed setup plan fail without partial activation. |
| I4 | Live tasks or unproven legacy maintenance state block activation; no forced global disconnect. |
| I5 | Repeated install is idempotent; caught failures restore prior owned state; hard interruption remains explicit and inspectable without stale-lock guessing. |
| I6 | Previous complete release works after task-drained rollback; schema-4 state/evidence preserved; uninstall affects only owned integration. |
| U1 | Popup accurately separates pairing, bridge readiness, native capability and sessions for this exact profile. |
| U2 | Status/diagnostic display is bounded and escaped; secrets absent; webpage/foreign/obsolete UI requests rejected. |
| U3 | Revoke A during pending data calls settles access/ownership, leaves B and physical tabs usable, preserves evidence and reports uncertainty. |
| U4 | Busy grant, duplicate click, stale row, successor lease, popup close, host loss and unconfirmed daemon cleanup produce truthful scoped results. |
| U5 | Explicit Retry stays within Phase 4's retry budget and never resumes automation or changes setup. |
| U6 | Headless popup page screenshots, keyboard flow, long content and status announcements verified; headed toolbar behavior clearly excluded. |
| S1 | Managed skill links/wrapper work from installed kit and separate cwd; unrelated links preserved through install/update/rollback. |
| S2 | CLI/help/docs/skill show coherent release and negotiated capabilities; runtime/extension mismatch is visible, with no silent adapter switch. |
| R1 | Existing 94-check coverage retained, relevant new regressions pass and resources return to baseline. |
| R2 | Permission-increase test scope recorded honestly; any actual human/Work acceptance remains a Phase 6 step. |
| R3 | Work diagnostic remains healthy/unchanged, cleanup audit is clear, and only a local checkpoint is created. |

## Implementation map

| Area | Responsibility |
| --- | --- |
| `src/build.mjs`, package/version metadata, release inventory | Deterministic native artifact, dependency/license inclusion and package exclusions. |
| `src/install.mjs`, installer support modules | Preflight, receipts, owned registration migration, stage/activation/rollback and private test roots. |
| `extension/background.js`, `bridge-connection.js`, `protocol.js` | Negotiated UI request correlation, sender/lifetime validation and bounded retry integration. |
| `src/native-host.mjs`, `native-recovery.mjs` | Sanitized own-profile status and coordinator-backed exact-lease UI revoke. |
| `extension/popup.html`, `popup.js`, optional local style/view module | Readable states, native task rows, details and truthful revoke outcomes. |
| `src/cli.mjs`, diagnostics, `src/install-skills.mjs`, shared skill | Coherent versions, managed link migration, installed-runtime resolution and instructions. |
| Build/installer/popup/upgrade test fixtures | Artifact-based headless install/update/revoke/rollback and failure evidence. |

## Completion rule and next phase

Phase 5 completes when the built native kit, owned installer upgrade/rollback,
popup status/revoke and canonical skill meet the matrix, with preserved recovery
invariants and explicit limitations. It is not complete merely because the popup
looks good or the extension ZIP loads.

The handoff is a verified local candidate, a concrete one-time Work upgrade
procedure and rollback artifact. Phase 6 then validates the actual Work update,
real permission acceptance, Latch-only application smoke, real terminal-client
contexts and eventual native-default cutover. Phase 5 does not perform that cutover.
