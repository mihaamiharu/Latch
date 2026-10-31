# Latch operations

Read this when you need command details or a concrete recovery path. The runtime is a prototype, validated with Playwright CLI 0.1.20. Do not auto-upgrade it to resolve an unknown error.

## Permission preflight (RC4+)

`preflight --profile work --session <task> --workspace <path>` checks the current
caller's platform, exact Node/CLI versions, paired bridge/controller, native
schema, task/cache writes and local loopback. Require `ready: true`, not merely
`ok: true`. Its JSON names the exact paths; attachment/application remain
`not-checked`. It creates missing task/cache directories and removes its own
probe files. A native setup default is selected separately by the installer's
`configure-native` command after installed identity/readiness verification.

For EPERM/EACCES, inspect the actual calling client's available tools and policy.
If command-scoped execution approval is exposed, request the exact blocked
command. If a permission-grant tool is actually exposed, use its supported scope;
category names in a policy do not prove a callable tool exists. An approved
diagnostic proves only that diagnostic's access. Discovery, attachment, daemon
cache writes and browser calls need their own permitted context. If neither
route exists, report a single actionable blocker and stop. Do not weaken socket
modes, edit global settings, switch OS users, assume Full Access or repeatedly
retry an unavailable route. Preserve partial evidence and earlier attempts.

Unreachable capability is unknown. A paired profile with an access-denied socket
is not unpaired, and a reachable host without a controller round trip is not a
verified native setup. CLI preflight cannot observe approval tools or determine
the real client's sandbox policy; record directly observed or client-reported
metadata with its provenance. It does not scan agent transcripts.

## Evidence and interaction

Run direct Playwright commands in `LATCH_WORKSPACE`, always specifying `-s="$LATCH_SESSION"`. On RC3+ the helper's `pw --profile work --session ... --workspace ... -- <command>` runs those same commands with JSON/error normalization. Use Latch for attachment/cleanup; `pw` rejects lifecycle commands and session/output overrides. Get fresh element references from the actual snapshot; the examples below use observed values supplied by the agent, not literal placeholder locators.

```bash
playwright-cli -s="$LATCH_SESSION" snapshot --filename="$LATCH_EVIDENCE/page.yaml"
playwright-cli -s="$LATCH_SESSION" click "$LATCH_ELEMENT"
playwright-cli -s="$LATCH_SESSION" fill "$LATCH_ELEMENT" "$LATCH_VALUE"
playwright-cli -s="$LATCH_SESSION" screenshot --filename="$LATCH_EVIDENCE/result.png"
playwright-cli -s="$LATCH_SESSION" console error
playwright-cli -s="$LATCH_SESSION" requests
```

Create the task's evidence directory before writing files. Check installed command help if an option differs. `run-code` executes an async Playwright function with `page`; return the result rather than relying on `console.log`. For structured assertions, `--json` returns a wrapper whose `result` can itself be a JSON string. Inspect `isError` even if a command exits zero.

Example read-only observation:

```bash
playwright-cli -s="$LATCH_SESSION" --json run-code 'async (page) => ({url: page.url(), title: await page.title()})'
```

Read only network bodies/headers relevant to the requested check. Limit evidence to useful application behavior; storage, headers and screenshots can include credentials or private content.

## Recover within the actual supported behavior

