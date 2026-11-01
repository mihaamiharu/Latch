# Repeatable local macOS qualification

This is the local release-engineering lane while repository/hosted CI are
deferred. It uses a clean committed clone, pinned prerequisites and disposable
headless profiles. It does not activate the installed Work extension, run an
agent on behalf of the operator, publish a release or pass M4/M5 live gates.

## Inputs and clean build

Use the supported Node/CLI and both Chrome for Testing pins in
`test/browser-versions.json`. Record actual versions first. Do not substitute
another cached browser or a headed launch when a pin fails. The retained complete
RC3 kit is read-only input for the native rollback test; its descriptor hash is
asserted by that test. Keep its own external prerequisites available.

From the clean source checkout, choose a fresh destination and record its commit:

```sh
LATCH_SOURCE=$(pwd -P)
LATCH_REVISION=$(git rev-parse HEAD)
LATCH_NODE=$(node -p 'process.execPath')
LATCH_QUALIFICATION="$LATCH_SOURCE/work/macos-release/<fresh-run-name>"
LATCH_RC3_KIT='/absolute/path/to/retained/0.2.0-rc.3-a50ad773869e'
test -z "$(git status --porcelain)" || exit 1
mkdir -p "$LATCH_SOURCE/work/macos-release"
mkdir "$LATCH_QUALIFICATION" || exit 1
git clone --no-hardlinks --no-checkout "$LATCH_SOURCE" "$LATCH_QUALIFICATION/source"
git -C "$LATCH_QUALIFICATION/source" checkout --detach "$LATCH_REVISION"
cd "$LATCH_QUALIFICATION/source"
npm ci --ignore-scripts
mkdir -p work
"$LATCH_NODE" src/build.mjs > "$LATCH_QUALIFICATION/build.json"
git status --porcelain
```

Run each command separately and record its actual exit status immediately. Stop
dependent steps on failure; keep the original logs. The final status must be
empty. A local clone's local `origin` does not authorize adding a remote to the
main checkout or pushing anywhere. `npm ci` needs the pinned external dependency
in cache or access to its normal registry; no user credentials belong in reports.

## Selected headless lanes

Use a fresh command environment so an inherited opt-in test flag or
configuration/runtime override cannot silently select another cohort or profile.
`HOME`, PATH and temporary-directory values below locate external prerequisites;
the browser fixtures create private registrations/configuration/runtime themselves.
The tests record actual browser/headless/test flags. `caffeinate -i` lasts only
for that command and does not change system power settings.

```sh
env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  "$LATCH_NODE" --test --test-concurrency=1 test/*.test.mjs \
  > "$LATCH_QUALIFICATION/default.tap" 2>&1

/usr/bin/caffeinate -i env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  LATCH_GUI_RUNTIME=1 LATCH_INSTALLED_KIT=1 \
  "$LATCH_NODE" --test --test-concurrency=1 \
  --test-name-pattern='minimal PATH|clean install without official' \
  test/gui-runtime.test.mjs test/installed-kit.test.mjs \
  > "$LATCH_QUALIFICATION/installed-native.tap" 2>&1

/usr/bin/caffeinate -i env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  LATCH_NATIVE_UPGRADE=1 LATCH_BASELINE_KIT="$LATCH_RC3_KIT" \
  "$LATCH_NODE" --test --test-concurrency=1 test/native-update.test.mjs \
  > "$LATCH_QUALIFICATION/native-update.tap" 2>&1

/usr/bin/caffeinate -i env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  LATCH_BROWSER_LANE=floor LATCH_EVIDENCE_RECORDER=1 LATCH_INSTALLED_KIT=1 \
  "$LATCH_NODE" --test --test-concurrency=1 \
  --test-name-pattern='real headless CLI records|clean install without official' \
  test/evidence-recorder-browser.test.mjs test/installed-kit.test.mjs \
  > "$LATCH_QUALIFICATION/floor.tap" 2>&1

/usr/bin/caffeinate -i env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  LATCH_EVIDENCE=1 LATCH_FILES=1 LATCH_FRAMES_WORKERS=1 LATCH_POPUP_WORKFLOW=1 \
  "$LATCH_NODE" --test --test-concurrency=1 --test-name-pattern=native \
  test/evidence-compat.test.mjs test/file-transfer-compat.test.mjs \
  test/frame-worker-compat.test.mjs test/popup-workflow.test.mjs \
  > "$LATCH_QUALIFICATION/compatibility.tap" 2>&1
```

Require the intended subtests to execute with zero failures/cancellations; exit
zero with all tests skipped is not a pass. Retain exact test counts, skips and
source TAP hashes. Compatibility tests exercise the selected source transport;
the installed lane exercises the packaged runtime. Keep those scopes distinct.
These selected lanes cover changed release paths, not every optional cohort.

The native lanes above require no official extension. The separately retained
0.1.2 legacy rollback cohort needs the official extension **fixture**, if selected:
pass `QA_BROWSER_OFFICIAL_EXTENSION=<verified fixture directory>` and run the
full installed-kit test. That input is not bundled into Latch and does not toggle
the user's installed extension. Record its actual version and provenance.

## Artifact and sign-off audit

Verify the built kit with `verifyKit` from `src/release.mjs`, archive SHA-256 values
against `build.json`, and source cleanliness. Review `release.json`: source commit,
release/Chrome versions, fixed extension/host identity, support matrix and complete
file inventory must match this run. New qualification must use the new versioned
directory; do not accidentally test a retained RC directory after version promotion.
The candidate test helper reads the expected identity from committed source.

Package metadata/reproducibility tests do not prove independent developer
signatures or provenance authentication: the descriptor and checksums detect
changes against the reviewed record. A final `0.2.0` requires its own build and
selected installed/native evidence, not just a renamed RC archive.

Collect a small acceptance summary with exact versions, tests/exit statuses,
descriptor/archive/TAP hashes, fixture scope, known limitations and live gate
status. Keep raw profiles, relay endpoints, CLI caches, recovery journals and
signed-in evidence private. Use the maintained recorder's selected export for
human-review screenshots. Do not claim a second Mac/account, actual Codex
discovery, restricted permissions, human Chrome prompts or signed-in Work reuse
from this lane. Follow the separate operator/client handoff for those checks.
