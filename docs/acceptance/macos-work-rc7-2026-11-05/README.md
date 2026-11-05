# Work RC7 update and identity observations

Operator-assisted, in real headed Google Chrome 157.0.8103.39 in the Work profile, as
an owner-approved exception to the rule that keeps Work unchanged. The operator made
every Chrome action; the agent read state through Latch and the installer. No cookies,
page content or Personal content were read. Automatic browser evidence is separate:
see the [headless qualification](../macos-rc7-qualification-2026-11-05/README.md).

Installed kit: `0.2.0-rc.7`, source `3b99c12`, descriptor
`8a7ac03d167b32f8f98c85462ffc58b5d7e93d2065d509da2d82d32f0d3e0703`.

## Result

**A switch-and-reload update kept the instance ID in both directions, once each, with
Chrome loading the managed folder.** The ID changes on 2026-11-01 and on this update
remain unexplained, so identity preservation is observed on this path, not proven in
general.

| Step | Instance | Extension Chrome reports | Host | Operator-reported Chrome result |
| --- | --- | --- | --- | --- |
| Baseline, RC7 | `dffe7611` | 0.1.99.7 | RC7 | Loaded from managed folder |
| Rollback, then switch on | `dffe7611` | **0.1.99.7, stale** | Nov 4 RC6 build | "An unknown error occurred when fetching the script." |
| Reload icon | `dffe7611` | 0.1.99.6 | Nov 4 RC6 build | No new error |
| Reactivate RC7, then switch on | `dffe7611` | **0.1.99.6, stale** | RC7 | No new error |
| Reload icon | `dffe7611` | 0.1.99.7 | RC7 | No new error |

After the final step `verify` and `preflight` passed, and `config.json` was unchanged
throughout. Neither checks an application run, so this is not an attachment or
application result.

## Findings

- **The switch alone does not complete an update.** Chrome keeps reporting the previous
  extension version until the reload icon is pressed, leaving the host and extension on
  different versions. `verify` is what catches this.
- **The script-fetch error recurred** after one of the two switch steps here, and was
  also reported on 2026-11-04. Latch kept working each time. Its cause is unknown.
- **`transaction.json` is not a health signal after activation.** Only activation and
  rollback write it, so it keeps saying `activated-awaiting-browser-verification` after
  `verify` passes.

## The ID change during this update

The first activation today changed the instance from `e4ce81c8` to `dffe7611`. It is
**not** a switch-only result: Chrome was found loading
`dist/latch-0.2.0-rc.7/extension` in the checkout, after an operator Load unpacked.
When and in what enabled state that folder was loaded is not established.

Moving the enabled extension from that folder to the managed folder with Load unpacked
kept `dffe7611`, so changing folder while enabled does not by itself reset the ID.
Loading a different folder while disabled, and the Chrome relaunch at 10:06, are
untested.

The operator approved a one-field repair of `profiles.work.instanceId`. `qa-browser pair`
refused with `PROFILE_ALREADY_PAIRED`, as designed and with no override, so the approved
edit went through the locked `updateConfig` with a precondition on the old value. A
backup was taken first, and a field comparison showed no other change. Records under
`e4ce81c8` were preserved.

## Instance history

| Date | Update | Extension version changed | Instance |
| --- | --- | --- | --- |
| 10-29 | RC2 setup and pairing repair | Not checked | Changed, `43ef1ff6` to `e55052a6` |
| 10-30 | RC2 to RC3 | Yes | Kept |
| 11-01 | RC3 to RC6, operator recalls switch only | Yes | **Changed**, to `e4ce81c8`; unexplained |
| 11-04 | RC6 to live view build | No | Kept |
| 11-05 | Live view build to RC7, with the Load unpacked above | Yes | **Changed**, to `dffe7611` |
| 11-05 | RC7 to live view build and back, watched | Yes, both ways | Kept, twice |

## Held-action popup Stop