| Code or condition | Meaning and next step |
| --- | --- |
| `PROFILE_UNPAIRED` | The requested alias is missing from this caller's readable config. Run `diagnose` to capture the config path and execution context; do not choose another profile or change pairing automatically. |
| `PROFILE_UNAVAILABLE`, `BRIDGE_DISCONNECTED` | Pairing may exist but its socket is unavailable. Run `diagnose` from the same failing agent; preserve `ENOENT`/`ECONNREFUSED`, runtime path and socket state. An empty discovery list is not proof that the profile is unpaired. |
| `BRIDGE_ACCESS_DENIED`, `BRIDGE_CONNECTION_FAILED` | Run `diagnose` inside the failing agent and compare it with the user's normal local terminal. `EPERM`/`EACCES` indicates access denial, not a missing pairing. Report the specific boundary; do not disable sandboxing or expand permissions silently. |
| `EXTENSION_CONNECTION_FAILED` | The official extension did not complete attachment. A healthy bridge is a separate layer. Preserve the selected transport/source and bounded redacted upstream cause from `error.diagnostics` when available. Check the official extension's enabled state, matching profile and authorization without assuming which prerequisite failed. Do not change defaults or use desktop clicking to bypass it. |
| `PLAYWRIGHT_ERROR` with actionability timeout | Read `error.diagnostics.upstreamError` (or direct CLI `error`): locating a node is separate from visible/enabled/stable/event checks. Verify the actual accessible label, duplicates, visibility and overlays. In native mode also inspect the recorded focus policy. A timeout does not establish whether a mutation occurred; inspect independent state and never blindly retry or force-click. |
| `UNSUPPORTED_VERSION` | The installed CLI is outside the adapter's validated version. Report the actual version and compatibility restriction. |
| `TAB_UNAVAILABLE`, `TAB_CLOSED`, `TAB_CHANGED` | Refresh Latch metadata. If the intended tab is still uniquely identifiable, reconnect that tab using fresh metadata; otherwise ask for the target. Do not treat a changed page as the same verified state. |
| `TAB_OWNED`, `SESSION_OWNED`, `TAB_GROUPED` | Another session or an unrelated tab group owns the target. Preserve it and report the conflict; never steal it or ungroup unrelated tabs. |
| `WINDOW_MISMATCH` | This prototype's session and target are in different work windows. Cross-window relocation is not implemented; report the limitation instead of silently moving tabs. |
| `SESSION_COLLISION` | Choose a fresh task session name. Never detach an existing session just to reclaim the name. |
| `SESSION_STALE`, `PROFILE_MISMATCH` | Browser/worker state changed. Restart recovery is not automatic. Capture the current doctor result and session name; stop rather than repeatedly retrying or deleting state. |
| `SESSION_BUSY` | Another operation holds the session lock, or an interrupted process left one. Do not remove a lock without establishing that its recorded owner is gone and that repair is in scope. |
| `ATTACH_TIMEOUT`, `BROWSER_TIMEOUT`, `BRIDGE_TIMEOUT` | Inspect current health and ownership before retrying. A timed-out mutation has an uncertain outcome. Report it if the state cannot be established. |

Chrome tab IDs and group IDs are valid only in the current browser session. A connection to a group does not provide hard isolation against all privileged extension code. Keep the intended Work profile as the access boundary.

`diagnose` is read-only and includes caller hostname/platform/UID, Node executable, working directory, config/runtime/socket paths, whether pairing was found, socket metadata and connection result. It does not claim tabs or read page content. Save the raw JSON so a different execution context can be distinguished from an offline browser. `discover` also reports warnings for sockets it could not reach instead of silently hiding their failures.

### Codex CLI socket access

When the extension is connected but Codex reports `BRIDGE_ACCESS_DENIED` with `EPERM`, the command sandbox can be blocking local Unix socket access. This was reproduced with Codex's sandbox helper while the same diagnostic succeeded in the ordinary local shell. Reinstalling or re-pairing the extension does not address that boundary.

If the current Codex session supports approval requests, request an approved rerun of the same read-only diagnostic outside its command sandbox, explaining that it connects to the paired local browser bridge. If approval is unavailable or denied, report the blocked socket path. Do not edit global permissions, disable sandboxing, or use another tool to evade the boundary. A successful diagnostic verifies bridge access only; subsequent Playwright attachment may require its own local transport permission.

## Native-mode preview

The source branch supports `connect --transport native` through the same helper, profile pairing, workspace and named-session contract. It requires a bridge/extension build with debugger capability; the installed daily 0.1.2 build does not gain that permission merely because this skill was updated. Check `doctor --profile work --transport native` first. Profiles without a configured preference retain the official default. Inspect `transport --profile work`; use the configured native default only after the migration's installation and Work-profile gates pass. Do not reinstall, re-pair or change browser permissions automatically to enable this preview.

Each native session owns its explicitly selected starting tab and new tabs with a verified opener in that session. Use distinct session names for different tasks in the same workspace. The same name in different canonical workspaces is isolated. Reconnecting an owned starting tab or child selects it by CDP target identity, even when URLs match. An unrelated existing tab needs a separate session. Native mode preserves existing windows/groups.

Establish the popup waiter before the action, using ordinary Playwright APIs:

```bash
playwright-cli -s="$LATCH_SESSION" --json run-code 'async(page)=>{const waiting=page.waitForEvent("popup",{timeout:10000});await page.getByRole("link",{name:"Open details"}).click();const child=await waiting;await child.waitForLoadState("domcontentloaded");return {url:child.url(),title:await child.title()}}'
```

Use actual locators from the page. A child can open another child. Closing a parent preserves surviving owned children. To select a child for later CLI commands, refresh Latch `tabs`, then use the same helper `connect --transport native --session ... --tab ... --workspace ...`; its result includes `rootTabId`, active `targets` and ownership warnings. CLI `tab-select` indexes are temporary and differ from Chrome tab IDs.

