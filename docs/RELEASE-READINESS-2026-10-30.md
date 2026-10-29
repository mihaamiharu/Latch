# Release readiness and agent experience

Reviewed October 30, 2026 (Asia/Jakarta). Installed candidate: `0.2.0-rc.3`.
Software checkpoint: `b0891c1`. This review does not publish, activate another
runtime, alter permissions or promote stable `0.2.0`.

## Current acceptance

RC3 is installed and identity/readiness-verified in Work. The pairing survived
this stable-path update byte-for-byte. RC2 is retained for rollback. The user
directed the official extension out of the workflow; Work's configured transport
is now native. This local preference is not the default for every new installation:
unconfigured profiles still select official for compatibility.

The [actual Codex terminal smoke](acceptance/codex-native-rc3-2026-10-30/README.md)
passed native connect, focus emulation, snapshot/screenshot, actionability trial,
one navigation click, expected error/exit 1 and confirmed disconnect. Its actual
policy was per-session Full Access, not restricted workspace-write. The earlier
restricted attempts failed on Unix socket access; command-scoped diagnose approval
was demonstrated separately, not for the complete browser workflow. A permitted
approval category must not be treated as proof its tool is exposed.

Fresh RC3 preparation covered 92 distinct passing checks across selected runs;
32 other optional checks were not repeated. A separate clean-install smoke of the
exact committed artifact passed and is not added as a distinct new check. These
results do not close every historical Phase 6 live-profile gate.

## What agents can use now

| Capability | Implemented | Evidence / boundary |
| --- | --- | --- |
| Native Work browser attachment | Yes | Latch extension plus local host; official Playwright extension not required in native mode |
| Shared agent skill | Yes | Canonical skill, installed `.agents` and `.claude` links, matching runtime wrapper |
| Codex CLI browser workflow | Yes, scoped acceptance | Actual terminal smoke with recorded Full Access policy |
| Claude Code and Cursor CLI integration | Discovery/runtime plumbing present | Actual end-to-end client runs still pending |
| Other shell-capable agents | CLI is not tied to a model provider | Individual discovery/permissions/workflow compatibility unverified |
| Concurrent agent sessions | Implemented and headless-tested | Distinct workspace/session ownership, scoped cleanup, peer survival; one task per session |
| Frames, popup descendants, uploads, large evidence | Implemented within documented bounds | Selected compatibility evidence; managed download retrieval and worker backfill remain outside support |
| Recovery and popup Stop | Implemented and headless-tested | Deliberate reconciliation; no automatic action replay or task resumption |
| Machine-readable command results | Yes | JSON, explicit native/focus state, `pw` error normalization |
| Packaged agent plugin | No | No Codex/Claude plugin manifest or marketplace package is tracked |
| MCP server or agent orchestrator | No | Neither is required for the CLI workflow; Latch does not plan QA tasks or replace the coding agent |
| Automatic session report / evidence index | No | Skill asks the agent to save evidence; reporting is currently agent-authored or manual |
| Cloud/remote agents | Not directly | The host/socket is local to the browser's Mac |

Session ownership coordinates access through Latch; it is not an OS sandbox for
arbitrary `run-code` or a separate browser profile per agent. The debugger extension
and same-user local processes retain meaningful privileges. Do not market this as
isolation from all other privileged local software.

Plugin packaging can simplify discovery and installation of the existing skill.
It does not remove the native-host installer, Chrome permission step or coding
client's execution permissions. Keep one runtime/skill and thin client packages;
avoid three divergent implementations or a new MCP server without a concrete need.

## Evidence: useful, but reporting needs product work

The reviewed local run has 13 files including review outputs: **279,584 bytes
(273.0 KiB)**. The screenshot is 212,209 bytes; the complete 223-node snapshot is
55,239 bytes. All text totals 67,375 bytes. Storage size is modest. Repeatedly
loading the entire snapshot and wrappers into model context is the larger cost.
These are file-size measurements, not a token-count or API-cost estimate.

What worked:

- Independent connect/action/error/disconnect outputs support an audit rather
  than relying on the agent's final prose.
- Exact helper process exit 1 was checked in the actual terminal tool log.
- Screenshot, snapshot and post-cleanup journal/tab metadata agreed with the run.
- Failed attempts were retained separately from the successful run.

What is missing:

- The terminal run did not produce a durable report.md; human-friendly review
  was added afterward. A small happy-path run needs a generated index.
- The global-settings assertion had no before/after evidence; it must stay
  unverified rather than silently inheriting the agent's PASS.
- The final screenshot preceded navigation; an after image and a content
  assertion would make review stronger than a URL alone.
- Shell snippets caused a read-only `status` failure and a screenshot argument
  correction. A maintained runner should capture output/exits deterministically.
- Raw evidence has no common step IDs, capture-time manifest, automatic redaction
  boundary or documented retention/export policy.

Recommended reporting contract (planned, not implemented):

```text
work/latch/<session>/
  report.md          human entry point: outcome, environment, checks, limitations, links
  result.json        compact agent entry point: schema, checks, policy, cleanup, evidence index
  commands.jsonl     bounded step records: time, operation, exit, outcome, artifact references
  screenshots/      before / after / failure as needed
  raw/              full snapshots and selected raw command evidence
```

Agents should read result.json first, then only the evidence relevant to the
question. Human reviewers should start with a short report and linked before/after
images. Keep large snapshots, response bodies and traces on disk/on demand.
Generate real exit codes before piping or printing; distinguish helper failure,
intentional negative test and uncertain application outcome. Record actual client
policy, transport and focus emulation at execution time.

Preserve original evidence and failures. Make retention/export explicit; do not
silently delete proof to reduce context. Do not collect unrelated tabs, cookie
values, bearer endpoints or whole agent transcripts as default evidence. The
portable acceptance bundle is an example produced by this review, not a runtime
report-generation feature.

