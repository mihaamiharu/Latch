# Phase 6 implementation and rollout status

Starting checkpoint: `0f52cf9`, October 29, 2026. Candidate: **0.2.0-rc.2**,
Chrome version **0.1.99.2**, native schema 4 and UI control 1.

The automated preparation and operator-assisted Work installation are implemented.
**The local native Work pilot passed with focus emulation enabled. Actual coding-
agent CLI application runs and native-default cutover remain pending.** The real
UI folder move changed the instance ID; the operator explicitly approved a backed-
up one-field Work rebind. Full original tab/login preservation is unverified.
The headless preparation and real Work observations below have separate scopes.

## Implemented

- Optional per-profile `defaultTransport`, inspected with `qa-browser transport
  --profile work` and explicitly selected with `--set native|official`.
- Transport precedence: explicit flag, recorded task adapter, profile preference,
  then official for existing configurations without a preference. Native disconnect
  still recognizes its retired record. Unknown/conflicting records fail clearly.
- Native preference requires a matching reachable schema-4 recovery-capable bridge.
  Official preference works offline for deliberate rollback. Existing task adapters
  are preserved, and unavailable native capability never selects official silently.
- Doctor reports the effective adapter/source, including recorded-session state.
  Diagnose separates profile preference from bridge capability; an invalid
  preference does not become a false missing-pairing result.
- Pairing and preference updates use one exclusive configuration gate, preserving
  unrelated profile fields and refusing to reclaim an existing gate by PID/age.
  Repeating the same pairing preserves its configured default.
- Shared skill/setup instructions describe effective defaults and the separate
  rollout step. Preparation changed no discovery links/security settings; after
  the successful Work pilot, proven managed Latch skill links were migrated to
  installed RC2. Global client security settings remain unchanged.

## New browser evidence

The path-migration fixture starts actual 0.1.2 code in a legacy folder, establishes
its instance/pairing, and opens three marked fixture pages across two windows with
an existing tab group. It disables that extension, activates the packaged RC2,
loads the managed physical directory and explicitly enables it. It then rolls
back to actual old code through the stable directory.

The same Chrome instance, extension instance, pairing bytes, physical tab/window/
group identities, page JavaScript heap markers, unsaved input, cookie observation
and local storage survived migration and rollback. No replacement page was seeded
to satisfy a preservation assertion. Earlier fixture attempts and their corrections
are retained in the local logs: enabling extensions in the private driver, valid
native registration metadata, and explicitly enabling the moved extension.