**Passed once, on a local fixture.** The operator clicked **Stop session** on
`rc7-hold-e` while a waiting action was running, with `rc7-hold-b` connected to a second
tab as the peer. The action only waits, and it was never rerun.

| Time | Observation |
| --- | --- |
| 12:52:55 | Action starts, planned to run about 3 minutes |
| 12:53:42 | Agent confirms it is still running, then tells the operator to click |
| 12:54:23 | Action errors with `Target page, context or browser has been closed`; lease moves to `interrupted/revoking` |
| 12:54:24 | Session retires with `outcome=unknown` and `cleanup=confirmed` |

The operator confirmed clicking at about 12:54:23. The peer passed a read afterwards,
both fixture tabs stayed open and the host did not restart. Peer disconnect left zero
controller sessions.

Limits: the action ran through `playwright-cli` directly, because `pw` has a 45-second
limit and a single evaluate call has a 30-second limit, so the recorder did not capture
that step; its output and a one-second monitor were saved separately. The popup's message
text was not captured. Closing the popup mid-Stop was not observed in Work; that remains
headless evidence.

### Earlier attempts, not counted

| Session | What happened |
| --- | --- |
| `rc7-stop-a`, `rc7-stop-b` | Operator stopped both before the action started. Idle Stop cleaned up each, and the tabs stayed open |
| `rc7-hold-a` | Retired about 5 seconds before the action started, with `rc7-hold-b` left healthy. Consistent with an early Stop, but not confirmed |
| `rc7-hold-c` | A single long evaluate ended at the 30-second limit; the operator did not click, and the popup correctly offered reconciliation instead of Stop. Outcome recorded as `unknown` and cleaned up through `reconcile` |
| `rc7-hold-d` | `pw` client ended at its 45-second limit. The operator clicked afterwards, and the session retired at 12:52:10, about when the daemon's loop was due to finish, so causation is unclear |

The 2026-11-01 held attempt ended with the same `Execution context was destroyed` error as
`rc7-hold-c`, so it probably hit the same 30-second limit. That was not retested.

## RC8 update and the identity fix

The owner chose to fix the ID problem before `0.2.0`. A host-restored ID was rejected: the
host learns the ID from the extension's hello and cannot tell Chrome profiles apart, so it
could give one profile another's identity. RC8 instead keeps a backup inside the extension
and adds `pair --replace`. The headless matrix did not find the cause: no scenario showed
a reset, its restart scenarios and Remove control were invalid, and only the folder-change
rows are usable (ID kept, including loading another folder while off and then switching on).

The watched update from RC7 to RC8, source `8ff7ed2`, kit
`dcd380d2205a806d6a23a783beea92c59dbf2b3a477e1d5527ebadb925d082c6`, kept `dffe7611` after both
the switch and the reload, with no new error reported. `verify` and `preflight` passed, and
`config.json` was unchanged.

`pair --replace` ran against the real extension and host with a disposable copy of the
configuration. The real configuration was byte-identical afterwards.

| Case | Result |
| --- | --- |
| Copy names the gone `e4ce81c8`, live instance `dffe7611` | Replaced, one backup written, other fields kept |
| Old instance still running | Refused, `PAIRING_OLD_INSTANCE_LIVE` |
| New instance not running | Refused, `PROFILE_UNAVAILABLE` |
| Copy does not match `--expect-old` | Refused, `PAIRING_CHANGED` |
| Plain `pair` over a different ID | Refused, `PROFILE_ALREADY_PAIRED` |

Not established: recovery from a genuine ID change in Chrome, whether the backup survives
whatever caused the real resets, and the cause itself. In fixtures, clearing `storage.local`
restored the ID, and wiping both copies changed it.

## Limits

One machine, one profile and three watched updates plus one watched rollback. Chrome's own record of extension
state was not read. The headless fixture does not reproduce either ID change. Latch
fails closed when the ID changes: `verify` refuses and no pairing is changed
automatically. A signed-in app read, fresh Codex acceptance and the final `0.2.0`
package remain open.
