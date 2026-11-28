# Contributing to Latch

Thanks for helping. Bug reports, fixes, and docs improvements are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security issues go through [SECURITY.md](SECURITY.md), never a public issue.
- By contributing you agree your work is licensed under the [Apache-2.0 license](LICENSE).

## Development setup

Requirements: Node.js 22+, and Google Chrome 125+ for manual testing.

```sh
npm ci
npm test          # unit and integration suites
npm run build     # deterministic release kit in dist/
```

### Browser suites

Real-browser suites run **headless** on the full Chrome for Testing binary
pinned in `test/browser-versions.json`, each with a disposable profile and a
test-only native host. See [AGENTS.md](AGENTS.md).

```sh
npm run build
npm run test:browser
```

Never point the suites at your everyday Chrome profile. Headless results do not
prove headed focus or tab-group behavior; say so in your PR if that matters.

## Pull requests

1. Fork and create a branch from `main`.
2. Keep each PR to one change. Add or update tests for behavior changes.
3. Make sure `npm test` and `npm run build` pass locally.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for titles,
   e.g. `fix: ...`, `feat: ...`, `test: ...`, `docs: ...`, `chore: ...`.
5. Fill in the PR template, including how you tested.

CI must be green before a PR is merged. PRs are squash-merged.

## Reporting bugs

Use the bug report form and include the output of `latch doctor`
(redact anything private). Exploration evidence from `work/` helps too, but
check it for tokens, cookies, and personal data before attaching it.
