# Release Policy

Applies to maintainers. Current release owner: repository owner ([`LICENSE`](LICENSE)).

## Versioning

[SemVer](https://semver.org). While at 0.x, minor bumps may contain breaking changes; patch bumps are fixes only. The git tag (`vX.Y.Z`) and `package.json` `version` must always match. The tag workflow fails before publish when they do not.

[`CHANGELOG.md`](CHANGELOG.md) records what shipped, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. A change lands under `Unreleased` in the PR that makes it; the release PR moves that section to `## [X.Y.Z] - <date>` and repoints the compare links.

## Gates — all required before tagging

1. Candidate lands on `main` through a reviewed PR (squash merge).
2. `verify` CI green on the exact merged SHA.
3. Locally on that SHA: `pnpm typecheck`, `pnpm test`, `pnpm test:release`, `npm audit signatures`, `node tools/pack-smoke.mjs`.
4. Dogfooding: install the candidate into a plugin profile and drive a real session in a terminal per [README](README.md#install). Unit tests do not prove the terminal surface.
5. README accuracy pass: every documented command and profile path still behaves as written.
6. `CHANGELOG.md` carries the version being tagged: `Unreleased` holds only what landed after it, the `## [X.Y.Z] - <date>` section names the tag, and the compare links point at that tag.
7. A publication carries both its `vX.Y.Z` tag and the GitHub release record for that tag. The tag is what `release.yml` publishes from and what a checkout resolves; the record is what a reader finds, and its notes are the version's `CHANGELOG.md` entry. Either half missing leaves the version incomplete: create the missing half from the same signed tag, and never retag and never republish a version already served.
8. A published npm version is immutable. A broken release is forward-fixed, never unpublished (see [Rollback](#rollback)).

Main/PR `verify` also runs the native terminal gate, offline harness matrix, and consumer install smoke. The tag workflow does not rerun those three gates. Both workflows install before `npm audit signatures`; that audit does not prove lifecycle scripts were disabled. The consumer smoke disables scripts for its direct npm installs, not explicitly for `dsh plugin add`. Keep real-session dogfooding separate from these automated checks.

## Harness matrix

The manifest declares `dsh.compatibility.dsh` as `>=0.2.0-rc.2 <0.3.0`. Its `dsh.compatibility.dshReleases` lists only `0.2.0-rc.2` as verified. Do not treat the rest of the declared range as tested. Mounted harness dependencies and harness development dependencies name that exact release; harness peers are open (`*`) and optional. These declarations do not guarantee deduplication in a consumer tree.

`verify` runs `node tools/harness-matrix.mjs` to check manifest consistency offline. It checks release bounds and line, mounted dependency declarations without aliases, allowed peer declarations, and one listed development dependency version. It does not compile sources, inspect installed package versions, run a profile, or independently verify the release list. Typecheck and runtime gates supply separate evidence.

The consumer install smoke packs the candidate and selects the highest listed release in `node:24-alpine`. Its npm-project install uses `--ignore-scripts` and counts `dsh-agent` copies. Its plugin-profile install checks bundle membership and counts mounted harness packages within its search depth. It does not start an interactive profile or call a model, and it does not test every release in the declared range. These checks do not prove general consumer deduplication or all lifecycle-script behavior.

[`.github/workflows/harness-matrix.yml`](.github/workflows/harness-matrix.yml) runs the tool with `--check-registry` daily. That mode checks only `@deepseek-ai/dsh`'s `latest` dist-tag against the listed releases. It does not monitor `rc` or other tags, or discover every newly published prerelease.

An unlisted `latest` requires investigation, not automatic verification. A verified-release change requires the following steps:

1. Run `node tools/harness-matrix.mjs --check-registry` to read the release the harness now serves as `latest`.
2. Prepare a candidate with matching harness development and mounted dependency versions. Update the declared range if needed. A proposed `dshReleases` entry is not verification evidence until the gates pass.
3. `pnpm install`, then run every gate in [Gates](#gates--all-required-before-tagging).
4. Dogfood a real session against the new release before it ships: install the candidate into a scratch profile and drive the terminal per [README](README.md#install). Keep the verified entry only after successful checks and dogfooding.
5. Land the bump through a reviewed PR and ship it with the next patch release.

## Release identity and authority

Static identity lives in [`scripts/npm/target.env`](scripts/npm/target.env). Load it before every helper action:

```sh
set -a; . scripts/npm/target.env; set +a
```

Per-release values are exported for one release only and are never stored in the repository: `PKG_VERSION`, `SOURCE_SHA`, `ARTIFACT`, `ARTIFACT_INTEGRITY`.

The helper is [`scripts/npm/release.py`](scripts/npm/release.py); [`pnpm test:release`](tests/release) exercises its guards through synthetic CLIs, and CI runs that suite on every change. No helper action writes to npm or GitHub without its own `CONFIRM=<action>` value. `DRY_RUN=1` prints the exact mutation instead of running it. Reading this policy, passing preflight, or exporting a variable is not approval.

The helper rejects a redirected registry before it acts: it reads the effective `registry` and `@sagmans:registry` configuration and fails closed unless both resolve to `https://registry.npmjs.org/`. The trust commands refuse unknown flags, so that check replaces pinning the scoped key on the command line.

Trust reads need an interactive terminal. npm starts its browser two-factor approval only when stdin and stdout are terminals, so the helper gives those reads a pseudo-terminal and mirrors the approval URL to stderr; approve it in a browser when the helper pauses.

Prerequisites: `python3` 3.11 or newer, npm 11.15.0 or newer, authenticated `npm` and `gh` CLIs, repository administration access, and a clean checkout.

## First publication (`v0.1.0` only)

npm requires a package to exist before trusted publishing can be configured, so the `v0.1.0` tag runs candidate verification but skips the publish job in [`release.yml`](.github/workflows/release.yml). The release owner publishes that version by hand from a clean checkout of the exact signed tag. Keep the reviewed artefact outside the checkout and unchanged until publication completes.

```sh
set -a; . scripts/npm/target.env; set +a
export PKG_VERSION='0.1.0'
export SOURCE_SHA="$(git rev-parse HEAD)"
export ARTIFACT_DIR='/tmp/dsh-tui-release'
mkdir -p "${ARTIFACT_DIR}"
# npm, not pnpm: the helper compares the packed manifest with the checkout
# byte-for-byte, and only npm's tarball embeds the manifest unchanged.
npm pack --pack-destination "${ARTIFACT_DIR}"
export ARTIFACT="${ARTIFACT_DIR}/sagmans-dsh-tui-${PKG_VERSION}.tgz"
export ARTIFACT_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "${ARTIFACT}" | openssl base64 -A)"
```

Review the packed inventory and confirm the artefact came from the reviewed SHA. Then preview and publish:

```sh
DRY_RUN=1 python3 scripts/npm/release.py preflight
DRY_RUN=1 python3 scripts/npm/release.py bootstrap-publish
CONFIRM=bootstrap-publish python3 scripts/npm/release.py bootstrap-publish
```

`bootstrap-publish` refuses an existing package, publishes the reviewed tarball with lifecycle scripts disabled, and verifies the delivered integrity. Local publication cannot generate provenance; provenance begins with the OIDC releases that follow. The registry can take minutes to serve a version it has already accepted — observed at about six minutes for the tarball — so the helper repeats a read that did not complete, then reports; a read that answered with the wrong identity is not repeated, and a publication is never retried. If the result is ambiguous, inspect the registry before any retry.

## Recurring release controls (once, after the bootstrap)

Each remote action needs its own approval. Preview first, then confirm:

```sh
DRY_RUN=1 python3 scripts/npm/release.py setup-github-release
CONFIRM=setup-github-release python3 scripts/npm/release.py setup-github-release

DRY_RUN=1 python3 scripts/npm/release.py configure-trust
CONFIRM=configure-trust python3 scripts/npm/release.py configure-trust

DRY_RUN=1 python3 scripts/npm/release.py harden-publishing
CONFIRM=harden-publishing python3 scripts/npm/release.py harden-publishing
```

- `setup-github-release` creates the approval-gated `npm-release` environment and an admin-only `v*` tag ruleset. It refuses to overwrite conflicting existing controls.
- `configure-trust` binds publication to this repository's `release.yml` on the `npm-release` environment. The registry answers a publish grant with stage publish included, so that pair is the accepted configuration; a stage-only grant carries no publish authority and is refused, as is any conflicting existing trust.
- `harden-publishing` requires two-factor authentication for publication and disallows traditional tokens, so the OIDC flow is the only publish path. Confirm the package settings on npmjs.com afterwards; the helper does not claim MFA readback.

Then verify identity, integrity, public access, and the exact trust. The trust read asks for browser approval, so run it from an interactive terminal:

```sh
DRY_RUN=1 python3 scripts/npm/release.py verify
python3 scripts/npm/release.py verify
```

## Tagging a release

Draft the GitHub release notes from the `CHANGELOG.md` entry against the candidate SHA before tagging. Tag creation for `v*` is restricted to repository admins by the ruleset above.

```sh
git tag -s -a "v${PKG_VERSION}" -m "v${PKG_VERSION}" <merged-sha>
git push origin "v${PKG_VERSION}"
```

The tag push runs `release.yml`: it checks tag/version agreement and reruns its candidate gates, not tag-signature verification, then the publish job waits for the release owner's approval on the `npm-release` environment before publishing through OIDC trusted publishing with automatic provenance. Create the GitHub release from the tag using the drafted notes once publication succeeds — the record is part of the release, not follow-up work, so a version that reaches the registry without it is finished by creating it from that same tag. A version already published before this rule is completed the same way.

## Rollback

- **Bad tag or release:** keep the signed tag, source SHA, and GitHub release record intact. npm versions are immutable, and deleting references breaks the source chain. Deprecate instead, mark the GitHub release as broken, and ship a patch release:
  ```sh
  npm deprecate "@sagmans/dsh-tui@<version>" "<reason>; use @sagmans/dsh-tui@<replacement> instead"
  ```
- **Bad terminal behaviour:** patch release; never disable a running profile or rewrite a user's stored conversations.
- **Broken trust configuration:** fix it with `configure-trust` after inspecting `npm trust list`; revoking credentials or changing account security needs separate approval.
