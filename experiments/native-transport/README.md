# Native browser transport: Phase 1 experiment

This is an isolated compatibility experiment, not the installed Latch transport.
It establishes whether an unmodified Playwright CLI can drive a selected existing
tab through Latch's own Chrome debugger transport, without the official extension
or Chrome remote-debugging flags.

## Run

On macOS, with Node 22+ and Playwright CLI 0.1.20 on PATH:

```bash
npm ci
npm run test:native-spike
```

The test finds Chrome for Testing in the local Playwright cache. Set
`LATCH_SPIKE_BROWSER` to an explicit executable when needed. It opens a disposable
headed browser, so a local graphical session is required. It does not use a
Playwright browser launcher, a browser remote-debugging port/pipe, desktop input,
or a substitution for Chrome's native messaging connection.

The test generates its extension/host manifest and native launcher under
`work/native-spike/run-*/`. Chrome's `--user-data-dir` scopes native host discovery
to that tree. The Work profile's registration, permissions and extension files
are not modified. The test uses the same public Latch key for identity in its
separate profile; no private signing key is needed.

Fixture provisioning opens two local test pages through the experimental
extension before connecting Playwright. Their synthetic cookie/localStorage
state exists before automation attaches. A fixture-only observer independently
checks both pages after disconnect. These setup/observer operations are not an
agent attachment API.

## Components

- `extension/background.js`: real native port, one selected debugger target,
  target/session checks and WebSocket event/command routing.
- `native-host.mjs`: private local control socket, actual Chrome native framing
  and relay bootstrap. Requires fixture-only environment and caller identity.
- `relay.mjs`: independent authenticated CDP/extension routes, Origin/Host checks,
  initialization barrier, bounded payload/pending-command queues and revocation.
- `browser-model.mjs`: owned-target mapping, minimal browser handshake and
  scoped inspection sessions. Relevant upstream attribution is in
  `third_party/playwright/SOURCES.md`.
- `test/native-browser.test.mjs`: actual Chrome/native/CLI integration.
- `test/native-relay.test.mjs`: access-boundary and routing regression checks.

The WebSocket dependency is pinned in the project lockfile. Production 0.1.2
modules still use Node built-ins; they do not import this experiment.

## Evidence and boundaries

Each successful browser run writes snapshots, a screenshot, console/network
output, a method-only protocol trace and `report.json` in the fixture's evidence
directory. Endpoint credentials are not written into those reports. Temporary
profile/session data remains ignored under `work/` for diagnosis; native socket
and registration cleanup is automatic. Stop/cleanup acts only on the spawned
fixture browser and the test's own session.

Supported proof: one existing tab, fixture sign-in reuse, snapshot, fill/click,
assertion, screenshot, console and network inspection, exact target-ID check,
and disconnect preserving both tabs, their placement and fixture state.

Explicit limits: one connection per native-host lifetime; no multi-agent or
restart recovery yet; no popup/worker/frame coverage; no target creation/closure
through CDP; no cookie/storage management, browser shutdown or download support.
The download-configuration call made by Playwright during attachment is accepted
as a no-op. Inspection aliases prove target identity; complete raw CDP event
semantics are not claimed. This is not a general CDP server or a production
security boundary.

Before integration, replace fixture-specific bootstrap with the existing pairing
and workspace/session contract, add the Phase 2 ownership tests, and complete the
remaining gates in `docs/SINGLE-EXTENSION-PLAN.md`. Do not load this experiment in
the user's Work profile.
