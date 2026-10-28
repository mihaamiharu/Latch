# Latch operations

Read this when you need command details or a concrete recovery path. The runtime is a prototype, validated with Playwright CLI 0.1.20. Do not auto-upgrade it to resolve an unknown error.

## Evidence and interaction

Run direct Playwright commands in `LATCH_WORKSPACE`, always specifying `-s="$LATCH_SESSION"`. Get fresh element references from the actual snapshot; the examples below use observed values supplied by the agent, not literal placeholder locators.

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
| `EXTENSION_CONNECTION_FAILED` | The official extension did not complete attachment in the configured profile. Report its installation/authorization prerequisite. Do not use desktop clicking as an alternative runtime. |
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

The source branch supports `connect --transport native` through the same helper, profile pairing, workspace and named-session contract. It requires a bridge/extension build with debugger capability; the installed daily 0.1.2 build does not gain that permission merely because this skill was updated. Check `doctor --profile work --transport native` first. Keep the official adapter as the default until the migration's installation and Work-profile gates pass. Do not reinstall, re-pair or change browser permissions automatically to enable this preview.

Each native session currently owns one tab. Use distinct session names for different tasks in the same workspace. The same name in different canonical workspaces is isolated. Reconnecting the same tab is idempotent; adding another tab returns `SESSION_TAB_LIMIT`. Native mode preserves existing windows/groups and verifies the actual CDP target identity, including when two tabs share a URL.

`--focus-emulation on` is an explicit native-connect option for background interactions. It simulates an active/focused page for the selected target and is cleared when its debugger detaches. It does not activate the Chrome tab, but can change the page's perceived focus/visibility; leave it off for checks that depend on real focus or background behavior. Changing it on an active session requires disconnect/reconnect. It is off by default and retained in the session record when later commands omit the flag.

`release` in native mode closes that session's single-target transport, detaches the CLI and preserves the tab. It returns `sessionClosed: true`; run the normal `disconnect` afterward to remove the released record. A failed connection revokes its new lease and cleans up only the task's session. If cleanup cannot be confirmed, `NATIVE_CLEANUP_FAILED` keeps the record for explicit disconnect. Stale epochs, unsupported state schemas and explicit transport changes fail rather than being repaired silently.

Native access is coordination between authorized local agents, not isolation from arbitrary programs running as the same OS user. Endpoint credentials stay out of Latch reports/records, but are passed to the local Playwright subprocess; private CLI registry files may retain attachment options. Protect task/daemon directories and do not publish their contents as evidence.

## Release one tab

Use fresh IDs from Latch and the same task session/workspace:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" release --profile work --session "$LATCH_SESSION" --tab "$LATCH_TAB_ID" --workspace "$LATCH_WORKSPACE"
```

If the last controlled tab closes after the initial Welcome page has closed, the official transport may disconnect. The application tab should remain intact when released; use the task's normal `disconnect` cleanup and report stale-state errors honestly.
