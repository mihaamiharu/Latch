#!/usr/bin/env bash
set -eu
if [ "${HERDR_ENV:-}" != 1 ]; then
  echo 'Open this action from inside a Herdr pane.' >&2
  exit 1
fi
exec "${HERDR_BIN_PATH:-herdr}" plugin pane open --plugin local.latch-view --entrypoint live --placement split --direction right --focus
