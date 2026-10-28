# Latch

A macOS Chrome companion extension and local CLI for connecting existing Work-profile tabs to Playwright CLI. Run `npm ci` after cloning/updating this source branch: the native host now depends on the pinned `ws` transport library.

**Status:** installed compatibility prototype. The native host is registered and the Work profile is paired. Direct Chrome → native messaging → companion → Playwright CLI attachment has been verified using a temporary local fixture in the actual Work profile. Browser/worker restart recovery remains prototype work. The official Playwright extension is still required.

The next version removes that extension dependency while keeping Playwright CLI. See [the single-extension migration plan](docs/SINGLE-EXTENSION-PLAN.md) for architecture, acceptance gates and rollback. Migration is in progress; the installed daily transport is unchanged.

The native preview integrates the normal CLI/helper with paired profiles and independent agent workspaces. It owns one selected starting tab plus verified popup descendants. The [Gate C work](docs/GATE-C-FRAMES-WORKERS-PLAN.md) adds bounded child-session lifetimes, nested frame routing, dedicated-worker checks and targeted cancellation. Headless comparison covers same-origin/cross-origin/OOPIF forms, navigation, replacement and frame evidence. The pinned CLI does not backfill already-running workers into `page.workers()` in these tests; new dedicated workers are observable and evaluable. See the [Phase 3 acceptance status](docs/PHASE-3-COMPATIBILITY-PLAN.md). Native mode remains opt-in; the Work installation and daily default are unchanged. Gate D verifies byte-preserving uploads and separates browser download receipt from unsupported managed retrieval. Large payloads, recovery and cutover remain later gates.

## Build the extension

```bash
npm run build
```

This regenerates the manifest and produces an unpacked extension in `dist/latch/` plus `dist/latch-<version>.zip`. The editable source remains in `extension/`; reloading an extension already loaded from that directory picks up the rebuilt name and icon. The ZIP contains `manifest.json` at its root.

Latch 0.1.1 uses the agent-and-latch icon in 16, 32, 48 and 128px sizes. The original generated master and prompt are preserved in `assets/latch/`. The extension ID, `qa-browser` command, native host name and existing config path are preserved.

## What it does

`qa-browser tabs` discovers ordinary tabs across the paired profile. `connect` places a selected existing tab into the exact Playwright session group, verifies the page through CLI, and selects it for subsequent CLI commands. `release` ungroups it while preserving the page and login. `disconnect` releases this bridge's owned tabs and detaches the CLI session.

The companion has `tabs`, `tabGroups`, `storage` and `nativeMessaging` permissions. It has no debugger permission, content scripts or external-message endpoint. Browser automation stays in the official Playwright extension. Tab metadata is available throughout the paired profile; selected-page content is accessed through Playwright.

The design and roadmap are in `BUILD-PLAN.md`. The earlier experimental helper is preserved in `legacy-prototype/`; its research/test artifacts are under `work/`.

## Files to review

| File | Purpose |
| --- | --- |
| `extension/manifest.json` | Permissions and this companion's own public identity |
| `extension/controller.js` | Tab discovery, exact session registration and ownership |
| `extension/background.js` | Chrome-native transport and scoped extension-page messages |
| `src/native-host.mjs` | Native message framing and per-profile Unix socket |
| `src/playwright.mjs` | CLI subprocesses, profile pinning, locator correlation and verification |
| `src/cli.mjs` | User-facing commands |
| `src/install.mjs` | Prepare/install/uninstall native host registration |
| `test/` | Protocol, conflict, identity and real-browser compatibility tests |

## One-time setup

First review the generated `install/preview.json`, extension manifest and native host manifest. Preparation only writes inside this project:

```bash
node src/install.mjs prepare
```

Installation registers `com.qa_browser.bridge` in the current user's macOS Chrome NativeMessagingHosts directory. Its allowed origin is this companion's own extension ID. The launcher uses an absolute Node executable path. Run from this project only after deciding to grant the extension Work-profile tab access:

```bash
node src/install.mjs apply
```

Load this project's `extension/` directory as an unpacked extension in the Work profile's `chrome://extensions` page. This is an initial installation step, not part of routine agent operation. Leave the official Playwright extension installed and authorized in that same profile.

Find the Chrome profile directory once using Profile Path on `chrome://version`. Use the final path component, such as `Profile 1`, rather than the visible profile label. Find our instance UUID via the companion popup or the discovery command. If several instances are present, identify the intended Work-profile instance explicitly.

```bash
./install/qa-browser discover
./install/qa-browser pair --profile work --instance <uuid> --chrome-profile-dir 'Profile 1'
./install/qa-browser doctor --profile work
```

