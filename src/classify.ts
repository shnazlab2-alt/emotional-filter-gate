import type { GateContext, ParsedInput, SentimentReading, ValenceState } from "./types.js";

export function classifyValenceState(
  reading: SentimentReading,
  parsed: ParsedInput,
  ctx: GateContext,
): { state: ValenceState; reasons: string[] } {
  const T = ctx.config.thresholds;
  const reasons: string[] = [];

  if (parsed.lang.confidence < 0.5 || !ctx.config.supportedLanguages.includes(parsed.lang.code)) {
    return { state: "UNSUPPORTED", reasons: ["LANG_UNSUPPORTED"] };
  }

  if (reading.confidence < T.CONFIDENCE_MIN) {
    return { state: "UNCERTAIN", reasons: ["LOW_CONFIDENCE"] };
  }

  if ((reading.disagreement ?? 0) > T.AMBIGUITY_SPREAD) {
    return { state: "UNCERTAIN", reasons: ["ANALYZER_DISAGREEMENT"] };
  }

  if (
    reading.sarcasmProb > 0.6 ||
    (parsed.sarcasmCues.length >= 2 && reading.valence > 0.2)
  ) {
    return { state: "SARCASTIC", reasons: ["SARCASM_SUSPECTED"] };
  }

  if (reading.posMass >= T.MIXED_POLE_MIN && reading.negMass >= T.MIXED_POLE_MIN) {
    return { state: "MIXED", reasons: ["MIXED_POLES"] };
  }

  if (Math.abs(reading.valence) < T.NEUTRAL_BAND) return { state: "NEUTRAL", reasons };
  if (reading.valence > 0) return { state: "POSITIVE", reasons };
  return { state: "NEGATIVE", reasons };
}
