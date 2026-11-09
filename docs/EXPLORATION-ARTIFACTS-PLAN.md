# Local exploration library and YAML automation handoff

Status: implementation candidate, November 9, 2026. The owner approved
implementation after resolving the local-library and YAML-only handoff choices.
Preserve the installed, working 0.2.0 while qualifying a separate candidate.
See [EXPLORATION-LIBRARY.md](EXPLORATION-LIBRARY.md) for the implemented contract.

## Product outcome

An agent explores a website once. A QA engineer can later open that run on their
own machine, watch its video, inspect the observed states and transitions, record
a review decision, and hand the bundle to an agent that writes Playwright tests.
The handoff should avoid repeating discovery; test execution and validation will
still require a live app, fresh locators and suitable test data.

Owner decisions:

- Central means a library on each QA engineer's local machine, across workspaces.
  No hosted backend, shared database, accounts or automatic uploads initially.
- Preserve video and YAML describing explored locators, transitions and behavior.
- Generated Playwright code, language conversion and test generation are excluded.
  This supersedes the earlier suggestion to retain generated code initially.
- A raw Playwright accessibility snapshot describes one observed state. It does
  not itself describe actions, transitions, business rules or unvisited states.
  Keep raw snapshots and introduce a separate structured `exploration.yaml`.

## Current gaps and reuse

Reuse the existing run IDs, session/profile identity, append-only command ledger,
artifact hashes, explicit expectations, error normalization, offline reports and
selected export. Keep browser transport and automation delegated to their current
implementations for this work.

Current evidence is opt-in per command via `--evidence-dir`, normally under a
workspace. Only explicit snapshot/screenshot commands get indexed capture files.
The ledger hashes arguments rather than retaining action semantics. Reports are
per run, with no central catalogue, review state or YAML exploration graph.
Video commands exist in the CLI adapter but playable recordings and lifecycle
handling have not been qualified. Arbitrary file collection from the external
CLI output directory is not a valid substitute for owned artifact paths.

## Scope and defaults

Proposed default root: `~/Library/Application Support/Work Browser Bridge/artifacts/`,
with a configurable absolute root. Keep it independent of runtime releases and
repositories so upgrade, rollback and branch switching do not move evidence.
Use a unique run ID; session names and workspace names are metadata, not unique
filesystem identifiers. Two projects with the same session name must stay separate.

A managed exploration creates its library run automatically. Normal `open` and
`connect` should register a managed run by default once this feature is qualified;
the session binding persists across short CLI invocations. Existing explicit
`--evidence-dir` runs remain supported, and conflicting destinations fail clearly.
Calls made directly to an external Playwright CLI can bypass Latch: do not claim
complete capture of those calls. Agent instructions use the managed path.

Video is the default visual record. Routine per-step screenshots are not required;
existing explicit screenshots remain available. Keep raw YAML snapshots at initial,
post-action/key states and finish, plus the structured exploration record.
A local review surface opens a list of runs and one selected run's video, states,
transitions, findings, gaps and QA review decision. Choice of viewer implementation
is deferred to the implementation design; it does not require a cloud service.

Suggested bundle:

```text
artifacts/
  catalogue.json                 # rebuildable from run manifests
  runs/<run-id>/
    run.json                     # run identity and lifecycle
    commands.jsonl               # durable observed tool execution
    events.jsonl                 # typed observations/checkpoints with provenance
    exploration.yaml             # validated, versioned automation handoff
    snapshots/<state-id>.yaml    # original scrubbed Playwright state captures
    snapshots/final-<page-id>.yaml
    videos/<segment-id>.webm
    artifacts.json              # hashes, sizes, capture status and references
    report.md                    # concise findings and capture summary
    review.json                  # QA notes/decision, separate from observations
```

## YAML handoff contract

The YAML describes the explored portion of the application, not every locator or
possible behavior on the website. Every state, action and behavior links to the
actual supporting evidence. Unknowns remain explicit.

Required sections:

- `schema_version`, run identity, objective, environment, starting URL and times.
- Prerequisites and test-data references; identify known setup/cleanup effects.
- Pages and frames: session-owned page identity, URL, frame context and relationships.
- States: snapshot path/hash, capture time, page/frame, visible content and observed
  elements. Keep semantic state labels separately marked as agent supplied.
