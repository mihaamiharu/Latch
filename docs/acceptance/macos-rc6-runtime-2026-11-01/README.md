# RC6 native runtime qualification

Software `1dd3eb2`, release `0.2.0-rc.6`, extension `0.1.99.6`. The complete
82-file kit was built from a clean clone. [result.json](result.json) records exact
descriptor/archive hashes, versions, launch flags and source TAP hashes.
[sha256.json](sha256.json) covers this portable record.

| Check | Result |
| --- | --- |
| Frozen clean-checkout default suite | 111 passed, 44 optional skipped, zero failures |
| Installed current-browser lane | Three passed: minimal-PATH runtime recovery, clean install and actual legacy 0.1.2 upgrade/rollback |
| Chrome floor 147.0.7727.15 | Two passed: maintained two-task evidence and installed clean smoke |
| Current Chrome 153.0.8010.12 compatibility | Four passed: large evidence, file transfer, frames/workers and popup workflow |
| Exact RC3 → RC6 → RC3 → RC6 | Passed separately against the frozen candidate descriptor; pairing, selected native default and synthetic local-storage authentication retained |
| Installed host PATH `/usr/bin:/bin` | Validated CLI/Node pin works without an ambient CLI override; normal disconnect, actual packaged popup Stop and exact host recovery passed |
| Interrupted action safety | One receipt per held fixture action; unknown outcomes retained, peer survives Stop, exact reconciliation follows host termination |
| Real Work installation | Still RC3; RC6 staged inactive only; historical interrupted record preserved |

There are ten selected optional headless executions across the lanes, in addition
to the 111 default passes. Clean install repeats on both browser lanes; these are
not ten distinct capabilities. The additional native-update harness was added
after the frozen software checkout and is hashed separately. It runs each kit's
own installer against private registration/runtime/profile paths; it never changes
the retained installed RC3 or candidate payload. The candidate descriptor matches
the clean build exactly. Development runs are not added to these totals.

The controlled RC5 CLI lookup finding is closed: setup resolves and validates the
CLI entrypoint, includes its hash in the inspection token, and pins it with the
selected Node environment in owned launchers. Removing a pin does not select a
different executable. The entrypoint hash does not cover the external CLI's whole
dependency graph. No global shell PATH or security settings change.

All browser tests used disposable **headless** Chrome for Testing profiles.
Minimal PATH is not a wholly empty environment. The installed popup test uses
`--silent-debugger-extension-api` and `--extensions-on-extension-urls` for a
separate private driver to exercise the unmodified packaged popup. These flags
never belong in Work. The Chrome sources describe the
[debugger URL restriction](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc)
and [test switch](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/common/switches.cc).
Other test-only/headless/keychain flags are recorded in the result.

The legacy 0.1.2 rollback cohort uses the official extension **only** for that
retained legacy path. Clean native installation, GUI-like runtime and RC3 native
rollback require no official extension. No live Work extension was toggled.

Private fixture restarts do not establish physical tab retention during a live
update, human Chrome permission acceptance, headed focus or Personal-foreground
behavior. Synthetic authentication retention does not establish signed-in Work
app reuse. These remain separate operator/client acceptance gates. The actual
Codex CLI discovery/permission/report run is also pending; executable inventory
and ordinary CLI subprocess tests do not count as agent acceptance.

Raw TAP logs and fixture data remain locally under `work/macos-release/` and
`work/attachment-compat/`. Earlier failed driver development logs are retained:
cross-extension debugger access and initial popup navigation required fixture
corrections before the final passing runs. This portable record includes no raw
profiles, tokens, relay endpoints or signed-in page evidence.

The owner selected **local internal delivery, no public project license yet**.
Repository, hosted CI and public delivery are deferred; no remote/push/upload is
authorized. M4/M5 live acceptance and exact final `0.2.0` qualification remain
open. A passing RC6 does not promote the final artifact automatically.
