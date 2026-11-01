# Latch 0.2.0-rc.6 local setup

This private macOS candidate includes the native extension, host/CLI, shared skill,
`ws` 8.22.0 and third-party licenses. Node **22.21.1** and Playwright CLI **0.1.20**
are external prerequisites. Setup validates them without installing anything
globally. Keep the full kit together; the extension ZIP alone is insufficient.
This candidate requires Apple Silicon (arm64), macOS 27.0.1 or later and Chrome
147 or later. See `SUPPORT.md` in the kit for exact tested builds and limitations;
older macOS/Intel qualification is deferred. Unsupported prerequisites fail before
setup changes the installation or configuration.

Automated browser tests use disposable headless profiles. The current operator-
assisted Work installation is RC3 with native selected explicitly for that profile.
Its actual Codex CLI smoke passed under per-session Full Access; other client and
permission modes remain unverified. The procedure below also serves first installs,
whose profile/default selection must be verified explicitly. See the current
release-readiness review in the source repository. The frozen installed RC3 kit
is not rewritten when this source document is updated.

## Inspect and stage

Unzip the complete kit into a permanent local directory. Use the selected Node
executable, then inspect from that directory:

```bash
LATCH_KIT='/absolute/path/to/latch-0.2.0-rc.6'
node "$LATCH_KIT/src/install.mjs" inspect --kit "$LATCH_KIT"
node "$LATCH_KIT/src/install.mjs" stage --kit "$LATCH_KIT"
```

The default runtime is `~/Library/Application Support/Work Browser Bridge/runtime`.
`releases/` contains complete hashed payloads, `current` selects the local host/CLI,
and `extension/` is a stable **physical directory**. Launchers capture the selected
Node and CLI executables and configuration/runtime paths. Staging changes no Chrome native
registration. `--root`, `--registration-root`, `--node` and `--playwright-cli` select explicit paths;
use identical options for all subsequent operations.

RC6 resolves and validates the CLI during inspection, then pins its absolute
executable in the receipt. The managed host and CLI use the selected Node's
executable directory in their own process PATH, so Chrome does not need to inherit
the installing terminal's PATH. No global shell or security setting is changed.
The plan token includes the CLI entrypoint hash; that is not a hash of its entire
external dependency tree. Node/CLI remain external prerequisites. If a pinned
executable is removed, preflight reports it instead of selecting another program.
Inspect a repaired path with `--playwright-cli` and use the normal drained/unloaded
activation procedure; do not replace receipts or clear recovery state manually.

