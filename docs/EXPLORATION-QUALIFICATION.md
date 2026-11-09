# Exploration library candidate qualification

Date: November 9, 2026. Version remains **0.2.0**.

This candidate adds a machine-local exploration library, video, initial/post-action/
final YAML snapshots, structured locator/transition/behavior evidence, offline repair,
a local QA viewer and verified handoff export. Generated Playwright code is excluded.

## Candidate identity

- Branch: `feat/exploration-library`.
- Runtime source: `bf2873697dc39583a81dfa92c5515506bdd7950f` (clean tree).
- Release descriptor SHA-256: `3f33a9b82aa75e5b967078ac38befb3a77892482204813391d34118b42285f3d`.
- Kit: `work/exploration-qualification/artifacts/latch-0.2.0/`.
- Kit ZIP SHA-256: `87be2214243936ef2026fe4874a2792e408249183f46934f21d121cf1b214190`.
- Packaged extension ZIP SHA-256: `74cbad8af265447a8210c0dc1ed45999f17a9c86f51fcb7dd9bc28c1f5e13e28`.
- Build record: `work/exploration-qualification/build.json`.

## Validation

The ordinary regression suite passed **137 tests**, with 55 optional browser tests
skipped and no failures. Source browser qualification passed **four tests per lane**
on Chrome for Testing 147.0.7727.15 and 157.0.8103.39, using Node v22.21.1 and the
pinned Playwright CLI 0.1.20. All browser runs were headless with disposable profiles.
Test launch flags and exact versions are retained with each fixture's evidence.

The browser checks cover the real local review UI and saved QA decision, central
capture and verified export, popup/iframe locator and final-state capture, two
playable clips for an owned popup kept open through finish, and decoded video
frames containing substantial red and blue visual changes. Exported YAML was
parsed independently with Ruby/Psych and matched its JSON equivalent on both lanes.
The versioned JSON Schema is bundled; runtime structural/cross-reference checks
are tested. No external JSON Schema validator was used.

The exact packaged candidate was also installed in isolated runtime roots and run
through its packaged CLI with a minimal native-host PATH. The checks cover final
snapshots, video finalization, agent-supplied behavior annotations, verified export,
repeat finish, preserved user tabs and confirmed cleanup. Both installed-kit
checks passed (one per Chrome lane), bringing optional browser qualification to
10 passed tests with no failures.

| Check | Floor lane evidence | Current lane evidence |
| --- | --- | --- |
| Source capture/review/export | `native-yd2LkP/evidence/` | `native-xB8Ap6/evidence/` |
| Popup and iframe YAML | `native-WntLto/evidence/` | `native-ux5r0W/evidence/` |
| Managed open-popup video | `native-uEZ4uG/evidence/` | `native-9J6vNx/evidence/` |
| Exact installed kit | `native-THt10c/evidence/` | `native-C30eqF/evidence/` |

Fixture paths above are relative to `work/attachment-compat/`. Full TAP logs are in
`work/exploration-qualification/{unit,source-floor,source-current,installed-floor,installed-current}.tap`.
The full-page QA viewer screenshot is
`work/attachment-compat/native-yd2LkP/evidence/library-review.png`; its self-contained
example handoff is in the sibling `handoff/` directory.

Unit coverage includes workspace/session isolation, crash-lock ownership, partial
observation recovery without replaying actions, tamper detection, unsafe paths,
video range serving, foreign review writes, failed encoding, reserved finalization
capacity and disconnect during an active command.

## Explicit limits and rollout

- Foreground frame changes and owned popups left open at finish are qualified.
  Continuous background and closed/short-lived popup capture are not qualified;
  missing clips become partial evidence. Exact page-to-clip offsets are not asserted.
- Video size limits apply during indexing/finalization; no live encoder disk quota
  or automatic pruning is implemented.
- Opaque scripts expose boundary states and a coverage gap. Historical snapshot refs
  and locator candidates require live validation when an agent writes automation.
- Agent descriptions and business expectations retain their provenance; unchecked
  behavior is not converted into an assertion pass. Inputs use test-data references.
- Test flags do not establish headed focus behavior. Actual Work-profile acceptance
  is still an operator-assisted step.

The installed runtime remains
`runtime/releases/0.2.0-40dedb02cb59` under Work Browser Bridge's Application Support
root. This candidate has not been activated in Work, merged into master or uploaded.
Follow the existing setup preview/token/activation procedure only after the operator
has drained sessions and unloaded the extension, then perform Work-profile acceptance.
