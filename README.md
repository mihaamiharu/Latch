# Latch

A macOS Chrome companion extension and local CLI for connecting existing Work-profile tabs to Playwright CLI. Run `npm ci` after cloning/updating this source branch: the native host now depends on the pinned `ws` transport library.

**Status (November 1, 2026):** RC6 is installed and verified in Work, with native
selected and the official extension off. The upgrade changed the extension's
stored instance ID; an explicitly approved pairing repair restored access. The
cause remains unproven, so identity-preserving live upgrade is **not accepted**.
The Work fixture pilot passed normal recording/error/cleanup, a background read
with operator-reported Personal foreground, and peer usability after observed
lease loss. Popup Stop is unverified: its prior idle PASS was withdrawn because
button-click causation was not confirmed. Fresh actual Codex CLI RC6 acceptance
also remains open.
See the [Work pilot record](docs/acceptance/macos-work-rc6-2026-11-01/README.md).

An earlier actual Codex CLI RC3 smoke passed under per-session Full Access;
restricted workspace-write, Claude Code and Cursor CLI remain unverified. Profiles
without an explicit native preference retain the legacy official default. See the
[RC3 acceptance](docs/acceptance/codex-native-rc3-2026-10-30/README.md) and
[release/agent/artifact review](docs/RELEASE-READINESS-2026-10-30.md).

The agreed first-release scope is **local and internal**, macOS only, with the
existing native bridge. The repository decision is deferred; no remote, push or
upload is authorized. No public project license has been selected. Third-party
notices retain their own terms.
The [macOS release execution plan](docs/MACOS-FIRST-RELEASE-PLAN.md) defines the
remaining implementation, reporting, client acceptance and packaging gates.

The source candidate is now **0.2.0-rc.6**. It pins the validated CLI and Node
execution environment for GUI-launched native-host cleanup, and includes local
data-handling/third-party notices. RC5 adds the maintained evidence recorder,
offline reports/integrity checks and explicitly selected evidence exports. RC4 adds checked macOS prerequisites,
a qualified Chrome minimum, pinned floor/current browser test lanes, verified
native-default setup and same-client `preflight` for task/cache/bridge access.
See [candidate support](docs/SUPPORT.md). RC3 preserves official-attach causes,
warns about native focus-off interactions and adds `qa-browser pw` to normalize
Playwright action errors.
See [RC3 failure handling](docs/RC3-FAILURE-HANDLING.md) for the preparation record.
The later operator-assisted update and Work-default change are recorded separately;
the installed RC6 payload is the frozen software checkpoint `1dd3eb2`; its retained
RC3 rollback payload remains `b0891c1`.

The native candidate removes that extension dependency while keeping Playwright CLI. See [the single-extension migration plan](docs/SINGLE-EXTENSION-PLAN.md) for architecture, acceptance gates and rollback. Broader release acceptance remains in progress; Work's explicit native preference does not change the default for other unconfigured profiles.

The native preview integrates the normal CLI/helper with paired profiles and independent agent workspaces. It owns one selected starting tab plus verified popup descendants. The [Gate C work](docs/GATE-C-FRAMES-WORKERS-PLAN.md) adds bounded child-session lifetimes, nested frame routing, dedicated-worker checks and targeted cancellation. Headless comparison covers same-origin/cross-origin/OOPIF forms, navigation, replacement and frame evidence. The pinned CLI does not backfill already-running workers into `page.workers()` in these tests; new dedicated workers are observable and evaluable. See the [Phase 3 acceptance status](docs/PHASE-3-COMPATIBILITY-PLAN.md). Work now explicitly defaults to native; transport/focus flags remain useful for reproducible smokes and other profiles retain their own preferences. Gate D verifies byte-preserving uploads and separates browser download receipt from unsupported managed retrieval. Gate E adds verified large evidence, finite transport bounds and scoped failure cleanup. Phase 4 adds acknowledged bridge recovery, fenced native leases, host-owned journals and guarded reconciliation; see [the recovery results](docs/PHASE-4-RECOVERY-RESULTS.md). Phase 5 adds a complete local release kit, an owned installer and profile-scoped session popup. See [setup](SETUP.md) and [Phase 5 results](docs/PHASE-5-INSTALLER-POPUP-RESULTS.md). Phase 6 adds explicit per-profile transport preferences; Work cutover remains gated. See [the Phase 6 plan](docs/PHASE-6-WORK-ROLLOUT-PLAN.md).

## Build the extension

```bash
npm run build
```

This builds `dist/latch/`, its extension ZIP, and the complete `dist/latch-0.2.0-rc.6/` kit plus kit ZIP. It validates the fixed identity, module inventory, permissions, dependency/licenses and file hashes. Build does not modify the source manifest, native registration or installed launchers. Load the built stable installation directory after setup; the source manifest remains the installed-compatibility baseline.

Latch 0.1.1 uses the agent-and-latch icon in 16, 32, 48 and 128px sizes. The original generated master and prompt are preserved in `assets/latch/`. The extension ID, `qa-browser` command, native host name and existing config path are preserved.

## What it does

`qa-browser tabs` discovers ordinary tabs across the paired profile. Native `connect` attaches the selected existing tab and verified descendants, preserving their windows/groups and signed-in state. `release` releases one owned tab; `disconnect` releases this task and detaches its CLI session. Website tabs stay open. The explicit legacy official adapter uses a Playwright tab group.

The retained 0.1.2 compatibility payload uses the official Playwright extension. The built native candidate adds `alarms` and `debugger` to `tabs`, `tabGroups`, `storage` and `nativeMessaging`. It has no website host permissions, content scripts or external-message endpoint. The candidate can operate selected native sessions without the official extension; verified native setup selects that profile's default. Tab metadata is available throughout the paired profile; selected-page content is accessed through Playwright.

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
| `src/install.mjs`, `src/setup.mjs` | Inspect/stage/activate/verify/rollback owned setup |
| `test/` | Protocol, conflict, identity and real-browser compatibility tests |

