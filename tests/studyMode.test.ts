import test from "node:test"
import assert from "node:assert/strict"
import { buildStudyPrompt, parseLooseJson, parseStudyResult } from "../electron/studyMode"

test("buildStudyPrompt: CLI mode lists paths; API mode does not", () => {
  const cli = buildStudyPrompt(["C:\\a\\1.png", "C:\\a\\2.png"], "python")
  assert.match(cli, /Read tool/)
  assert.ok(cli.includes("- C:\\a\\1.png\n- C:\\a\\2.png"))
  const api = buildStudyPrompt(null, "python")
  assert.match(api, /attached screenshot/)
  assert.doesNotMatch(api, /Read tool/)
  for (const f of ["question_type", "reasoning", "why_not_others", "key_concepts", "study_tip"]) {
    assert.ok(cli.includes(f), f)
  }
})

const good = {
  question: "Which figure replaces the question mark?",
  question_type: "iq_logic",
  options: ["a. two dots", "d. 12 dots"],
  answer: "d",
  confidence: "high",
  reasoning: ["Left scale balances", "Right scale doubles"],
  why_not_others: ["a is too few"],
  key_concepts: ["balance equations"],
  study_tip: "Assign values to symbols."
}

test("parseStudyResult: clean JSON round-trips", () => {
  assert.deepEqual(parseStudyResult(JSON.stringify(good)), good)
})

test("parseStudyResult: tolerates fences and surrounding prose", () => {
  const wrapped = "Sure! Here you go:\n```json\n" + JSON.stringify(good) + "\n```\nHope that helps."
  assert.equal(parseStudyResult(wrapped).answer, "d")
})

test("parseStudyResult: normalizes bad/missing fields", () => {
  const r = parseStudyResult(
    JSON.stringify({ answer: "B", question_type: "weird", confidence: "certain", reasoning: "single string", options: null })
  )
  assert.equal(r.question_type, "other")
  assert.equal(r.confidence, "medium")
  assert.deepEqual(r.reasoning, ["single string"])
  assert.deepEqual(r.options, [])
  assert.deepEqual(r.key_concepts, [])
  assert.equal(r.study_tip, "")
})

test("parseStudyResult: rejects empty or non-JSON replies", () => {
  assert.throws(() => parseStudyResult("I can't see an image."), /No JSON/)
  assert.throws(() => parseStudyResult("{}"), /neither an answer nor reasoning/)
  assert.throws(() => parseStudyResult("[1,2]"))
})

test("parseLooseJson: picks the outermost object", () => {
  assert.deepEqual(parseLooseJson('noise {"a":{"b":1}} trailing'), { a: { b: 1 } })
})
