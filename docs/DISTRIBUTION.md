# Distribution & Publishing Guide

Latch is distributed as an npm package (`@mihaamiharu/latch`), GitHub Release archives (`dist/latch-<version>-kit.zip` and `dist/latch-<version>.zip`), and a Chrome Web Store MV3 extension (fixed ID `dlkpkeiejlgggeoibejpoajedoelfcli`).

## 1. Cut a GitHub Release

Pushing a version tag matching `v*` triggers [.github/workflows/release.yml](../.github/workflows/release.yml):

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow runs `npm test` and `npm run build`, generates `dist/SHA256SUMS.txt`, creates a GitHub Release with `latch-<version>-kit.zip`, `latch-<version>.zip`, and `SHA256SUMS.txt`, and publishes `@mihaamiharu/latch` with npm provenance if `NPM_TOKEN` is configured.

## 2. Publish to npm (`@mihaamiharu/latch`)

**Manual publish:**

```sh
npm login
npm pack --dry-run
npm publish --access public
```

**Automated CI publish:** Add an npm automation token as the repository secret `NPM_TOKEN` in GitHub Settings → Secrets and variables → Actions. Subsequent `v*` tag pushes publish automatically via `npm publish --provenance --access public`.

End users then install globally (no browser binary downloads—`playwright-core` uses your existing Chrome):

```sh
npm install -g @mihaamiharu/latch
latch install
```

## 3. Publish the Chrome Extension (Chrome Web Store)

Upload `dist/latch-<version>.zip` from `npm run build` (or GitHub Release assets) to the Chrome Web Store Developer Dashboard:

- **Fixed extension ID:** `extension/manifest.json` includes the pinned `"key"`, keeping extension ID `dlkpkeiejlgggeoibejpoajedoelfcli` consistent across unpacked installs and Chrome Web Store releases (Unlisted for teams or Public).
- **Host permissions & content scripts:** None (`host_permissions` and `content_scripts` are not used).

Permission justifications for Chrome Web Store review:

| Permission | Justification |
| --- | --- |
| `debugger` | Attaches CDP to the single tab the user explicitly connects via the `latch` CLI or popup, enabling inspection, input, screenshots, and ARIA snapshots without injecting content scripts. |
| `nativeMessaging` | Connects the extension to the user-installed local `com.latch.bridge` Node host (`native-host.mjs`). |
| `tabs` | Lists open tabs (`latch tabs`), opens tabs explicitly requested by `latch open`, and tracks which tab a session owns. |
| `tabGroups` | Reads tab-group context when connecting or releasing tabs so existing user tab groups are preserved. |
| `storage` | Persists the local extension pairing UUID and connection retry metadata on the device. |
| `alarms` | Wakes the MV3 service worker to retry reconnecting to the local native messaging host after transient disconnects. |
