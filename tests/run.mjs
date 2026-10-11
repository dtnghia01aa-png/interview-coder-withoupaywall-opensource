// Bundles the TypeScript tests with esbuild and runs them with node:test.
// Usage: npm test
//   CLAUDE_LIVE=1 [CLAUDE_LIVE_IMAGE=<png>] npm test   also runs the live Claude CLI test
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const out = mkdtempSync(join(tmpdir(), "ic-tests-"))
const entries = readdirSync(root)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(root, f))

await build({
  entryPoints: entries,
  outdir: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: "inline",
  // Bundled output lives in a temp dir; keep __dirname pointing at tests/.
  banner: { js: `var __dirname = ${JSON.stringify(root)};` }
})

const files = readdirSync(out)
  .filter((f) => f.endsWith(".js"))
  .map((f) => join(out, f))
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
rmSync(out, { recursive: true, force: true })
process.exit(res.status ?? 1)
