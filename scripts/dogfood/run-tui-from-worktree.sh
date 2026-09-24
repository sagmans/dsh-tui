#!/usr/bin/env bash
# Keep the historic entry point anchored to its own checkout, even from another cwd.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export DSH_DOGFOOD_DEFAULT_REPO="$(cd "$script_dir/../.." && pwd -P)"
export DSH_DOGFOOD_REQUIRE_LISTED=1
exec "$DSH_DOGFOOD_DEFAULT_REPO/.agents/skills/dsh-tui-dogfood/scripts/run-plugin-from-worktree.sh" "$@"
