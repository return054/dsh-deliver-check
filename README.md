# dsh-deliver-check

[DSH (DeepSeek Harness)](https://deepseek-harness.github.io/deepseek-harness/) plugin that exposes
a deterministic **deliver pre-flight gate** for AI code changes as the `deliver_check` tool.

It scans AI-generated code for delivery blockers — debug leftovers (`console.log` / `debugger` /
`print` / `pdb`), TODO/FIXME markers, not-implemented throws, hardcoded credentials, and placeholder
text — and issues a mechanical **exit-code verdict** the model may only relay, never re-interpret:
`0 = PASS`, `1 = FAIL`, `2 = UNVERIFIED`.

## Install

```bash
dsh plugin add dsh-deliver-check
```

Other channels: `dsh plugin add github:<owner>/<repo>` (pure JS, no build step) or
`dsh plugin add ./dsh-deliver-check-<version>.tgz`.

## Tool: `deliver_check`

| Parameter   | Type     | Required | Description |
|-------------|----------|----------|-------------|
| `projectDir`| `string` | yes      | Absolute path of the project root to scan (script runs with `cwd` set here). |
| `paths`     | `string[]`| no      | Explicit file paths (relative to `projectDir`) to scan instead of git changes. |
| `staged`    | `boolean`| no       | Only scan git-staged files (default: all uncommitted changes incl. untracked). |
| `allow`     | `string` | no       | Case-insensitive regex; lines matching it are exempted (e.g. `logger\.log`). |
| `offline`   | `boolean`| no       | Offline mode: built-in free rules only, no network request for the cloud rule pack. |

Returns the script's raw stdout/stderr followed by a final `EXIT CODE: N` line.

## Exit codes

| Code | Verdict      | Meaning |
|------|--------------|---------|
| `0`  | PASS         | Zero delivery blockers in scanned files — safe to deliver. |
| `1`  | FAIL         | At least one blocker. Fix **every** reported line, then re-run until exit `0`. |
| `2`  | UNVERIFIED   | Cannot judge (no checkable files, or paid cloud rules not obtained). **Never** treat as PASS. |

## Rules & payment

- **Free tier (built-in, offline):** debug leftovers + TODO markers for the JS/TS family and Python.
- **Cloud rule pack (paid):** not-implemented throws, hardcoded credentials, placeholders
  (needed for JS/TS + Python too), plus full debug/throw signatures for
  Go/Rust/Java/Kotlin/C#/PHP/Ruby. Billed per use at **¥0.01 via Alipay 402 payment**
  (the A2M HTTP 402 protocol); results are cached for 7 days so no repeated billing within TTL.
  Rule packs are Ed25519-signed and verified client-side.
- When the tool output contains a `402` / `[payment-required]` section, the model must relay the
  payment instructions to the user verbatim — never bypass or simulate payment.

## Publish

Tag push auto-publishes to npm (requires `NPM_TOKEN`, see `.github/workflows/publish.yml`):

```bash
npm version patch && git push --follow-tags
```
