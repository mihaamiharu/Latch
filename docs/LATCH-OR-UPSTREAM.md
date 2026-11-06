# Latch or the official Playwright extension?

Decision for the local `0.2.0` release, November 6, 2026: retain Latch for the
existing paired-profile workflow, session Stop/recovery and recorded evidence.
Treat the official extension as a viable simpler alternative for routine QA.
Do not expand the Herdr viewer or claim Latch is required to reuse browser logins.
No installed browser transport or dependency version was changed by this review.

## Overlap and actual evidence

The upstream [extension documentation](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)
describes existing profile state, independent clients, profile-directory selection,
status/disconnect controls and background operation. Background operation requires
extension 0.5.0+; those current documentation claims were not exercised here.
[Playwright CLI](https://playwright.dev/agent-cli/commands/attach) supports extension
attachment, and its [tab commands](https://playwright.dev/agent-cli/commands/tabs)
include creating a new tab and navigating it directly.

The reproducible comparison uses our already retained official extension **0.4.0**
and pinned CLI **0.1.20**, on disposable headless Chrome 147 and 157. It passed new
tab creation through ordinary CLI `tab-new`, synthetic profile login-state reuse,
navigation, concurrent sessions and a surviving peer after disconnect. Latch was
used for fixture discovery/bootstrap, so this is not proof of a complete standalone
upstream installation experience. Latest extension 0.5.0 behavior, background
focus and the real signed-in Work profile remain untested in this comparison.

| Requirement | Official extension | Latch 0.2.0 |
| --- | --- | --- |
| Existing profile state | Documented; synthetic storage reuse tested | Synthetic storage reuse tested |
| Fresh page | CLI `tab-new URL` tested after attachment | `open --url URL --session NEW` tested without a prepared website tab |
| Independent agents | Tested | Tested |
| Named paired-profile selection | Upstream offers profile-directory selection; not compared here | Existing explicit pairing contract retained |
| Stop, recovery, evidence | Status/disconnect documented; no equivalence claim for Latch recovery/recorder | Existing native leases, guarded reconciliation and maintained recorder retained |
| Maintenance | Upstream owns the extension/transport | We own the custom relay, installer, compatibility and tests |

Latch is justified here by continuity with the installed workflow and its tested
lifecycle/evidence contract. This is a project decision, not a claim that upstream
cannot meet those needs. Prefer upstream for a new workflow when its standard
controls are sufficient; validate it separately before migrating the current setup.

## Frozen release scope

Local/internal, macOS Apple Silicon; keep version `0.2.0`, Node 22.21.1, CLI 0.1.20,
and the current supported Chrome lanes. Add only a fresh-root-tab workflow:

1. Validate a credential-free HTTP(S) URL and a new session name.
2. Journal creation intent before asking the paired extension to create a tab.
3. Reserve the exact background `about:blank` tab in a regular profile window.
4. Attach and verify identity before navigation; permit normal redirects afterward.
5. Reject active names without another creation. Never replay an uncertain open.
6. Preserve tabs/login state on disconnect, including after a navigation failure.

No automatic transport switching, arbitrary `context.newPage()`/native `tab-new`,
new Herdr behavior, public distribution, wider platform support or managed download
retrieval. An existing regular Chrome window is required. The complete updated
host and extension must advertise `createTab: 1`; a version string alone cannot
distinguish earlier 0.2.0 payloads. Use descriptor hashes for exact artifacts.

Qualification results and remaining operator gates are in
[the fresh-tab acceptance record](acceptance/macos-0.2.0-fresh-tab-2026-11-06/README.md).
