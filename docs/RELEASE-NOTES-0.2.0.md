# Latch 0.2.0

First local, internal release. It connects a coding agent to tabs you already have open in a
paired Chrome profile, through Playwright CLI. There is no public license, remote or hosted
distribution. See [setup](../SETUP.md), [support matrix](SUPPORT.md) and
[data handling](../PRIVACY.md).

## What's included

- `qa-browser open --url ... --session ...` creates and connects a fresh tab in the
  paired profile. It requires the updated host/extension (`createTab: 1`), a regular
  Chrome window and a fresh session name. Navigation failures preserve the session
  for inspection; normal disconnect preserves its tab.
- Native attachment to a selected existing tab and its verified popups, with no official
  Playwright extension and no Chrome remote-debugging port.
- Separate sessions for separate tasks, with popup **Stop session** that keeps your tabs open.
- Recovery that does not replay uncertain actions, and an evidence recorder with offline reports.
- A view-only live pane, `qa-browser view`.
- An in-extension backup of the instance ID, and a confirmed `pair --replace`.

## Tested

| Area | Evidence |
| --- | --- |
| Automatic tests | Headless Chrome for Testing 147 and 157 on Apple Silicon, macOS 27 |
| Update to `0.2.0` | Recorded in the final acceptance record |
| Popup Stop during a running action, with a second session surviving | Real Chrome 157, operator-confirmed, on a local test page |
| Codex CLI 0.166.0 | Real run on a local test page, with per-command approval |

## Known limits

- **An update can change the instance ID.** It happened on two real updates, and the cause
  is unknown. Watched updates using the switch and then reload kept it. If it changes, Latch
  stops and nothing re-pairs automatically; follow the recovery steps in setup.
- **An update needs the reload icon.** The switch alone leaves Chrome on the old version.
- **Unexplained Chrome message.** "An unknown error occurred when fetching the script" can
  appear after an update. Latch kept working when this was observed.
- **Intermittent test setup timeout.** On Chrome 157 test runs only, the extension sometimes
  missed a 20-second discovery limit. The cause is unknown, and it was only seen in
  disposable test browsers.

## Not verified

Signed-in app reuse, skipped by the owner. Restricted-sandbox operation, since Codex needed
approved commands that run outside its sandbox. Claude Code and Cursor. Intel Macs, other
operating systems and a second Mac or account. Popup closure during Stop in real Chrome.
Managed download retrieval, already-running worker backfill and remote or cloud agents are
outside this release.

## Requirements

Apple Silicon, macOS 27.0.1 or later, Chrome 147 or later, Node 22.21.1 and Playwright CLI
0.1.20. Exact tested builds are in the support matrix; other versions are not claimed.
