# Codex permission boundary on macOS

Read this for Codex CLI socket `EPERM`/`BRIDGE_ACCESS_DENIED`. A skill does not
grant access. The bridge can be healthy from another context while this caller
cannot reach it. Preserve the failed diagnostic and inspect actual tool/policy
availability. If escalation is auto-rejected and no permission-grant tool exists,
stop dependent browser work; do not repeatedly retry the same socket.

Latch needs the paired Unix socket, task writes, the exact per-workspace
Playwright daemon-cache directory and caller loopback networking. `diagnose`
reports the socket; `preflight` reports the other paths/checks. A socket-only
grant does not establish browser readiness. Native attachment still needs these
permissions even though the official extension is unused.

## Controlled qualification, Codex 0.166.0

On macOS 27.0.1, separate read-only probes using `codex sandbox -P :workspace
--include-managed-config` reproduced socket EPERM. Adding only the exact socket
with `--allow-unix-socket <paired-socket>` made `diagnose` healthy. Subsequent
preflight still blocked on the daemon-cache write and caller loopback. No browser
attachment was attempted. These are sandbox-command probes, not permissions
granted to the original agent session or complete sandboxed browser acceptance.

The installed version's `codex sandbox --help` documents the socket option.
It belongs to the sandbox subcommand; do not pass it as an invented interactive
CLI flag. Resolve a fresh paired path instead of reusing an old instance ID.

## Operator-selected, per-invocation approval path

When the operator wants to allow individually reviewed escalations without
editing global configuration, Codex 0.166.0 exposes this new-session invocation:

```sh
codex --no-daemon --sandbox workspace-write --ask-for-approval on-request
```

Run it from the intended task directory. This does not modify the existing
agent's policy. In the new session, observe effective policy and tool availability
again; request only an exact necessary command if its approval facility exists.
An approved command can execute outside the sandbox. Record that boundary rather
than calling it a fully sandboxed pass. Do not substitute blanket bypass flags,
change socket modes, switch transports, or edit global policies to pass a smoke.

Higher-priority managed requirements can still reject a launch or approval.
If they do, preserve the rejection and stop; the model cannot override them.
Official OpenAI documentation describes
[approval-policy categories](https://learn.chatgpt.com/docs/config-file/config-reference)
and [permission profiles, Unix sockets and managed constraints](https://learn.chatgpt.com/docs/permissions).
The profile syntax is beta; a complete custom browser profile requires its own
qualification, including cache writes and loopback. No such pass is claimed here.

If preflight blocked before connection was attempted, report that boundary.
There is no successful disconnect to claim. After any connection attempt or use
of an existing attached session, perform exact own-session cleanup or preserve
its unconfirmed status. A separate host-side observation of no lease does not
rewrite an access-denied disconnect as successful.
