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

## Final package and installed Work status

Final package qualification is in progress. `work/release-0.2.0-fresh-tab/` retains
test logs, package metadata and staging information. Source results are not a pass
for a different final artifact. A complete kit must be built/verified and exercised
through its installed launcher, then retained with its checksums for rollback.

The actual Work installation remains on its prior runtime. Activation requires
all tasks drained and the operator switching Latch off, followed by activation,
switch-on and the reload icon. Then verify exact host/extension identity,
`createTab: 1`, preflight, a fresh local fixture tab, snapshot/screenshot and
confirmed disconnect. Do not attest extension unload from a lost socket alone.

Earlier update-instance changes remain unexplained. Prior signed-in real-app
acceptance was skipped by the owner; it remains unverified. Claude Code, Cursor,
Intel, other operating systems, a second Mac/account and unrestricted background
focus are not newly qualified. Public/hosted release remains outside scope.
