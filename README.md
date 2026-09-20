# Archify — Quick Start

Write plain-JSON diagrams, get validated, self-contained, explorable HTML — plus direct PNG export.
Types: **architecture · workflow · sequence · dataflow · lifecycle**.

中文速览见文末。

## Requirements

- Node.js ≥ 18
- Google Chrome or Chromium — used by `visual-check` and `png` export (set `ARCHIFY_CHROME` to point at a specific binary)

## Installation

**Run from a repo checkout** (no install step):

```bash
node archify/bin/archify.mjs doctor          # verify the toolchain
node archify/bin/archify.mjs demo /tmp/archify-demo
```

**Install as an agent skill** (Codex CLI / opencode: `~/.agents/skills`, Claude Code: `~/.claude/skills`, Raven: `~/.raven/workspace/skills`, opencode project: `.opencode/skills`):

```bash
# from the repo root
node scripts/stage-clean-skill.mjs --dest /tmp/archify-skill
mv /tmp/archify-skill ~/.agents/skills/archify

# verify from inside the skill
node ~/.agents/skills/archify/bin/archify.mjs doctor
```

**Claude.ai / Project Knowledge**: upload the deterministic `archify.zip`.

Below, `archify` means the CLI entry: `node archify/bin/archify.mjs` (repo checkout) or `node bin/archify.mjs` (inside an installed skill).

## Core workflow

1. **Author** diagram JSON (five types share one schema family; examples live in `archify/examples/`).
2. **Validate + repair** until clean:

   ```bash
   archify validate architecture diagram.json --json
   ```

   The JSON receipt carries blocking `diagnostics` plus non-blocking `advisories` (e.g. alignment suggestions); fix the diagnosed `subject`, follow a `supportedFixes` entry, and re-run.

3. **Deliver** the final artifact (atomic, deterministic, SHA-256 receipt):

   ```bash
   archify deliver architecture diagram.json diagram.html --json
   ```

4. **Collect browser evidence** on the delivered HTML:

   ```bash
   archify visual-check diagram.html --json
   ```

## Direct PNG export

```bash
archify png architecture diagram.json hero.png --theme light --background transparent --scale 2 --json
```

| Option | Values | Default |
|---|---|---|
| `--theme` | `light` · `dark` | `dark` |
| `--background` | `transparent` · `opaque` (`--transparent` shorthand) | `opaque` |
| `--scale` | `1`–`8` raster multiplier | `4` (auto-reduced for very large diagrams) |
| `--quality` | `standard` · `showcase` | standard |
| `--json` | machine-readable receipt (`width`/`height`/`scale`/`bytes`) | — |

Requires Chrome/Chromium. Transparent keeps translucent diagram fills (boundary masks, lanes) at authored alpha while dropping only the background plate.

## Command map

| Command | Purpose |
|---|---|
| `render <type> <input.json> [out.html]` | One-shot render to HTML |
| `validate <type> <input.json>` | Layout/authoring checks + advisories |
| `deliver <type> <input.json> [out.html]` | Validated, receipted, atomic delivery |
| `preview <type> <input.json> [out.html]` | Deliver + open locally |
| `compare architecture <base> <head> [out.html]` | Delta view between two specs |
| `png <type> <input.json> [out.png]` | Direct PNG (theme/background/scale) |
| `visual-check <out.html>` | Automated browser evidence + screenshots |
| `check <out.html>` | Fast artifact self-check |
| `inspect <type> <input.json>` | Architecture layout receipt (JSON) |
| `migrate workflow <old> <new> --to-schema 2` | Upgrade v1 workflow JSON |
| `guide / brands / examples / doctor / demo` | Help, brand marks, samples, self-test |

`--repo-root <path>` (architecture only) attaches repository evidence so the diagram reflects real code.

## 中文速览

- 安装：仓库内直接 `node archify/bin/archify.mjs <命令>`；或 `node scripts/stage-clean-skill.mjs --dest /tmp/archify-skill` 后移动到 `~/.agents/skills/archify`（Claude Code 用 `~/.claude/skills`）；Claude.ai 上传 `archify.zip`。
- 常用：`deliver` 出图、`validate --json` 校验并按 diagnostics/advisories 修复、`visual-check` 收集浏览器证据、`png` 直接导出 PNG（`--theme light|dark`、`--transparent`、`--scale 1-8`）。
- 五种图：architecture / workflow / sequence / dataflow / lifecycle；示例在 `archify/examples/`。

## More

- Full documentation: [README-OLD.md](README-OLD.md) · [README_ZH.md](README_ZH.md)
- Authoring contracts: [archify/SKILL.md](archify/SKILL.md) · [Schema reference](archify/schemas/README.md)
- [Changelog](CHANGELOG.md) · MIT [License](LICENSE)
