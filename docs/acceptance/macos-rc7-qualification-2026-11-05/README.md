# RC7 headless qualification

Clean-clone qualification of `0.2.0-rc.7` at source `3b99c12`, on Apple Silicon with
Node 22.21.1 and Playwright CLI 0.1.20. All browser runs used disposable headless
Chrome for Testing profiles. This does not establish headed focus, real Chrome
permission prompts or anything about the Work profile; those are separate live gates.

- Kit ZIP SHA-256: `fd800168ec0fc421d58f4a805864a93d47215d37bacebababa0f22146a353971`
- Descriptor SHA-256: `8a7ac03d167b32f8f98c85462ffc58b5d7e93d2065d509da2d82d32f0d3e0703`
- `sourceDirty: false`. Three separate clean clones produced the identical kit ZIP.

## Results at `3b99c12`

| Lane | Floor 147.0.7727.15 | Current 157.0.8103.39, first run | Current, rerun |
| --- | --- | --- | --- |
| Default (162 tests, 47 opt-in skips) | 115 passed | 115 passed | 115 passed |
| Installed native (2) | Passed | Passed | Passed |
| Native update and rollback from RC3 (1) | Passed | Passed | Passed |
| Live update from RC3 (1) | Passed | Passed | Passed |
| Recorder (2) | Passed | Passed | Passed |
| Compatibility (4) | Passed | Passed | Passed |
| Live view (1) | Passed | Passed | Passed |
| Popup UI (4) | Passed | **3 passed, 1 failed** | Passed |
| Recovery (8) | Passed | Passed | Passed |

The owner accepted the clean rerun as passing, with the failure below logged as open.
The first-run failure is not withdrawn by the later pass.

## Open issue: intermittent discovery timeout during fixture setup

**Cause unknown.** On the 157 lane only, a fixture sometimes failed to see the test
browser's extension in `discover` within its 20-second limit, before any test body ran.

| Run | Setup failures |
| --- | --- |
| Current at `8f797ef` | Live view, popup UI 3 and 4, recovery 5. Popup UI 1 separately timed out |
| Current at `3b99c12`, first run | Popup UI 4 |
| Current at `3b99c12`, rerun | None |
| Floor, three full runs | None |
| 24 instrumented setups in short runs, alternating 147 and 157 | None. Times: 147 2.0–10.2 s, 157 1.9–9.7 s |

Setups running the host from a copied source tree failed 4 of 9 across the two failing
current runs, against 1 of 52 for other setups, but that variant alone did not reproduce
it. Kernel memory kills were heavy during the first failing run and absent at the second
failure, so memory pressure is not established as the cause. The failures came during
full-lane runs, so a cumulative effect is plausible but unproven. The 20-second limit
was not changed. The live Work update observes how real Chrome connects, which this
fixture evidence cannot.

## Fixed: login-state test on Chrome 157

The native update test failed 3 of 3 on 157 at `8f797ef`. With no Latch involved, Chrome
for Testing 157 exits on SIGTERM in about 20 ms and loses `localStorage` written shortly
before.

| Chrome for Testing, no Latch | Value retained |
| --- | --- |
| 147, SIGTERM at 0, 2 and 15 s after the write | 3/3 each |
| 157, SIGTERM at 0 s | 1/3 |
| 157, SIGTERM at 2 s | 0/3 |
| 157, SIGTERM at 4 s | 0/5 |
| 157, SIGTERM at 6, 8 and 10 s | 5/5 each |
| 157, SIGTERM at 15 s | 3/3 |
| 157, graceful `Browser.close` immediately | 4/4 |

`3b99c12` adds an 8-second wait to that test only. Latch's shipped code is unchanged.
These are small samples on one machine, and branded Chrome was not measured.

## Identity gate input

The operator recalls only using the switch during the 2026-11-01 RC3 to RC6 update, which
changed the instance ID. This is a recollection, not an observation, and the cause stays
unproven. The fixture live update preserved identity on both browsers; that does not
reproduce or explain the Work result. The 2026-11-04 update of Work kept its paired
instance. A step-by-step observation of the live update to RC7 remains the open gate.
