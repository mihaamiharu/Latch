# Latch 1.0.0 local setup

This release includes the native extension, host/CLI, shared skill, `ws` 8.22.0, and third-party licenses. Node **>=22.0.0** and Playwright CLI **0.1.20** are external prerequisites. Chrome **>=125** is required (`minimum_chrome_version: "125"`).

Open a fresh tab with:

```sh
latch open --profile work --session fresh-qa \
  --workspace /absolute/project --focus-emulation on --url https://staging.example.com
latch pw --profile work --session fresh-qa --workspace /absolute/project -- snapshot
latch disconnect --profile work --session fresh-qa --workspace /absolute/project
```

## Inspect and stage

```bash
LATCH_KIT='/absolute/path/to/latch-1.0.0'
node "$LATCH_KIT/src/install.mjs" inspect --kit "$LATCH_KIT"
node "$LATCH_KIT/src/install.mjs" stage --kit "$LATCH_KIT"
```

The default runtime is `~/Library/Application Support/Latch/runtime`. `releases/` contains complete hashed payloads, `current` selects the local host/CLI, and `extension/` is a stable physical directory.

## Activate once, then verify

```bash
node "$LATCH_KIT/src/install.mjs" inspect --kit "$LATCH_KIT"
node "$LATCH_KIT/src/install.mjs" activate --kit "$LATCH_KIT" \
  --expect '<planToken from this inspection>' --tasks-drained --extension-unloaded
```

Load unpacked `extensionDirectory` in Chrome (`dlkpkeiejlgggeoibejpoajedoelfcli`), enable the extension, then verify:

```bash
LATCH_RUNTIME="$HOME/Library/Application Support/Latch/runtime"
"$LATCH_RUNTIME/bin/latch" diagnose --profile work
node "$LATCH_KIT/src/install.mjs" verify --profile work
```

If `verify` refuses because the instance changed, use `latch pair --replace`:

```bash
latch pair --profile work --instance <new uuid from popup> \
  --chrome-profile-dir <same directory as before> --replace --expect-old <old uuid>
```

## Shared skill and daily use

```bash
node "$LATCH_KIT/src/install.mjs" skills
"$LATCH_RUNTIME/bin/latch" preflight --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE"
"$LATCH_RUNTIME/bin/latch" pw --profile work --session "$LATCH_SESSION" --workspace "$LATCH_WORKSPACE" -- snapshot
```

## Rollback and uninstall

```bash
node "$LATCH_KIT/src/install.mjs" rollback --tasks-drained --extension-unloaded
node "$LATCH_KIT/src/install.mjs" uninstall --tasks-drained --extension-unloaded
```
