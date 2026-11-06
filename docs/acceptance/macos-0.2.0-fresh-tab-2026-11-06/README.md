# Latch 0.2.0 fresh-tab qualification

November 6, 2026. Scope: local/internal macOS release with `open --url` and
`createTab: 1`. The version remains 0.2.0. No Herdr viewer code changed.

## Source browser qualification

All automatic browsers were headless, disposable Chrome for Testing, with fixture
launch arguments and exact versions retained in each result. Synthetic storage
was used for login reuse; no real Work cookies or account content was collected.

| Lane | Latch fresh-tab evidence | Official 0.4.0 comparison evidence |
| --- | --- | --- |
| Chrome 147.0.7727.15 | `work/attachment-compat/native-UwFWg1/evidence/open-tab-result.json` | `work/attachment-compat/official-hm8eJA/evidence/official-alternative-result.json` |
| Chrome 157.0.8103.39 | `work/attachment-compat/native-aZBCMs/evidence/open-tab-result.json` | `work/attachment-compat/official-P24sDv/evidence/official-alternative-result.json` |

Both lanes passed: fresh tab, shared synthetic profile state, unchanged existing
URLs/windows/groups, independent peer survival, active-session duplicate rejection,
continued navigation, preserved tab after disconnect, and retained inspectable
session after a failed navigation. Recorder reports have confirmed cleanup and
verified indexed artifacts. Interrupted-creation unit tests verify that intent is
persisted before mutation, an uncertain creation is not replayed, and failed
bootstrap releases the early reservation before retiring its record.

The official comparison validates substantial overlap; it does not qualify latest
upstream extension behavior or the real Work profile. See [the decision](../../LATCH-OR-UPSTREAM.md).

## Final package qualification

The exact complete kit is built from clean committed source `d0da4388765012fa49bcb824d639e5a858e89e63`.
Version remains **0.2.0**. Descriptor SHA-256:
`40dedb02cb591cdc541766015fc2120040987ec35344386858d964c65b32e333`.

| Archive | SHA-256 |
| --- | --- |
| `latch-0.2.0-kit.zip` | `28e526c390afeec177f0505ba030669313d9572560a6d0d5bb01df191893c825` |
| `latch-0.2.0.zip` | `74cbad8af265447a8210c0dc1ed45999f17a9c86f51fcb7dd9bc28c1f5e13e28` |

The kit, archives, `SHA256SUMS`, test logs, `qualification.json` and activation
handoff are under `work/release-0.2.0-fresh-tab/`. Its source-reported provenance is
clean; subsequent test/report-only commits do not change the packaged runtime.
Runtime files were compared with the descriptor inventory. The staged release is
`0.2.0-40dedb02cb59`. No new Chrome permissions are requested.

| Final check | Result | Evidence |
| --- | --- | --- |
| Default automated suite | 126 passed, 50 optional browser tests skipped | `unit-tests.tap` |
| Exact installed kit on Chrome 147 | Clean install, fresh tab/recorder, legacy update/rollback, RC8 update/rollback, fresh-tab failures: 4 passed | `final-floor.tap` |
| Exact installed kit plus control checks on Chrome 157 | The same checks, plus popup Stop/unsupported/unconfirmed/closure: 8 passed | `final-current.tap` |

Installed-launcher cases use the kit's host and pinned CLI, including a minimal
host PATH; extension files are checked against the packaged inventory. Popup UI
cases use the selected packaged extension with the matching source host plus
fixture-only control hooks, not the Work browser. All automatic runs are headless
with disposable profiles and synthetic login state. This does not prove headed
focus or real permission acceptance.

| Exact-package fixture | Chrome 147 | Chrome 157 |
| --- | --- | --- |
| Clean install and packaged fresh-tab recorder | `native-EpsHvM/evidence` | `native-PmUaoD/evidence` |
| Legacy 0.1.2 upgrade/rollback | `native-4doqpo/evidence` | `native-pIhDz1/evidence` |
| Retained RC8 update/rollback/reactivation | `native-JLHdqb/evidence/native-update.json` | `native-eBzk0B/evidence/native-update.json` |
| Fresh-tab navigation failures and peer preservation | `native-IbaRPE/evidence/open-tab-result.json` | `native-uTDx36/evidence/open-tab-result.json` |

Fixture paths above are relative to `work/attachment-compat/`. Chrome 157 popup
results are in `native-885U4o`, `native-gvbOss`, `native-rN7Tzp` and `native-NvXceQ`.
The fresh-tab recorder and packaged screenshot reports have confirmed cleanup and
verified indexed artifacts. Neither recorder output nor a version string alone
replaces matching the exact release descriptor.

## Failures caught during qualification

The first RC8 rollback rejected a new persisted `createdTabId` field, even on
retired sessions. The fix keeps blank-tab admission in the connection-bound grant
and retains only existing schema-4 journal fields. Exact RC8 update, rollback and
reactivation now pass on both Chrome lanes. Failed output is retained in
`before-rollback-fix-current.tap`; it must not be counted as a passing run.

The initial legacy rollback on Chrome 157 lost synthetic login state after abrupt
fixture shutdown. The existing no-Latch diagnosis already showed recently written
state can be lost under SIGTERM. The legacy test now uses the same 8-second commit
window as the native update test. This is a test-only change; see
[the earlier diagnosis](../macos-rc7-qualification-2026-11-05/README.md#fixed-login-state-test-on-chrome-157).

## Installed Work status and remaining gate

The actual Work installation remains on its prior RC8 runtime. Staging did not
change the active pointer, receipt or loaded extension. The complete prior release
is retained as `0.2.0-rc.8-c153486c0d3b`.

Activation requires all tasks drained and the operator switching Latch off,
followed by activation, switch-on and the reload icon. Then verify exact
host/extension identity, `createTab: 1`, preflight, the prepared fresh local fixture,
snapshot/screenshot and confirmed disconnect. Do not attest extension unload from
a lost socket alone. The ready handoff is
`work/release-0.2.0-fresh-tab/ACTIVATION.md`; its local fixture needs no account data.

Earlier update-instance changes remain unexplained. Prior signed-in real-app
acceptance was skipped by the owner and remains unverified. Claude Code, Cursor,
Intel, other operating systems, a second Mac/account and unrestricted background
focus are not newly qualified. Public/hosted release remains outside scope.
