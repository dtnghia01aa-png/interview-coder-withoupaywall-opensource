// studyMode.ts
// "Study mode": explain theory / aptitude / technical-concept questions from
// screenshots for learning and review. Pure functions only (no Electron).

export type StudyQuestionType =
  | "iq_logic"
  | "math"
  | "multiple_choice"
  | "technical_theory"
  | "open_ended"
  | "other"

export interface StudyResult {
  question: string
  question_type: StudyQuestionType
  options: string[]
  /** The recommended answer, e.g. "d" or a short statement. */
  answer: string
  confidence: "high" | "medium" | "low"
  /** Step-by-step reasoning that leads to the answer. */
  reasoning: string[]
  /** For multiple choice: why each remaining option is wrong. */
  why_not_others: string[]
  /** Concepts worth reviewing to master this question type. */
  key_concepts: string[]
  /** A transferable tip/heuristic for similar questions. */
  study_tip: string
}

const QUESTION_TYPES: StudyQuestionType[] = [
  "iq_logic", "math", "multiple_choice", "technical_theory", "open_ended", "other"
]

/**
 * @param imagePaths absolute screenshot paths for CLI mode (the model Reads
 *   them), or null when the images are attached inline (API providers).
 */
export function buildStudyPrompt(imagePaths: string[] | null, language: string): string {
  const where = imagePaths
    ? `The question is in the screenshot(s) saved at these absolute file paths — use the Read tool to view each one:\n${imagePaths.map((p) => `- ${p}`).join("\n")}`
    : "The question is in the attached screenshot(s)."
  return `You are a patient tutor helping a learner study and review practice questions (IQ/logic puzzles, aptitude tests, and technical theory questions such as CS fundamentals, networking, databases, OOP, system design, cloud, security).
${where}

Work out the question carefully, and for visual puzzles describe the pattern you observe before concluding. Then return ONLY a JSON object (no prose, no markdown fences) with exactly these fields:
- question (string): the question text, transcribed faithfully
- question_type (string): one of ${QUESTION_TYPES.join(" | ")}
- options (array of strings): the answer options as shown, e.g. "a. ..." (empty array if none; describe image-only options briefly)
- answer (string): the correct option label and/or a concise answer
- confidence (string): high | medium | low
- reasoning (array of strings): clear step-by-step explanation a learner can follow
- why_not_others (array of strings): for multiple choice, one entry per wrong option explaining why it fails (empty array otherwise)
- key_concepts (array of strings): 2-5 concepts to review
- study_tip (string): one reusable heuristic for similar questions

If a code example is useful, use ${language}. Be honest: if the screenshot is unreadable or the question is ambiguous, say so in "reasoning" and set confidence to low.`
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === "string" && v.trim()) return [v.trim()]
  return []
}

/** Lenient JSON extraction: strips fences and leading/trailing prose. */
export function parseLooseJson(text: string): any {
  const cleaned = text.replace(/```json|```/g, "").trim()
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) return JSON.parse(match[0])
  throw new Error("No JSON object found in response")
}

/** Parse + normalize a model reply into a StudyResult; throws if unusable. */
export function parseStudyResult(text: string): StudyResult {
  const raw = parseLooseJson(text)
  if (!raw || typeof raw !== "object") throw new Error("Response is not a JSON object")

  const answer = String(raw.answer ?? "").trim()
  const reasoning = asStringArray(raw.reasoning)
  if (!answer && reasoning.length === 0) {
    throw new Error("Response contained neither an answer nor reasoning")
  }

  const type = QUESTION_TYPES.includes(raw.question_type) ? raw.question_type : "other"
  const confidence = ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "medium"

  return {
    question: String(raw.question ?? "").trim(),
    question_type: type,
    options: asStringArray(raw.options),
    answer: answer || "(no definitive answer)",
    confidence,
    reasoning,
    why_not_others: asStringArray(raw.why_not_others),
    key_concepts: asStringArray(raw.key_concepts),
    study_tip: String(raw.study_tip ?? "").trim()
  }
}
