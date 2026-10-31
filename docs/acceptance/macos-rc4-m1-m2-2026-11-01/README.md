# RC4 macOS compatibility and native setup checkpoint

Software revision: `76e8c544796b49385436c5e5641917af2b534919`.
This implements M1's release contracts and M2's native setup/preflight. It is not
the final release or a new Work installation. See [result.json](result.json) for
the exact build hashes, versions, test counts, launch flags and limitations;
[sha256.json](sha256.json) verifies that summary.

| Check | Result |
| --- | --- |
| Clean local clone, pinned dependency install and complete build | PASS; 72 payload files, committed source revision in descriptor |
| Default suite in the clean checkout | PASS; 92 passed, 41 optional skipped, 0 failures |
| Chrome 147.0.7727.15 floor | PASS; native frame/worker fixture and installed native clean setup |
| Chrome 153.0.8010.12 current test lane | PASS; the same two cases on this pinned build |
| Verified native setup | PASS in disposable installed kits; fresh tasks connect without a transport flag or official extension |
| Same-caller preflight | PASS; actual installed CLI checks bridge/controller, task/cache writes and local loopback before attachment |
| Failure boundaries | PASS in focused tests; denied sockets, unverified controller, write/network denial, unsupported platform/architecture/Node and mismatched browser pins |
| Frozen installed Work | Still RC3; descriptor and configuration match the prior checkpoint |

The browser counts above are two cases executed in each of two lanes, not four
different features. Each case is headless, uses disposable profiles/registrations
and records test-only flags. Installed-kit cases use the built extension/host/CLI;
frame cases exercise the committed source fixture. A limited existing-worker
backfill outcome is preserved rather than converted to a universal worker PASS.

The candidate requires Apple Silicon, macOS 27.0.1+, Node 22.21.1, CLI 0.1.20 and
Chrome 147+. This conservative qualification floor does not claim that older
macOS or Intel are technically impossible. Newer untested builds also need their
own acceptance. The source compatibility manifest and frozen RC3 kit are retained.

Local raw logs are under `work/macos-release/clean-*.tap` in the maintainer
checkout; fixture evidence remains under its disposable clone's
`work/attachment-compat/`. They are intentionally excluded from this portable
summary. The clean kit is under that clone's `dist/latch-0.2.0-rc.4/` and the ZIP
names/hashes are recorded in the result. No private browser evidence is published.

M2 real-client permission acceptance remains tied to M4. No actual client was
launched and counted as accepted here. Headless results do not establish real
focus, Personal-foreground behavior, signed-in Work app reuse, human permission
acceptance or second-machine acceptance. Those M4/M5 gates stay open.

Next implementation: M3's maintained evidence recorder, compact `result.json`,
human report and offline integrity verification. This release-engineering summary
does not imply those product commands already exist. Owner license/distribution
decisions and M6/M7 final promotion remain required before publication.