## One-time setup

Follow [SETUP.md](SETUP.md) for candidate inspect/stage/activate/verify, retained
0.1.2 upgrade/rollback and explicit managed skill migration. Setup validates Node
22.21.1 and Playwright CLI 0.1.20 without installing dependencies globally. It uses
a versioned local runtime and a stable physical extension directory. Chrome
enable/permission acceptance is a one-time operator step, separate from daily
agent operation. Installed Work runs RC6 after approved pairing repair; remaining Work/client
acceptance is recorded separately.

`node src/install.mjs prepare` now writes an **unregistered development preview**
under `dist/setup-preview/` only. The historical `apply` command is replaced by
reviewed `activate`. Existing `install/qa-browser` commands below describe the
unchanged installed 0.1.2 compatibility prototype; new managed installations use
`<runtime>/bin/qa-browser` instead.

If one coding agent cannot reach Latch while another can, run `./install/qa-browser diagnose --profile work` **inside the failing agent's shell environment** and compare it with the same command in a normal local terminal. The output separates configured pairing, caller/runtime paths, socket visibility and actual connection errors. `BRIDGE_ACCESS_DENIED` preserves `EPERM`/`EACCES`; `PROFILE_UNAVAILABLE` preserves `ENOENT`/`ECONNREFUSED`. Discovery also retains unreachable-socket warnings. An empty discovery list alone does not establish that the profile is unpaired. This diagnostic does not read web pages or change browser/client settings.

Pairing stores configuration in `~/Library/Application Support/Work Browser Bridge/config.json`. Successful session registration verifies that the CLI connection page appears inside the paired extension instance, so a wrong profile directory fails before any target tab is claimed. The prototype deliberately does not infer the work profile from last-used state or read Chrome's protected profile files.

The bridge is intended for regular, already open Chrome windows. Native setup uses Latch alone. The legacy official adapter separately needs the official extension's authorization. Chrome enable/permission prompts remain operator steps.

## Terminal workflow

For a managed release installation, use `node src/install.mjs skills` from its kit after verification. For checkout-based development only, run `npm run skills:install` once. It links the canonical `skills/latch/` directory into the local user's `.agents/skills/latch` for Codex/Cursor and `.claude/skills/latch` for Claude Code. Existing unrelated skills are not overwritten. The same skill contains the workflow, wrapper and recovery reference; clients do not need an MCP server configuration for Latch.

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

## Legacy official session registration

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
npm run test:evidence
npm run test:evidence-limits
npm run test:evidence-isolation
npm run test:evidence-performance
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
bounds, not production transfer-size promises. Gate E
validates separate evidence routes at the measured sizes below.
The tests configure only private disposable-profile download directories before
launch. They add no downloads permission and do not change the Work profile.

## Large evidence and transport

Gate E verifies exact decoded pixels in PNGs up to 12,623,891 bytes and all rows
in snapshots around 1.17 and 4.70 MB. Text and binary response-body files match
independent server hashes at 1 and 4 MiB. At 16 MiB, both pinned adapters report
inspector-cache eviction; browser receipt is not a saved body. The pinned CLI
can return `{}` when that capture fails, so verify the saved file's content.

Prefer `screenshot`, `snapshot` and `response-body` with explicit `--filename`
paths. `requests` provides the current request index for `response-body`. These
normal CLI outputs save files and return small metadata. No new file broker is
needed. The CLI's console history retains at most 200 messages; establish a
listener before a bounded burst when the complete event sequence matters.

Native messages are bounded to 32 MiB serialized UTF-8, in both directions. A send
is admitted only while existing backlog is at most 8 MiB, with at most one 32 MiB
message added: up to 40 MiB application bytes before another send is rejected.
This is not a process-memory cap. Ordinary browser calls retain a 10-second
deadline; awaited Runtime.evaluate/callFunctionOn calls get 30 seconds. Stuck
work revokes its own relay; it does not reconnect or replay an uncertain action.

Latch's internal CLI wrapper retains a 2 MiB raw stdout bound and 45-second
default deadline, with a one-second forced-exit fallback before returning an
aborted child result. Direct `playwright-cli` commands do not pass through that
collector. Large captures use file output, rather than relying on inline results.
See [the Gate E matrix](docs/GATE-E-EVIDENCE-TRANSPORT-PLAN.md) and
[measured route ledger](docs/GATE-E-ROUTE-LEDGER.md) for scope and limitations.

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


## Native recovery preview

For a paired schema-4 native host, inspect the exact task before cleanup:

```bash
qa-browser doctor --profile work --transport native --session task --workspace /absolute/project
qa-browser reconcile --profile work --session task --workspace /absolute/project
qa-browser reconcile --profile work --session task --workspace /absolute/project --apply --expect <returned-plan-token>
```

Inspection is read-only and works offline. Apply needs a verified live native
bridge and the current token. It preserves website tabs, peers, login state and
evidence. A healthy session uses normal `disconnect`; a stale successor token
is rejected. Corrupt/partial/legacy state and unproven daemon ownership are
preserved with specific blockers. Never delete PID-only locks or replay an
uncertain application action as recovery. Bridge reconnection does not reconnect
automation: discover fresh metadata and explicitly connect after scoped cleanup.

New native journals are beside the selected configuration under
`native-v4/<instance>/`; task evidence stays in its existing task directory.
`npm run test:recovery` and `npm run test:recovery-chaos` use headless disposable
profiles. Updating these sources or the skill does not upgrade installed Work.
