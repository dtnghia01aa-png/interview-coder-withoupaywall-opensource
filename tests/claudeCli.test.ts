import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildClaudeArgs,
  parseCliOutput,
  prepareSpawn,
  resolveClaudeExecutable,
  runClaudeCli
} from "../electron/claudeCli"
import { buildStudyPrompt, parseStudyResult } from "../electron/studyMode"

// ---------- pure helpers ----------

test("resolveClaudeExecutable: env override wins only if the file exists", () => {
  const exists = (p: string) => p === "C:\\custom\\claude.exe"
  assert.equal(
    resolveClaudeExecutable({ CLAUDE_CLI_PATH: "C:\\custom\\claude.exe" }, "win32", exists, "C:\\Users\\a"),
    "C:\\custom\\claude.exe"
  )
  assert.equal(
    resolveClaudeExecutable({ CLAUDE_CLI_PATH: "C:\\nope.exe" }, "win32", () => false, "C:\\Users\\a"),
    "claude"
  )
})

test("resolveClaudeExecutable: finds default install per platform, else bare name", () => {
  const home = path.join("/", "home", "u")
  const target = path.join(home, ".local", "bin", "claude")
  assert.equal(resolveClaudeExecutable({}, "linux", (p) => p === target, home), target)
  assert.equal(
    resolveClaudeExecutable({}, "darwin", (p) => p === "/opt/homebrew/bin/claude", home),
    "/opt/homebrew/bin/claude"
  )
  assert.equal(resolveClaudeExecutable({}, "linux", () => false, home), "claude")
})

test("buildClaudeArgs: prompt is never in argv; dirs deduped; read-only tools", () => {
  const a = path.join("/", "a", "x.png")
  const a2 = path.join("/", "a", "y.png")
  const b = path.join("/", "b", "z.png")
  const args = buildClaudeArgs("sonnet", [a, a2, b])
  assert.equal(args[0], "-p")
  assert.ok(args.includes("--no-session-persistence"))
  assert.equal(args[args.indexOf("--tools") + 1], "Read")
  assert.equal(args[args.indexOf("--model") + 1], "sonnet")
  const dirs = args.filter((_, i) => args[i - 1] === "--add-dir")
  assert.deepEqual(dirs.sort(), [path.dirname(a), path.dirname(b)].sort())
  // --add-dir is variadic: only directories may follow the first one.
  const firstDir = args.indexOf("--add-dir")
  assert.ok(args.slice(firstDir).every((x, i) => (i % 2 === 0 ? x === "--add-dir" : true)))
})

test("buildClaudeArgs: no images -> no --add-dir", () => {
  assert.ok(!buildClaudeArgs("haiku", []).includes("--add-dir"))
})

test("prepareSpawn: .cmd needs a shell with quoting on Windows only", () => {
  const plain = prepareSpawn("C:\\x\\claude.exe", ["-p", "a b"], "win32")
  assert.deepEqual(plain, { command: "C:\\x\\claude.exe", args: ["-p", "a b"], shell: false })

  const cmd = prepareSpawn("C:\\Program Files\\n\\claude.cmd", ["-p", "C:\\my dir"], "win32")
  assert.equal(cmd.shell, true)
  assert.equal(cmd.command, '"C:\\Program Files\\n\\claude.cmd"')
  assert.deepEqual(cmd.args, ["-p", '"C:\\my dir"'])

  assert.equal(prepareSpawn("/usr/bin/claude.cmd", ["-p"], "linux").shell, false)
})

test("parseCliOutput: success, is_error, and garbage", () => {
  assert.deepEqual(parseCliOutput(JSON.stringify({ result: "hi", is_error: false })), { text: "hi" })
  assert.match(parseCliOutput(JSON.stringify({ result: "Please run /login", is_error: true })).error!, /login/)
  assert.match(parseCliOutput("not json").error!, /Failed to parse/)
  assert.match(parseCliOutput(JSON.stringify({ foo: 1 })).error!, /error response/)
})

