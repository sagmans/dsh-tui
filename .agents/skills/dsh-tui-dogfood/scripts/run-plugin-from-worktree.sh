#!/usr/bin/env bash
# Clone the selected dsh home so plugin runs never write into the real profile.
set -euo pipefail

name="$(basename "${BASH_SOURCE[0]}")"
# The link policy is shared with the validator, so both read one rule set.
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
default_repo="${DSH_DOGFOOD_DEFAULT_REPO:-$PWD}"
default_repo="$(cd "$default_repo" && pwd -P)"

die() { printf '%s: error: %s\n' "$name" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "$name" "$*" >&2; }
step() { printf '\n==> %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Run a dsh plugin from a worktree, in a clone of the real home.

Usage:
  run-plugin-from-worktree.sh [options] [<worktree-name-or-path>] [-- <dsh args>]

The target is the checkout to run. A path is used as given; a name is matched
against this checkout's worktrees by directory name or branch tail (feat/copy
matches .../feat/copy). No target means the current checkout.

Options:
  --home DIR          scratch home to run in (default: <tmp>/dsh-dogfood/<name>-<id>)
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
  run-plugin-from-worktree.sh feature-x -- --resume
  run-plugin-from-worktree.sh --fresh --profile tui-copy-fix ../dsh-tui-copy
  run-plugin-from-worktree.sh --with-sessions --no-launch

The scratch home holds copied credentials and is kept private. --clean requires
a marker bound to this home, source, and checkout; no unmarked home is deleted.
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