The kit includes [data handling](PRIVACY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
The owner selected local internal delivery and no public project license yet.
Repository setup, uploads and public support/distribution URLs are deferred. This
kit does not grant a public project license; third-party notices retain their own
terms. These choices do not replace the remaining local acceptance gates.

A pre-receipt 0.1.2 registration requires both `--legacy-root` (the original checkout
with its exact `install/preview.json` and native manifest) and `--rollback-kit`
(the complete actual 0.1.2 payload). Export that payload from checkpoint
`ad4819827f0fc994a1df39aed930a2bab8f44972`; do not reconstruct it using current
code. The prepared handoff includes a retained baseline archive. Include both
options during inspect, stage and activate. An unrelated registration or skill is
a blocker, preserved unchanged.

## Activate once, then verify

Finish/disconnect every affected task. Disable the target Latch extension in
Chrome and confirm its host exits before replacing files. RC2's headless setup
rehearsal moved an actual 0.1.2 extension from its old folder into the managed
folder using Chrome's test-only installation API, then explicitly enabled it.
Its instance, pairing, tabs/windows/groups, page memory and unsaved fixture input
survived without a browser restart. Actual Chrome UI/permission acceptance in
Work remains unverified and requires the operator-assisted rollout gate.

Do not uninstall the existing extension, silently re-pair, automate Chrome's
permission UI or force a browser restart. A restart is only a separately accepted
fallback maintenance procedure and may affect Personal in the same Chrome process.
Version metadata alone does not prove that the expected code is ready.

Inspect again, review the returned paths, permission delta and rollback target,
then pass that exact `planToken`:

```bash
node "$LATCH_KIT/src/install.mjs" inspect --kit "$LATCH_KIT"
node "$LATCH_KIT/src/install.mjs" activate --kit "$LATCH_KIT" \
  --expect '<planToken from this inspection>' --tasks-drained --extension-unloaded
```

These flags are operator attestations. Setup additionally requires configured
bridge sockets to be unreachable; it cannot prove Chrome was unloaded or accept a
permission prompt. Activation returns `verified: false` until browser verification.
It does not restart browsers, disconnect tasks, pair profiles or change defaults.

In the intended Chrome profile, use Load unpacked to select the returned stable
`extensionDirectory`. Review the fixed ID `dlkpkeiejlgggeoibejpoajedoelfcli` and
explicitly enable the updated extension. Accept Chrome's added debugger permission
yourself. Use this same path for future updates; do not keep loading the checkout.
The headless fixture needed an explicit enable after the directory move. Its
API-based permission enable does not prove real human permission acceptance.

For an existing profile, preserve its stored instance and pairing. For a clean
profile only, inspect the popup/discovery result, then explicitly pair that exact
instance and Chrome profile directory using `qa-browser pair --help`.

```bash
LATCH_RUNTIME="$HOME/Library/Application Support/Work Browser Bridge/runtime"
"$LATCH_RUNTIME/bin/qa-browser" diagnose --profile work
node "$LATCH_KIT/src/install.mjs" verify --profile work
```

Verification checks the installed identity/readiness and requires extension
`0.1.99.6` (display name `0.2.0-rc.6`), release `0.2.0-rc.6`, native schema 4 and
UI capability 1. It separately reports `applicationSmokeRequired: true`. Complete
a disposable native CLI smoke against the intended app before calling rollout
successful; do not silently fall back to another adapter.

Select native for this verified profile during setup:

```bash
node "$LATCH_KIT/src/install.mjs" configure-native --profile work
```

This re-verifies installed identity/readiness and uses the managed launcher's
configuration. It sets only that profile's default after a fresh schema-4
controller round trip. Existing sessions retain their adapters. It does not
enable the official extension or treat a bridge check as application acceptance.

## Shared skill and daily use

After verification, explicitly install/migrate only managed discovery links:

```bash
node "$LATCH_KIT/src/install.mjs" skills
```

This links `.agents/skills/latch` and `.claude/skills/latch` through `current`.
It preserves unrelated skills. The packaged wrapper preserves the task cwd,
arguments and selected runtime configuration. `LATCH_HOME` remains an explicit
runtime override. Link tests do not prove actual Codex/Claude/Cursor execution;
run each intended terminal client separately during Phase 6.

Use the skill from the task workspace. Native preview connections use explicit
`--transport native --focus-emulation on` for ordinary background interactions
during rollout; keep emulation off for real focus/visibility assertions. Profiles without a preference still default
to official; inspect `qa-browser transport --profile work`. New setups should use
the verified `configure-native` step above. Existing sessions retain
their adapter; explicit `--transport official` remains available. Give each agent a unique
session. The popup shows only this profile's pairing/session metadata and can stop
one schema-4 native session while preserving website tabs and peers. A busy
operation is not bypassed. “Access stopped; CLI cleanup unconfirmed” requires
scoped reconciliation. Retry restores bridge readiness, never automation.

Before discovery/attachment, run from the actual task/client context:

```bash
"$LATCH_RUNTIME/bin/qa-browser" preflight --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
```

Require `ready: true`. The result distinguishes platform/dependencies, bridge and
controller, native capability, exact task/cache write paths and local networking.
It creates missing task/cache directories but removes its own probe files. It
does not attach or establish application acceptance. Access denied is different
from an unpaired profile. Permission facilities must be checked in the actual
agent's tool inventory; the CLI cannot know which tools are available. Stop if no
appropriate scoped route is exposed; never change global security or retry an
uncertain browser action to work around a blocked preflight.

RC3 adds an optional error-normalizing adapter for an already attached task:

```bash
"$LATCH_RUNTIME/bin/qa-browser" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" -- snapshot
```

It runs the unmodified pinned Playwright CLI, returning exit 1 for tool errors
even when upstream exits zero. It never attaches, changes transports, force-clicks
or retries an action. Direct CLI use remains supported; inspect its JSON `isError`
as well as its exit code. A successful doctor/diagnose does not verify the separate
official extension handshake. RC3 attach errors retain bounded redacted upstream
detail and selected-transport metadata.

RC5 adds recorded commands with `--evidence-dir`, stable `--step` IDs and explicit
result/error expectations. See [recorded evidence](skills/latch/references/evidence.md)
for maintained human/agent reports, offline integrity checking and selected export.
Do not pass a filename to recorded snapshot/screenshot commands; the recorder
supplies a fresh path.

Save reports/screenshots/snapshots under the task's chosen directory, normally
`work/latch/<session>/`. Runtime journals are local recovery state, not exported
evidence. Preserve completed artifacts after disconnect. Never replay a save,
upload or submission when its response was lost: its outcome may be unknown.
Socket EPERM/EACCES needs command-scoped execution authorization in the failing
client; setup does not change global security settings.

## Rollback and uninstall

Drain tasks, disable Latch and confirm its host exits using the same maintenance
procedure. Roll back using the retained complete release:

```bash
node "$LATCH_KIT/src/install.mjs" rollback --tasks-drained --extension-unloaded
```

Reload/select the stable extension directory and explicitly enable it as above,
then run diagnostics and a normal
CLI smoke. Actual 0.1.2 rollback uses the stable launcher/registration pointing to
retained 0.1.2 code and restores migrated legacy skill links. It does not restore
the original checkout path as the active runtime. Caught activation failure does
restore the exact prior registration/receipt/launchers. Schema-4 journals and
evidence remain; old clients must not interpret newer native state.

`uninstall --tasks-drained --extension-unloaded` unregisters only the exact owned
host and managed skill links. It preserves release payloads, pairing, journals,
evidence and browser data. Remove the extension separately only if desired.

An interrupted installer leaves `setup.lock` and `transaction.json`. Inspect them
and stop: PID/age do not authorize deleting the gate. There is no automatic
crash/power-loss repair. Restore an interrupted installation only after reviewing
its recorded state and proving ownership; do not guess which paths changed.
