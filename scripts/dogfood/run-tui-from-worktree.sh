#!/usr/bin/env bash
#
# Dogfood a checkout's terminal surface in a profile that behaves like the real one.
#
# Why this exists: a plain scratch home proves the bundle boots and nothing else.
# It has none of the developer's other bundles, none of the profile patch that
# shapes their setup, none of their settings or themes, so a change is tested
# against a composition nobody runs. Pointing the real home at a feature worktree
# is the opposite mistake: the branch then writes sessions, prompt history,
# storage and themes into the state the daily driver reads, and a state migration
# or a crash mid-write lands there permanently.
#
# So this script clones the real home and runs the real profile inside the clone.
# Everything that shapes a run is present -- credentials, settings, themes,
# stash, storage, the other bundles, the profile patch -- while every write goes
# to a throwaway directory. Only the bundle under test is repointed, at the
# checkout given on the command line.
#
#   ./scripts/dogfood/run-tui-from-worktree.sh                    # this checkout
#   ./scripts/dogfood/run-tui-from-worktree.sh feat/copy-columns  # a sibling worktree
#   ./scripts/dogfood/run-tui-from-worktree.sh ../dsh-tui-fix
#
# The first run copies the home (sessions excluded: they are the bulk). Later
# runs reuse the clone and only re-link and rebuild, so they start in about a
# second. --with-sessions copies the stored sessions too, which is what makes
# --resume reach the developer's own history.
set -euo pipefail

name="$(basename "${BASH_SOURCE[0]}")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
default_repo="$(cd "$script_dir/../.." && pwd -P)"

die() { printf '%s: error: %s\n' "$name" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "$name" "$*" >&2; }
step() { printf '\n==> %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Run this repository's terminal surface from a worktree, in a clone of the real home.

Usage:
  run-tui-from-worktree.sh [options] [<worktree-name-or-path>] [-- <dsh args>]

The target is the checkout to run. A path is used as given; a name is matched
against this repository's worktrees by directory name or branch tail (feat/copy
matches .../feat/copy). No target means the checkout this script lives in.

Options:
  --home DIR          scratch home to run in (default: <tmp>/dsh-dogfood/<name>)
  --source-home DIR   home to clone (default: ~/.dsh)
  --profile NAME      profile inside the scratch home (default: tui)
  --dsh PATH          launcher to run (default: dsh on PATH, or $DSH_BIN)
  --fresh             seed the scratch home with credentials and settings only
  --with-sessions     copy stored sessions too, so --resume reaches real history
  --reseed            discard an existing scratch home and clone again
  --no-build          do not run pnpm run build in the target first
  --no-launch         set the run up and print the command instead of starting
  --status            print what the scratch home is pointed at and exit
  --dry-run           print the plan without touching anything
  --clean             remove the scratch home and exit
  --list              list this repository's worktrees and exit
  -h, --help          this text

Examples:
  run-tui-from-worktree.sh feature-x -- --resume
  run-tui-from-worktree.sh --fresh --profile tui-copy-fix ../dsh-tui-copy
  run-tui-from-worktree.sh --with-sessions --no-launch

The scratch home holds a copy of the real credentials. It is created 700 and the
marker file inside it is what --clean trusts; nothing else is ever deleted.
EOF
}

# --- arguments ---------------------------------------------------------------

target=""
home=""
source_home="$HOME/.dsh"
profile="tui"
dsh_bin="${DSH_BIN:-}"
fresh=0
with_sessions=0
reseed=0
build=1
launch=1
dry_run=0
action=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) home="${2:?--home needs a directory}"; shift 2 ;;
    --source-home) source_home="${2:?--source-home needs a directory}"; shift 2 ;;
    --profile) profile="${2:?--profile needs a name}"; shift 2 ;;
    --dsh) dsh_bin="${2:?--dsh needs a path}"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    --with-sessions) with_sessions=1; shift ;;
    --reseed) reseed=1; shift ;;
    --no-build) build=0; shift ;;
    --no-launch) launch=0; shift ;;
    --status) action="status"; shift ;;
    --dry-run) dry_run=1; launch=0; shift ;;
    --clean) action="clean"; shift ;;
    --list) action="list"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$target" ]] || die "only one target is accepted (got $target and $1)"
       target="$1"; shift ;;
  esac
done
passthrough=("$@")

if [[ -n "$source_home" ]]; then source_home="${source_home/#\~/$HOME}"; fi

# --- the repository's worktrees ---------------------------------------------

worktree_lines() {
  git -C "$default_repo" worktree list --porcelain 2>/dev/null || true
}

list_worktrees() {
  local line path="" branch=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ *) branch="${line#branch refs/heads/}" ;;
      "")
        [[ -n "$path" ]] || continue
        if [[ -n "$branch" ]]; then printf '%-44s %s\n' "$path" "($branch)"
        else printf '%-44s %s\n' "$path" "(detached)"; fi
        path=""; branch="" ;;
    esac
  done < <(worktree_lines)
  if [[ -n "$path" ]]; then printf '%-44s %s\n' "$path" "(${branch:-detached})"; fi
}

