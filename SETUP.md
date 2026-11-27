# Latch v1.0 Setup Guide

Latch connects coding agents to tabs in your real Google Chrome profile across **Windows**, **macOS**, and **Linux**.

## Prerequisites

- **Node.js `>= 22.0.0`**
- **Google Chrome `>= 125`**
- No external `playwright-cli` or `ffmpeg` needed — `playwright-core` is bundled inside `native-host`.

### Platform data directories

| Platform | Default `<appDataDir>` | Native host registration |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Latch` | `%LOCALAPPDATA%\Latch\NativeMessagingHosts\com.latch.bridge.json` + `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.latch.bridge` |
| macOS | `~/Library/Application Support/Latch` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.latch.bridge.json` |
| Linux | `$XDG_CONFIG_HOME/latch` (or `~/.config/latch`) | `$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts/com.latch.bridge.json` |

Environment overrides: `LATCH_CONFIG`, `LATCH_RUNTIME_DIR`, `LATCH_ARTIFACT_ROOT`, `LATCH_HOME`.

You can also configure a custom exploration artifacts folder persistently in `config.json` (resolution order: `LATCH_ARTIFACT_ROOT` env → `config.json` `artifactsDir` → default `<appDataDir>/artifacts`) via CLI or the extension popup's **Library & storage** section:

```sh
latch config get artifacts-dir
latch config set artifacts-dir /path/to/artifacts
latch config unset artifacts-dir
```

Click **Open Library** in the Latch Chrome extension popup at any time to start the local Exploration Library viewer in a browser tab without needing `latch library serve`.

## 1. Install native host & CLI launcher

From your Latch checkout or extracted release kit:

```sh
node src/cli.mjs install
```

This creates `<appDataDir>/runtime/bin/latch` (`latch.cmd` on Windows), registers the `com.latch.bridge` native messaging host for extension ID `dlkpkeiejlgggeoibejpoajedoelfcli`, initializes `config.json`, and links the agent skills/plugins. Add `<appDataDir>/runtime/bin` to your `PATH` (or link `npm link` from a checkout) to run `latch` directly from any folder.

## 2. Load the Chrome extension

1. Open `chrome://extensions` in the Chrome profile you want agents to use.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder from Latch.
4. Confirm the extension ID is `dlkpkeiejlgggeoibejpoajedoelfcli` and keep it enabled.

## 3. Pair and verify

With Chrome running and the extension enabled:

```sh
latch pair
latch doctor
```

- `latch pair` auto-discovers a single live unpaired extension instance and binds it to the default `work` profile alias (pass `--profile <alias>` to add another profile, or `--instance <uuid> --chrome-profile-dir "Profile 1"` when multiple instances are running).
- `latch doctor` checks OS, Node version, native messaging registration, and live bridge connectivity. Pass `latch doctor --fix` to repair missing registration or stale workspace bindings.
- If you ever reinstall the extension and its instance UUID changes:
  ```sh
  latch pair --profile work --instance <new-uuid> --chrome-profile-dir Default --replace --expect-old <old-uuid>
  ```

## 4. Install agent plugins & skills

Install Latch into Antigravity, Claude Code, and Codex/Cursor (or select specific targets):

```sh
latch agents install
latch agents install --target antigravity,claude
latch agents status
```

Target paths:
- **Antigravity:** `~/.gemini/config/plugins/latch` (plugin bundle with `plugin.json`, `rules/AGENTS.md`, `skills/latch/SKILL.md`)
- **Claude Code:** `~/.claude/skills/latch` (plus repo `.claude-plugin/plugin.json`)
- **Codex / Cursor:** `~/.agents/skills/latch`

Existing user-owned skills or plugins are never overwritten (`conflict` status).

## 5. Daily workflow

Quick inspection:

```sh
latch tabs
latch open https://staging.example.com
latch snapshot
latch click e3
latch fill e5 "synthetic input"
latch screenshot --out result.png
latch disconnect
```

Recorded exploration with before/after screenshot filmstrips:

```sh
latch connect 12345 --record --objective "Verify settings save flow" --environment staging
latch snapshot
latch click e7
latch checkpoint "Save button updates banner without page reload"
latch finish
latch library serve
```

- `--profile`, `--workspace`, and `-s`/`--session` have smart defaults (active sessions are bound per workspace under `<appDataDir>/sessions/` with zero repo dotfiles).
- Pass `--focus-emulation off` on `open`/`connect` only when testing real window focus or visibility events.
- Pass `--json` to any command for structured JSON output.

## 6. Uninstall

Disconnect active sessions first, then remove agent links and native registration:

```sh
latch agents uninstall
latch uninstall
```

`latch uninstall` removes the native host registration and launchers while preserving your `config.json` and `artifacts/` exploration library.