If one coding agent cannot reach Latch while another can, run `./install/qa-browser diagnose --profile work` **inside the failing agent's shell environment** and compare it with the same command in a normal local terminal. The output separates configured pairing, caller/runtime paths, socket visibility and actual connection errors. `BRIDGE_ACCESS_DENIED` preserves `EPERM`/`EACCES`; `PROFILE_UNAVAILABLE` preserves `ENOENT`/`ECONNREFUSED`. Discovery also retains unreachable-socket warnings. An empty discovery list alone does not establish that the profile is unpaired. This diagnostic does not read web pages or change browser/client settings.

Pairing stores configuration in `~/Library/Application Support/Work Browser Bridge/config.json`. Successful session registration verifies that the CLI connection page appears inside the paired extension instance, so a wrong profile directory fails before any target tab is claimed. The prototype deliberately does not infer the work profile from last-used state or read Chrome's protected profile files.

The bridge is intended for regular, already open Chrome windows. Initial automatic attachment depends on the official extension's existing authorization; this tool does not approve dialogs or obtain/save an authorization token for you.

## Terminal workflow

For reusable agent instructions, run `npm run skills:install` once. It links the canonical `skills/latch/` directory into the local user's `.agents/skills/latch` for Codex/Cursor and `.claude/skills/latch` for Claude Code. Existing unrelated skills are not overwritten. The same skill contains the workflow, wrapper and recovery reference; clients do not need an MCP server configuration for Latch.

Start a fresh local agent session, then invoke `$latch` in Codex, `/latch` in Claude Code, or select Latch from Cursor's skill menu. Natural requests such as “Use Latch to verify my existing staging tab” can also trigger it. Runtime capabilities still depend on shell permissions and the installed browser connection.

Use `npm run skills:status` to inspect discovery links. `npm run skills:uninstall` removes only links pointing to this canonical skill, leaving its source and other user skills intact. For a skill copied separately from the checkout, set `LATCH_HOME` to the installed Latch checkout; linked installations resolve the runtime automatically.

Use an explicit project root with `--workspace`, or run every command from the same directory. On the first connection the bridge creates `.playwright/` in that workspace so Playwright's own registry is scoped to that project.

```bash
/absolute/path/to/work-browser-bridge/install/qa-browser tabs --profile work
/absolute/path/to/work-browser-bridge/install/qa-browser connect \
  --profile work --session checkout --tab 123 --workspace /absolute/path/to/project

cd /absolute/path/to/project
playwright-cli -s=checkout snapshot
playwright-cli -s=checkout screenshot

/absolute/path/to/work-browser-bridge/install/qa-browser release \
  --profile work --session checkout --tab 123 --workspace /absolute/path/to/project
/absolute/path/to/work-browser-bridge/install/qa-browser disconnect \
  --profile work --session checkout --workspace /absolute/path/to/project
```

All bridge command results are JSON. The CLI can report a failure with a nonzero process exit even when Playwright's underlying command exits zero; it also inspects structured `isError` responses.

## How session registration works

The wrapper starts a normal `playwright-cli attach --extension=chrome` with the explicitly configured profile directory. Standard Playwright page inventory identifies the fresh official connection page. The adapter retains its relay locator, discards any connection-token parameter, and sends the sanitized locator to our extension.

The companion matches exactly one connection tab in its own profile and records that tab's actual group ID. It then uses Chrome's `tabs.group()` API for the selected work tab. The official extension observes the group change and performs its normal debugger attachment. No code is evaluated inside the official extension, and its files/ID are not modified.

Once registered, the group ID remains usable after the Welcome page closes, while another controlled tab keeps the official transport alive. A fresh registration still needs the initial connection page. Losing the last controlled tab can end the official transport; `disconnect` is the normal terminal cleanup path.

## Tests

```bash
npm test
```

After `npm ci`, the default tests run without browser prerequisites and skip opt-in browser cases. The two-session official-browser test is enabled by these three paths:

```bash
QA_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
QA_BROWSER_CHROME='/absolute/path/to/Google Chrome for Testing' \
QA_BROWSER_OFFICIAL_EXTENSION=/absolute/path/to/unpacked-official-playwright-extension \
npm test
```

All maintained browser tests now use disposable **headless** full Chrome for Testing profiles. Both adapters use real Chrome native messaging and private fixture-only registrations. Official authorization is provisioned only in the disposable profile, then its setup browser closes before runtime attachment. The earlier driver-substituted official test has been replaced by the shared actual-native-messaging fixture. Historical headed/Work results remain in `TEST-RESULTS.md`.