# A name matches a worktree's directory name or the tail of its branch, so both
# feat/copy-columns and copy-columns reach the same checkout.
resolve_by_name() {
  local want="$1" line path="" branch="" found=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ *) branch="${line#branch refs/heads/}" ;;
      "")
        [[ -n "$path" ]] || continue
        if [[ "$(basename "$path")" == "$want" || "$branch" == "$want" || "${branch##*/}" == "$want" ]]; then
          [[ -z "$found" ]] || die "'$want' matches more than one worktree; pass a path"
          found="$path"
        fi
        path=""; branch="" ;;
    esac
  done < <(worktree_lines)
  if [[ -n "$path" ]] && [[ "$(basename "$path")" == "$want" || "$branch" == "$want" || "${branch##*/}" == "$want" ]]; then
    [[ -z "$found" ]] || die "'$want' matches more than one worktree; pass a path"
    found="$path"
  fi
  printf '%s' "$found"
}

resolve_target() {
  [[ -n "$target" ]] || { printf '%s' "$default_repo"; return; }
  if [[ -d "$target" ]]; then (cd "$target" && pwd -P); return; fi
  local hit sibling
  hit="$(resolve_by_name "$target")"
  if [[ -z "$hit" ]]; then
    sibling="$(cd "$default_repo/.." 2>/dev/null && pwd -P)/$target"
    if [[ -d "$sibling" ]]; then hit="$sibling"; fi
  fi
  [[ -n "$hit" ]] || die "no worktree or directory named '$target' (try --list)"
  (cd "$hit" && pwd -P)
}

if [[ "$action" == "list" ]]; then list_worktrees; exit 0; fi

target_path="$(resolve_target)"
[[ -f "$target_path/package.json" ]] || die "$target_path has no package.json"
package_name="$(node -p "require('$target_path/package.json').name" 2>/dev/null || true)"
[[ "$package_name" == "@sagmans/dsh-tui" ]] || die "$target_path is not a dsh-tui checkout (name: ${package_name:-unknown})"

target_name="$(basename "$target_path")"
tmp_root="${TMPDIR:-/tmp}"
: "${home:=${tmp_root%/}/dsh-dogfood/$target_name}"
marker="$home/.dsh-dogfood"
profile_json="$home/profiles/$profile/package.json"

[[ -n "$dsh_bin" ]] || dsh_bin="$(command -v dsh || true)"

describe_bundles() {
  [[ -f "$profile_json" ]] || { printf 'none\n'; return; }
  node -p "require('$profile_json').dsh.profile.bundles.join(', ')" 2>/dev/null || printf 'unreadable\n'
}

marker_value() {
  [[ -f "$marker" ]] || { printf 'unknown'; return; }
  sed -n "s/^$1=//p" "$marker" | head -1
}

if [[ "$action" == "status" ]]; then
  [[ -d "$home" ]] || die "no scratch home at $home"
  printf 'home:    %s\n' "$home"
  printf 'source:  %s\n' "$(marker_value source)"
  printf 'target:  %s\n' "$(marker_value target)"
  printf 'profile: %s\n' "$profile"
  printf 'bundles: %s\n' "$(describe_bundles)"
  printf 'link:    %s\n' "$(node -p "require('$profile_json').dependencies['@sagmans/dsh-tui'] ?? 'absent'" 2>/dev/null || printf 'absent')"
  exit 0
fi

if [[ "$action" == "clean" ]]; then
  [[ -d "$home" ]] || { note "nothing at $home"; exit 0; }
  [[ -f "$marker" ]] || die "$home has no .dsh-dogfood marker; refusing to delete it"
  rm -rf "$home"
  note "removed $home"
  exit 0
fi

if [[ "$dry_run" == 1 ]]; then
  printf 'target:  %s\n' "$target_path"
  printf 'home:    %s%s\n' "$home" "$([[ -d "$home" ]] && printf ' (exists: reuse)' || printf ' (missing: seed)')"
  printf 'source:  %s%s\n' "$source_home" "$([[ "$fresh" == 1 ]] && printf ' (fresh: credentials and settings only)' || printf '')"
  printf 'profile: %s\n' "$profile"
  printf 'build:   %s\n' "$([[ "$build" == 1 ]] && printf 'pnpm run build' || printf 'skipped')"
  printf 'launch:  DSH_HOME=%s %s --profile %s %s\n' "$home" "${dsh_bin:-dsh}" "$profile" "${passthrough[*]:-}"
  exit 0
fi

[[ -n "$dsh_bin" ]] || die "no dsh launcher found; put dsh on PATH or pass --dsh"

# --- seed the scratch home ---------------------------------------------------

if [[ "$reseed" == 1 && -d "$home" ]]; then
  [[ -f "$marker" ]] || die "$home has no .dsh-dogfood marker; refusing to replace it"
  rm -rf "$home"
fi

if [[ "$fresh" == 1 && -d "$home" ]]; then
  note "$home already exists: --fresh applies when a home is seeded (--reseed to re-seed it)"
fi

