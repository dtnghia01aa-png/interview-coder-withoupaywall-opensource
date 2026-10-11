// Fake `claude` CLI used by tests. Behaviour is selected via FAKE_MODE and
// everything it saw is dumped to FAKE_LOG so tests can assert on it.
const fs = require("node:fs")
const mode = process.env.FAKE_MODE || "ok"
const log = (extra) =>
  process.env.FAKE_LOG &&
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), ...extra }))

if (mode === "early-exit") {
  // Exit immediately without reading stdin -> parent's stdin write hits EPIPE.
  log({})
  process.stderr.write("boom: not logged in\n")
  process.exit(1)
}
if (mode === "hang") {
  log({})
  setInterval(() => {}, 1000)
} else {
  let stdin = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (c) => (stdin += c))
  process.stdin.on("end", () => {
    log({ stdin })
    if (mode === "exit2") {
      process.stderr.write("something broke\n")
      process.exit(2)
    }
    if (mode === "garbage") {
      process.stdout.write("not json at all")
      return
    }
    if (mode === "is-error") {
      process.stdout.write(JSON.stringify({ is_error: true, result: "Please run /login" }))
      return
    }
    process.stdout.write(
      JSON.stringify({ type: "result", is_error: false, result: process.env.FAKE_REPLY || "pong:" + stdin.length })
    )
  })
}
