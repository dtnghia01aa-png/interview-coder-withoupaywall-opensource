import React, { useState } from "react"
import type { StudyResult } from "../../types/electron"

interface StudyPanelProps {
  loading: boolean
  result: StudyResult | null
  error: string | null
  onClose: () => void
}

const TYPE_LABELS: Record<string, string> = {
  iq_logic: "IQ / Logic",
  math: "Math",
  multiple_choice: "Multiple choice",
  technical_theory: "Technical theory",
  open_ended: "Open-ended",
  other: "Question"
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children
}) => (
  <div className="space-y-1">
    <h4 className="text-[11px] font-semibold text-white/60 uppercase tracking-wide">
      {title}
    </h4>
    {children}
  </div>
)

const List: React.FC<{ items: string[]; ordered?: boolean }> = ({
  items,
  ordered
}) => {
  const Tag = ordered ? "ol" : "ul"
  return (
    <Tag
      className={`pl-4 space-y-1 text-[12px] leading-snug text-white/85 ${
        ordered ? "list-decimal" : "list-disc"
      }`}
    >
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Tag>
  )
}

const StudyPanel: React.FC<StudyPanelProps> = ({
  loading,
  result,
  error,
  onClose
}) => {
  // Learning aid: the answer stays hidden until the learner commits to a guess.
  const [revealed, setRevealed] = useState(false)
  React.useEffect(() => setRevealed(false), [result])

  return (
    <div
      data-testid="study-panel"
      className="w-[460px] max-h-[420px] overflow-y-auto text-white/90 backdrop-blur-md bg-black/70 rounded-lg border border-white/10 p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">
          Study mode
          {result && (
            <span className="ml-2 text-white/50">
              {TYPE_LABELS[result.question_type] ?? "Question"}
            </span>
          )}
        </h3>
        <button
          onClick={onClose}
          className="text-white/50 hover:text-white text-xs px-1"
          aria-label="Close study panel"
        >
          ✕
        </button>
      </div>

      {loading && (
        <p className="text-[12px] text-white/70 animate-pulse">
          Analyzing the question…
        </p>
      )}

      {error && !loading && (
        <p className="text-[12px] text-red-300 whitespace-pre-wrap">{error}</p>
      )}

      {result && !loading && (
        <>
          {result.question && (
            <Section title="Question">
              <p className="text-[12px] leading-snug text-white/85">
                {result.question}
              </p>
            </Section>
          )}

          {result.options.length > 0 && (
            <Section title="Options">
              <List items={result.options} />
            </Section>
          )}

          {!revealed ? (
            <div className="space-y-1">
              <p className="text-[11px] text-white/50">
                Try it yourself first, then check your reasoning.
              </p>
              <button
                onClick={() => setRevealed(true)}
                className="bg-white/10 hover:bg-white/20 rounded-md px-3 py-1.5 text-[11px]"
              >
                Reveal answer &amp; explanation
              </button>
            </div>
          ) : (
            <>
              <Section title={`Answer (${result.confidence} confidence)`}>
                <p className="text-[13px] font-semibold text-emerald-300">
                  {result.answer}
                </p>
              </Section>
              {result.reasoning.length > 0 && (
                <Section title="Why">
                  <List items={result.reasoning} ordered />
                </Section>
              )}
              {result.why_not_others.length > 0 && (
                <Section title="Why not the others">
                  <List items={result.why_not_others} />
                </Section>
              )}
              {result.key_concepts.length > 0 && (
                <Section title="Concepts to review">
                  <div className="flex flex-wrap gap-1">
                    {result.key_concepts.map((c, i) => (
                      <span
                        key={i}
                        className="bg-white/10 rounded px-1.5 py-0.5 text-[11px]"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </Section>
              )}
              {result.study_tip && (
                <Section title="Tip">
                  <p className="text-[12px] text-white/80">{result.study_tip}</p>
                </Section>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

export default StudyPanel
