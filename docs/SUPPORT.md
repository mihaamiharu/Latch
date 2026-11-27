# Latch support matrix

| Component | Requirement | Notes |
| --- | --- | --- |
| Node | `>=22.0.0` | External prerequisite |
| Playwright CLI | `0.1.20` | External prerequisite; `pw` normalizes errors |
| Chrome | `125` or later | Flat debugger session API floor (`minimum_chrome_version: "125"`) |
| Browser transport | Latch native schema 4, recovery contract 1, popup control 1 | Uses `debugger` permission directly; no external extension |
| Native messaging host | `com.latch.bridge` | Fixed extension ID `dlkpkeiejlgggeoibejpoajedoelfcli` |

Automatic browser tests run headless with disposable profiles and test-only launch flags (see `AGENTS.md`). Headless results do not establish headed focus behavior.
