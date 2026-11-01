# Local internal release handoff

Owner decision, November 1, 2026: keep Latch local and internal. No public project
license selected; no repository creation, remote, push or upload authorized.
Third-party notices remain included. Hosted CI and public distribution are
deferred. Local qualification continues against the macOS release plan.

## Reviewable candidate

- Release: `0.2.0-rc.6`, software `1dd3eb2`, Chrome version `0.1.99.6`.
- Complete ZIP: `work/macos-release/rc6-clean-checkout/dist/latch-0.2.0-rc.6-kit.zip`.
- ZIP SHA-256: `b8f977dbae34ad6fbc4c013c58d1165645de11aad6709b6725c89b3052f11d75`.
- Descriptor SHA-256: `1e022c2963012b2082eb18b35ca558cd2051e3df42e07463ff4988c1bc8ebe01`.
- Exact candidate already staged under the managed runtime's
  `releases/0.2.0-rc.6-1e022c296301`, **inactive**.
- Active Work payload is retained RC3, `0.2.0-rc.3-a50ad773869e`.
- Extension ID: `dlkpkeiejlgggeoibejpoajedoelfcli`; native host:
  `com.qa_browser.bridge`. Expected paired instance is `e55052a6…`.
- [Qualification](acceptance/macos-rc6-runtime-2026-11-01/README.md) records the
  exact packaged tests. Installed Work acceptance has not happened.

Do not rebuild RC6 and substitute another payload under this approval. Source
documentation/checkpoint changes after `1dd3eb2` are not changes to the frozen kit.
The final `0.2.0` package will have its own committed source and acceptance.

## Operator-assisted Work pilot — not authorized by staging

Repository `AGENTS.md` says: “Keep test profiles disposable and keep the installed
Work browser unchanged.” A live pilot therefore needs an explicit scoped
exception before activation. Earlier RC2/RC3 approvals are not RC6 approval.
Automatic tests remain headless; real Chrome prompts stay user-operated.

The proposed exception is limited to updating Latch in Work using this exact kit,
verifying identity/readiness, managed skill links and local A/B fixture checks.
It does not authorize access to Personal content, signed-in app mutations,
extension removal, an official-extension toggle, a browser restart or global
security changes. A signed-in app read needs an intended target supplied by the
operator; a public page or synthetic cookie is not that acceptance.

After approval:

1. The operator finishes affected automation, saves unsaved work, confirms the
   actual Work Latch loaded folder and disables Latch. Do not remove it. Record
   the current official-extension state and leave it unchanged.
2. Inspect the historical `gherkin-msg-v2` journal without replaying its action.
   Its last known outcome is unknown and its daemon absent. Preserve the record;
   inspect any live leases before maintenance. If exact cleanup is required,
   review a fresh scoped reconciliation plan. Age/PID alone is not authority.
3. Require the paired socket/owned host to have exited. Run the staged kit's
   `src/install.mjs inspect --kit <exact staged kit>`, review current paths,
   prerequisite pins, permission delta and retained rollback target. Use its
   **fresh** plan token for `activate --tasks-drained --extension-unloaded`.
   Those flags record the operator's attestations; they do not disable Chrome.
4. The operator enables Latch from the same managed physical extension folder
   and accepts any Chrome prompt. No debugger/test launch flags or desktop UI
   automation are used. A changed instance stops the pilot; do not auto-repair
   pairing. Verify the unchanged profile, selected native default, RC6 readiness
   and existing intended tabs before installing/verifying managed skill links.
5. Start `node test/fixtures/pilot-server.mjs <fresh private evidence directory>`
   in this checkout. The operator opens its generated A/B URLs in Work. Record
   the exact fixture origin/run and fresh tab IDs. Never reuse old fixture URLs.
6. Use separate workspaces/sessions and recorder directories. Connect explicitly
   native with focus emulation on. Assert the marked actor, capture before/after
   evidence around one scoped fixture save, compare the server receipt, test the
   intentional adapter error and disconnect normally. No action replay after a
   timeout. Use a second session for the bounded Stop/peer-survival check; retain
   unknown action outcomes separately from confirmed cleanup.
7. The operator foregrounds Personal while a bounded read-only fixture command
   targets Work. Record the operator observation and selected focus emulation;
   inspect no Personal tabs/content. This is headed observation, not a headless
   focus result. Stop the private server after cleanup; preserve its evidence.
8. Run the fresh actual Codex CLI acceptance below. Claude/Cursor remain
   unverified until their own actual runs. A second Mac/account is an additional
   qualification, not inferred from disposable profiles on this Mac.

If rollback is needed, drain only affected sessions, ask the operator to disable
Latch, verify the host exits, inspect the owned receipt/retained RC3 target, and
use the normal `rollback --tasks-drained --extension-unloaded` procedure. Enable
the stable folder, verify RC3 identity/native readiness and unchanged pairing.
Do not enable official transport as a workaround or clear profiles/recovery data.

## Fresh Codex CLI acceptance prompt

Run this in a new actual Codex CLI session after managed RC6 setup is verified:

```text
Use Latch for the approved local fixture acceptance in this current directory.
Keep cwd selected; record branch or N/A outside Git. Report the actual client and
version, skill discovery or explicit loading, and observed/reported permission
policy with provenance. Do not infer policy from the launcher version.

Use the installed canonical latch skill, not the development checkout skill.
If absent, report discovery blocked before explicitly loading
/Users/ekkisyam/.agents/skills/latch/SKILL.md as a separate check.

Require RC6 and same-context preflight ready. Use fresh Work tab metadata to
select the operator-supplied unique fixture URL. If no URL was supplied, ask for
it; never substitute a signed-in app. Choose a unique session and use native
transport, focus emulation on and the maintained --evidence-dir recorder on every
task command. Keep configured transport defaults unchanged.

Capture before screenshot/snapshot; assert the fixture actor. Perform one approved
fixture value save, assert its visible result and compare its server receipt.
Capture after. Run a function that only throws LATCH_RC6_EXPECTED_FAILURE with
--expect-error PLAYWRIGHT_ERROR; retain actual exit 1 separately from assertion
PASS. Do not force-click or blindly retry uncertain actions.

Disconnect only this session in cleanup even after failures, preserving tabs and
peers. Generate offline report and require integrity.verified true. Link report.md,
result.json and before/after evidence. If access is denied, inspect actual tool
availability and use only a supported command-scoped approval path. Otherwise
report blocked; do not alter global policies or silently enable Full Access.
```

## Final local delivery gate

After M4/M5 observations, freeze supported claims, build committed `0.2.0` in a
clean checkout, verify inventory/checksums and run exact-package clean install,
native application/evidence/cleanup, update and rollback checks. Package the kit,
notes, local setup/privacy/support/notices and verified acceptance links together.
RC6 passing does not pass this final package. Review the complete local bundle;
GitHub/public publication remains deferred regardless of local acceptance.
