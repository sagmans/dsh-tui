# dsh-tui

Full-screen, hotkey-first OpenTUI profile for DeepSeek Harness `0.1.0-rc.6`.

## Run from this checkout

```sh
pnpm run build
dsh plugin --profile tui add .
dsh plugin --profile tui install
mise exec node@26.4.0 -- node --experimental-ffi "$(command -v dsh)" --profile tui
```

Node.js `26.4.0+` and direct `--experimental-ffi` activation are required by OpenTUI. Plain `dsh --profile tui` remains the intended Harness command, but the current Node launcher cannot inject that process-start flag.

TUI provides terminal-native Web capability parity: sessions/workspaces, conversation and queue control, tools/files, subagents, trajectory, operations, interactions, provider/model/preset/permission management, field-level plugin settings, theme, and locale. Browser/DOM-only behavior stays excluded.

See [`docs/profile.md`](docs/profile.md) for controls and [`docs/parity.md`](docs/parity.md) for capability decisions and proof.
