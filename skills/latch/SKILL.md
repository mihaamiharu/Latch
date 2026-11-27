---
name: latch
description: Connect to the user's signed-in Chrome tabs and record step-by-step browser explorations via the flat latch CLI. Use when reproducing web bugs, verifying UI behavior in an open work browser, or capturing an exploration handoff.
---

# Latch

Drive tabs in the user's paired Chrome profile via Chrome's `debugger` API and bundled `playwright-core` (no external `playwright-cli` or `ffmpeg`).

## Smart defaults

- `--profile` defaults to the sole/default paired profile (`work`); `--workspace` defaults to `cwd`.
- `-s` / `--session` auto-generates on `open`/`connect` and binds to `<appDataDir>/sessions/` (no repo dotfiles); later commands reuse it.
- Pass `--json` for structured `{ ok, ... }` output.

## Workflow

1. **Check health & list tabs**
   ```sh
   latch doctor
   latch tabs
   ```
   Run `latch doctor --fix` if host registration needs repair, or `latch pair` if unpaired.

2. **Attach or open a tab**
   ```sh
   latch connect <tabId>
   latch open https://staging.example.com
   ```
   `--focus-emulation` defaults to `on` (`off` tests real focus/visibility). Pass `--record` or `--objective "<goal>"` (optional `--environment <env>`) to record an exploration.

3. **Inspect & interact**
   ```sh
   latch snapshot
   latch click e3
   latch fill e5 "synthetic input"
   latch press Enter
   latch screenshot --out result.png
   ```
   Actions: `snapshot`, `click <ref|sel>`, `fill <ref|sel> <val>`, `type [ref|sel] <text>`, `press <key>`, `hover <ref|sel>`, `select <ref|sel> <val>`, `check`/`uncheck <ref|sel>`, `upload <ref|sel> <path...>`, `screenshot [--out <path>]`, `goto <url>`, `back`, `forward`, `reload`, `eval <expr>`, `run-code <fn>`, `console`, `network`, `dialog <accept|dismiss> [text]`.

4. **Record, finish & review**
   ```sh
   latch checkpoint "Empty submit shows required-field errors"
   latch finish
   latch library serve
   ```
   Use `latch checkpoint <note> [--annotation-file <path>]`, `latch finish` to capture final states and disconnect, and `latch library <list|show|serve|review|export> [--run <id>]` for local filmstrip review.

5. **Clean up**
   `latch release [tabId]` detaches one tab; `latch disconnect` ends the session while preserving Chrome tabs and logins.

## Safety rules

- Refresh `latch snapshot` before using refs (`e1`, `e2`); refs are not durable across DOM changes.
- Never close unrelated Chrome tabs, clear cookies/storage as cleanup, or steal another task's session.
- Never store passwords, cookies, or auth tokens in checkpoints or reports.
- After a timeout, inspect `snapshot`, `console`, or `network` before retrying mutations.

## Troubleshooting

- `PROFILE_UNPAIRED` / `PROFILE_UNAVAILABLE`: open Chrome with Latch enabled and run `latch doctor` or `latch pair`.
- Stale ref: run `latch snapshot` to refresh refs.
- `TAB_OWNED` / `SESSION_COLLISION`: pick another tab or pass `-s <new-session>`.
