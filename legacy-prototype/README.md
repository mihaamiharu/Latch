# Existing work tab → Playwright CLI

This prototype adds an existing work tab to the connected Playwright tab group entirely through the terminal. It uses `playwright-cli run-code` to call Chrome's Tabs API from the extension's connected Welcome page. No desktop automation, extra extension, remote debugging port, cookie export, or browser restart is involved.

## Run

Use the same working directory for the attach, helper, and subsequent CLI commands.

```bash
playwright-cli -s=qa-work attach --extension=chrome
node /Users/ekkisyam/Workspace/qa/qax/work-browser-bridge/legacy-prototype/claim-tab.mjs \
  https://github.com/rizaqpratama/testsaurus/issues qa-work
playwright-cli -s=qa-work tab-list
```

Select the target's index from `tab-list`, then use normal CLI commands:

```bash
playwright-cli -s=qa-work tab-select <index>
playwright-cli -s=qa-work snapshot
```

## Preconditions and boundaries

- The extension must already be installed and authorized in the Work profile. This machine's extension currently connects automatically. The helper does not approve connection dialogs or set/read authentication tokens.
- To explicitly pin a profile on future attachments, set `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` to the work profile directory name before `attach`. This installed CLI reads that setting. The directory name is the last component of Profile Path shown by `chrome://version`; it is not the visible label "Work". Explicit profile pinning has not yet been validated on this machine.
- Keep the connected extension Welcome tab open. It is the bootstrap context for tab management.
- Supply an exact URL. The helper only considers tabs in the Welcome tab's profile/window and requires exactly one matching tab.
- A target already in the session's group succeeds without moving it. A target in another group is rejected to avoid stealing another client's tab or changing an unrelated group.
- The helper never navigates, reloads, closes, or logs into the target page. Its browser mutation is placing that specific tab into the existing Playwright group.
- Tab-group scoping is a workflow boundary, not a security sandbox: extension-page code can access Chrome APIs across the connected profile. Separate Work and Personal profiles matter. This helper does not connect to the Personal profile.
- This is a version-dependent workaround using an accessible extension context, not a documented Playwright CLI tab-import command. Tested runtime: CLI 0.1.20, Playwright extension 0.4.0. Revalidate after updates.
- For subsequent independent agents, use separate named sessions. A tab cannot be shared by multiple client groups at once.

To detach without closing your browser or website tabs:

```bash
playwright-cli -s=qa-work detach
```

## Verified on this machine

On October 28, 2026, using Playwright CLI 0.1.20 and Playwright extension 0.4.0:

1. Detached the existing `qa-work` session, then attached again using only CLI commands. The new session initially saw only its Welcome page.
2. Ran this helper against the existing GitHub Issues URL. It moved the existing tab into the new group and verified the page title. The Chrome tab ID before and after reattachment was identical; no replacement page was created.
3. Selected the tab through CLI. The signed-in user navigation button and Issues (22) link were present.
4. Repeated the helper against an already connected tab; it succeeded without regrouping it.
5. Supplied an absent exact URL; the helper exited with failure and reported that no tab was moved.

All steps above used terminal commands, without desktop automation or manual dragging. The test used an already installed and authorized extension. Explicit profile pinning, browser restarts, and operation from a different project directory remain untested.

## Sources

- [Playwright CLI attach/detach](https://playwright.dev/agent-cli/commands/attach)
- [Playwright extension source and group behavior](https://github.com/microsoft/playwright/tree/main/packages/extension)
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
