# Phase 1 native transport contract

Recorded October 28, 2026. Experimental implementation on
`feat/latch-native-transport`, based on checkpoint
`ad4819827f0fc994a1df39aed930a2bab8f44972`.

This records Phase 1's compatibility scope, not a public production protocol.
Phase 2 subsequently graduated its relay/model into `src/` and added an opt-in
native path to the normal helper/controller. See `NATIVE-SESSION-WORKFLOW.md` for
current behavior. The installed Work manifest still lacks debugger permission
and the official adapter remains the default; this source update does not grant
new browser permissions.

## Versions and transport

- Playwright CLI: exactly 0.1.20, globally installed and unmodified.
- Node used for verification: 22.21.1.
- Chrome for Testing: 153.0.8010.12 on macOS arm64.
- WebSocket dependency: `ws` 8.22.0, exact version and lockfile.
- Upstream reference: Playwright revision
  `f9a841f968dd9a4e315df2ec2930da1952971667`; retained Apache license and
  adaptation provenance under `third_party/playwright/`.

The fixture launcher supplies no Chrome remote-debugging flag. A custom
user-data directory contains only the test extension plus Chrome's built-in
extensions. The official Playwright extension is not installed.

Chrome starts the actual native host through `connectNative()`. The host's
origin argument and the registered extension ID must match. Its private Unix
socket handles fixture control requests. Separate, random 256-bit capability
paths authenticate extension and CDP WebSocket connections on `127.0.0.1`.
Only the pinned extension Origin is accepted on its route. CDP callers must
have the separate credential and no website Origin header. No public discovery
endpoint exposes credentials.

The wrapper-side fixture driver passes the CDP address to
`playwright-cli -s=<session> --json attach --cdp=<address>`. It does not print the
address. Native messages carry bootstrap/control, not screenshots or page data.

## Supported command categories

The browser model provides minimal browser version/target metadata and target
auto-attachment. It maps the selected native Chrome tab to a relay CDP target
session, and supports scoped diagnostic inspection sessions for that same target.
Root target enumeration excludes every other tab. Target creation/closure and
unrecognized browser-level methods fail explicitly. Download configuration is
accepted as a compatibility no-op; downloads are not supported in this proof.

On the explicitly attached target, the extension routes commands in the
Accessibility, DOM/DOMSnapshot, CSS, Runtime, Page, Input, Network, Emulation,
Log and Performance domains, plus selected Target metadata/auto-attach commands.
Cookie-management and profile-wide cache/cookie clearing are rejected.
Commands are checked again against the selected tab and known child session IDs
inside the extension. This domain list is not a claim that every method in every
domain is tested or isolated from shared same-origin storage.

The tested QA surface is narrower: snapshot, DOM input/click, assertion,
screenshot, console, network request listing, read-only page evaluation and
target identity inspection. Popup, frame and worker behavior, full raw inspector
event semantics and browser-wide commands remain outside acceptance.

## State, limits and cleanup

The experiment has one native connection and one selected tab per host lifetime.
It does not yet implement the production profile/workspace/session reservation
contract or recover stale state. CDP/native disconnect revokes both relay paths;
extension cleanup detaches its debugger. Credentials are never reused after relay
shutdown. New sessions require a new fixture host.

Bounds: WebSocket messages 32 MiB; buffered outgoing transport 8 MiB; pending
extension commands 64; native control requests 16; inspection aliases/browser
sessions 64 each. Native framing retains the existing 1 MiB limit. Command and
initialization deadlines are bounded. Method-only traces store at most 4096
entries and exclude parameters, result bodies and endpoint URLs.

Cleanup detaches the CLI and debugger, verifies both fixture tabs and their
window/group identities still exist, and independently observes preserved
synthetic cookie/localStorage state. Only after those assertions does the test
close its own disposable browser and inspect persisted extension inventory.
Registration and socket cleanup is scoped to the test's generated paths.

## Validation boundary

The real-browser test uses no replacement native wiring and no direct
Playwright launch/driver connection to seed or observe the browser. Fixture-only
native provisioning creates the test pages before attachment; a local fixture
observer checks their state after disconnection. This validates browser transport,
not a real application's authentication system.

`npm test` covers existing regression checks and relay authentication/routing;
the real browser suite is opt-in via `npm run test:native-spike`. A skipped
browser test is never counted as a pass. The main migration plan's remaining
ownership, lifecycle, packaging and actual Work-profile gates still apply.
