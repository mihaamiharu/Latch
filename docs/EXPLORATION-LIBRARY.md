# Local exploration library

This feature is a source candidate on `feat/exploration-library`. The installed
0.2.0 runtime does not gain it until a complete candidate is qualified and activated.
Version remains 0.2.0; use descriptor hashes to identify a particular build.

## Capture an exploration

Normal managed `open`/`connect` commands allocate a local run and begin video plus
YAML state capture. Repeated short CLI invocations find the session's bound run;
you do not need to repeat an evidence directory on each command.

```sh
latch open --profile work --session checkout \
  --workspace /absolute/project --focus-emulation on \
  --objective 'Explore checkout validation' --environment staging \
  --url https://staging.example.test/checkout
latch pw --profile work --session checkout --workspace /absolute/project -- snapshot
latch pw --profile work --session checkout --workspace /absolute/project \
  --data-ref seeded-customer -- fill e5 'synthetic test input'
latch checkpoint --profile work --session checkout --workspace /absolute/project \
  --note 'Submitting an empty form exposed required-field messages; expected business behavior needs QA review.'
latch finish --profile work --session checkout --workspace /absolute/project
```

Use fresh snapshot refs or semantic selectors; refs from a previous page state are
historical, not durable selectors. Ordinary actions get before/after state links.
Captured main-page and iframe YAML includes observed accessible roles/names and
DOM attributes such as IDs, labels and test IDs, with candidate locator strategies.
Ambiguous accessible names are marked. These observations still require live
validation when another agent writes tests.

`finish` attempts final captures for owned open pages, stops video, disconnects,
verifies artifacts and preserves tabs/logins. Normal `disconnect` also finalizes.
An active command does not block a separate disconnect from revoking its lease;
the interrupted run can be repaired offline after that command exits.

Pass `--video foreground` to explicitly bring the selected owned page forward
before recording/actions; this helps Chrome deliver frames and can change window
focus. The default `--video on` does not force foreground focus.

For a run where recording is undesirable, pass `--video off` at attachment. Video
then remains explicitly disabled; snapshots and YAML capture continue. Existing
explicit `--evidence-dir` workflows keep their original recorder behavior. Set
`LATCH_CAPTURE=off` for a deliberately unmanaged invocation; the output will not
have a central-library handoff. Direct external Playwright calls can bypass Latch.

## Describe behavior without generating code

Simple `--note` checkpoints add agent-supplied findings linked to a fresh capture.
For structured behavior, write a small JSON annotation outside the run directory:

```json
{
  "kind": "behavior",
  "observed": "Required-field messages appear after submitting empty inputs",
  "expected": null,
  "text": "Confirm the product requirement before turning this into assertions"
}
```

Then use `checkpoint --annotation-file /absolute/behavior.json` with the same
session/workspace. Supported kinds are behavior, finding, prerequisite, test_data,
question and coverage_gap. Test data should be a reference to a fixture/seed, not
passwords, cookies or exported authentication state. An optional `transition` must
refer to a recorded action, and any explicit evidence paths must be indexed in
that run. Agent annotations never manufacture an assertion pass.

`exploration.yaml` contains the explored states, pages/frames, transitions,
locator observations, agent-supplied findings, prerequisites, data references,
final states and capture gaps. It links original YAML snapshots and video clips.
A versioned `exploration.schema.json` travels with the handoff. Generated Playwright
code and automatic test generation are outside this feature.

## Review locally

```sh
latch library list
latch library serve
# Open the printed http://127.0.0.1:PORT URL on this machine.
latch library show --run RUN_ID
latch library review --run RUN_ID --decision automate --note 'Cover required fields'
latch library export --run RUN_ID --destination /absolute/new-handoff-folder
```

The local viewer searches runs across projects, plays recorded clips, lists states
and transitions, links YAML and saves QA decisions separately from source evidence.
Decisions are unreviewed, automate, investigate, report_bug and closed. The server
binds only to loopback, accepts review writes only from its own page and supports
video seeking. It does not register or publish a Site or upload artifacts.
Export refuses an existing destination and verifies indexed hashes before copying.
The exported folder includes the YAML, schema, snapshots, recordings, supporting
command data, manifest and a snapshot of QA review notes.

## Location, failures and limits

The default root is `artifacts/` next to the configured Latch config, normally:

```text
~/Library/Application Support/Latch/artifacts/
```

`LATCH_ARTIFACT_ROOT` selects a different absolute root. Runs use UUIDs, with
workspace/session/profile bindings stored separately. Runtime upgrades and branch
changes do not move this library. No automatic deletion or upload is performed.

- Capture gaps and action outcomes are distinct. A failed capture never repeats
  an application action. A complete bundle is not a claim that every behavior is tested.
- `run-code`/`eval` are opaque command boundaries: internal actions may not have
  intermediate captures. Use checkpoints and smaller ordinary commands when the
  handoff needs detailed transitions. Direct CLI calls outside Latch may be absent.
- Capture helpers have a finite deadline. Interrupted, closed or unavailable pages
  retain their last observed states; missing final captures are explicit.
- Video uses the pinned CLI's recording API and its Playwright-managed encoder.
  The initial qualification proves decoded foreground frame changes. Chrome can
  throttle hidden pages, and closed/short-lived popup clips have failed capture in
  probes. Reported clip paths alone are not proof that a file exists. Missing clips
  are marked partial, never silently substituted. Continuous background or complete
  transient-popup video coverage is not currently qualified.
- Video clips can belong to separate pages. Run elapsed timestamps are provided,
  but exact page-to-clip/timestamp alignment is not asserted.
- Indexed video artifacts are limited to 512 MiB each, with 2 GiB indexed artifacts per run.
  These are indexing/finalization limits; an unattended encoder can write beyond
  them before finish. There is no background disk-quota enforcement or pruning.
  Existing recorder bounds still apply to its command/text files. DOM-attribute
  observations are capped at 2000 per frame, with a gap when exceeded; raw accessible
  snapshots are preserved subject to capture/output limits.
- Snapshots/videos can contain page content. Existing credential scrubbing is not
  universal secret or visual redaction. Review before export.

`library repair --run RUN_ID` rebuilds YAML/manifest state from durable observation
and command records without browser calls or action replay. A crashed capture gate
is reclaimed only after checking its recorded process identity, and its nonempty
owner record is retained in `lock-audit/`. A live, unknown or changed owner remains
blocked; PID age alone does not authorize removal. Partial tails and unknown action
outcomes remain visible. QA notes stay separate and are not overwritten by repair.
