# Latch data handling

Latch connects a local coding agent to selected tabs in a paired Chrome profile.
The current release is a macOS candidate. This document describes the bridge and
its local files; it does not replace your coding agent/provider's data policies.

## Browser access

Install Latch only in the intended profile, then pair that extension instance.
Tab discovery exposes titles, URLs and ownership metadata from that profile.
Native sessions attach to an explicitly selected tab and verified related targets.
Authorized Playwright commands can inspect page content, screenshots, network
data and browser storage, or change application data. Latch is not a sandbox for
arbitrary JavaScript or local file access performed by the coding agent.

The extension declares tabs, tab groups, storage, native messaging, alarms and
debugger permissions. It has no persistent website content scripts or website
host-permission declarations. Debugger access still allows substantial access to
the attached pages; the absence of content scripts does not limit that capability.

## Local transport and external traffic

Chrome launches the Node native host through Native Messaging. Agent commands use
a per-user Unix socket; the native data relay listens on `127.0.0.1` with ephemeral
connection credentials. Latch's bridge does not include an analytics service or
an automatic evidence-upload endpoint. It does not expose a LAN/public listener.

Websites and authorized browser actions generate their normal network traffic.
Playwright CLI and the coding client are separate programs with their own behavior
and policies. Cloud-backed agents may send viewed page text, screenshots, command
outputs or selected artifacts to their provider. A local Latch connection does
not mean that all content seen by an agent stays on the Mac.

## Files and retention

Default locations retain the historical directory name for upgrade compatibility:

| Data | Default location / purpose |
| --- | --- |
| Pairing and profile preferences | `~/Library/Application Support/Latch/config.json` |
| Owned runtime, receipts and retained releases | `~/Library/Application Support/Latch/runtime/` |
| Native recovery journals | `native-v4/` beside the selected configuration; bounded lease/cleanup metadata |
| Per-user socket directory | `/tmp/latch-<uid>/` |
| Task evidence | Explicit recorder directories, or candidate central runs under `artifacts/` beside config |
| Playwright daemon state | External CLI cache, normally `~/Library/Caches/ms-playwright/daemon/` |

Receipts contain local configuration/runtime paths and the selected Node/CLI
executables. Managed launchers supply those prerequisites to their own processes;
they do not edit the shell's global PATH or the coding client's security settings.
Configuration/runtime overrides are explicit and are reported by diagnostics.

Recovery journals are separate from evidence. They do not store page bodies or
relay endpoint credentials. External Playwright daemon state may retain attachment
options: do not export its registry or native state as a verification report.
Runtime coordination is not isolation from other programs running as your OS user.

Recorded evidence includes run identity, workspace/branch, versions, supplied
client-context provenance, command outcomes, assertions, cleanup and artifact
hashes. Command records retain argument hashes/counts rather than source argument
lists. Upstream results and error diagnostics can still echo submitted content.
Recognized credential fields, sensitive headers and connection URLs are redacted.
Cookie/storage-command values are excluded from persisted evidence. These checks
are not universal secret detection: arbitrary page text, file paths, network data
and screenshots can still contain private information. Visual redaction is not
automatic. Review evidence before sharing it.

Full snapshots and bounded raw command results stay on disk; compact results are
the default agent output. Export copies only explicitly selected verified artifacts
and their check metadata into a new folder. Unselected raw files and the full
ledger are omitted. Selected raw files may still contain paths or page text.

There is no automatic evidence upload or deletion schedule. Completed and partial
evidence remains until you explicitly remove it. Disconnect preserves website
tabs and completed evidence. Uninstall unregisters the owned host/skill links and
retains configuration, release payloads, recovery state and artifacts. Chrome
keeps profile/website data under its own lifecycle.

## Publication and support

The owner selected local internal delivery, with no public project license yet.
Repository setup, public distribution and public support/contact URLs are deferred
until separately chosen and authorized. No remote publishing or account
provisioning is performed by installing this local candidate. See `SUPPORT.md` in
the kit for the tested matrix and current acceptance limitations.

The exploration-library candidate additionally stores observed locator attributes,
page/frame transitions, agent annotations, videos and separate QA review notes in a
local library. Video pixels are not automatically redacted. Input values are omitted
from transition metadata; page captures or agent-supplied text can still expose them.
The review server is loopback-only, with same-origin review writes. Export is an
explicit local copy. Library files and owner audit records persist until removed.
