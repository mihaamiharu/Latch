# macOS candidate support matrix

This is the RC4 compatibility baseline used by the RC5 development candidate. RC3 remains installed in Work; source changes
do not update Chrome or establish final-release acceptance.

| Component | Candidate requirement | Evidence / boundary |
| --- | --- | --- |
| OS | macOS 27.0.1 or later | Tested here on 27.0.1, build 26A434; later versions need their own acceptance |
| CPU / Node binary | Apple Silicon, arm64 | Intel and Rosetta are unqualified and rejected by setup |
| Node | Exactly 22.21.1 | External prerequisite; no automatic global installation |
| Playwright CLI | Exactly 0.1.20 | External prerequisite; `pw` preserves ordinary commands and normalizes errors |
| Chrome | 147 or later | Qualification floor 147.0.7727.15; current lane 153.0.8010.12 |
| Browser transport | Latch native schema 4, recovery contract 1, popup control 1 | No official Playwright extension required; no automatic fallback |
| Coding client | Actual Codex RC3 native smoke established | RC5/reporting real-client acceptance pending; Claude Code and Cursor remain unverified |
| Client permissions | Access to paired Unix socket, local loopback, task and exact CLI cache directories | Run `preflight` in the actual client context; this does not grant permissions |

The native Chrome manifest requires 147. Chrome's flat debugger session API was
introduced in [Chrome 125](https://developer.chrome.com/docs/extensions/reference/api/debugger#attach-to-related-targets),
but availability of that API alone is not compatibility evidence. The older source
manifest remains a retained compatibility baseline and is not the native release
manifest. Exact supported build claims are limited to recorded test lanes.

Automatic browser qualification is headless with disposable profiles and test-only
launch flags, recorded in each fixture. It does not establish headed focus,
Personal-foreground behavior or real permission acceptance. The test browser is
pinned by `test/browser-versions.json`; set `LATCH_BROWSER_LANE=floor` or `current`.
Explicit binary paths are accepted only if their reported version matches the
selected pin. Tests never silently select the newest cached browser.

`preflight` reports platform, Node/CLI, bridge/controller, native capability,
task/cache writes and caller loopback separately. It creates missing task/cache
directories and removes only its own probe files. It never attaches a tab, grants
permissions or changes a transport preference. A successful preflight is not an
application PASS. Tool availability and approval policy must be observed by the
calling agent; a CLI cannot infer them. Full Access was the actual RC3 client smoke
mode, not proof of restricted-sandbox acceptance.

Excluded from this candidate's claims: Windows/Linux, Intel, remote/cloud agents,
managed browser-download retrieval, already-running worker backfill, arbitrary
JavaScript isolation and client marketplace/plugin distribution. Release kit,
second-user acceptance, owner license/distribution decisions and exact final
artifact promotion remain gates in the macOS release plan.
