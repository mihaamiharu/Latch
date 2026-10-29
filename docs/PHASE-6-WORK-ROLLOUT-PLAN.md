# Phase 6: Work rollout and native default

Prepared October 29, 2026. Implementation in progress; no Work rollout performed. See
`PHASE-6-IMPLEMENTATION-RESULTS.md` for completed preparation and pending gates.
Starting checkpoint: `0f52cf98b321a1546f452c6ca00d855ae1805e2a`.
Baseline: Phase 5 local candidate 0.2.0-rc.1, Chrome version 0.1.99.1,
112 distinct passing checks across selected runs. Installed Work last reported
healthy 0.1.2 with native transport unavailable. Recheck this when execution begins.

## Outcome and scope

Make the existing signed-in Work browser usable through Latch alone from actual
Codex CLI, Claude Code and Cursor CLI contexts. Preserve pairing, browser state,
other agents and completed evidence. A new daily task must discover/connect its
intended tab without desktop control, manual dragging, browser restart or an
implicit transport fallback.

A one-time installation/permission operation is separate from daily automation.
Keep the official extension installed as a rollback option. Disable it temporarily
only for the scoped Latch-only pilot, recording and restoring its prior state on
failure. Uninstalling it, publishing, pushing and changing global client security
settings are outside this plan.

Current `AGENTS.md` requires headless disposable browser tests and says to keep the
installed Work browser unchanged. Automated development/rehearsal follows that
rule. The later Work pilot requires explicit authorization for a narrow exception:
one-time Work installation plus scoped existing-browser verification. Record that
exception before execution; do not infer it from permission to run fixture tests.
No headed fallback or desktop automation is part of either track. Chrome's human
permission acceptance remains a user-operated installation step.

## G0 — Freeze artifacts and capture the starting state

1. Verify candidate and actual 0.1.2 rollback ZIPs against the Phase 5 hashes.
   Use the complete kit, not the extension ZIP alone. Confirm selected Node,
   Playwright CLI and browser versions; do not silently upgrade prerequisites.
2. Capture read-only Work diagnostics, exact native registration bytes/path,
   pairing configuration hash, extension source path, managed skill-link targets,
   running task identities and the official extension's prior enabled state.
   Confirm the actual loaded path through user-visible extension details; a legacy
   preview file describes intended setup and is not proof of Chrome's current path.
3. Prepare private rollback material: owned registration/launcher/link values,
   retained actual 0.1.2 payload and the documented restore procedure. Do not export
   a Chrome profile, cookies or login databases. Record metadata and hashes only.
4. Create a concrete proposed change sheet showing old/new runtime and extension
   paths, fixed extension ID, added permissions, commands, maintenance requirement,
   expected capabilities and rollback trigger. Inspection is not activation.

**Gate:** candidate provenance and old state are known; no live Work change.

## G1 — Close the remaining disposable-profile gaps

All automated browser work stays headless with full Chrome for Testing, private
profiles and private registrations. Use actual packaged payloads and the retained
0.1.2 checkpoint.

### Extension-path migration and preservation

Phase 5 proved a stable physical-path replacement and restart. Its installed-kit
upgrade case started the browser with the candidate already selected; it did not
prove moving an already-loaded legacy checkout extension into the managed path.

Reproduce that exact path migration: start actual 0.1.2 from a legacy directory,
pair it, create uniquely marked tabs across two windows/groups, then migrate to
`<runtime>/extension` using a supported mechanism exercised by the fixture. Do
not equate matching public keys with proven storage/instance preservation.

Record before/after extension ID, stored instance, configuration bytes, versions,
capabilities, tabs/windows/groups, persistent fixture authentication and state.
Cover rollback from the new directory to actual old code as well. Never uninstall
and re-pair to make a preservation assertion pass.

Record mechanisms separately: in-place update, extension path change, reload and
browser restart are different cases. Use a bounded investigation; do not repeat
Phase 5's failed reload approaches without a new hypothesis. If the permitted
headless tools cannot exercise the real browser installation gesture, mark that
specific transition unverified and prepare a user-operated disposable-profile
rehearsal before Work. Do not claim the path-migration gate passed from a mock.

After a restart, tab IDs can change. Verify the same fixture page markers and
window/group relationships, and report the changed IDs. A newly seeded replacement
page is not retained-tab evidence. Check fixture tab-local state separately from
persistent cookies/storage; do not claim unsaved application state survives a
reload or browser quit.