// ---------- end-to-end against a fake CLI (real spawn + real stdin) ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"))
const fakeJs = path.resolve(__dirname, "fixtures", "fake-claude.js")
let executable: string
if (process.platform === "win32") {
  // A .cmd shim with a space in its path, like npm's `claude.cmd` — also covers prepareSpawn.
  executable = path.join(tmp, "claude fake.cmd")
  fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`)
} else {
  executable = path.join(tmp, "claude")
  fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 })
}

const IMG_DIR = path.join(tmp, "shots dir")
const PROMPT = 'line1\n--add-dir /etc "quoted" & | > unicode: \u00fc\u00f1\u00ee'

function run(
  mode: string,
  extra: Record<string, string> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const log = path.join(tmp, `log-${mode}-${Math.random().toString(36).slice(2)}.json`)
  const p = runClaudeCli({
    prompt: PROMPT,
    imagePaths: [path.join(IMG_DIR, "1.png")],
    model: "haiku",
    signal: opts.signal ?? new AbortController().signal,
    executable,
    timeoutMs: opts.timeoutMs ?? 20_000,
    env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log, ...extra }
  })
  return { p, log }
}

test("runClaudeCli: delivers the prompt over stdin verbatim and parses the reply", async () => {
  const { p, log } = run("ok", { FAKE_REPLY: "hello" })
  assert.deepEqual(await p, { text: "hello" })
  const seen = JSON.parse(fs.readFileSync(log, "utf8"))
  assert.equal(seen.stdin, PROMPT)
  assert.ok(!seen.argv.join(" ").includes("line1"), "prompt must not leak into argv")
  assert.ok(seen.argv.includes(IMG_DIR), "dir with a space survives as ONE argument")
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(os.tmpdir()))
})

test("runClaudeCli: non-zero exit surfaces stderr tail", async () => {
  const r = await run("exit2").p
  assert.match(r.error!, /exited with code 2/)
  assert.match(r.error!, /something broke/)
})

test("runClaudeCli: is_error JSON becomes an error with the CLI message", async () => {
  assert.match((await run("is-error").p).error!, /Please run \/login/)
})

test("runClaudeCli: garbage stdout is a parse error, not a crash", async () => {
  assert.match((await run("garbage").p).error!, /Failed to parse/)
})

test("runClaudeCli: child that exits without reading stdin does not crash (EPIPE)", async () => {
  const r = await runClaudeCli({
    prompt: "x".repeat(2_000_000),
    imagePaths: [],
    model: "haiku",
    signal: new AbortController().signal,
    executable,
    env: { ...process.env, FAKE_MODE: "early-exit" }
  })
  assert.match(r.error!, /exited with code 1/)
  assert.match(r.error!, /not logged in/)
})

test("runClaudeCli: hung CLI is killed on timeout", async () => {
  const t0 = Date.now()
  const r = await run("hang", {}, { timeoutMs: 800 }).p
  assert.match(r.error!, /timed out/)
  assert.ok(Date.now() - t0 < 10_000)
})

test("runClaudeCli: abort signal cancels a running CLI", async () => {
  const ac = new AbortController()
  const { p } = run("hang", {}, { signal: ac.signal })
  setTimeout(() => ac.abort(), 400)
  assert.match((await p).error!, /canceled/)
})

test("runClaudeCli: already-aborted signal never spawns", async () => {
  const ac = new AbortController()
  ac.abort()
  assert.match((await run("ok", {}, { signal: ac.signal }).p).error!, /canceled/)
})

test("runClaudeCli: missing executable gives an actionable message", async () => {
  const r = await runClaudeCli({
    prompt: "x",
    imagePaths: [],
    model: "haiku",
    signal: new AbortController().signal,
    executable: path.join(tmp, "does-not-exist.exe")
  })
  assert.match(r.error!, /not found|Failed to spawn/)
})

test("study flow: fake CLI reply -> parseStudyResult", async () => {
  const reply = JSON.stringify({
    question: "q", question_type: "technical_theory", options: [], answer: "TCP",
    confidence: "high", reasoning: ["because"], why_not_others: [], key_concepts: ["OSI"], study_tip: "t"
  })
  const { p, log } = run("ok", { FAKE_REPLY: "```json\n" + reply + "\n```" })
  const r = await p
  assert.equal(parseStudyResult(r.text!).answer, "TCP")
  assert.equal(JSON.parse(fs.readFileSync(log, "utf8")).stdin, PROMPT)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ---------- live test against the REAL Claude Code CLI (opt-in) ----------
// CLAUDE_LIVE=1 npm test            -> ping
// CLAUDE_LIVE_IMAGE=<png> as well   -> full study-mode flow on that screenshot

const live = process.env.CLAUDE_LIVE ? {} : { skip: "set CLAUDE_LIVE=1 to run against the real CLI" }

test("LIVE: real claude CLI answers a ping through runClaudeCli", live, async () => {
  const r = await runClaudeCli({
    prompt: "Reply with exactly the word OK and nothing else.",
    imagePaths: [],
    model: "haiku",
    signal: new AbortController().signal,
    timeoutMs: 90_000
  })
  assert.equal(r.error, undefined)
  assert.match(r.text!, /OK/)
})

const liveImg = process.env.CLAUDE_LIVE_IMAGE
test(
  "LIVE: study mode on a real screenshot",
  liveImg && fs.existsSync(liveImg) ? {} : { skip: "set CLAUDE_LIVE_IMAGE=<png>" },
  async () => {
    const r = await runClaudeCli({
      prompt: buildStudyPrompt([liveImg!], "python"),
      imagePaths: [liveImg!],
      model: process.env.CLAUDE_LIVE_MODEL || "sonnet",
      signal: new AbortController().signal,
      timeoutMs: 240_000
    })
    assert.equal(r.error, undefined)
    const s = parseStudyResult(r.text!)
    console.log("LIVE STUDY RESULT:", JSON.stringify(s, null, 2))
    assert.ok(s.answer.length > 0)
    assert.ok(s.reasoning.length > 0)
  }
)
