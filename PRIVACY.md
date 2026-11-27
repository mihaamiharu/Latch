# Latch data handling

Latch connects a local coding agent to selected tabs in a paired Chrome profile across Windows, macOS, and Linux. This document describes the local bridge and files; it does not replace your coding agent or model provider's data policies.

## Browser access

Install Latch only in the intended Chrome profile, then pair that extension instance (`latch pair`). Tab discovery exposes titles, URLs, and ownership metadata for that profile. Native sessions attach only to an explicitly opened or connected tab and its verified child frames/popups. Authorized commands can inspect page content, screenshots, console/network logs, and DOM state, or interact with the page.

The extension (`extension/manifest.json`) declares `tabs`, `tabGroups`, `storage`, `nativeMessaging`, `alarms`, and `debugger` permissions. It has no persistent website content scripts, no website `host_permissions`, and no `externally_connectable` declarations. Debugger access still allows substantial access to attached tabs while a session is active.

## Local transport and external traffic

Chrome launches `native-host` through Chrome Native Messaging. Local CLI commands communicate with `native-host` over a per-user Named Pipe on Windows (`\\.\pipe\latch-*`) or Unix domain socket on macOS/Linux. Inside `native-host`, bundled `playwright-core` connects via `chromium.connectOverCDP` to an in-process WebSocket relay bound strictly to `127.0.0.1` with random per-connection capability tokens.

Latch includes no telemetry, analytics, cloud sync, or automatic upload service, and exposes no LAN or public listeners. Websites generate their normal traffic during interactions, and your AI coding client/provider has its own retention policies for CLI outputs, snapshots, or screenshots you share with it.

## Files and retention

| Data | Default location / purpose |
| --- | --- |
| Configuration & pairing | `<appDataDir>/config.json` (Win: `%LOCALAPPDATA%\Latch`, macOS: `~/Library/Application Support/Latch`, Linux: `~/.config/latch`) |
| Native host registration & launcher | `<appDataDir>/runtime/bin/latch` and OS Chrome NativeMessagingHosts registration |
| Workspace session bindings & large snapshots | `<appDataDir>/sessions/` (never writes `.playwright/` or `.latch/` dotfiles into user repositories) |
| Exploration Library runs | `artifacts/` next to config, or custom `artifactsDir` / `LATCH_ARTIFACT_ROOT` |

Secrets & redaction:
- Recognized credential headers, cookies, tokens, password inputs, and internal CDP endpoints are scrubbed (`[redacted]`) from persisted artifacts, console/network captures, and diagnostics.
- Arbitrary page text and PNG screenshots can still show sensitive information on screen; review runs before exporting or sharing.

Deletion & uninstall:
- No automatic expiration or remote upload occurs.
- Delete individual or all inactive runs anytime via `latch library delete <runId>`, `latch library delete --all`, or the **Delete** buttons in the local Exploration Library UI.
- `latch finish` and `latch disconnect` detach automation while keeping Chrome tabs, cookies, and logins intact.
- `latch uninstall` removes native messaging registration and runtime launchers while preserving `config.json` and `artifacts/`.