### Popup closure during accepted cleanup

Add a deterministic headless test: A and B are attached; A has a held application
call with an independent receipt. Click Stop session, wait until the host accepts
cleanup, close the popup page, and let cleanup finish. Reopen it and verify A's
lease is stopped/retired or truthfully cleanup-unconfirmed, B still works, tabs
and artifacts remain, and the mutation was not replayed. A stale duplicate must
not affect A's successor. Keep any pause/fault hook in private fixture copies.

### Prepare default selection without enabling it

Implement optional per-paired-profile `defaultTransport` support in the candidate,
leaving existing configurations on official. Freeze the precedence defined in G5,
cover unknown/legacy records and unsupported capability, and update doctor/help
and the skill. The setter command name is proposed work, not an implemented
command today. Use private configuration fixtures for all tests.

Ship this support in the artifact frozen at G2 so cutover later changes only the
explicit Work preference; avoid requiring a second extension update just to add
default selection. Do not enable native in the real configuration during development.

### Decide the usable one-time update procedure

Prefer a proven reload that preserves existing tabs. If only browser restart
works, describe it as installation downtime affecting all profiles in that Chrome
process, including Personal. Do not quit a user's browser automatically. Offer
that route only as a separately accepted one-time maintenance procedure, with
state-preservation limits made explicit. Keep daily automation restart-free.

**Gate:** an executable migration/rollback procedure has actual evidence, or an
explicit unverified browser-UI step remains blocked for a disposable human rehearsal.
No Work activation while preservation is uncertain.

## G2 — Prepare the Work handoff

Freeze the tested artifact and exact change sheet. If code changed, produce a new
RC rather than overwriting the tested 0.2.0-rc.1 identity. Record the resulting
version, source revision and file hashes; regenerate commands from that artifact.

Provide one short operator runbook: save unsaved work, drain only affected Latch
tasks normally, perform the proven extension unload/update action, accept the
new Chrome permission, and confirm readiness. Installer maintenance flags are
attestations; they do not prove Chrome unloaded or accepted a permission.

Stage only after the ownership/inspection checks pass. Before activation, inspect
again and use the fresh plan token. Never use another client's lock, delete a stale
installer gate, re-pair Work automatically or detach unrelated automation.

Use version/capability verification to require the frozen release, schema 4,
recovery contract and UI control 1. An installer readiness pass remains separate
from application verification.

**Gate:** reviewable installation and rollback steps are ready; Work pilot scope
has been explicitly authorized. This plan request alone does not perform rollout.

## G3 — Controlled Work pilot

1. Record a before-inventory of the intended Work tabs/windows/groups and visible
   signed-in state, without accessing unrelated content or Personal's tab inventory.
   Resolve unsaved work before a user-operated restart, if that route was accepted.
2. Apply the proven one-time installation sequence. The user handles Chrome's
   permission UI. Verify the fixed extension ID, retained instance and pairing;
   compare after-inventory and state. A new instance or missing tabs is a failed
   preservation check, not a reason to silently re-pair.
3. Use the installed runtime's diagnostics and setup verification. Mismatch,
   denied permission, EPERM, an interrupted transaction or unknown ownership stops
   the pilot at that specific boundary. Preserve evidence and the old setup.
4. Temporarily disable the official extension in Work through the agreed operator
   step. Run a complete explicit-native smoke on a disposable local fixture tab
   in Work: inspect, input/assert a marked fixture value, owned child tab, screenshot,
   snapshot, console/request metadata and normal disconnect. Include one read-only
   observation of the intended signed-in staging app to establish real session reuse.
5. Confirm website tabs, groups and sign-in survive disconnect, and no task remains
   claimed. Restore the official extension's prior state if the pilot fails.

The private fixture server/evidence directory is prepared by the agent. The
operator may open its single marked URL in Work during setup; daily attachment
must subsequently discover the existing tab automatically. No tab dragging or
manual Playwright attachment is an acceptance step.

**Gate:** evidence proves installed Latch-only operation in Work. Real permission
acceptance and tab preservation have separate recorded outcomes.

## G4 — Actual terminal clients and concurrent agents

After G3 installed verification/Latch-only smoke, migrate only proven managed
skill links and verify the installed targets. Start fresh clients and use the
installed canonical skill from separate task workspaces. Ship a concrete
smoke prompt per client containing its fresh session name, approved target URL,
workspace, explicit native transport, assertions, evidence directory and cleanup.
Run diagnostics inside the actual client's execution context before attachment.

