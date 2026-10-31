# RC5 maintained evidence checkpoint

Software: `fc682a2` (`0.2.0-rc.5`, extension `0.1.99.5`). The complete kit was built
from a clean local clone using the pinned dependency. It contains 79 payload files;
exact hashes, process exits and versions are in [result.json](result.json), verified
by [sha256.json](sha256.json).

[Generated selected-evidence report](example/report.md) shows the unmodified
before/after fixture screenshots. It was produced by the product's offline
`export` command, with only those two images selected. Its [manifest](example/export.json)
contains their capture checks; the full local run also asserted the save result,
expected error and cleanup. No signed-in Work content is in this example.

| Check | Result |
| --- | --- |
| Clean-checkout default suite | 109 passed; 43 optional skipped; no failures |
| Selected headless cases | 4 passed: two-task recording, real recorder interruption, installed-kit recording, popup Stop |
| Normal fixture | Application assertion PASS, before/after PNGs and snapshot, native/focus policy recorded, cleanup confirmed |
| Intentional error | Adapter assertion PASS; actual helper and Playwright exited 1; assertion exit 0 |
| Intentional mismatched result | FAIL surfaced; successful helper exit 0 kept separately from assertion exit 1 |
| Interrupted browser action | Actual recorder SIGKILL after one fixture receipt; unknown outcome retained; exact cleanup confirmed; peer usable |
| Popup Stop during recorded action | One fixture receipt; unknown outcome preserved; peer and tabs retained; cleanup confirmed |
| Offline integrity negative | Modified an owned copy only; report exited 1 and export was refused; original evidence unchanged |
| Limits and failures | Focused cases cover truncation, command/capture bounds, partial ledger, disk failure, cleanup failure, duplicate steps, identity mismatch and unsafe files |
| Existing Work | Still frozen RC3; configuration and stable extension match the prior checkpoint |

The selected total is **113 distinct current cases**: 109 default passes and four
otherwise optional cases. Repeated development runs are not added. Another 39
optional cases were not rerun for this candidate. Browser qualification here used
Chrome for Testing 153.0.8010.12 with disposable profiles; launch flags are retained
in the machine result. It does not establish headed focus or human permission
acceptance. RC4's Chrome-floor qualification remains a separate record.

The recorder keeps `run.json` and its ledger separate from native lease journals.
It observes an ordinary action-helper subprocess before reporting. Normal steps
use capture-time hashes without repeatedly reading older image payloads; recorded
disconnect and offline report verify current files. Storage/report failure never
causes an action replay. Recognized credentials and storage-command values are
excluded/redacted; arbitrary page text and screenshots still require review.

Full reports, ledgers, diagnostics and source TAP logs remain locally under
`work/macos-release/rc5-final-checkout/` and `work/macos-release/`. The portable
example deliberately excludes the original workspace/client context and unselected
raw outputs. This acceptance record is release-engineering evidence, not actual
Codex/Claude/Cursor agent acceptance. All three client executables are available;
fresh client workflow verification remains M4.

A separate version-only probe exposed a release dependency: CLI 0.1.20 is found
under the terminal PATH but returns `CLI_UNAVAILABLE` with `/usr/bin:/bin`.
Owned setup pins Node, while host-side detach still looks up Playwright CLI by
name. This does **not** establish a failure in the current Work GUI environment.
The next implementation must pin the CLI/runtime environment and test a minimal
native-host PATH before live rollout. No Work update is needed to implement it.

M4–M7, the live/clean-user gates, owner publication decisions and exact final
`0.2.0` promotion remain open. Nothing has been pushed or published.
