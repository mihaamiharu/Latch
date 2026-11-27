# Latch

A cross-platform Chrome companion extension, native bridge, and flat `latch` CLI that connects AI coding agents to your signed-in Chrome tabs—with bundled `playwright-core` and built-in exploration filmstrips.

## Prerequisites

- **OS:** Windows, macOS, or Linux
- **Node.js:** `>= 22.0.0`
- **Google Chrome:** `>= 125`
- No external `playwright-cli` or `ffmpeg` required (`playwright-core` is bundled inside `native-host` over an in-process CDP relay).

## Quick start

1. Install dependencies (skipping Playwright browser downloads):
   ```sh
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
   ```
   On Windows PowerShell:
   ```powershell
   $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; npm ci
   ```
2. Install the native host and `latch` launcher, then load `extension/` unpacked in Chrome (`chrome://extensions`, Developer mode, fixed ID `dlkpkeiejlgggeoibejpoajedoelfcli`):
   ```sh
   node src/cli.mjs install
   ```
3. Pair the running extension and verify health:
   ```sh
   latch pair
   latch doctor
   ```
4. Install the native plugin/skill for your coding agents:
   ```sh
   latch agents install
   ```

See [SETUP.md](SETUP.md) for full Windows, macOS, and Linux installation details.

## Flat CLI overview

All commands support global flags `--json`, `-s` / `--session <name>`, `--profile <alias>`, and `--workspace <path>`. `--profile` defaults to the sole/default paired profile, `--workspace` defaults to `cwd`, and active workspace sessions bind cleanly under `<appDataDir>/sessions/` with zero dotfiles added to your repository.

### Session lifecycle & browser actions

```sh
latch tabs
latch open https://staging.example.com
latch snapshot
latch click e3
latch fill e5 "synthetic input"
latch screenshot --out result.png
latch disconnect
```

- **Lifecycle:** `latch tabs`, `latch open <url> [--record] [--objective <text>] [--environment <text>] [--focus-emulation on|off]`, `latch connect <tabId> [...]`, `latch sessions`, `latch release [tabId]`, `latch disconnect`, `latch finish`
- **Actions:** `latch snapshot`, `latch click <ref|selector>`, `latch fill <ref|selector> <value>`, `latch type [ref|selector] <text>`, `latch press <key>`, `latch hover <ref|selector>`, `latch select <ref|selector> <value>`, `latch check <ref|selector>`, `latch uncheck <ref|selector>`, `latch upload <ref|selector> <path...>`, `latch screenshot [--out <path>]`, `latch goto <url>`, `latch back`, `latch forward`, `latch reload`, `latch eval <expr>`, `latch run-code <fn>`, `latch console`, `latch network`, `latch dialog <accept|dismiss> [promptText]`

### Recorded explorations

Pass `--record` or `--objective "<goal>"` on `open` or `connect` to capture before/after PNG screenshot filmstrips, ARIA snapshots, and DOM locator candidates:

```sh
latch open https://staging.example.com/checkout --record --objective "Verify checkout validation"
latch snapshot
latch click e4
latch checkpoint "Submitting empty form shows required-field errors"
latch finish
latch library serve
```

- `latch checkpoint <note> [--annotation-file <path>]`
- `latch library <list|show|serve|review|export> [--run <id>]`

## Agent plugins & skills

`latch agents <install|status|uninstall> [--target antigravity,claude,codex,cursor]` links Latch into your agent toolchains using directory junctions (Windows) or symlinks (macOS/Linux), never overwriting unrelated user customizations:

| Client | Target path | Source in repo |
| --- | --- | --- |
| Antigravity | `~/.gemini/config/plugins/latch` | `plugins/antigravity/` |
| Claude Code | `~/.claude/skills/latch` | `skills/latch/` (and `.claude-plugin/plugin.json`) |
| Codex / Cursor | `~/.agents/skills/latch` | `skills/latch/` |

## Architecture & key files

| Path | Purpose |
| --- | --- |
| `extension/` | MV3 Chrome extension (`tabs`, `tabGroups`, `storage`, `nativeMessaging`, `alarms`, `debugger`; no website host permissions) |
| `src/native-host.mjs` | Native messaging host, IPC listener, and in-process CDP relay |
| `src/browser-engine.mjs` | Bundled `playwright-core` (`chromium.connectOverCDP`) session & ARIA ref engine |
| `src/platform.mjs` | Cross-platform paths, named pipes / Unix sockets, launchers, and registry/manifest helpers |
| `src/cli.mjs` | Flat `latch` CLI with smart defaults and `--json` output |
| `src/exploration*.mjs` | Unified Exploration Library, before/after screenshot filmstrip, and local review UI |
| `src/agents.mjs` | Native agent plugin & skill installer (`latch agents`) |
| `plugins/antigravity/` | Native Antigravity plugin bundle (`plugin.json`, `rules/AGENTS.md`, `skills/latch/SKILL.md`, `assets/logo.png`) |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest pointing to `skills/` |
| `skills/latch/` | Slim cross-agent `SKILL.md` and `agents/openai.yaml` |

## Build & tests

```sh
npm run build
npm test
```

`npm run build` produces `dist/latch/`, `dist/latch-1.0.0/`, and deterministic release archives in `dist/`. Browser integration tests run headless with disposable profiles per [AGENTS.md](AGENTS.md).

## More documentation

- [SETUP.md](SETUP.md) — cross-platform installation, pairing, and troubleshooting
- [PRIVACY.md](PRIVACY.md) — local transport, redaction, and retention details
- [docs/SUPPORT.md](docs/SUPPORT.md) — supported OS/Node/Chrome matrix
- [docs/EXPLORATION-LIBRARY.md](docs/EXPLORATION-LIBRARY.md) — exploration handoff and local review server