| Client | Required evidence |
| --- | --- |
| Codex CLI | Actual version/context, same-context diagnostic, installed skill/runtime, native app smoke and disconnect. |
| Claude Code | Same workflow through its discovered canonical skill; actual result, not a symlink-only claim. |
| Cursor CLI | Same workflow when installed/available; otherwise mark unverified and scope the supported release accordingly. |

For EPERM/EACCES, use the client's supported command-scoped approval path when
available. If denied/unavailable, report blocked. Do not disable its sandbox or
edit global security configuration. A diagnostic approval does not automatically
prove permission for the separate Playwright data transport.

Run A and B concurrently in distinct workspaces on distinct disposable Work tabs.
Stop A through the popup while B remains usable. Preserve both tabs and evidence.
Then have the user foreground Personal and repeat a bounded Work fixture read/
input check with the selected focus policy recorded. Do not inspect Personal or
claim headless tests prove this real foreground interaction. If focus emulation
is used, report it and keep it off for real-focus/visibility assertions.

**Gate:** actual results exist for every claimed supported client; simultaneous
session ownership and Work targeting hold. Unavailable clients stay unverified.

## G5 — Explicit native-default cutover and rollback drill

Keep `--transport native` explicit throughout the pilot. The default-selection
code is implemented/tested in G1 and included in G2's frozen artifact. Only after
G3/G4 pass, deliberately set the paired Work profile's preference to native using
the tested setter. Other profiles/configurations retain their preferences.

Resolution order: explicit transport override, existing recorded session
transport, paired profile's configured default, then legacy official default when
no preference exists. Release/disconnect continue using recorded transport,
including native cleanup records. Existing sessions never migrate adapters because
a default changed. Doctor/help/skill report the effective default consistently.

G1's meaningful configuration/precedence and headless installed tests must prove
that unavailable native capability fails clearly with a native default, without
fallback, and explicit official override remains available. At cutover, verify
those same effective settings through the installed CLI and a fresh task that
omits the transport flag. Do not repeat unrelated browser cohorts without a new
change or concern.

Confirm the managed skill links migrated for G4 still select the active runtime.
Verify fresh client discovery, cwd/session isolation and evidence paths.
Document `LATCH_HOME` overrides that could still select a checkout.

Rehearse rollback on disposable installations with current journals and evidence:
drain tasks, restore actual 0.1.2 payload/links, restore official-default behavior
and the prior official-extension state, verify readiness plus normal official
smoke. The live rollback path preserves data and requires its own maintenance
step. Never read newer native journals as legacy state or replay uncertain actions.

**Gate:** native is deliberately selected for Work, normal fresh tasks require no
transport flag/manual attachment, and explicit rollback remains usable. Keep the
official extension installed; removal is a separate user decision.

## Evidence and completion

Use `outputs/latch-phase-6/` for the consolidated report and sanitized evidence;
client tasks use `work/latch/phase6-<client>-<run>/` in their own workspaces.
Include artifact hashes, actual before/after path/permission/identity observations,
installer receipts, tab/state-preservation results, popup-close test, per-client
contexts/results, Latch-only proof, concurrency/Personal-foreground observations,
default resolution, rollback drill, cleanup and final read-only diagnostics.

Publish no cookies, tokens, profile databases or raw CLI attachment registries.
Keep pass/fail/blocked/unverified separate. Count distinct checks and opt-in skips
without presenting old Phase 5 results as new Phase 6 passes. Retain failed attempts.
All automated fixtures remain headless and record test-only flags. Actual Work
observations are separately labelled operator-assisted installed-profile evidence.

If a mutation response is lost, record unknown outcome, perform scoped cleanup and
inspect application state independently; never automatically replay it. Managed
download retrieval, worker backfill and other previously excluded features remain
outside scope.

Finish with a local checkpoint and an honest support matrix. Phase 6 completes
only when installation preservation, real permission acceptance, installed native
application verification, claimed terminal clients, ownership, explicit default
and rollback gates pass. Promote a final 0.2.0 only after the exact final artifact
gets its own identity/readiness and application smoke. No push or publication.

**First execution step:** G0 and headless G1, with the current Work installation
unchanged. Prepare the concrete Work pilot only after those results are known.
