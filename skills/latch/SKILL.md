---
name: latch
description: Inspect and verify an existing signed-in Work Chrome tab using Latch and Playwright CLI. Use when the user asks to use Latch, reuse an open work-browser session, reproduce a web bug, or verify behavior in an already open app from a local coding agent.
---

# Latch

Use the user's existing paired Work browser. Latch discovers tabs and assigns a specific tab to a named session; Playwright CLI operates that session. This workflow needs local shell access on the browser's Mac. A cloud/remote agent cannot reach the laptop's bridge merely by loading this skill.

## Locate the runtime

Resolve the absolute directory containing this `SKILL.md` from the client-provided skill path. Below, `LATCH_SKILL_DIR` means that directory, `LATCH_WORKSPACE` means the current task's canonical project root, and `LATCH_SESSION` is a fresh, unique name for this task. Keep those exact values throughout the workflow, including cleanup. Shell variables may need to be reassigned in each tool call.

The helper locates the Latch checkout relative to this skill, preserves your working directory, and forwards to its CLI. If the skill was copied separately from the checkout, the user can configure `LATCH_HOME` to locate the installed runtime. Do not assume `qa-browser` is globally on PATH or change into the Latch source checkout to work on another project.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" doctor --profile work --workspace "$LATCH_WORKSPACE"
node "$LATCH_SKILL_DIR/scripts/latch.mjs" tabs --profile work --workspace "$LATCH_WORKSPACE"
```

Inspect JSON and the process exit code. A failed connection check is a setup/blocking result, not a failed application test. For an unfamiliar command, run the helper with `help` or run `playwright-cli <command> --help`.

If discovery/doctor fails, run `diagnose --profile work` with the same helper **inside the same agent execution context**. Save that JSON with the report. `PROFILE_UNAVAILABLE` means the local socket could not be reached; it does not mean the pairing is missing. Only report an unpaired profile when configuration actually lacks the alias. Preserve the operating-system error, socket path and runtime directory; do not silently change client security settings.

## Select and connect

Choose a tab from current Latch metadata using the requested URL/app, title and window. A tab ID from an earlier browser session is not durable. If the intended app is absent or genuinely ambiguous, report the candidates or ask for the missing target; do not substitute an unrelated signed-in site.

Use a unique session name of at most 60 letters, digits, hyphens or underscores. Set `LATCH_TAB_ID` to the observed numeric ID. Another agent needs its own session. Do not claim a tab owned by another task.

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" connect --profile work --session "$LATCH_SESSION" --tab "$LATCH_TAB_ID" --workspace "$LATCH_WORKSPACE"
```

Require successful JSON with `connected: true`. The wrapper handles profile pinning, exact group registration and page verification. It creates `.playwright/` in the selected workspace to isolate Playwright's session registry. Keep the same workspace for direct Playwright commands:

```bash
cd "$LATCH_WORKSPACE"
playwright-cli -s="$LATCH_SESSION" snapshot
```

## Verify the requested behavior

Use fresh snapshots/locators and the user's acceptance criteria to drive ordinary Playwright CLI operations: inspect, click, fill, evaluate, screenshots and relevant console/network checks. Run each command in the same workspace and with the explicit session name. Read `references/operations.md` when you need evidence command examples, command limitations or error recovery.

Attaching successfully or completing clicks is not proof of a pass. Check the observable result, including negative behavior when relevant. Separate application failures from unavailable environments, missing test data and ambiguous observations. Follow the user's requested scope and existing authorization for application changes.

Save useful evidence in the requested artifact location, or a task-local `work/latch/<session>/` directory. Report the tested URL/role or environment, actual checks, pass/fail/blocked outcome, and evidence paths. Do not put authentication tokens, cookie values or official-extension connection URLs in reports. Playwright tab listings can contain such connection URLs; use Latch metadata for initial discovery.

## Release the session

Unless the user asked to keep the task's session connected, run cleanup after success or failure:

```bash
node "$LATCH_SKILL_DIR/scripts/latch.mjs" disconnect --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
```

Disconnect releases this task's claims and preserves website tabs and their logins. To release one tab while continuing the same session, use `release` with its observed ID. Do not close existing user tabs or run `close-all`, `kill-all`, cookie clearing or data deletion as generic cleanup. If cleanup fails, report the exact session and failure rather than claiming it was released.

## Connection limits

Use the Latch wrapper for attachment; do not manually drag tabs, automate desktop input, evaluate code in the official extension, or replace Latch with an MCP/browser-launch workflow. Work-profile pairing is already configured; changing it is a separate setup task. For failures, read `references/operations.md` and stop at the specific unsupported condition instead of broadening access or repeatedly retrying mutations.
