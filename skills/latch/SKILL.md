---
name: latch
description: Inspect and verify an existing signed-in Work Chrome tab using Latch and Playwright CLI. Use when the user asks to use Latch, reuse an open work-browser session, reproduce a web bug, or verify behavior in an already open app from a local coding agent.
---

# Latch

Use the user's existing paired Work browser. Latch discovers tabs and assigns a specific tab to a named session; Playwright CLI operates that session. This workflow needs local shell access on the browser's Mac. A cloud/remote agent cannot reach the laptop's bridge merely by loading this skill.

## Locate the runtime

Resolve the absolute directory containing this `SKILL.md` from the client-provided skill path. Below, `LATCH_SKILL_DIR` means that directory, `LATCH_WORKSPACE` means the current task's canonical project root, and `LATCH_SESSION` is a fresh, unique name for this task. Keep those exact values throughout the workflow, including cleanup. Shell variables may need to be reassigned in each tool call.

The helper locates the matching Latch runtime relative to this skill, preserves your working directory, and forwards to its CLI. In a managed release installation it uses the installed launcher and its selected configuration. If the skill was copied separately from the checkout, the user can configure `LATCH_HOME` to locate the installed runtime. Do not assume `qa-browser` is globally on PATH or change into the Latch source checkout to work on another project.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" doctor --profile work --workspace "$LATCH_WORKSPACE"
node "$LATCH_SKILL_DIR/scripts/latch.mjs" tabs --profile work --workspace "$LATCH_WORKSPACE"
```

Inspect JSON and the process exit code. A failed connection check is a setup/blocking result, not a failed application test. For an unfamiliar command, run the helper with `help` or run `playwright-cli <command> --help`.

On RC4+ (`help` lists `preflight`), run this before tab discovery/connection in the
same client context, using the chosen task workspace/session:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" preflight --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
```

Require `ready: true`. Save blocked results and stop dependent browser work.
Preflight checks exact cache/task writes and local networking, and removes its
own probe files; it does not attach, grant permissions or prove application
behavior. Read the permission preflight section of `references/operations.md`
when access is denied. Record actual client/version, cwd/branch (N/A outside Git),
skill discovery versus explicit loading and permission-policy provenance; do not
infer the client policy from a launcher executable or assume a permissions tool
exists because its category appears in a policy description.

Run `transport --profile work` to inspect the configured default when supported. Profiles without a preference use official, even when native capability is available. Honor a transport explicitly requested for this task; otherwise use the recorded session/configured default. Set `LATCH_TRANSPORT` to that selected `native` or `official` value and pass it explicitly at connection. A healthy doctor/diagnose verifies the bridge; it does not prove the official extension can attach. If native is selected or explicitly requested, read the native-mode section of `references/operations.md`. Default changes are separate setup actions: do not set a preference or switch adapters to bypass a failure. Older runtimes may lack the transport command; their default remains official.

If discovery/doctor fails, run `diagnose --profile work` with the same helper **inside the same agent execution context**. Save that JSON with the report. `PROFILE_UNAVAILABLE` means the local socket could not be reached; it does not mean the pairing is missing. Only report an unpaired profile when configuration actually lacks the alias. Preserve the operating-system error, socket path and runtime directory; do not silently change client security settings.

## Select and connect

Choose a tab from current Latch metadata using the requested URL/app, title and window. A tab ID from an earlier browser session is not durable. If the intended app is absent or genuinely ambiguous, report the candidates or ask for the missing target; do not substitute an unrelated signed-in site.

Use a unique session name of at most 60 letters, digits, hyphens or underscores. Set `LATCH_TAB_ID` to the observed numeric ID. Another agent needs its own session. Do not claim a tab owned by another task.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" connect --profile work --transport "$LATCH_TRANSPORT" --session "$LATCH_SESSION" --tab "$LATCH_TAB_ID" --workspace "$LATCH_WORKSPACE"
```

For ordinary native-mode interactions with a background Work tab, append `--focus-emulation on` to that command. For tests of actual focus, visibility or background behavior, explicitly use `--focus-emulation off` and report the limitation if actions stall. Emulation changes the page's perceived focus; it does not foreground the browser. Inspect the returned `focusEmulation` and `warnings`; changing the policy requires disconnect/reconnect, not replaying a timed-out action.

Require successful JSON with `connected: true`. The wrapper handles profile pinning, exact group registration and page verification. It creates `.playwright/` in the selected workspace to isolate Playwright's session registry. Keep the same workspace for direct Playwright commands:

```bash
cd "$LATCH_WORKSPACE"
playwright-cli -s="$LATCH_SESSION" snapshot
```

## Verify the requested behavior

Use fresh snapshots/locators and the user's acceptance criteria to drive ordinary Playwright CLI operations: inspect, click, fill, evaluate, screenshots and relevant console/network checks. Run each command in the same workspace and with the explicit session name. Read `references/operations.md` when you need evidence command examples, uploads, large-output limits, download limitations or error recovery.

If helper `help` lists `pw` (RC3+), prefer its session-bound adapter for ordinary commands:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" -- snapshot
```

It runs the normal pinned Playwright CLI and returns exit 1 on `isError: true`, including when upstream exits zero. It requires an existing attached task and never attaches or retries. On older installed runtimes, use direct `playwright-cli --json` and inspect both its exit status and `isError`; exit zero alone is not success. A located element or accessibility-tree entry does not prove click actionability. After a timeout, inspect the locator, page state and independent mutation outcome before deciding whether a new action is safe.

Attaching successfully or completing clicks is not proof of a pass. Check the observable result, including negative behavior when relevant. Separate application failures from unavailable environments, missing test data and ambiguous observations. Follow the user's requested scope and existing authorization for application changes.

Save useful evidence in the requested artifact location, or a task-local `work/latch/<session>/` directory. Report the tested URL/role or environment, actual checks, pass/fail/blocked outcome, and evidence paths. Do not put authentication tokens, cookie values or official-extension connection URLs in reports. Playwright tab listings can contain such connection URLs; use Latch metadata for initial discovery.

For RC5+ (`help` lists `report`), use the maintained recorder described in
`references/evidence.md`. Pass the same `--evidence-dir` on connect, each `pw` and
disconnect; use unique `--step` IDs and explicit result/error expectations. It
produces compact agent results, `report.md`, `result.json`, a durable command
ledger and verified artifact links. Keep full snapshots on disk and read only
what the task needs. Offline reporting never replays browser actions.

## Release the session

Unless the user asked to keep the task's session connected, run cleanup after success or failure:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" disconnect --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
```

Disconnect releases this task's claims and preserves website tabs and their logins. To release one tab while continuing the same session, use `release` with its observed ID. Do not close existing user tabs or run `close-all`, `kill-all`, cookie clearing or data deletion as generic cleanup. If cleanup fails, report the exact session and failure rather than claiming it was released. For schema-4 native sessions, read the recovery section in `references/operations.md`: inspect with `reconcile`, then use its current plan token for scoped cleanup. Bridge reconnection restores readiness; it never resumes a lost automation lease or repeats an uncertain action.

## Connection limits

Use the Latch wrapper for attachment; do not manually drag tabs, automate desktop input, evaluate code in the official extension, or replace Latch with an MCP/browser-launch workflow. Work-profile pairing is already configured; changing it is a separate setup task. For failures, read `references/operations.md` and stop at the specific unsupported condition instead of broadening access or repeatedly retrying mutations.
