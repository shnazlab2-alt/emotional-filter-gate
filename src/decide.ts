import { reconcileReadings, runAnalyzers } from "./analyze.js";
import { classifyValenceState } from "./classify.js";
import type {
  AmbiguousState,
  Decision,
  GateContext,
  ParsedInput,
  SentimentReading,
  ValenceState,
} from "./types.js";

export interface Outcome {
  decision: Decision;
  reasons: string[];
}

// ---------- Crisis detection ----------

export function containsCrisisSignal(reading: SentimentReading): boolean {
  const e = reading.emotions;
  return (
    (e["despair"] ?? 0) > 0.6 ||
    ((e["fear"] ?? 0) > 0.8 && reading.valence < -0.85) ||
    (e["self_harm_intent"] ?? 0) > 0.3 // intentionally low threshold
  );
}

// ---------- Threshold evaluation (clear states) ----------

export function evaluateThresholds(reading: SentimentReading, ctx: GateContext): Outcome {
  const T = ctx.config.thresholds;
  const v = reading.valence;
  const a = reading.arousal;
  const reasons: string[] = [];

  if (v <= T.NEG_HARD_BLOCK) {
    reasons.push("NEG_HARD_BLOCK");
    if (containsCrisisSignal(reading)) {
      reasons.push("CRISIS_SIGNAL");
      return { decision: "REDIRECT", reasons };
    }
    return { decision: "BLOCK", reasons };
  }

  // Crisis markers matter even when valence alone is not extreme.
  if (containsCrisisSignal(reading)) {
    return { decision: "REDIRECT", reasons: ["CRISIS_SIGNAL"] };
  }

  if (v <= T.NEG_SOFT_FLAG && a >= T.AROUSAL_HIGH) {
    return { decision: "HOLD_FOR_REVIEW", reasons: ["NEG_HIGH_AROUSAL"] };
  }
  if (v <= T.NEG_SOFT_FLAG) {
    return { decision: "PASS_WITH_FLAG", reasons: ["NEG_SOFT_FLAG"] };
  }
  if (v >= T.POS_MANIA_CAP && a >= T.AROUSAL_HIGH) {
    return { decision: "PASS_WITH_FLAG", reasons: ["POS_EXTREME_HIGH_AROUSAL"] };
  }
  if (v >= T.POS_SOFT_FLAG) {
    return { decision: "PASS", reasons: ["POS_NOTED"] };
  }
  return { decision: "PASS", reasons: ["WITHIN_BAND"] };
}

// ---------- Ambiguous-state resolution ----------

async function analyzeSegments(parsed: ParsedInput, ctx: GateContext): Promise<SentimentReading[]> {
  const out: SentimentReading[] = [];
  for (const seg of parsed.segments) {
    const segParsed: ParsedInput = { ...parsed, text: seg, segments: [seg] };
    out.push(reconcileReadings(await runAnalyzers(segParsed, ctx)));
  }
  return out;
}

const DEFAULT_EMOJI_VALENCE: Record<string, number> = {
  "\u{1F621}": -0.9, "\u{1F620}": -0.8, "\u{1F622}": -0.6, "\u{1F62D}": -0.7,
  "\u{1F92C}": -0.9, "\u{1F494}": -0.7, "\u{1F600}": 0.7, "\u{1F60A}": 0.7, "\u2764\uFE0F": 0.8,
};

export function emojiValence(emoji: string[]): number {
  if (emoji.length === 0) return 0;
  return emoji.reduce((s, e) => s + (DEFAULT_EMOJI_VALENCE[e] ?? 0), 0) / emoji.length;
}