Chrome must supply a verifiable opener. A `noopener` tab may remain unclaimed; a blocked popup creates no owned child. Report the popup wait timeout and current inventory instead of assigning ownership by URL, timing or window. Limits are 16 active top-level tabs, four child generations and 256 recorded tab identities per session. Limit/attachment/opener warnings leave the affected tab unclaimed. Upload support and download limitations are described below. Large evidence support and limits are described below; restart recovery remains a separate gate.

Native frame interactions have been compared with the official adapter using headless Chrome for Testing: same-origin, cross-origin, nested out-of-process frames, insertion/removal, navigation and replacement. Use standard `page.frameLocator(...)` and fresh locators after replacement. An iframe remains inside its owning tab/session; do not create a separate tab claim for it. Removed frame/child-session identities cannot be reused for a replacement.

For a new dedicated worker, establish `page.waitForEvent('worker', {timeout: ...})` before its creating action, then use the returned Worker's evaluation/close APIs. The pinned CLI does not backfill workers that were already running at attachment into `page.workers()` in the verified baseline; an empty inventory does not prove no worker exists. Report that limitation and use authorized application observations where appropriate. Do not restart an application worker merely to make it discoverable. Native shared/service-worker management is unsupported; its related-target filter accepts only iframe and dedicated-worker child types.

Child-session bounds are 64 active per top-level tab, 256 per lease and 16 target-ancestry levels. Retirement history is bounded at 1024 identities per tab; exhaustion rejects further child adoption for the affected tab. Native diagnostics retain bounded `CHILD_TARGET_REJECTED` warnings. These are debugger target/session bounds, distinct from popup and DOM-frame counts. Headless fixture results do not establish every headed/background focus behavior.

`--focus-emulation on` is an explicit native-connect option for background interactions. It simulates an active/focused page for the selected target and is cleared when its debugger detaches. It does not activate the Chrome tab, but can change the page's perceived focus/visibility; leave it off for checks that depend on real focus or background behavior. Changing it on an active session requires disconnect/reconnect. It is off by default and retained in the session record when later commands omit the flag.

For ordinary native background QA, choose `--focus-emulation on` at connection, before an interaction fails. RC3+ returns a `FOCUS_EMULATION_DISABLED` warning when it is off; that warning identifies a limitation, not the cause of every timeout. Stability checks can depend on animation frames. A fresh read-only observation can collect `document.visibilityState`, `document.hasFocus()`, locator count/visibility/enabled state and its bounding box. A bounded `locator.click({trial:true,timeout:1500})` probes actionability without clicking; it may still scroll, so use it only within the intended page. Use a bounded animation-frame probe if needed. Do not enable emulation during a focus/visibility assertion or equate its reported focus with operating-system focus.

The `pw` adapter returns structured errors on stderr with exit 1 and successful JSON on stdout. Its diagnostics retain the command name, upstream exit code, elapsed time and up to 4096 redacted cause characters. It does not expose raw stdout, connection URLs or CDP endpoints. It requires the exact workspace/session record and an attached daemon; schema-4 native commands preflight the live lease/daemon identity. That inspection is not an atomic reservation across CLI execution: use a unique session name per task and do not concurrently reconnect the same task. It releases the inspection grant before the application call so popup Stop/normal disconnect can revoke a held action. An upstream timeout remains an unknown application outcome, and no failed action is automatically repeated. This adapter does not sandbox JavaScript supplied to `run-code`.

Focus emulation does not establish every background popup/input flow. After a child is released, Chrome may still have that child active. For a foreground verification, explicitly call `page.bringToFront()` on the intended parent before establishing the popup waiter and clicking. Child selection through CLI `tab-select` also brings that page forward. A popup timeout alone does not establish that the browser blocked it: inspect current Latch metadata before deciding whether any action is safe to repeat.

`release` detaches only the specified owned tab and preserves it. Other owned pages keep their session. Explicitly released children are not automatically reclaimed. Releasing the last target returns `sessionClosed: true` and detaches the CLI; run normal `disconnect` afterward to remove the record. `disconnect` releases the whole task session, including surviving children. A failed new connection revokes its lease and cleans up only that task's session. If cleanup cannot be confirmed, `NATIVE_CLEANUP_FAILED` keeps the record for explicit disconnect. Popup-capable records use schema 3; a schema-2 preview session must be disconnected before reconnecting, rather than silently migrated. Stale epochs, unsupported schemas and explicit transport changes fail rather than being repaired silently.

Native access is coordination between authorized local agents, not isolation from arbitrary programs running as the same OS user. Endpoint credentials stay out of Latch reports/records, but are passed to the local Playwright subprocess; private CLI registry files may retain attachment options. Protect task/daemon directories and do not publish their contents as evidence.

