# Exploration Library

Latch unifies opt-in browser recording into the local Exploration Library, capturing before/after PNG screenshot filmstrips, ARIA snapshots, and DOM locator observations alongside a loopback-only review UI.

## Capture an exploration

Pass `--record` or `--objective "<goal>"` (with optional `--environment <name>`) on `latch open` or `latch connect` to start a recorded run. Active workspace bindings live under `<appDataDir>/sessions/` (never in your repo) and repeated `latch` commands automatically bind to the active run:

```sh
latch open https://staging.example.com/checkout --record --objective "Verify checkout validation" --environment staging
latch snapshot
latch fill e5 "synthetic test input"
latch checkpoint "Submitting an empty form shows required-field errors; expected business behavior needs QA review."
latch finish
```

Use fresh snapshot refs (`e1`, `e2`, ...) or semantic selectors; refs from an earlier state are historical, not durable selectors. Each action links before/after states (`screenshots/state-NNNNN.png`) and captured main-page/iframe YAML includes accessible roles/names plus DOM attributes (IDs, labels, `data-testid`) with ambiguity warnings.

- `latch finish` captures final states for owned open pages, verifies SHA-256 artifact hashes, writes `exploration.yaml`, `exploration.json`, and `exploration.schema.json`, and disconnects while keeping your Chrome tabs and logins intact.
- Normal `latch disconnect` also finalizes an active recorded run.
- `--focus-emulation` defaults to `on` so background tabs complete actionability checks cleanly; pass `--focus-emulation off` only when testing real focus/visibility events.
- Without `--record` / `--objective`, `latch open` and `latch connect` run lightweight unrecorded sessions.

## Describe behavior without generating code

Simple positional notes on `latch checkpoint "<note>"` record agent-supplied findings linked to the current state. For structured annotations, pass a JSON file stored outside the run directory:

```json
{
  "kind": "behavior",
  "observed": "Required-field messages appear after submitting empty inputs",
  "expected": null,
  "text": "Confirm the product requirement before turning this into assertions"
}
```

Then run `latch checkpoint "Summary" --annotation-file /absolute/behavior.json` (add `--data-ref <ref>` on checkpoints or actions to cite a fixture/seed rather than secrets). Supported kinds are `behavior`, `finding`, `prerequisite`, `test_data`, `question`, and `coverage_gap`. Agent annotations never fabricate passing assertions, and Latch does not emit generated Playwright test scripts.

## Review and manage locally

Open the local `127.0.0.1` reviewer directly from Chrome by clicking **Open Library** in the Latch extension popup, or run it from a terminal:

```sh
latch library list
latch library serve
latch library show <runId>
latch library review <runId> --decision automate --note "Cover required fields"
latch library export <runId> --destination /absolute/new-handoff-folder
latch library delete <runId>
latch library delete --all
```

(`--run <id>` is also accepted instead of a positional `<runId>`.)

- **Before/after filmstrip & QA review:** Search runs across projects, step through before/after PNG screenshots, inspect ARIA/DOM locator candidates, download `exploration.yaml` / `exploration.json`, and save QA decisions (`unreviewed`, `automate`, `investigate`, `report_bug`, `closed`) in `review.json` separately from source evidence.
- **Loopback security:** The server binds only to `127.0.0.1` and requires a same-origin page token (`X-Latch-Review`) for reviews and deletions.
- **Export:** Verifies indexed SHA-256 hashes before copying the self-contained handoff bundle (`exploration.yaml`, `exploration.json`, snapshots, screenshots, manifest, and `review.json`) into a new directory.
- **Delete:** Both the Library UI **Delete** buttons and `latch library delete` refuse to delete active or locked runs (`EXPLORATION_BUSY` / HTTP `409`) until `latch finish` or `latch disconnect` completes. `latch library delete --all` removes all inactive runs and skips active ones.

## Storage location, failures, and limits

Artifacts root resolution order:
1. `LATCH_ARTIFACT_ROOT` environment variable
2. `artifactsDir` in `config.json` (set via `latch config set artifacts-dir <path>` or the popup's **Library & storage** → **Choose folder…** / **Save path**)
3. Platform default:
   - **Windows:** `%LOCALAPPDATA%\Latch\artifacts`
   - **macOS:** `~/Library/Application Support/Latch/artifacts`
   - **Linux:** `$XDG_CONFIG_HOME/latch/artifacts` (or `~/.config/latch/artifacts`)

Operational bounds & recovery:
- `32 MiB` per indexed artifact, `512 MiB` total indexed artifacts per run, `256` commands (`8 MiB` command ledger), and `2000` DOM-attribute observations per frame (gaps recorded when exceeded).
- Capture gaps and action outcomes are distinct; a failed capture never repeats an application action, and background/closed tabs retain their last observed state with explicit gap entries.
- `latch library repair <runId>` recovers interrupted runs from durable `events.jsonl` and `commands.jsonl` ledgers without calling Chrome or replaying actions, auditing reclaimed dead-PID locks in `lock-audit/`.
- Snapshots and screenshots can still contain page content; credential scrubbing is automatic on known headers/tokens/fields, not visual pixels — review before exporting or sharing.
