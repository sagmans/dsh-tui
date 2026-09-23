# Consumer install smoke inside node:24-alpine. install-smoke.mjs replaces the
# @HARNESS@, @VERSION@, @BUNDLED@ and @TARBALL@ placeholders before piping this
# script in, so every path below is a container path.
set -eu
echo "install-smoke: node $(node -v), npm $(npm -v), harness @HARNESS@"

# Phase one: the tree a consumer gets from installing the harness and this
# package into one npm project.
mkdir -p /npm-check && cd /npm-check
npm init -y >/dev/null 2>&1
if ! npm install --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@@HARNESS@" /pkg/@TARBALL@ >npm.log 2>&1; then
  echo "install-smoke: npm could not resolve the packed tree"
  tail -40 npm.log
  exit 1
fi
test "$(node -p "require('@sagmans/dsh-tui/package.json').version")" = "@VERSION@"
# A package the host also installs must resolve to one copy; a second copy is the
# duplicate singleton that the optional peers exist to prevent.
test "$(find node_modules -path '*@deepseek-ai/dsh-agent/package.json' | wc -l | tr -d ' ')" = "1"
echo "install-smoke: npm tree ok"

# Phase two: the supported path, where dsh itself builds the profile.
npm install -g --ignore-scripts --no-audit --no-fund "@deepseek-ai/dsh@@HARNESS@" >/dev/null 2>&1
corepack enable >/dev/null 2>&1
export DSH_HOME=/dsh-home
if ! dsh plugin --profile tui add /pkg/@TARBALL@ >plugin.log 2>&1; then
  echo "install-smoke: the plugin profile install failed"
  tail -40 plugin.log
  exit 1
fi
PROFILE="$DSH_HOME/profiles/tui/node_modules"
test "$(node -p "require('$PROFILE/@sagmans/dsh-tui/package.json').version")" = "@VERSION@"
node -e "const bundles = require('$DSH_HOME/profiles/tui/package.json').dsh.profile.bundles; if (!bundles.includes('@sagmans/dsh-tui')) { console.error('install-smoke: the bundle left dsh.profile.bundles'); process.exit(1) }"
for pkg in @BUNDLED@; do
  copies=$(find "$PROFILE" -maxdepth 4 -path "*/$pkg/package.json" | wc -l | tr -d ' ')
  test "$copies" = "1" || { echo "install-smoke: $pkg resolved $copies copies"; exit 1; }
done
echo "install-smoke: profile ok, one copy of every mounted harness package"