## Uploads and downloads

Gate D compared the pinned CLI 0.1.20 with official 0.4.0 and native attachment
in disposable headless Chrome for Testing 153.0.8010.12. Use absolute paths to
files authorized for the task. Latch does not sandbox local file reads by other
programs running as the same OS user.

For an ordinary file input, use its observed locator:

```bash
playwright-cli -s="$LATCH_SESSION" --json run-code 'async(page)=>{await page.getByLabel("Attachment").setInputFiles("/absolute/task/inputs/sample.txt")}'
```

An array selects multiple files on a multiple input; `setInputFiles([])` clears
it. Frame inputs use normal `page.frameLocator(...)` locators, including OOPIFs.
For a custom chooser, first click its observed control, then run:

```bash
playwright-cli -s="$LATCH_SESSION" upload "/absolute/task/inputs/sample.txt"
```

The CLI requires a pending chooser and calls its `FileChooser.setFiles` API.
Verify the application result after submission; a populated input alone does not
prove an upload. Replaced inputs need fresh locators. In the pinned baseline an
old handle can set files on a detached input without an error, while leaving the
fresh replacement empty. Detached frames and missing files fail.

Downloads have three distinct results: browser receipt, lifecycle observation and
exact agent retrieval. Both tested attachment adapters receive files under their
existing browser settings and expose low-level `Page.download*` events, but do
not expose a normal Playwright `Download` object in these tests. `saveAs`, `path`
and `cancel` are consequently unavailable through that object. Native mode now
rejects `Browser.setDownloadBehavior` explicitly instead of acknowledging a no-op.
Do not promise that clicking a download produced a task artifact.

There is no Latch download-retrieval broker. Low-level GUID/frame metadata does
not identify the exact file saved under the browser's default naming rules.
Do not guess a file from URL, filename, timestamp or the newest item in Downloads,
or export a fixture observer's inbox path as agent evidence. If a requested check
requires retrieval, report that capability as unsupported. Leave browser download
settings and permissions unchanged unless a separate setup change is authorized.
Screenshots, snapshots, console and request reports still use the normal task
evidence directory; this download limitation does not block those artifacts.

## Large evidence and bounded failures

Prefer file output and create a fresh task evidence path for each operation:

```bash
playwright-cli -s="$LATCH_SESSION" screenshot --filename="$LATCH_EVIDENCE/page.png"
playwright-cli -s="$LATCH_SESSION" snapshot --filename="$LATCH_EVIDENCE/page.yaml"
playwright-cli -s="$LATCH_SESSION" requests
playwright-cli -s="$LATCH_SESSION" response-body "$LATCH_REQUEST_INDEX" --filename="$LATCH_EVIDENCE/response.body"
```

Use the actual current index from `requests`, matched to the authorized request.
Check that the new file exists and contains the expected complete data, including
byte count/hash or markers where available. The pinned response-body command can
return `{}` after inspector-cache eviction without saving anything. Do not treat
that as success, reuse a stale file, or replay the application request automatically.

Gate E verifies high-entropy PNGs up to 12,623,891 bytes, snapshots with every row
around 1.17/4.70 MB, and exact text/binary bodies at 1/4 MiB. Both adapters lose
16 MiB response bodies from the inspector cache in these tests. These samples are
validated support, not universal maximums. Console history is capped at 200
messages and may contain fewer; it is not a complete long event stream. A listener
established before the action received all 512 events in the bounded fixture.

Native transport allows 32 MiB serialized messages and an 8 MiB existing-backlog
threshold plus one bounded message. JSON/base64 expansion counts toward the wire
limit. Ordinary calls have 10 seconds; awaited Runtime.evaluate/callFunctionOn
calls have 30. These are inner command deadlines, distinct from Playwright's own
operation timeouts. The Latch wrapper has a 2 MiB raw stdout bound and default
45-second process deadline; direct CLI commands do not use that collector.

`CLI_OUTPUT_LARGE` means the wrapper could not accept its inline result; prefer
supported file output. `CLI_TIMEOUT` kills/reaps that wrapper subprocess, not
necessarily the browser action or daemon. A transport overflow/timeout can leave
this session stale. Capture the specific error and known application outcome,
then run normal scoped disconnect. Do not retry an uncertain click, switch
transport, or reconnect as if the original operation succeeded. A healthy peer
session remains separate. Native mode still requires the later installed-preview
cutover; changing these sources/skills does not upgrade the Work extension.

## Release one tab