if [[ ! -d "$home" ]]; then
  [[ -d "$source_home" ]] || die "no home to clone at $source_home; pass --source-home"
  step "seeding $home from $source_home"
  mkdir -p "$home"
  chmod 700 "$home"
  if [[ "$fresh" == 1 ]]; then
    for seed in .credentials.yaml settings.yaml; do
      if [[ -f "$source_home/$seed" ]]; then cp -p "$source_home/$seed" "$home/$seed"; fi
    done
  elif command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '/sessions/' --exclude '/.dsh-dogfood' "$source_home/" "$home/"
    if [[ "$with_sessions" == 1 ]]; then rsync -a "$source_home/sessions/" "$home/sessions/"; fi
  else
    # tar carries the tree without the bulk of the sessions; BSD tar takes the
    # exclude in the same form as GNU tar.
    mkdir -p "$home/sessions"
    (cd "$source_home" && tar -c --exclude './sessions' .) | (cd "$home" && tar -x)
    if [[ "$with_sessions" == 1 ]]; then (cd "$source_home" && tar -c sessions) | (cd "$home" && tar -x); fi
  fi
  chmod 600 "$home/.credentials.yaml" 2>/dev/null || true
  if [[ "$with_sessions" != 1 ]]; then
    note "sessions were not copied; --resume starts empty (pass --with-sessions for your history)"
  fi
fi

printf 'source=%s\ntarget=%s\nprofile=%s\n' "$source_home" "$target_path" "$profile" > "$marker"

# --- build, link, run --------------------------------------------------------

if [[ "$build" == 1 && ! -d "$target_path/node_modules" ]]; then
  die "$target_path has no node_modules; run pnpm install there first (or pass --no-build)"
fi

if [[ "$build" == 1 ]]; then
  step "building $target_path"
  (cd "$target_path" && pnpm run build) || die "pnpm run build failed in $target_path"
fi

# A profile's local bundles are installed as relative symlinks under its own
# node_modules, and those paths only resolve at the depth of the home they were
# installed in. A clone at a different depth (a /tmp scratch home) leaves every
# one dangling, so dsh refuses to mount the profile. Rebuild each link from the
# absolute 'link:' spec its package.json already carries. The profile is created
# from the shipped template when it is missing, then rewritten, because
# 'dsh plugin add' re-materialises the same relative links and drops the other
# bundles the profile had.
step "pointing profile '$profile' at $target_path"
profile_dir="$home/profiles/$profile"
if [[ ! -f "$profile_json" ]]; then
  DSH_HOME="$home" "$dsh_bin" --profile "$profile" --from-default-profile "$profile" --help >/dev/null 2>&1 \
    || DSH_HOME="$home" "$dsh_bin" plugin --profile "$profile" add "$target_path" >&2 \
    || die "could not create profile '$profile' in $home"
fi
[[ -f "$profile_json" ]] || die "profile '$profile' has no package.json at $profile_json"

# Point the bundle under test at the checkout, leaving every other dependency's
# spec untouched. The bundle must already be listed; inserting it would put the
# tool rows in two layers and fail composition.
if ! node -e "process.exit(require(process.argv[1]).dsh.profile.bundles.includes('@sagmans/dsh-tui') ? 0 : 1)" "$profile_json"; then
  die "profile '$profile' does not list @sagmans/dsh-tui (bundles: $(describe_bundles)); add it to the profile first"
fi
node -e "
const fs = require('node:fs')
const path = process.argv[1]
const target = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dependencies['@sagmans/dsh-tui'] = 'link:' + target
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
" "$profile_json" "$target_path"

# Materialise every 'link:' dependency as an absolute symlink, which is what a
# fresh install would do at this home's own depth.
relink_profile() {
  local manifest="$1" directory="$2" entry spec name dest
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    name="${entry%%=*}"
    spec="${entry#*=}"
    dest="$directory/node_modules/$name"
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    ln -s "${spec#link:}" "$dest"
  done < <(node -e "
const m = require(process.argv[1])
for (const [name, spec] of Object.entries(m.dependencies || {})) {
  if (String(spec).startsWith('link:')) console.log(name + '=' + spec)
}
" "$manifest")
}
relink_profile "$profile_json" "$profile_dir"

bundles="$(describe_bundles)"
if ! node -e "process.exit(require(process.argv[1]).dsh.profile.bundles.includes('@sagmans/dsh-tui') ? 0 : 1)" "$profile_json"; then
  die "profile '$profile' does not list @sagmans/dsh-tui after relink (bundles: $bundles)"
fi

printf '\n' >&2
printf 'home:    %s\n' "$home" >&2
printf 'target:  %s\n' "$target_path" >&2
printf 'profile: %s (%s)\n' "$profile" "$bundles" >&2

run_command=(env "DSH_HOME=$home" "$dsh_bin" --profile "$profile")
if [[ "${#passthrough[@]}" -gt 0 ]]; then
  run_command+=("${passthrough[@]}")
fi

if [[ "$launch" != 1 ]]; then
  printf '\nrun it with:\n  %s\n' "${run_command[*]}" >&2
  exit 0
fi

step "starting the surface"
exec "${run_command[@]}"