- Locators: snapshot-local ref plus observed role/name/label/test ID where available,
  frame context, ambiguity and candidate locator strategy. Only record attributes
  actually observed; do not invent test IDs or imply accessibility YAML is full DOM.
- Actions/transitions: order, source state, target element, operation, test-data
  reference, destination state, outcome, linked command ID and video offsets.
- Behaviors/findings: trigger, actual result, any explicitly checked expectation,
  evidence, origin and confidence. Observed behavior and expected business behavior
  are distinct; one observed result is not proof of a universal rule.
- Coverage/gaps: paths explored, branches not attempted, failures, opaque operations,
  absent captures and remaining questions for QA or the automation agent.
- Final state for each still-open owned page, capture completeness, cleanup status
  and a summary of side effects. A closed/unreachable page gets its last observed
  state and an explicit reason a final capture is unavailable.

Illustrative subset (not a complete snapshot or generated test):

```yaml
schema_version: 1
run_id: example-run
objective: Explore required-field validation
states:
  - id: form_empty
    page: page_1
    url: https://staging.example.test/login
    snapshot: snapshots/state-001.yaml
    elements:
      - id: submit
        snapshot_ref: e5
        locator:
          strategy: role
          role: button
          name: Sign in
          exact: true
        evidence_source: snapshot
transitions:
  - id: step_002
    command_id: command_002
    from: form_empty
    action:
      type: click
      target: submit
    to: required_fields_visible
    outcome: succeeded
    video:
      segment: segment_001
      offset_ms: 4100
behaviors:
  - id: required_fields
    trigger: step_002
    observed: Required-field messages appeared after submitting empty fields
    expected: null
    assertion_status: not_asserted
    evidence:
      - snapshots/state-003.yaml
    provenance: agent_interpretation_of_captured_state
```

Snapshot refs such as `e5` are historical references, not durable test selectors.
A future automation agent uses semantic locator candidates, refreshes them against
the live page, adds reviewed assertions and validates the resulting code.

## Implementation stages and exit criteria

### 1. Qualify capture capabilities first

Use disposable headless Chrome with the installed/pinned CLI version to prove
video start, interaction, stop and saved-file retrieval. Decode the resulting WebM
and verify it contains changed frames, usable duration and the final interaction;
file existence alone is insufficient. Check required encoding dependencies.
Test background pages, navigation, agent tab selection, popups, tab closure and
normal disconnect. Determine whether upstream video follows the selected page or
needs per-page segments. Never activate unrelated tabs to force recording.

Exit: supported recording behavior is demonstrated on both Chrome lanes, including
multi-page coverage or an explicit scoped limitation. If a gap prevents the desired
handoff, resolve it before treating video as a default supported artifact. Do not
promise full recording based only on a forwarded CLI command or live screencast.

### 2. Add central run ownership and lifecycle

Introduce run allocation, canonical paths, persistent session-to-run binding and
atomic manifests. Maintain one writer per run; the catalogue is a rebuildable cache.
Record start/end/failure states and step timestamps. Bind video segments to owned
pages and align event offsets to recording start with a monotonic clock.

Exit: concurrent agents/projects cannot mix artifacts; explicit legacy directories
work; a broken catalogue can be rebuilt without browser interaction. A storage
failure reports capture status and does not repeat an application action.

### 3. Capture state and build the exploration graph

Capture initial state and exact post-command YAML artifacts. Reuse returned
artifact paths or allocate explicit paths; never select the newest file in a
shared `.playwright-cli` directory. Capture navigation/dialog/error states and
allow explicit agent checkpoints for useful intermediate observations.

Use executed tool results for factual actions/outcomes. Accept agent annotations
for intent, semantic state names, findings and expected outcomes with provenance.
An opaque `run-code` block may contain multiple actions; expose that coverage gap
unless it provides supported checkpoints. Do not infer a complete transition
history from a final snapshot or an arbitrary script's return value.

Validate `exploration.yaml` against a versioned schema: unique IDs, resolvable
state/locator/frame/command/artifact references, timestamps and known/unknown
outcomes. Preserve source observations so the YAML can be rebuilt offline.