This is **headless setup-only evidence** using Chrome's experimental
`Extensions.loadUnpacked`, not the normal Latch data path or real human permission
acceptance. Its unsafe-extension-debugging flag and driver pipe apply only to the
private disposable fixture. The separate installed-kit test uses actual native
messaging and ordinary unmodified Playwright CLI attachment without that driver.
See the [Chrome API implementation](https://chromium.googlesource.com/chromium/src.git/+/225b2eaa7f23c33b7c4e30c1bfc58f1bd99cbe1c%5E%21/).

The popup-closure fixture pauses exact CLI cleanup after the host accepted revoke
and stopped native access, closes the real popup page, then allows cleanup to
finish. Reopening accurately omits the retired A lease; B remains usable, tabs
remain open and the server records one mutation. A stale request cannot revoke
A's successor. The pause exists only in a copied private host source.

The installed clean kit also selected native for a new session with no transport
flag and retained that native session after the preference changed to official.
Old official/session compatibility and explicit mismatch rejection are tested
separately; config mutations and test aliases remain private.

## Human rollout boundary

`AGENTS.md` says: “Keep test profiles disposable and keep the installed Work
browser unchanged.” Automated work follows that instruction. The prepared
[Work pilot runbook](PHASE-6-WORK-PILOT-RUNBOOK.md) needs an explicitly scoped
exception before installed Work changes/verification. Chrome permission acceptance
is operator-controlled; there is no desktop control, headed fixture fallback,
forced restart, automatic re-pairing or global client-security change.

The read-only baseline verifies the old candidate/rollback hashes and records
configuration/registration/launcher hashes plus skill-link targets. The actual
loaded extension path and official-extension enabled state still require the
operator's Chrome observation; a legacy preview is not runtime proof.

Prepared handoff: exact change sheet/inspection, complete RC2 kit, actual old
rollback artifact, standalone local pilot fixture, per-client smoke prompts and
sanitized observations. Run the real client prompts only after installed readiness
and the approved target tab are established. Only local fixture mutation is
included; a signed-in staging check needs its specific intended tab and stays
read-only.

## Verification record

Fresh verification: the broad serial run passed 116 and skipped three optional
checks out of 119 registered checks, with zero failures. The final default run
passed 80 and skipped 39. Separate real-browser checks cover path migration and
the original authenticated official case. The isolated performance cohort was
not repeated; it remains historical Phase 5 evidence, not a fresh pass.

The consolidated report under the chat's `outputs/latch-phase-6/` records selected
runs, exact new counts/skips, artifact hashes, failed attempts and cleanup. Prior
Phase 5 results remain historical evidence; they are not counted as fresh Phase 6
passes. No performance rerun is claimed: these changes do not introduce a relay
poller or alter the normal Playwright data path. Final support still excludes
managed download retrieval and previously unsupported worker behavior.

Phase 6 is **not complete** until real Work preservation/permissions, claimed
client contexts, concurrent ownership, Personal-foreground observation, explicit
Work default and rollback gates are verified. A local preparation checkpoint does
not change those statuses. No push or publication.


## Operator-assisted Work observations

Observed October 29, 2026, Asia/Jakarta. The user explicitly authorized a narrow
Work-pilot exception to AGENTS.md, confirmed the legacy loaded folder, disabled
Latch, then loaded/enabled the managed RC2 directory. Runtime activation retained
the actual 0.1.2 payload and preserved pairing bytes initially. The supplied
screenshot showed Latch RC2 enabled and the official Playwright extension disabled.
Native operations subsequently prove effective debugger permission; the precise
Chrome permission-prompt presentation/prior official state were not reported.

The real UI migration produced a different stored instance ID. The existing Work
alias was left untouched until the operator confirmed the Work popup and explicitly
selected the backed-up repair. Only its instance ID changed; all other config
fields remained. This is an accepted rebind, not an identity-preservation pass.
The metadata comparison matched 14 of 15 original web tab IDs, retaining the matched
windows/groups. One original web tab was absent from the web-only listing and one
URL hash changed. Full pre-update preservation/login state was not established;
no unrelated page content was read.

The first native fixture attempt attached and captured readable screenshot/snapshot
evidence but timed out waiting for button stability. It disconnected normally.
Independent server receipts showed no save, and a fresh read-only connection still
observed Waiting. Focus emulation then reported visible/focused state and two
animation frames. A distinct marked case with focus emulation on saved once with
one matching server receipt, adopted/released a child, retained parent state,
captured after evidence plus console/requests and disconnected. Both physical tabs
remained open/unowned. The failed attempt and inspected outcome remain in evidence.
This is a local background-fixture observation, not a real-focus guarantee.

Two independent normal CLI workspaces also attached A/B, exposed only their own
targets, rejected foreign target metadata and kept B usable after A disconnected.
Both cleaned up with tabs preserved. This was one Codex desktop orchestrator using
normal Playwright CLI processes, not actual Codex CLI/Claude Code/Cursor model runs.
Real popup Stop-session and Personal-foreground observations remain pending.

After this pilot, setup migrated only the proven .agents/.claude Latch skill links
to the matching installed RC2 skill. The default remains unset/official. Separate
Codex/Claude/Cursor local fixture tabs are open and unowned, with explicit-native,
focus-emulation smoke prompts ready. Their model/client contexts have not run.
The local server is intentionally retained for these checks; no test lease remains
from the completed pilot/preparation/isolation sessions.

The artifact/runtime source remains software checkpoint 57ccca5. These observations
update documentation only; the frozen installed release was not rebuilt or patched.
No global client-security setting, unrelated application data or profile was changed.
Nothing was pushed. Phase 6 remains incomplete until the remaining claimed client,
foreground, application-scope and default gates are handled. A rollback must verify
the actual current extension instance rather than blindly restoring the old binding.
