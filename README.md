# Latch

A Chrome companion extension and local CLI for connecting existing browser tabs to coding agents. Run `npm ci` after cloning/updating this repository.

## Build the extension

```bash
npm run build
```

This builds `dist/latch/`, its extension ZIP, and the complete `dist/latch-1.0.0/` kit plus kit ZIP. It validates the fixed identity (`dlkpkeiejlgggeoibejpoajedoelfcli`), module inventory, permissions, dependency/licenses, and file hashes.

## What it does

`latch tabs` discovers ordinary tabs across the paired Chrome profile. `latch connect` attaches the selected existing tab and verified popup descendants via Chrome's `debugger` API (native schema 4), preserving existing windows, tab groups, and signed-in state. `latch open` creates a fresh tab in an existing window and navigates to a URL. `latch release` releases one owned tab; `latch disconnect` releases the session while preserving website tabs.

The extension (`extension/manifest.json`) declares `tabs`, `tabGroups`, `storage`, `nativeMessaging`, `alarms`, and `debugger` permissions, with `minimum_chrome_version: "125"`. It has no website host permissions, content scripts, or external-message endpoint.

## Files to review

| File | Purpose |
| --- | --- |
| `extension/manifest.json` | Permissions (`debugger`, `alarms`, etc.) and fixed public extension identity |
| `extension/controller.js` | Tab discovery, native session reservation, and ownership |
| `extension/background.js` | Chrome-native transport and scoped extension-page messages |
| `src/native-host.mjs` | Native message framing and per-profile IPC socket |
| `src/playwright.mjs` | CLI subprocesses and verification |
| `src/cli.mjs` | User-facing `latch` commands |
| `src/install.mjs`, `src/setup.mjs` | Inspect/stage/activate/verify/rollback/uninstall owned setup |
| `test/` | Protocol, conflict, identity, and browser compatibility tests |

## One-time setup

Follow [SETUP.md](SETUP.md) for inspect/stage/activate/verify and managed skill installation. Setup validates Node `>=22.0.0` and Playwright CLI `0.1.20`.

`node src/install.mjs prepare` writes an unregistered development preview under `dist/setup-preview/`. Managed installations use `<runtime>/bin/latch`.

Pairing stores configuration in `~/Library/Application Support/Latch/config.json` (overridable via `LATCH_CONFIG`). The native messaging host is `com.latch.bridge`.

## Open a URL in a fresh tab

```sh
latch open --profile work --session checkout-qa \
  --workspace /absolute/project --focus-emulation on --url https://staging.example.com
latch pw --profile work --session checkout-qa --workspace /absolute/project -- snapshot
latch disconnect --profile work --session checkout-qa --workspace /absolute/project
```

## Terminal workflow

For a managed release installation, use `node src/install.mjs skills` from its kit after verification. For checkout-based development, run `npm run skills:install` once to link `skills/latch/` into `.agents/skills/latch` and `.claude/skills/latch`.

```bash
latch tabs --profile work
latch connect --profile work --session checkout --tab 123 --workspace /absolute/path/to/project
latch pw --profile work --session checkout --workspace /absolute/path/to/project -- snapshot
latch release --profile work --session checkout --tab 123 --workspace /absolute/path/to/project
latch disconnect --profile work --session checkout --workspace /absolute/path/to/project
```

## Tests

```bash
npm test
```

All browser tests run headless with disposable profiles and test-only launch flags (see `AGENTS.md`).

## Uninstall

Disconnect managed sessions first, then run:

```bash
node src/install.mjs uninstall
```

## Exploration library

See [docs/EXPLORATION-LIBRARY.md](docs/EXPLORATION-LIBRARY.md) for the local review library and structured YAML handoff, [docs/NATIVE-SESSION-WORKFLOW.md](docs/NATIVE-SESSION-WORKFLOW.md), [docs/NATIVE-TRANSPORT-CONTRACT.md](docs/NATIVE-TRANSPORT-CONTRACT.md), and [docs/SUPPORT.md](docs/SUPPORT.md).
