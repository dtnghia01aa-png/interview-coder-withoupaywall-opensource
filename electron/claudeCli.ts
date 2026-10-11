// claudeCli.ts
// Thin, Electron-free wrapper around the local Claude Code CLI (`claude -p`).
// Kept free of Electron imports so it can be unit-tested with plain Node.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

export const DEFAULT_CLI_TIMEOUT_MS = 180_000

export interface ClaudeCliResult {
  text?: string
  error?: string
}

/**
 * Locate the `claude` CLI executable. Checks (in order):
 *   1) CLAUDE_CLI_PATH env var
 *   2) well-known install locations for the current platform
 *   3) bare "claude" — relies on PATH resolution at spawn time
 */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
  home: string = os.homedir()
): string {
  const override = env.CLAUDE_CLI_PATH
  if (override && exists(override)) return override

  const candidates =
    platform === "win32"
      ? [
          path.join(home, ".local", "bin", "claude.exe"),
          path.join(home, "AppData", "Roaming", "npm", "claude.cmd")
        ]
      : [
          path.join(home, ".local", "bin", "claude"),
          "/usr/local/bin/claude",
          "/opt/homebrew/bin/claude"
        ]

  for (const c of candidates) {
    if (exists(c)) return c
  }
  return "claude"
}

/**
 * Build argv for a non-interactive, read-only Claude Code invocation.
 * The prompt is NOT part of argv: `--add-dir` is variadic and would swallow a
 * trailing positional, so the prompt is piped over stdin instead.
 */
export function buildClaudeArgs(model: string, imagePaths: string[]): string[] {
  const args = [
    "-p",
    "--output-format", "json",
    "--input-format", "text",
    "--model", model,
    // Only the Read tool is exposed, so bypassing prompts is safe and avoids
    // hanging on a permission request nobody can answer in print mode.
    "--permission-mode", "bypassPermissions",
    "--tools", "Read",
    // Don't pollute the user's Claude Code session history / skill list.
    "--no-session-persistence",
    "--disable-slash-commands"
  ]
  const dirs = Array.from(new Set(imagePaths.map((p) => path.dirname(p))))
  for (const d of dirs) args.push("--add-dir", d)
  return args
}

/**
 * Node refuses to spawn .cmd/.bat shims without a shell (EINVAL since the
 * 2024 security fix), so npm-installed `claude.cmd` needs shell + quoting.
 */
export function prepareSpawn(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(executable)
  if (!needsShell) return { command: executable, args, shell: false }
  const quote = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return { command: quote(executable), args: args.map(quote), shell: true }
}

/**
 * Parse the `--output-format json` wrapper:
 *   {"type":"result","is_error":false,"result":"..."}
 */
export function parseCliOutput(stdout: string): ClaudeCliResult {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed.result === "string" && !parsed.is_error) {
      return { text: parsed.result }
    }
    return {
      error:
        (typeof parsed?.result === "string" && parsed.result) ||
        parsed?.error ||
        "Claude Code CLI returned an error response."
    }
  } catch (err: any) {
    return {
      error: `Failed to parse Claude Code CLI output: ${err.message}\nRaw: ${stdout.slice(0, 500)}`
    }
  }
}

export interface RunClaudeCliOptions {
  prompt: string
  imagePaths: string[]
  model: string
  signal: AbortSignal
  onProgress?: (msg: string) => void
  /** Override for tests; defaults to resolveClaudeExecutable(). */
  executable?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Invoke the local Claude Code CLI in print mode and return the text reply. */
export async function runClaudeCli(opts: RunClaudeCliOptions): Promise<ClaudeCliResult> {
  const { prompt, imagePaths, model, signal, onProgress } = opts
  const executable = opts.executable ?? resolveClaudeExecutable()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  const spawnSpec = prepareSpawn(executable, buildClaudeArgs(model, imagePaths))

  if (signal.aborted) return { error: "Processing was canceled by the user." }
  onProgress?.("Invoking Claude Code CLI...")

  return new Promise<ClaudeCliResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      shell: spawnSpec.shell,
      windowsHide: true,
      env: opts.env ?? process.env,
      // Run from a neutral dir so a project CLAUDE.md / settings in the app's
      // cwd can't leak into the prompt context.
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"]
    })

    const finish = (result: ClaudeCliResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(result)
    }

    // Kill the whole tree: a .cmd shim (or the CLI's own helpers) would
    // otherwise survive, keep our pipes open, and 'close' would never fire.
    const kill = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
        } else {
          child.kill("SIGKILL")
        }
      } catch { /* already gone */ }
    }
    const onAbort = () => {
      kill()
      finish({ error: "Processing was canceled by the user." })
    }
    signal.addEventListener("abort", onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({ error: `Claude Code CLI timed out after ${Math.round(timeoutMs / 1000)}s.` })
    }, timeoutMs)

    // An early-exiting child closes stdin and the write raises EPIPE as an
    // 'error' event; unhandled, that would crash the Electron main process.
    child.stdin.on("error", () => { /* surfaced via 'close' / 'error' below */ })
    child.stdin.end(prompt)

    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({
          error:
            "Claude Code CLI not found. Install it (https://docs.claude.com/en/docs/claude-code) " +
            "or set CLAUDE_CLI_PATH to its location."
        })
      } else {
        finish({ error: `Failed to spawn claude: ${err.message}` })
      }
    })

    child.on("close", (code) => {
      if (signal.aborted) return finish({ error: "Processing was canceled by the user." })
      if (timedOut) {
        return finish({
          error: `Claude Code CLI timed out after ${Math.round(timeoutMs / 1000)}s.`
        })
      }
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split("\n").slice(-5).join("\n")
        return finish({
          error: `Claude Code CLI exited with code ${code}.${tail ? `\n${tail}` : ""}`
        })
      }
      finish(parseCliOutput(stdout))
    })
  })
}
