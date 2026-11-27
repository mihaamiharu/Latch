# Latch support matrix

| Component | Requirement | Notes |
| --- | --- | --- |
| Operating systems | Windows, macOS, Linux | Named Pipes (`\\.\pipe\latch-*`) on Windows; Unix domain sockets on macOS/Linux |
| Node.js | `>=22.0.0` | External prerequisite |
| Google Chrome | `125` or later | Flat debugger session API floor (`minimum_chrome_version: "125"`) |
| Browser engine | Bundled `playwright-core` `1.65.1` + `ws` `8.22.0` | Runs in-process inside `native-host` over CDP relay; no external `playwright-cli` or `ffmpeg` |
| Browser transport | Latch native schema 4, recovery contract 1, popup control 1 | Uses `debugger` permission directly; no website host permissions or content scripts |
| Native messaging host | `com.latch.bridge` | Fixed extension ID `dlkpkeiejlgggeoibejpoajedoelfcli` |

Automatic browser tests run headless Chrome for Testing with disposable profiles and test-only launch flags (see `AGENTS.md`). Headless results do not establish headed focus behavior.
