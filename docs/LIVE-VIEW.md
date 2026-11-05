# Live Chrome view in Herdr

RC7 adds `qa-browser view` and the local `local.latch-view`
Herdr plugin. It displays the root tab of an **already attached native schema-4
Latch session**, using that session's existing Chrome debugger attachment. The
agent remains the controller. It requires no Chrome remote-debugging port, new
browser profile, extra extension permissions or third-party browser plugin.

The viewer is view-only. It does not forward clicks/keys, navigate, resize the
browser or bring its tab to the foreground. `q`, Escape or Ctrl-C closes the
viewer, preserves the agent connection and leaves Chrome/logins open. It watches
the session's starting tab; selecting a different page in Playwright does not
retarget it. Root-tab loss closes the viewer rather than switching to another tab.

## Installation status

An installed runtime does not gain this feature when source files change. Both the
CLI and native host need it. The frozen RC6 kit does not contain it. An earlier live
view build, `0.2.0-rc.6-75833d720037`, carries the RC6 version; RC7 is the identifiable
release and is what Work runs. Use the normal build, inspect, stage and activate workflow
in SETUP.md, retaining the previous runtime. Activation requires drained tasks and
Latch switched off, not removed; do not attest those conditions without actually
completing them. No installed Work configuration is changed by building or testing
this source candidate.

## Terminal command

Connect the desired tab through the usual Latch skill first. Use the **same
session name and canonical project path** in a second terminal pane:

```sh
qa-browser view --profile work --session YOUR_SESSION --workspace /absolute/project
```

The default renderer uses `chafa` (`brew install chafa`) and ANSI true-color
characters. For a sharper PNG view with a Kitty-compatible outer terminal,
enable `[terminal] kitty_graphics = true` in Herdr's configuration (check your
installed `herdr --default-config` for the section), reload config, and run:

```sh
qa-browser view --profile work --session YOUR_SESSION --workspace /absolute/project --renderer kitty
```

The standalone source entrypoint is `node /path/to/work-browser-bridge/src/cli.mjs
view ...`; it still requires a running host containing the same feature.

## Optional Herdr action

After activating the candidate, link its integration directory from inside Herdr:

```sh
herdr plugin link /absolute/path/to/candidate/integrations/herdr
herdr plugin action invoke local.latch-view.open
```

The pane prompts for the existing session and project directory. Optional pane
environment settings are `LATCH_VIEW_SESSION`, `LATCH_VIEW_WORKSPACE`,
`LATCH_VIEW_PROFILE` (default `work`), and `LATCH_VIEW_RENDERER` (default `chafa`).
This plugin only opens the terminal viewer; it never claims or disconnects tabs.

## Stream behavior and limitations

Chrome sends PNG screencast frames after an initial viewport screenshot. This is
an event stream, not a CLI screenshot polling loop. Chrome may pause delivery
for hidden/background/occluded tabs; the viewer never changes actual focus to
force frames. A static page need not emit new frames. The initial screenshot is
viewport-sized; streamed frames are capped at 1280×800. Terminal painting is
limited to roughly six frames per second and keeps only the latest pending PNG.
Frames exceeding 4 MiB of base64 or a full sender backlog are dropped; output
depends on terminal size, renderer speed and browser visibility. This is a QA
viewer, not a smooth-video guarantee.

Only one viewer per native session is accepted. The viewer owns that session's
screencast while open: CDP screencast recording commands are rejected until it
closes, and an existing screencast prevents a viewer from opening. Ordinary
screenshots, browser actions and independently owned peer sessions continue.

The host exposes a random, session-scoped loopback WebSocket that accepts no
Origin header and sends pixels only. It rejects client messages, webpage origins
and duplicate viewers. Credentials stay on the private native operation channel;
they are not a general CDP endpoint. Same-user local processes remain trusted.
No frame recordings are saved by the viewer; page pixels still contain whatever
the selected signed-in tab displays.

## Verification

```sh
node --test test/live-view.test.mjs
LATCH_BROWSER_LANE=floor LATCH_LIVE_VIEW=1 node --test test/live-view-browser.test.mjs
```

The browser test uses disposable headless Chrome for Testing and synthetic login
state. It verifies changed streamed pixels, preserved agent/peer connections,
login retention, viewer quit, disconnect cleanup, and Kitty output/terminal
restoration using a simulated TTY. This does **not** establish actual Herdr image
rendering or headed/background focus behavior; verify those in the user's terminal.