[[ "$profile" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || die "invalid profile name: $profile"
# A removed checkout cannot supply package.json. Only explicit scratch-home cleanup
# may use its private marker to recover the original, now absent target identity.
orphan_clean=0
if [[ "$action" == clean && -n "$home" && -z "$target" ]]; then
  candidate_home="$(node -e "console.log(require('node:path').resolve(process.argv[1]))" "$home")"
  # Orphan cleanup trusts only a private clone marker owned by this user.
  if [[ -f "$candidate_home/.dsh-dogfood" ]] && node -e '
const fs = require("node:fs")
const [dir, marker] = process.argv.slice(1).map((file) => fs.lstatSync(file))
process.exit(dir.isDirectory() && dir.uid === process.getuid() && (dir.mode & 0o077) === 0 && marker.isFile() && marker.nlink === 1 && marker.uid === process.getuid() && (marker.mode & 0o077) === 0 ? 0 : 1)
' "$candidate_home" "$candidate_home/.dsh-dogfood"; then
    candidate_target="$(sed -n 's/^target=//p' "$candidate_home/.dsh-dogfood" | head -1)"
    if [[ -n "$candidate_target" && ! -e "$candidate_target/package.json" ]]; then
      node -e "const p=require('node:path'),s=process.argv[1];process.exit(p.isAbsolute(s) && s !== p.parse(s).root && s === p.normalize(s) ? 0 : 1)" "$candidate_target" || die "scratch marker has invalid target path"
      target_path="$candidate_target"
      orphan_clean=1
    fi
  fi
fi
if [[ "$orphan_clean" == 0 ]]; then
  target_path="$(resolve_target)"
  [[ -f "$target_path/package.json" ]] || die "$target_path has no package.json"
  package_name="$(node -e "const p = require(process.argv[1]); if (typeof p.name !== 'string') process.exit(1); console.log(p.name)" "$target_path/package.json")" || die "$target_path has an invalid package.json"
  [[ "$package_name" =~ ^(@[a-zA-Z0-9][a-zA-Z0-9._-]*/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || die "invalid plugin package name: $package_name"
  if [[ "$build" == 1 ]] && ! node -e "process.exit(typeof require(process.argv[1]).scripts?.build === 'string' && require(process.argv[1]).scripts.build.trim() ? 0 : 1)" "$target_path/package.json"; then
    build=0
  fi
fi

# The hash prevents same-named checkouts in different repositories sharing state.
target_name="$(basename "$target_path")"
target_id="$(node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0, 12))" "$target_path")"
tmp_root="${TMPDIR:-/tmp}"
: "${home:=${tmp_root%/}/dsh-dogfood/${target_name}-${target_id}}"
if [[ "$action" == clean && ! -d "$source_home" ]]; then
  [[ -n "$home" && ! -e "$source_home" && ! -L "$source_home" ]] || die "missing source home requires --clean --home and an absent source path"
  # Cleanup still needs the original physical identity to match its private marker.
  source_home="$(node -e "const fs=require('node:fs'),p=require('node:path');let x=p.resolve(process.argv[1]),b=x;while(!fs.existsSync(b))b=p.dirname(b);console.log(p.join(fs.realpathSync(b),p.relative(b,x)))" "$source_home")"
else
  [[ -d "$source_home" ]] || die "no home to clone at $source_home; pass --source-home"
  source_home="$(cd "$source_home" && pwd -P)"
fi
[[ ! -L "$home" ]] || die "scratch home cannot be a symlink: $home"
home="$(node -e "const fs=require('node:fs'),p=require('node:path');let x=p.resolve(process.argv[1]),b=x;while(!fs.existsSync(b))b=p.dirname(b);console.log(p.join(fs.realpathSync(b),p.relative(b,x)))" "$home")"
[[ ! -L "$home" ]] || die "scratch home cannot be a symlink: $home"
[[ "$home" != "$source_home" && "$home/" != "$source_home/"* && "$source_home/" != "$home/"* ]] || die "scratch home and source home must not overlap"
user_home="$(cd "$HOME" && pwd -P)"
[[ "$home/" != "$user_home/"* && "$user_home/" != "$home/"* ]] || die "scratch home cannot overlap the user home"
[[ "$home/" != "$target_path/"* && "$target_path/" != "$home/"* ]] || die "scratch home cannot overlap the target checkout"
[[ "$home" != / ]] || die "scratch home cannot be filesystem root"
for path in "$home" "$source_home" "$target_path"; do [[ "$path" != *$'\n'* ]] || die "paths cannot contain newlines"; done
marker="$home/.dsh-dogfood"
profile_json="$home/profiles/$profile/package.json"

check_credentials() {
  [[ ! -L "$home/.credentials.yaml" ]] || die "cloned credentials cannot be a symlink"
  [[ -e "$home/.credentials.yaml" ]] || return 0
  node -e "const s=require('node:fs').lstatSync(process.argv[1]);process.exit(s.isFile() && s.nlink === 1 ? 0 : 1)" "$home/.credentials.yaml" || die "cloned credentials cannot be hardlinked or non-regular"
}

check_clone_links() {
  node "$helper_dir/clone-links.mjs" check "$home" "$source_home" || die "cloned home contains unsafe symlink or hardlink"
}

materialize_cloned_links() {
  node "$helper_dir/clone-links.mjs" materialize "$home" "$source_home" || die "cloned home links could not be made self-contained"
}

validate_marker() {
  [[ -f "$marker" && ! -L "$marker" ]] || die "$home has no valid .dsh-dogfood marker; refusing to modify it"
  node -e "const s=require('node:fs').lstatSync(process.argv[1]);process.exit(s.isFile() && s.nlink === 1 ? 0 : 1)" "$marker" || die "$home marker cannot be hardlinked or non-regular"
  [[ "$(marker_value home)" == "$home" && "$(marker_value source)" == "$source_home" && "$(marker_value target)" == "$target_path" && "$(marker_value profile)" == "$profile" ]] || die "$home marker identity does not match home, source, target, and profile"
}

[[ -n "$dsh_bin" ]] || dsh_bin="$(command -v dsh || true)"

describe_bundles() {
  [[ -f "$profile_json" ]] || { printf 'none\n'; return; }
  node -e "console.log(require(process.argv[1]).dsh.profile.bundles.join(', '))" "$profile_json" 2>/dev/null || printf 'unreadable\n'
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
  printf 'link:    %s\n' "$(node -e "console.log(require(process.argv[1]).dependencies?.[process.argv[2]] ?? 'absent')" "$profile_json" "$package_name" 2>/dev/null || printf 'absent')"
  exit 0
fi

if [[ "$action" == "clean" ]]; then
  [[ -d "$home" ]] || { note "nothing at $home"; exit 0; }
  validate_marker
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

if [[ -d "$home" && "$action" != "clean" && "$dry_run" != 1 ]]; then
  validate_marker
  check_credentials
  chmod 700 "$home"
  if [[ -f "$home/.credentials.yaml" ]]; then chmod 600 "$home/.credentials.yaml"; fi
fi

if [[ "$reseed" == 1 && -d "$home" ]]; then
  validate_marker
  rm -rf "$home"
fi

if [[ "$fresh" == 1 && -d "$home" ]]; then
  note "$home already exists: --fresh applies when a home is seeded (--reseed to re-seed it)"
fi

if [[ ! -d "$home" ]]; then
  [[ -d "$source_home" ]] || die "no home to clone at $source_home; pass --source-home"
  [[ "$with_sessions" != 1 || ! -L "$source_home/sessions" ]] || die "source sessions cannot be a symlink"
  step "seeding $home from $source_home"
  mkdir -p "$home"
  chmod 700 "$home"
  if [[ "$fresh" == 1 ]]; then
    for seed in .credentials.yaml settings.yaml; do
      if [[ -f "$source_home/$seed" ]]; then cp -p "$source_home/$seed" "$home/$seed"; fi
    done
  elif command -v rsync >/dev/null 2>&1; then
    # Preserving the source root's mode can expose copied credentials before final chmod.
    rsync -a --no-perms --exclude '/sessions/' --exclude '/.dsh-dogfood' "$source_home/" "$home/"
    if [[ "$with_sessions" == 1 && -d "$source_home/sessions" ]]; then rsync -a --no-perms "$source_home/sessions/" "$home/sessions/"; fi
  else
    # tar carries the tree without the bulk of the sessions; BSD tar takes the
    # exclude in the same form as GNU tar.
    mkdir -p "$home/sessions"
    (cd "$source_home" && tar -c --exclude './sessions' --exclude './.dsh-dogfood' .) | (cd "$home" && tar -x)
    if [[ "$with_sessions" == 1 && -d "$source_home/sessions" ]]; then (cd "$source_home" && tar -c sessions) | (cd "$home" && tar -x); fi
  fi
  chmod 700 "$home"
  check_credentials
  chmod 600 "$home/.credentials.yaml" 2>/dev/null || true
  if [[ "$with_sessions" != 1 ]]; then
    note "sessions were not copied; --resume starts empty (pass --with-sessions for your history)"
  fi
fi

printf 'home=%s\nsource=%s\ntarget=%s\nprofile=%s\n' "$home" "$source_home" "$target_path" "$profile" > "$marker"
chmod 600 "$marker"
materialize_cloned_links
check_clone_links

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
[[ ! -L "$home/profiles" && ! -L "$profile_dir" && ! -L "$profile_json" ]] || die "cloned profile cannot contain a symlink in its manifest path"
if [[ ! -f "$profile_json" ]]; then
  DSH_HOME="$home" "$dsh_bin" --profile "$profile" --from-default-profile "$profile" --help >/dev/null 2>&1 || true
  [[ ! -L "$home/profiles" && ! -L "$profile_dir" && ! -L "$profile_json" ]] || die "cloned profile cannot contain a symlink in its manifest path"
  if [[ ! -f "$profile_json" ]]; then
    DSH_HOME="$home" "$dsh_bin" plugin --profile "$profile" add "$target_path" >&2 || die "could not create profile '$profile' in $home"
  fi
fi
[[ -f "$profile_json" ]] || die "profile '$profile' has no package.json at $profile_json"
node -e "const s=require('node:fs').lstatSync(process.argv[1]);process.exit(s.isFile() && s.nlink === 1 ? 0 : 1)" "$profile_json" || die "cloned profile manifest cannot be hardlinked or non-regular"

# Legacy callers require a prelisted bundle; generic callers can add one in the clone.
if [[ "${DSH_DOGFOOD_REQUIRE_LISTED:-0}" == 1 ]] && ! node -e "process.exit(require(process.argv[1]).dsh?.profile?.bundles?.includes(process.argv[2]) ? 0 : 1)" "$profile_json" "$package_name"; then
  die "profile '$profile' does not list $package_name (bundles: $(describe_bundles)); add it to the profile first"
fi
node -e '
const fs = require("node:fs")
const path = require("node:path")
const [manifestPath, directory, originalDirectory, packageName, targetPath] = process.argv.slice(1)
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error("invalid profile bundle list")
if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
manifest.dependencies ||= {}
manifest.dependencies[packageName] = "link:" + targetPath
const moduleDir = path.join(directory, "node_modules")
const entries = Object.entries(manifest.dependencies).filter(([, spec]) => typeof spec === "string" && spec.startsWith("link:"))
const packagePattern = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const state = (file) => fs.lstatSync(file, { throwIfNoEntry: false })
for (const part of [directory, path.dirname(directory), moduleDir]) {
  if (state(part)?.isSymbolicLink()) throw Error("unsafe symlink in profile path: " + part)
}
for (const [name, spec] of entries) {
  if (!packagePattern.test(name)) throw Error("invalid link dependency name: " + name)
  if (name.includes("\n") || spec.includes("\n") || spec.includes("\0")) throw Error("unsafe link dependency: " + name)
  const destination = path.join(moduleDir, name)
  if (state(path.dirname(destination))?.isSymbolicLink()) throw Error("unsafe symlink in node_modules: " + name)
  const existing = state(destination)
  if (existing && !existing.isSymbolicLink()) throw Error("unsafe existing module at " + destination)
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
for (const [name, spec] of entries) {
  const destination = path.join(moduleDir, name)
  const target = path.resolve(originalDirectory, spec.slice("link:".length))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (state(destination)) fs.unlinkSync(destination)
  fs.symlinkSync(target, destination)
}
' "$profile_json" "$profile_dir" "$source_home/profiles/$profile" "$package_name" "$target_path" || die "could not safely relink profile '$profile'"
# Newly materialized dependency links must obey the same source-home boundary.
check_clone_links

bundles="$(describe_bundles)"
if ! node -e "process.exit(require(process.argv[1]).dsh.profile.bundles.includes(process.argv[2]) ? 0 : 1)" "$profile_json" "$package_name"; then
  die "profile '$profile' does not list $package_name after relink (bundles: $bundles)"
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