Use fresh IDs from Latch and the same task session/workspace:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" release --profile work --session "$LATCH_SESSION" --tab "$LATCH_TAB_ID" --workspace "$LATCH_WORKSPACE"
```

If the last controlled tab closes after the initial Welcome page has closed, the official transport may disconnect. The application tab should remain intact when released; use the task's normal `disconnect` cleanup and report stale-state errors honestly.


## Native recovery (schema 4 preview)

Use these commands only when the paired host advertises `nativeSessionSchema: 4`
and `recoveryContract: 1`. Installed 0.1.2/official mode stays compatible and does
not gain native recovery by updating this skill.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" doctor --profile work --transport native --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
node "$LATCH_SKILL_DIR/scripts/latch.mjs" reconcile --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
```

`reconcile` is read-only by default and works offline. A healthy session needs
normal `disconnect`; a short coding-agent/CLI exit does not abandon its persistent
daemon. For an interrupted task, capture the specific error, evidence and known
application outcome. After a host/worker/browser loss, pending actions have an
**unknown outcome**, even if the last record was idle. Never replay a click,
save, upload or submission automatically. A missing/non-JSON direct CLI response
after transport loss also leaves the action outcome unknown. Inspect the app separately after an
explicit fresh connection.

When scoped cleanup is within the authorized task, use the exact returned token:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" reconcile --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" --apply --expect "$LATCH_PLAN_TOKEN"
```

Apply revokes the old native lease, confirms owned debugger cleanup, attempts the
exact recorded CLI task's normal detach, and retires the record. It preserves
website tabs, login state, peers and completed evidence. A changed plan/successor
returns `RECOVERY_PLAN_CHANGED`; inspect again before deciding what to clean up.
Matching repeated apply is a no-op. No reconnect or application action is replayed.

`BRIDGE_ACCESS_DENIED` retains EPERM/EACCES and requires appropriate execution
permission for that command; do not change global security. Offline apply is
blocked. `LEGACY_STATE_BLOCKED`, `PARTIAL_JOURNAL_PRESENT`, corrupt/unknown records
and `DAEMON_IDENTITY_CHANGED` preserve ambiguous state; report the blocker rather
than deleting locks, registries, partial files or evidence. A foreign debugger
conflict must be released by its owner before Latch can connect. Recovery does
not force a competing debugger off a tab.

Schema-4 journals live under `native-v4/<instance>/<workspace-session-hash>.json`
beside the selected configuration (`QA_BROWSER_CONFIG` applies). They contain
bounded task/lease metadata, never endpoint credentials or page bodies. They are
host-owned state, separate from task evidence. Completed evidence remains in the
same task directory; partial files are not promoted after recovery.


## Installed preview and popup controls

The local RC kit can include native debugger permission and a matching host while
the installed Work profile still uses 0.1.2 compatibility mode. Check reported
versions and negotiated capabilities; updating source/skill text does not upgrade
Chrome. Keep explicit `--transport native` for the preview. Installation, one-time
permission acceptance, rollback and transport-default changes are setup tasks,
not automatic responses to an application-test failure.

The popup shows only its own profile's pairing and task metadata. Its **Stop
session** action revokes one current schema-4 native lease through the host,
preserving website tabs and peers. It does not replay pending application actions.
A busy task has not been stopped; a cleanup-unconfirmed result means native access
was stopped but exact CLI detachment remains unproven. Inspect/reconcile the same
workspace/session rather than deleting registries or changing adapters. Refresh
a stale row before acting on it. Official/legacy tasks use normal CLI disconnect.

Managed installation skill links follow the selected release. A separately copied
skill still uses `LATCH_HOME` to locate a complete runtime. Keep that override
intentional; do not silently substitute another checkout after a version error.


## Profile transport preference

`transport --profile work` reports the configured/effective new-session default
without opening a bridge connection. `doctor` reports the effective adapter and
its selection source; supply the task's session/workspace to inspect its recorded
adapter. `diagnose` reports the profile default and bridge capability separately.
A healthy bridge does not prove the selected native adapter is available.

The explicit setup setter is `transport --profile work --set native|official`.
Only use it within an authorized rollout/default-change task. Native selection
requires a reachable schema-4 recovery-capable bridge. Selecting official works
offline for deliberate rollback. Neither setter migrates or disconnects existing
sessions, installs software, changes Chrome permissions or enables an extension.

Selection order is explicit `--transport`, recorded task adapter, profile default,
then official when no preference exists. Retired native records still identify
normal native disconnect cleanup. An unavailable native default fails clearly;
it does not fall back. Unknown/conflicting state is preserved for inspection.
`CONFIG_BUSY` means a configuration update gate exists: do not reclaim it using
PID/age or delete it as ordinary application-test cleanup.