## Release blockers and required configuration

| Priority | Missing work | Completion evidence |
| --- | --- | --- |
| P0 | Correct the native build's Chrome minimum | Source/build currently inherit `minimum_chrome_version: 120`, but child sessions use the Chrome 125+ debugger session API. Set a truthful minimum in the native release generator and test the advertised browser floor. |
| P0 | Define supported client and permission modes | Complete a scoped-approved restricted Codex smoke, or explicitly limit the beta to the demonstrated mode. Validate Claude/Cursor before claiming them. Never silently change global security settings. |
| P0 | Make native setup consistent for new users | After successful native pairing/readiness, deliberately configure that profile's native default. Verify a new task without a transport flag uses native. Preserve explicit legacy compatibility and avoid fallback. |
| P0 | Finish installed-profile acceptance | Real Work popup Stop/peer behavior, Personal-foreground behavior and intended signed-in app read remain separate live gates; migration/identity limitations remain explicit. Drain/recovery and Work update/rollback need an executable operator runbook. |
| P1 | Generate dependable reports | Implement the compact result/index contract and reusable execution helper; test failures, actual process exits, partial evidence and cleanup outcomes. |
| P1 | Freeze a truthful compatibility matrix | Current installer pins Node 22.21.1 and Playwright CLI 0.1.20. Decide whether to keep those prerequisites or validate a broader range. macOS is implemented; other OS/architecture claims need their own evidence. |
| P1 | Clean first-install/update experience | Rehearse on a second clean Mac/account with no existing runtime/skills. Verify exact profile selection, identity, stable path, controlled unload/re-enable, upgrade and rollback without copying a signed-in Chrome profile. |
| P1 | Fix current-vs-historical documentation | Remove stale active-version/default claims from entry points. Keep old execution records labelled historical. Make the built extension directory distinct from the compatibility source manifest. |
| P1 | Versioned release pipeline | Add a chosen remote/release home, CI for selected headless checks and reproducible packaging, a supported-platform/version matrix, release notes and exact-final-artifact smoke. Do not overwrite RC3 or label an untested package stable. |
| P1 for public distribution | Project license and privacy documentation | Choose the project's license; retain existing upstream notices. Document browser access, local artifacts, agent-provider handling, telemetry/retention and support contact. No top-level project license/privacy file is currently tracked. |
| Optional distribution layer | Agent plugin packages | Thin packages wrapping the same skill; validate discovery/update/removal in each claimed client. This is not required to prove native browser operation. |

Chrome documents flat debugger sessions as available from Chrome 125:
[debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger#attach-to-related-targets).
This is a concrete compatibility mismatch in the current manifest, not a claim
that RC3 was tested on Chrome 125 or that every native feature's lower bound is
already known.

Keep configuration divided by responsibility:

| Configuration | Who/when | Release requirement |
| --- | --- | --- |
| Project name, version, repository, license, support URLs | Maintainer before publishing | Release metadata and distribution choice are explicit |
| Extension ID and `com.qa_browser.bridge` host origin | Maintainer/build | Compiled IDs, manifest key and native host allowed origin match the actual distributed extension |
| Native host path, runtime and Node executable | Owned local installer | Absolute paths derived on the target machine, with ownership/rollback checks |
| Work profile alias and instance | User/operator during setup | Confirm intended profile; never auto-bind Personal or copy browser secrets |
| Profile transport preference | Explicit native setup | Native after readiness; do not inherit a disabled official extension as the daily default |
| Client execution permissions | Client/user within allowed policy | Same-context socket and relay access verified; unavailable approvals are a blocked environment |
| Task workspace, session, focus policy and evidence directory | Each coding-agent task | Unique session, real execution policy recorded, explicit cleanup and evidence links |

## Distribution choices

Start with a **private macOS beta** using the complete kit and a supported-client
matrix. Restrict claims to tested clients/modes; a plugin or store listing is not
needed to establish that beta workflow. Address the P0 compatibility/permission/
onboarding issues before inviting testers.

For Chrome Web Store distribution, configure the developer listing, public
support/privacy URLs, permission explanations and versioned extension updates.
The local native host still needs its own installation/registration; an agent
plugin or extension ZIP alone does not supply it. Keep the distributed extension
ID consistent with the manifest key and native allowed origins. Chrome's guidance
uses the Developer Dashboard's public key for matching development IDs:
[manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

An extension handling user data needs an accurate linked privacy policy for the
store: [Chrome Web Store privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy).
Do not promise store approval before review.

If shipping a downloadable macOS app or installer package, plan the appropriate
Developer ID signing/notarization and update process for that chosen format;
the present development kit is a Node/script ZIP, not an already signed app/pkg:
[Apple distribution guidance](https://developer.apple.com/macos/distribution).
Do not treat a signing certificate as a substitute for the native-host or Chrome
configuration above.

No remote is configured in this repository. Public pushing, store upload, npm
publication and signing credentials are not configured or performed by this review.
`package.json` is private; choosing npm distribution would also require deliberate
publication metadata/packaging changes. Do not create accounts, select a license,
publish or provision credentials implicitly.

## Recommended next implementation slice

1. Correct/test the native browser minimum and implement a trustworthy first-run
   native/permission preflight. Validate on a clean supported Mac/client.
2. Build the maintained evidence runner and compact result/human report index,
   using the acceptance bundle as a review example.
3. Complete the intended client/mode matrix and live Work gates. Scope the beta
   honestly if a client remains unsupported.
4. Freeze and smoke a separately versioned beta/final artifact, then add thin
   plugin/store distribution for the selected audience. Keep publication approval
   as a separate final action.
