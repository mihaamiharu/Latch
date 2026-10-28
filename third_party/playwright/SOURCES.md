# Playwright source provenance

Reference revision: `f9a841f968dd9a4e315df2ec2930da1952971667`.
Copyright (c) Microsoft Corporation. Apache License, Version 2.0; see `LICENSE`.

`src/native-browser-model.mjs` (originally the Phase 1 experiment) adapts the target/session mapping
and initialization pattern from:

- https://github.com/microsoft/playwright/blob/f9a841f968dd9a4e315df2ec2930da1952971667/packages/playwright-core/src/tools/mcp/browserModel.ts
- https://github.com/microsoft/playwright/blob/f9a841f968dd9a4e315df2ec2930da1952971667/packages/playwright-core/src/tools/mcp/cdpRelayV2.ts

Changes: JavaScript ESM without private Playwright imports; a single selected tab;
explicit root command handling; no arbitrary browser-level fallback; restricted
target enumeration; connection-specific session namespaces; unsupported target creation/closure rejected. The transport,
native bootstrap and fixture harness are Latch-specific code.

The installed Playwright CLI remains unmodified. This provenance does not claim
that every upstream relay capability is supported by this experiment.
