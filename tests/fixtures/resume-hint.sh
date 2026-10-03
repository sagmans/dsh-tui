#!/bin/sh
# A stub proves argument boundaries without starting the harness or touching a profile.
set -eu
dsh() {
  printf '%s\n' "$@"
}
eval "$1"
