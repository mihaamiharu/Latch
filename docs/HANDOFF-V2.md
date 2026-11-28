# Handoff v2 design

Status: phase 1 implemented (`src/exploration-handoff.mjs`); phases 2–5 pending.

## Problem

`exploration.yaml` is the file the "Copy QA handoff prompt" button points agents at, but it is a full state graph, not a handoff. A 13-state checkout run produced 223 KB:

- `states` is 87% of the file; 13 states on one URL contained only 2 distinct element lists, repeated in full per state.
- 448 of 565 element entries (79%) are `generic` wrappers with no name and no locator.
- Agent observation commands (`snapshot`, `console`, `network`, `run-code`) are recorded as transitions alongside real user actions.
- Network requests are captured by `browser-engine.mjs` but never attributed to steps or written to the handoff.
- `behaviors` and `test_data` are usually empty; the useful QA content ends up as free text in a finding.

## Audiences

| Reader | Sees | Does |
|---|---|---|
| AI agent (primary) | `handoff.yaml`: steps, locators, network shapes, effects, assertions | Writes Playwright UI + API e2e tests |
| Human QA | Library UI behavior list with before/after screenshots | Gives each behavior a verdict |

Behaviors are the contract: the human decides **what** is tested, the agent decides **how**. Humans never read YAML; locators and network stay hidden in the review UI.

## Decisions

- **Network scope:** XHR/fetch only, app origin plus configured API hosts. No assets, fonts, analytics.
- **Bodies:** shape (keys, types), status, content-type, with values redacted by default. Full bodies only behind an opt-in flag, stored in a side file.
- **Files:** new compact `handoff.yaml` is primary and is what the copy prompt references. `exploration.json` stays as the full graph for tooling. The duplicate `exploration.yaml` is dropped.
- **Steps:** only user interactions (navigate, click, fill, select, press, …). Observation commands go to evidence, not steps.
- **Elements:** only those acted on, asserted on, or changed. Full snapshots remain in `snapshots/*.yaml`.
- **Effects:** snapshot diffs per step (appeared, disappeared, text changed, URL changed, validation shown).
- **Network attribution:** requests are assigned to the step whose time window they started in. `network: []` is recorded explicitly, because "no request sent" is a valid assertion.

## Behaviors and review

- On `finish`, Latch drafts behaviors from step effects and network results, then merges in the agent's `behavior` / `finding` checkpoints.
- Each behavior links to `steps` and `assert` entries.
- Human verdict per behavior: **expected** (test it), **bug** (assert the correct behavior; the test should fail until it is fixed), **ignore** (skip).
- This replaces the single run-level decision as the main review signal.

## `handoff.yaml` shape

Based on the checkout run. Network entries, fallback locators and step mappings are illustrative: that run never linked requests to steps.

```yaml
schema_version: 2
run_id: 0723e743-3d55-4f51-b910-2a406eda8d9b
objective: Verify checkout validation
base_url: https://…/checkout

test_data:
  - {ref: billing_email, kind: email, example: "<redacted>"}
  - {ref: promo_code, kind: string, example: QA10}

steps:
  - id: s3
    action: click
    target: {role: button, name: Apply, fallbacks: [{css: "#apply-promo"}], ambiguous: false}
    network:
      - {method: POST, url: /api/promo, status: 200,
         request: {code: string}, response: {discount: number, total: number}}
    effects:
      - {text_changed: {locator: total, from: "$49.00", to: "$39.00"}}
    assert: [{locator: total, toHaveText: "$39.00"}]
    evidence: {before: screenshots/state-00005.png, after: screenshots/state-00006.png}
  - id: s4
    action: click
    target: {role: button, name: Pay now}
    network: []
    effects:
      - {appeared: {locator: "#checkout-alert", role: alert,
         text: "Card number is required before submitting order #8492."}}
    assert:
      - {locator: "#checkout-alert", toBeVisible: true}
      - {no_request: {method: POST, url: /api/orders}}

behaviors:
  - {id: b1, text: "Applying promo QA10 reduces total from $49.00 to $39.00", steps: [s3], verdict: expected}
  - {id: b2, text: "Pay now with empty card number shows a required error and submits no order", steps: [s4], verdict: expected}
  - {id: b3, text: "Promo discount text is shown before Apply is clicked", steps: [s2], verdict: bug}

gaps: [Card number never filled; happy-path payment not explored]
```

## Copy prompt

```
Implement Playwright e2e tests for Latch run <id> (<objective>).
Read: <path>/handoff.yaml
Cover behaviors marked expected (b1, b2) and bug (b3, assert the correct behavior; it should fail until fixed).
Use UI steps plus API assertions from `network`. Re-verify locators against the live app.
```

## Implementation phases

1. **Compact steps (done):** emit `handoff.yaml` with steps-only transitions, pruned elements, target locators, evidence; repoint the copy prompt. No new capture.
2. **Network:** filter engine entries to XHR/fetch, attribute to steps by time window, derive redacted shapes; opt-in full bodies side file.
3. **Effects and assertions:** snapshot diffs per step, generated assertion candidates.
4. **Behaviors:** draft at finish, merge checkpoints, per-behavior verdicts in the library UI and review JSON, verdict-aware copy prompt.
5. **Cleanup:** schema v2, drop `exploration.yaml`, update docs, skills and tests.