export async function resolveAmbiguousState(
  state: AmbiguousState,
  reading: SentimentReading,
  parsed: ParsedInput,
  ctx: GateContext,
): Promise<Outcome> {
  const T = ctx.config.thresholds;

  switch (state) {
    case "MIXED": {
      // Evaluate per segment so one negative sentence is not diluted.
      const segs = await analyzeSegments(parsed, ctx);
      const worst = segs.length ? segs.reduce((m, r) => (r.valence < m.valence ? r : m)) : reading;
      if (worst.valence <= T.NEG_HARD_BLOCK)
        return { decision: "HOLD_FOR_REVIEW", reasons: ["MIXED_WORST_SEGMENT_SEVERE"] };
      if (worst.valence <= T.NEG_SOFT_FLAG)
        return { decision: "PASS_WITH_FLAG", reasons: ["MIXED_WORST_SEGMENT_NEG"] };
      return { decision: "PASS", reasons: ["MIXED_BENIGN"] };
    }

    case "SARCASTIC": {
      // Invert provisionally but damp it; never trust the inversion fully.
      const inverted = reading.valence * -1 * 0.7;
      const reasons = ["SARCASM_INVERTED_DAMPED"];
      if (inverted <= T.NEG_SOFT_FLAG) return { decision: "HOLD_FOR_REVIEW", reasons };
      return { decision: "PASS_WITH_FLAG", reasons };
    }

    case "UNCERTAIN": {
      const prior = parsed.meta.priorValence;
      if (prior !== null && prior <= T.NEG_SOFT_FLAG && reading.valence <= 0) {
        return { decision: "HOLD_FOR_REVIEW", reasons: ["UNCERTAIN_NEGATIVE_HISTORY"] };
      }

      const { deepAnalyzer, deepBudgetAllows } = ctx.services;
      if (deepAnalyzer && (deepBudgetAllows?.() ?? true) && !ctx.flags.deepDone) {
        ctx.flags.deepDone = true;
        try {
          const deep = await deepAnalyzer.score(parsed);
          if (deep.confidence >= T.CONFIDENCE_MIN) {
            const { state: newState } = classifyValenceState(deep, parsed, ctx);
            if (newState !== "UNCERTAIN" && newState !== "UNSUPPORTED") {
              const o = evaluateThresholds(deep, ctx);
              return { decision: o.decision, reasons: ["DEEP_ANALYZER_RESOLVED", ...o.reasons] };
            }
          }
        } catch (e) {
          ctx.services.logWarn?.("deep analyzer failed", e);
        }
      }
      return { decision: ctx.config.uncertainDefault, reasons: ["UNCERTAIN_UNRESOLVED"] };
    }

    case "UNSUPPORTED": {
      const reasons = ["UNSUPPORTED_LANG_OR_FORMAT"];
      if (parsed.emojiSet.length > 0) {
        const coarse = (ctx.services.emojiValence ?? emojiValence)(parsed.emojiSet);
        if (coarse <= -0.6) return { decision: "HOLD_FOR_REVIEW", reasons };
      }
      return { decision: ctx.config.strict ? "HOLD_FOR_REVIEW" : "PASS_WITH_FLAG", reasons };
    }
  }
}

// ---------- Overrides ----------

export function applyOverrides(
  decision: Decision,
  reasons: string[],
  reading: SentimentReading,
  ctx: GateContext,
): Outcome {
  const out = [...reasons];
  let d = decision;

  if (ctx.channel && ctx.config.venting_channels.includes(ctx.channel) && d === "BLOCK" && !out.includes("CRISIS_SIGNAL")) {
    out.push("OVERRIDE_VENTING_CHANNEL");
    d = "HOLD_FOR_REVIEW";
  }

  if ((ctx.sender?.trustLevel ?? 0) >= 3 && d === "HOLD_FOR_REVIEW" && reading.valence > -0.7) {
    out.push("OVERRIDE_TRUSTED_SENDER");
    d = "PASS_WITH_FLAG";
  }

  if (d === "PASS_WITH_FLAG" && ctx.services.countRecentFlags(ctx.userId, "1h") >= 3) {
    out.push("ESCALATE_REPEAT_PATTERN");
    d = "HOLD_FOR_REVIEW";
  }

  // Hard rule: crisis redirect is never downgraded.
  if (out.includes("CRISIS_SIGNAL")) d = "REDIRECT";

  return { decision: d, reasons: out };
}

export function isAmbiguous(s: ValenceState): s is AmbiguousState {
  return s === "MIXED" || s === "SARCASTIC" || s === "UNCERTAIN" || s === "UNSUPPORTED";
}