Exit: a second agent can follow the tested scenario's observed flow using the YAML
and snapshots, including a validation error and a popup/frame case, without having
to repeat discovery. No code generation is required for this gate.

### 4. Finalize reliably

On normal finish, attempt final YAML captures for every still-open session-owned
page, finalize video segments, verify artifacts, build the YAML/report and close
the run. Capture must not navigate, resubmit forms or replay uncertain actions.
Keep finalization bounded, record partial/failed captures explicitly and allow
Stop/disconnect to revoke browser access even when recording/storage fails.

On agent/host/browser loss, retain partial evidence and mark the run interrupted.
Offline repair can rebuild indexes/reports from durable data; it cannot manufacture
a missing final snapshot or silently relabel an old snapshot as a final capture.
A verified bundle, completed exploration and confirmed cleanup are separate states.

Exit: final snapshots and videos are indexed on normal completion; crashes, disk
limits and unavailable pages preserve useful partial bundles with honest status.

### 5. Provide local QA review and handoff

Browse/search by project, objective, environment, date and status. Open the video,
ordered states/transitions, YAML, findings and missing coverage. Link a step to
its snapshot and relevant video segment/offset. Save QA decisions and notes
separately so original evidence remains intact.

Support selected, verified export of the YAML plus its referenced artifacts into a
self-contained handoff bundle. No server, generated code, automatic test execution,
Jira integration or automatic upload is needed for this first iteration.

Exit: QA can review a real example, choose what should be automated and hand one
bundle to an automation agent. The agent can identify prerequisites, actions,
observed locators, expected/unchecked behavior and unresolved questions from it.

### 6. Qualify and roll out a complete candidate

Test across both supported Chrome lanes with headless/disposable profiles. Cover
concurrent sessions, navigation/redirects, frames/popups, repeated finish, interrupted
recording, missing encoder, disk-full/size limits, expired refs, incomplete annotations,
unsafe paths and catalogue recovery. Raise video limits deliberately: current
32 MiB artifact/128 MiB run caps may be inadequate; choose measured duration/byte
limits and mark recording gaps instead of silently dropping footage.

Update the shared skill, usage/support/privacy documentation, installer inventory
and exact artifact tests. Rehearse upgrade/rollback with retained 0.2.0. The final
Work-profile acceptance stays operator assisted. No release renumbering or installed
runtime replacement occurs as part of this planning task.

## Data handling and compatibility

Local files contain selected page content and video. Reuse credential scrubbing,
store credential/test-data references rather than passwords or authentication state,
and make gaps in automatic redaction explicit; video pixels are not automatically
redacted. Export remains deliberate. No automatic deletion initially: show usage
and let QA remove chosen runs. Retention limits beyond recording bounds can follow
actual usage. Runtime/session registries and profile data are never handoff artifacts.

Keep the existing evidence schema/reader and rollback behavior compatible; introduce
new versioned exploration/library files instead of adding unknown fields to schema-4
native recovery journals. Prior per-workspace runs may be explicitly imported by
copying/verifying indexed artifacts; never move or merge their originals silently.

## Implementation decisions and remaining limits

The candidate implements automatic central runs, durable observations and offline
repair, initial/post-command/final snapshots, structured YAML with locator and
transition provenance, video finalization, local QA review and verified export.
The library scans run metadata rather than maintaining a separate catalogue cache.
The viewer supplies the capture summary; no separate generated report is required.
Existing explicit evidence-directory workflows remain supported without automatic
import. There is no delete command or automatic pruning in this first candidate.

Qualification established foreground frame changes and separate clips for an owned
popup kept open until finish. Background and short-lived/closed-popup video coverage
remain unqualified. Exact page-to-clip alignment is not asserted; transition times
are run-elapsed references. `--video foreground` is an explicit focus choice.
Indexing limits do not enforce an unattended encoder's live disk usage.

Runtime cross-reference checks and the bundled versioned schema document the YAML
contract. A future automation agent must validate locators against the live app,
review expected behavior and supply referenced test data. No generated Playwright
code is included. Installed Work activation remains a separate operator-assisted
step after candidate qualification.
