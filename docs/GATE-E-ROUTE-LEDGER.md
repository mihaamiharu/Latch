# Gate E route ledger

Measured E0 probes, October 29, 2026; pinned versions from the execution plan.
The original runs are `work/gate-e-probe-2.log` and `work/gate-e-output-probe.log`.

- Ordinary CLI screenshot with an explicit filename writes the PNG and returns
  a small JSON file link. A 64×64 seeded canvas produced the same decoded pixels
  and PNG hash in both adapters (12,475 PNG bytes; 86 stdout bytes).
- Explicit snapshot filename writes the complete small YAML. Ten independent row
  markers and both sentinels were verified; stdout was 76 bytes. Reference IDs
  differ across adapters, so semantic row comparison is the oracle.
- `requests` provides the actual request's numeric index; `response-body <index>
  --filename=...` saves both binary and text bodies in the pinned implementation.
  The 1024-byte binary probe matched the independent response hash; stdout was
  57 bytes. No new production artifact helper is necessary.
- These direct CLI commands do not traverse Latch's `runCLI` output collector.
  Large test output has its own bounded file sink; small filename responses avoid
  dumping file bodies through stdout. Native bootstrap/control requests remain
  small. Screenshot/Network body data travels through the WebSocket data route.
- The original native 10-second command timer closed an 11-second awaited fetch
  (10.19 seconds observed); official completed it (12.28 seconds including CLI
  overhead). Native needs a bounded awaited-evaluation policy. Implemented repair:
  Runtime.evaluate/callFunctionOn with awaitPromise=true get 30 seconds; all other
  calls retain 10. Clients cannot choose an arbitrary longer transport timeout.
  Wrapper 45 seconds and fixture 65 seconds remain above these deadlines. The
  native host's 40-second lease-operation socket and short control/browser RPC
  timers are separate from the direct data-channel await.
- Exact-byte output tests exposed decoding each pipe chunk as a string: split
  multibyte characters inflated/corrupted the output and caused a false over-limit
  failure. The repair counts/stores bounded raw bytes and decodes after close.
  Aborted wrapper subprocesses receive TERM then a bounded KILL fallback and are
  reaped before the wrapper returns. This does not cancel daemon/browser actions.
- Current guard policy is 8 MiB existing backlog plus one message bounded to
  32 MiB serialized UTF-8. Thus admitted application bytes can reach 40 MiB before
  another send is rejected; framing, kernel buffers and object allocations are
  separate memory costs. Both relay and extension must enforce the same rule.
- Native metadata counters will report actual message/backlog/pending high-water
  values without bodies/tokens. Official wire byte measurements remain unavailable
  unless independently observable; file/stdout sizes are measured normally.


E1 follow-up: the high-entropy 2048×2048 PNG is 12,623,891 bytes and decodes to
all expected pixels. Snapshot outputs contain all 1024/4096 rows at approximately
1.17/4.70 MB. Text/binary bodies save exactly at 1 and 4 MiB. Both 16 MiB variants
are read by page fetch but unavailable through the inspector: standard Response.body
reports `Request content was evicted from inspector cache`. The CLI's body command
swallows that failure and returns `{}`; the harness rejects a missing artifact.
It does not copy server-side bytes to manufacture browser evidence.

Q3 follow-up: a pre-established Page listener receives all 512 numbered events;
the CLI's pinned Page console cache retains at most 200 entries (trimmed in batches
of 20), not a complete event stream. The native fixture retained 192 burst entries
when queried. That is documented partial history, not transport event loss.

Native byte counters are relay-wide sent/received aggregates and maxima; they are
not per-role packet captures. Exact input-role boundaries are proven separately
with authenticated protocol peers. The timeout collector also closes its owned
pipes after the forced-exit grace period: a CLI that exits while a descendant
retains stdout/stderr cannot leave the wrapper waiting indefinitely. Targeted
coverage verifies that behavior without claiming daemon/browser cancellation.
