# Phase 6 Work pilot: operator handoff

This runbook describes the prepared RC2 pilot. It is not evidence that Work has
been upgraded. Automated development remains headless and disposable under
`AGENTS.md`. Actual Work setup/verification requires the explicitly authorized
Phase 6 exception. No client-global security changes, extension removal or push.

## Proposed changes

| Integration | Before | Proposed after |
| --- | --- | --- |
| Work extension | Last reported 0.1.2; actual loaded path must be confirmed in Chrome | Latch 0.2.0-rc.2 / Chrome 0.1.99.2 from the managed physical extension directory |
| Public extension ID | `dlkpkeiejlgggeoibejpoajedoelfcli` | Same ID; stored instance and pairing must match |
| Native host registration | Original checkout's `install/native-host` | Owned runtime's `bin/native-host` |
| Runtime root | Checkout-based code | `~/Library/Application Support/Work Browser Bridge/runtime` |
| Permissions | Review actual current Chrome list | tabs, tabGroups, storage, nativeMessaging, alarms, debugger; no website host permissions/content scripts |
| Agent skill links | Canonical checkout links | Managed `current/skills/latch`, only after verification |
| New-session default | Legacy official, unless explicitly configured otherwise | Unchanged throughout pilot; native selected only after real-client gates |
| Official extension | Record actual prior state | Temporarily disabled for Latch-only proof; retained for rollback |
| Personal browser | No access authorized | No inventory/content interaction; any proposed shared-process restart requires separate agreement |

The full release/rollback paths and fresh inspection result are recorded in the
chat's `outputs/latch-phase-6/` handoff. Use those exact artifacts. Do not substitute
a newly rebuilt ZIP with the same version or a different Node/CLI.

## One-time Chrome steps

1. Confirm the intended Work profile, actual loaded Latch path, ID and current
   official-extension state. Save unsaved work; finish affected automation normally.
2. Disable Latch in Work. The agent verifies its configured host socket has exited
   and runs a fresh installer inspection. Existing live bridges, unexpected paths,
   foreign integration or a transaction gate remain blockers.
3. The agent activates using the reviewed artifact and fresh plan token. This
   replaces owned runtime/registration files, not profile data. Maintenance flags
   record the operator's unload/drain attestations.
4. In Work's extension page choose Load unpacked, select the returned managed
   `extensionDirectory`, then explicitly enable it and accept Chrome's permission
   prompt yourself. Do not Remove/uninstall the old extension to force this step.
5. The agent verifies the same stored instance/pairing and expected RC2 capabilities.
   Compare the selected website tabs/windows/groups and visible signed-in state.
   Any changed instance or lost state stops the pilot; do not automatically pair
   a replacement or treat newly opened tabs as retained ones.

The rehearsal used full headless Chrome and `Extensions.loadUnpacked` through a
private setup-only driver, followed by explicit enable. It preserved actual
fixture tabs, groups/windows, page memory and unsaved inputs across migration and
rollback. Chrome's human UI/permission path is separately unverified. The test-only
`--enable-unsafe-extension-debugging`/pipe connection never belongs in Work or
normal Latch launchers. See Chrome's
[installation API implementation](https://chromium.googlesource.com/chromium/src.git/+/225b2eaa7f23c33b7c4e30c1bfc58f1bd99cbe1c%5E%21/).

## Latch-only and client checks

Start the supplied private fixture server only for the authorized pilot:

```bash
node /absolute/path/to/outputs/latch-phase-6/pilot-fixture.mjs \
  /absolute/path/to/outputs/latch-phase-6/pilot-evidence
```

Use the actual URLs written to `pilot-evidence/fixture.json`; the operator opens
the marked case URL in Work once. Disable the official extension temporarily in
that profile through the agreed operator step. The agent then discovers/connects
the existing fixture tab using explicit native transport, verifies a marked input
and one server-receipted save, checks an owned child, captures screenshot/snapshot
and console/request evidence, and disconnects normally. No manual tab dragging,
Playwright attachment, alternate browser or desktop automation is an acceptance step.

After installed readiness and the Latch-only smoke pass, migrate only the proven
managed skill links through setup and verify their targets. Start fresh clients
so discovery uses the installed canonical skill. Run the prepared per-client
prompt inside actual Codex CLI, Claude Code and Cursor
CLI workspaces. Version availability is already observed; actual execution is
still unverified. Each prompt has its own workspace, session and evidence path.
Use command-scoped execution approval if the client supports it when EPERM occurs;
otherwise preserve the error and report blocked. Do not broaden global settings.

Use A/B fixture tabs for concurrent clients. Stop A through the popup; verify B,
website tabs and saved evidence survive. For the Personal-foreground observation,
the operator foregrounds Personal while a bounded fixture action targets Work;
do not inspect Personal. Report focus emulation if deliberately used.

The fixture authorizes only local fixture mutations. A read-only signed-in staging
check requires the specific intended app tab/URL and records no credentials. Do
not reuse a historical issue/test mutation merely because it appeared in old chat.

## Cutover and rollback

Only after real Work preservation, permissions, Latch-only operation and claimed
client checks pass, confirm the managed skill targets and deliberately set Work's
new-session preference:

```bash
"$LATCH_RUNTIME/bin/qa-browser" transport --profile work --set native
```

`LATCH_RUNTIME` is the exact runtime path from the inspection. Verify a fresh
session without a transport flag chooses native. Existing sessions retain their
adapter; explicit `--transport official` remains available. No automatic fallback.

On a pilot failure, preserve diagnostic/evidence state and stop uncertain actions.
Restore the prior official-extension state and run the scoped rollback procedure:
normal task cleanup, official preference where necessary, extension disabled,
owned host exited, retained actual 0.1.2 payload selected, stable extension enabled,
then identity/readiness and normal official smoke. A changed installer gate or
ambiguous ownership requires inspection, not PID/age-based deletion. No replay of
an uncertain save/upload/submission, profile copy, cookie clearing or broad kill.