No user browser profiles, real login cookies or production mutations are needed for these tests. Intermediate browser fixtures are retained under this workspace's `work/browser-bridge/` for diagnosis. Unix sockets use short temporary paths because macOS limits their length, and are removed after tests.

The newer comparison harness uses real Chrome native messaging for **both** adapters, separate disposable profiles and the normal shared-skill helper. Run on macOS with Chrome for Testing and the pinned CLI on PATH:

```bash
npm run test:attachment-compat
npm run test:popups
npm run test:frames-workers
npm run test:frame-isolation
npm run test:files
npm run test:file-isolation
```

Set `QA_BROWSER_OFFICIAL_EXTENSION` to an unpacked official extension if it is not at `work/browser-bridge/official-extension`. Official authorization is provisioned once in the disposable profile, then that setup browser closes; the comparison runtime launches without a driver or remote-debugging flags. Native runs omit the official extension. Both launches use mock-keychain flags. Reports, fixture observations and screenshots are retained under `work/attachment-compat/<adapter>-*/evidence/`. Private profiles and CLI registries alongside them are diagnostic data, not publishable evidence.

Headless fixtures disable background throttling. Frame tests additionally use browser-local test-host mappings and site isolation, recorded in reports; no system hosts file is changed. On macOS, the official headless fixture adapts connection-page URL delivery through a private, bounded loopback queue consumed by its provisioning code. It opens the normal official connect page; the official extension, CLI, automation relay and actual native-messaging path remain unmodified. This is test infrastructure, not a Work-browser runtime fallback or a claim of headed focus parity. The repository's `AGENTS.md` keeps future browser tests headless.

## File support

Gate D uses ordinary Playwright file-input APIs and CLI pending-chooser `upload`.
Text, empty/binary files, duplicate basenames, spaces/Unicode and same-origin/OOPIF
inputs are checked against the bytes received by a real multipart server. Clear
and reselect work; use fresh locators after input/frame replacement.

Browser download receipt is distinct from agent retrieval. Both pinned adapters
receive basic, redirected, duplicate-name and slow downloads in private fixture
inboxes. Low-level Page events are observable, but normal Playwright Download
objects and exact `saveAs` retrieval are unavailable in this attachment baseline.
Native mode rejects managed download configuration explicitly. There is no file
broker and no latest-file/filename guessing. Ordinary screenshot/snapshot evidence
still works. See [the Gate D plan and dispositions](docs/GATE-D-FILES-PLAN.md) and
[shared agent instructions](skills/latch/references/operations.md#uploads-and-downloads).

The test corpus is at most 256 KiB per file and 1 MiB per case. These are fixture
bounds, not production transfer-size promises; larger evidence remains Gate E.
The tests configure only private disposable-profile download directories before
launch. They add no downloads permission and do not change the Work profile.

## Prototype limits

- Compatibility is pinned to Playwright CLI **0.1.20**; other versions fail explicitly until tested. The official extension tested is **0.4.0**.
- Official sessions use one window's tab group; cross-window claims fail rather than relocate tabs. Native descendants can open another window when their opener is verified.
- Official claims reject unrelated groups and ambiguous duplicate URLs. Native mode preserves existing groups and selects owned pages by exact target identity.
- Two bridge sessions cannot own the same tab. Other tools and agents must still avoid concurrent actions within one shared session.
- Browser/extension-worker restart recovery is not automated yet. Epoch mismatch fails closed; stale state needs deliberate reconciliation. This is not a production-ready recovery system.
- Process termination during a session operation can leave a lock directory. Its `owner.json` records the PID. Inspect the process before removing a stale lock; no automatic lock stealing is implemented.
- The official extension can detach when DevTools or browser lifecycle events interfere. Automatic reattachment/recovery beyond the official behavior is not implemented here.
- All profile-wide access assumes this companion is installed and paired in the intended Work profile. Group ownership is coordination, not a security sandbox around the official extension's existing privileges.
- The local socket trusts the current OS user and is protected with directory mode 0700/socket mode 0600. It is not a remote service.
- Unpacking/installing this companion is a one-time setup action. This release does not publish to the Chrome Web Store or install itself silently.

## Uninstall

Disconnect managed sessions first, then run:

```bash
node src/install.mjs uninstall
```

This removes only a native host registration matching this installation. Remove **Latch** in Chrome. The official Playwright extension and user website tabs remain independently installed/open. Configuration and workspace markers are preserved for deliberate removal if desired.

## Sources

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Playwright extension source](https://github.com/microsoft/playwright/tree/main/packages/extension)
- [Playwright CLI attachment](https://playwright.dev/agent-cli/commands/attach)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
