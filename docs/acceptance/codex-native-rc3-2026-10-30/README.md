# Recorded Codex CLI native smoke

Verified October 30, 2026 (Asia/Jakarta), against software revision
`b0891c128e141a82305db45fd96c7df0bab88eb3`, Latch `0.2.0-rc.3`.

**PASS for the recorded native browser workflow.** Actual Codex CLI 0.165.0
connected to the existing Work tab, captured the public homepage, passed a Learn
navigation click trial, navigated to `/en/learn`, returned the expected tool error
with process exit 1 and disconnected successfully. A read-only follow-up confirmed
a retired journal, confirmed cleanup, absent task daemon and preserved unowned tab.

The recorded session used `danger-full-access` with approval policy `never`.
This is not a restricted workspace-write acceptance pass. No global configuration
mutation appeared in the recorded smoke commands, but no before/after global
settings snapshot exists. Other terminal clients are not established by this run.

| Artifact | Purpose |
| --- | --- |
| [result.json](result.json) | Normalized checks, actual execution policy, scope and limitations |
| [before.png](before.png) | Screenshot before navigation |
| [navigation-snapshot.json](navigation-snapshot.json) | Primary navigation subtree derived from the complete snapshot |
| [execution-proof.json](execution-proof.json) | Selected actual shell exit codes and execution context |
| [sha256.json](sha256.json) | Hashes of the four checkpoint evidence files |

The first connect shell command failed when assigning zsh's read-only `status`
variable after the helper had written successful connection JSON. The connected
session was inspected and reused; there was no repeated successful attachment.
The intentional error and disconnect commands captured their real process exits.

This portable checkpoint omits machine-specific runtime identities, absolute
workspace paths, pairing configuration, full agent transcripts, credentials and
connection endpoints. It uses a public-site screenshot. The original ten files
remain unchanged in the local run's `work/latch/latch-rc3-work-20261030-r7k2/`;
their hashes are retained in result.json. The full raw snapshot remains there.

The evidence was normalized during this review. Latch does not yet automatically
generate this result schema or report; these files are a checkpoint/example, not
a new runtime reporting feature. No after-navigation screenshot was recorded.
