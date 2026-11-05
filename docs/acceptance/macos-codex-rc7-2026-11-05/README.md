# Codex CLI RC7 acceptance

**Passed on a local fixture, with per-command approval. Not a restricted-sandbox pass.**
Installed kit `0.2.0-rc.7`, source `3b99c12`, descriptor
`8a7ac03d167b32f8f98c85462ffc58b5d7e93d2065d509da2d82d32f0d3e0703`, in real headed Google
Chrome 157 in the Work profile. [Selected before/after evidence](example/report.md) comes
from the maintained exporter.

## Client and policy

| Fact | Value | Provenance |
| --- | --- | --- |
| Launch | Operator typed `codex` in the terminal panel of the Claude desktop app | Operator-confirmed; Codex itself correctly declined to claim this |
| Version | 0.166.0 | Codex observed `CODEX_VERSION` in its environment |
| Surface marker | `TERM_PROGRAM=claude-desktop` | Codex observed; consistent with the launch above |
| Sandbox | `CODEX_SANDBOX=seatbelt`, workspace-write | Codex observed and supplied |
| Skill discovery | Latch in the session's skill catalog, then read explicitly | Codex reported |
| Approval | Command-scoped escalation granted for the diagnostics and browser commands | Codex reported |

The launch command prepared for the operator was
`codex --no-daemon --sandbox workspace-write --ask-for-approval on-request`. The flags
actually typed were not separately recorded.

Under the sandbox, profile-only doctor returned `BRIDGE_ACCESS_DENIED` (`EPERM` on the
paired socket). Browser work succeeded only through approved commands, which run outside
the sandbox.

## Independently checked

| Check | Result |
| --- | --- |
| Fixture server receipt | Exactly one, actor `codex`, matching the recorded marker |
| Offline `report` | Outcome pass, integrity verified, 13 artifacts, cleanup confirmed |
| Recorded checks | 10 of 10 pass; expected adapter error exited 1, separate from its assertion pass |
| After-screenshot | Shows the saved marker |
| Host journal | Session retired, cleanup confirmed, zero controller sessions afterwards |
| Software record | Source `3b99c12`, `dirty: false` |

## Corrections to the client's summary

- It listed the doctor JSON under the wrong name. The file is
  `rc7-acceptance-20261105-profile-doctor.json`.
- Tab `1964221618` previously held fixture actor `a`. It was reused for the `codex` page,
  apparently by the operator. Codex did not close any tab.

## Not established

Signed-in app reuse, which the owner skipped for now. Restricted-sandbox operation. Claude
Code and Cursor. Identity-preserving upgrade, which is covered in the
[RC7 Work record](../macos-work-rc7-2026-11-05/README.md).
