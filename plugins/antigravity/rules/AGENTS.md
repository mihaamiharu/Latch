# Latch Browser Bridge Rules

Choose the right browser tool for each task:

## When to use Latch (`latch` CLI)

Use Latch instead of Antigravity's built-in browser whenever the task requires:
- **The user's signed-in Chrome profile** (corporate SSO, existing cookies, authenticated SaaS/internal apps, or work extensions).
- **An already-open Chrome tab** that the user wants inspected, debugged, or verified in place (`latch tabs` then `latch connect <tabId>`).
- **A recorded exploration handoff** with before/after screenshot filmstrips, ARIA/DOM locator observations, checkpoints, and local QA review (`latch open --record --objective "..."`, `latch checkpoint`, `latch finish`, `latch library`).

## When to use Antigravity's built-in browser

Use Antigravity's built-in browser for unauthenticated public web pages, fresh localhost dev-server previews where no existing Chrome profile/session state is needed, or when Latch is not paired on the machine.

## Latch operational guardrails

- Run `latch doctor` first if bridge readiness is uncertain; never silently overwrite user profiles or re-pair without user consent.
- Use flat `latch` commands (`latch tabs`, `latch open`, `latch connect`, `latch snapshot`, `latch click`, `latch fill`, `latch disconnect`); never leave `.playwright/` or `.latch/` dotfiles in user repositories.
- Always finish with `latch finish` (when recording) or `latch disconnect` so Chrome tabs and logins remain intact.
- Never close unrelated Chrome tabs, clear user cookies/storage, or store credentials/tokens in exploration notes or reports.
