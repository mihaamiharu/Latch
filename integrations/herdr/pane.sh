#!/usr/bin/env bash
set -eu
plugin_root="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
session="${LATCH_VIEW_SESSION:-}"
workspace="${LATCH_VIEW_WORKSPACE:-}"
renderer="${LATCH_VIEW_RENDERER:-chafa}"
if [ -z "$session" ]; then read -r -p 'Existing Latch session name: ' session; fi
if [ -z "$workspace" ]; then read -r -p 'Session project directory (absolute path): ' workspace; fi
if ! node "$plugin_root/../../src/cli.mjs" view --profile "${LATCH_VIEW_PROFILE:-work}" --session "$session" --workspace "$workspace" --renderer "$renderer"; then
  echo 'Viewer could not start. Review the error above; Chrome and the agent session were preserved.' >&2
  read -r -p 'Press Enter to close this pane.' ignored
  exit 1
fi
