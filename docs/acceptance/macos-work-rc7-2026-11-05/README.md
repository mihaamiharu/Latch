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

## Limits

One machine, one profile and two watched transitions. Chrome's own record of extension
state was not read. The headless fixture does not reproduce either ID change. Latch
fails closed when the ID changes: `verify` refuses and no pairing is changed
automatically. Held-action Stop, a signed-in app read, fresh Codex acceptance and the
final `0.2.0` package remain open.
