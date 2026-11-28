# Security policy

Latch bridges a Chrome extension to a local native host and drives signed-in
browser tabs through the `debugger` permission. Bugs here can expose a user's
browser sessions, so security reports are taken seriously.

## Supported versions

Only the latest released minor version receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.1.x   | Yes       |
| < 1.1   | No        |

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a vulnerability.**

Report it privately through GitHub:
[Report a vulnerability](https://github.com/mihaamiharu/Latch/security/advisories/new)

Please include:

- The Latch version (`latch --version`), OS, and Chrome version
- What an attacker can do and what they need (local user, malicious web page, other extension, etc.)
- Steps or a proof of concept to reproduce
- Any suggested fix

You can expect an acknowledgement within 7 days. Once the issue is confirmed,
a fix and a GitHub Security Advisory will be published, and you will be
credited unless you ask not to be.

## Scope

In scope: the extension (`extension/`), native host and bridge, CLI (`src/`),
installers, and the release kit published on GitHub Releases and npm.

Out of scope: vulnerabilities in Chrome, Node.js, or upstream dependencies
(report those upstream), and issues that require an already-compromised local
user account.
