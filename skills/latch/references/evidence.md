# Recorded evidence (RC5+)

Read this when helper `help` lists `report` and the task needs a maintained report.
Older installed releases need the manual evidence path in `operations.md` until
the operator updates Latch. Loading this skill alone does not update Chrome.

Choose a fresh `LATCH_EVIDENCE` directory, normally
`$LATCH_WORKSPACE/work/latch/$LATCH_SESSION`. Pass the same absolute
`--evidence-dir "$LATCH_EVIDENCE"` on **every** recorded task command, including
preflight/diagnostics when wanted, connect, `pw` and disconnect. There is no hidden
session-to-directory lookup. The recorder verifies workspace/session/profile and
runtime identity. Do not reuse another task's directory or start a new connected
run in a completed directory.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" connect --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --transport native --focus-emulation on --tab "$LATCH_TAB_ID" --evidence-dir "$LATCH_EVIDENCE" --step attach
node "$LATCH_SKILL_DIR/scripts/latch.mjs" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --evidence-dir "$LATCH_EVIDENCE" --step before -- screenshot
node "$LATCH_SKILL_DIR/scripts/latch.mjs" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --evidence-dir "$LATCH_EVIDENCE" --step inspect -- snapshot
```

Use fresh stable step IDs for actions/checks. Duplicate IDs are rejected before
ordinary actions, preserving the original result. The recorder supplies a fresh
`--filename=` for snapshot/screenshot; do not supply a second filename or a
positional screenshot path. It writes the original PNG once. Snapshots remain
on disk, with recognized text credentials redacted. Read the needed snapshot
section for fresh locators rather than copying the entire run into context.

Default JSON is compact: execution status, check result and artifact paths. Use
`--inline` only when you need the ordinary full command response (for example a
small current page observation). Raw bounded results remain in `raw/`.
Command argument lists are not logged; their hash/count is retained instead.
Upstream results or error diagnostics can still echo submitted content.

## Assertions and actual exits

For an observed page property, compare its returned JSON explicitly:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --evidence-dir "$LATCH_EVIDENCE" --step title --expect-result '"Expected title from the acceptance criteria"' -- run-code 'async(page)=>page.title()'
```

Choose expectations from the actual task; the example title is not a locator or
test oracle. `--expect-result` compares the decoded Playwright result exactly.
A mismatch returns `ASSERTION_FAILED` and helper exit 1, while retaining the
successful underlying tool exit separately. Capture both before/after state
around an authorized action and assert the observed application result.

For an intentional adapter negative test, use `--expect-error PLAYWRIGHT_ERROR`
with a `run-code` function that only throws the intended marker. A matching error
passes that adapter assertion while preserving helper exit **1** and the actual
upstream exit. Do not treat that marker as an application defect. An ordinary
successful command without an application assertion does not establish an app
PASS. Timeout/interruption can leave an unknown action outcome.

The recorder observes an ordinary action-helper subprocess before it writes the
report. `helperExitCode` is that process's actual exit; `upstreamExitCode` is the
observed Playwright exit when one ran. `assertionExitCode` is separate: a matching
expected error has assertion 0 while the failed helper still has exit 1. A result
mismatch can have successful helper/Playwright exits and assertion 1. The recorder
returns exit 1 for that mismatch or a reporting failure; it does not relabel a
successful action process as failed merely because report writing failed.

Optional `--check-kind application|adapter|environment` labels an explicit
expectation. `--context-file PATH` supplies bounded JSON describing actual client,
version, discovery mode and observed/reported permissions. The recorder labels
it **agent-supplied** even if the input claims direct observation; runtime cwd,
branch and Node metadata are recorded separately. Never infer a client's policy
from its launcher or scan unrelated transcripts to fill missing metadata.

## Cleanup and offline review

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" disconnect --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --evidence-dir "$LATCH_EVIDENCE" --step cleanup
node "$LATCH_SKILL_DIR/scripts/latch.mjs" report --evidence-dir "$LATCH_EVIDENCE"
```

Disconnect remains possible while a recorded action is held or evidence storage
is damaged. The recorder does not hold a host/recovery grant over a browser call;
popup Stop still works. Cleanup status is independent of application assertions.
Keep the same runtime/workspace/session even after an error. Do not disconnect
peers, close existing tabs or replay a mutation to repair a report.

`report` reads the durable ledger and checks capture-time file hashes, without
connecting to Chrome. `report.md` contains the short check table and image links;
`result.json` contains typed checks, execution exits, cleanup, provenance and the
artifact index; `commands.jsonl` preserves started/completed events. `run.json`
holds this evidence run's identity, separately from native lease journals.
Routine steps index capture-time hashes without rereading every older payload;
their `integrity.verified` is null and verification is explicitly pending. Recorded
disconnect and offline `report` rehash the current files; require true for a final
verified bundle. Offline report returns exit 1 when integrity fails. It preserves
the original hashes and does not silently bless changed evidence.
An unfinished step is unknown, even if its active-command gate remains. Preserve
that gate; PID/age alone does not authorize clearing it. Offline reporting and
explicit disconnect remain available. Start a fresh run after scoped cleanup.

`EVIDENCE_WRITE_FAILED` reports whether the underlying operation succeeded or is
unknown. A completed action can have failed report writing. Fix storage and run
offline `report`; never repeat the action to regenerate evidence. If completion
could not be persisted, retain that uncertainty and the emitted command result.

Limits: 256 commands (one slot reserved for cleanup), 8 MiB ledger, 16 KiB per
event, 2 MiB raw inline result, 32 MiB individual captured artifact and 128 MiB
indexed run budget. Truncation is explicit. Failure/partial evidence is retained;
there is no automatic deletion policy.

## Selected export

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" export --evidence-dir "$LATCH_EVIDENCE" --export-dir "$LATCH_EXPORT" --include screenshots/before.png,screenshots/after.png
```

Export only explicitly selected verified artifacts and their check metadata into
a new directory. It excludes unselected raw files and the full command ledger.
The export manifest omits workspace/client context; explicitly selected raw files
can still contain paths or page text. Existing exports are never merged or overwritten.
Review the selected page content before sharing. Known tokens, sensitive headers
and storage-command values are excluded/redacted, but arbitrary page text and
screenshots can contain private data. No visual redaction or universal secret
detection is promised. Do not export native lease journals, CLI daemon registries,
cookies, attachment endpoints or unrelated tab data as evidence.
