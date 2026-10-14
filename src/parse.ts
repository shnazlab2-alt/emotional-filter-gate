import type {
  GateContext,
  LanguageGuess,
  ParseResult,
  Payload,
} from "./types.js";

// ---------- Small text helpers (exported for testing) ----------

export function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const ch of text) if (ch === "\uFFFD") n++;
  return n / text.length;
}

export function stripControlChars(text: string): string {
  // keep \n and \t for now; whitespace collapse handles them next
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Truncate at the last sentence boundary within `max` chars (falls back to hard cut). */
export function smartTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const idx = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  return idx > max * 0.5 ? slice.slice(0, idx + 1) : slice;
}

export function extractEmoji(text: string): string[] {
  return text.match(/\p{Extended_Pictographic}/gu) ?? [];
}

export function capsRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  const upper = text.match(/\p{Lu}/gu) ?? [];
  return upper.length / Math.max(1, letters.length);
}

export function punctBurstCount(text: string): number {
  return (text.match(/[!?]{2,}/g) ?? []).length;
}

export function detectQuotedSpans(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|\u201C([^\u201D]+)\u201D/g)].map((m) => (m[1] ?? m[2]) as string);
}

const NEGATION_WORDS = /\b(not|no|never|n't|none|nothing|neither|nor|hardly)\b/i;

export function detectNegationScopes(segments: string[]): string[] {
  return segments.filter((s) => NEGATION_WORDS.test(s));
}

const SARCASM_PATTERNS: RegExp[] = [
  /\byeah,? right\b/i,
  /\boh,? great\b/i,
  /\bthanks a lot\b/i,
  /\bhow wonderful\b/i,
  /\bsure,? because\b/i,
  /\/s\b/i,
  /\bwhat a surprise\b/i,
];

export function detectSarcasmCues(text: string, emoji: string[]): string[] {
  const cues = SARCASM_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
  if (emoji.some((e) => e === "\u{1F643}" || e === "\u{1F644}")) cues.push("sarcasm_emoji");
  return cues;
}

function defaultDetectLanguage(text: string): LanguageGuess {
  // Placeholder: swap in a real detector (cld3, franc, fastText) via services.detectLanguage.
  const nonLatin = (text.match(/[^\u0000-\u024F\s\d\p{P}\p{Extended_Pictographic}]/gu) ?? []).length;
  if (nonLatin / Math.max(1, text.length) > 0.3) return { code: "xx", confidence: 0.3 };
  return { code: "en", confidence: 0.9 };
}

function defaultSplitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

// ---------- Main parser ----------

export function parseInput(payload: Payload | null | undefined, ctx: GateContext): ParseResult {
  if (payload == null || payload.content == null) return { ok: false, error: "EMPTY_PAYLOAD" };

  let text: string;
  const raw = payload.content;
  if (raw instanceof Uint8Array) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    if (replacementRatio(text) > 0.05) return { ok: false, error: "ENCODING_CORRUPT" };
  } else if (typeof raw === "string") {
    text = raw;
  } else {
    return { ok: false, error: "UNSUPPORTED_TYPE" };
  }

  text = text.normalize("NFKC");
  text = stripControlChars(text);
  text = collapseWhitespace(text);
  if (text.length === 0) return { ok: false, error: "EMPTY_AFTER_NORMALIZATION" };

  let truncated = false;
  if (text.length > ctx.config.maxInputChars) {
    text = smartTruncate(text, ctx.config.maxInputChars);
    truncated = true;
  }

  const svc = ctx.services;
  const lang = (svc.detectLanguage ?? defaultDetectLanguage)(text);
  const segments = (svc.splitSentences ?? defaultSplitSentences)(text, lang.code);
  const emojiSet = extractEmoji(text);

  return {
    ok: true,
    value: {
      text,
      segments,
      lang,
      emojiSet,
      capsRatio: capsRatio(text),
      punctBurst: punctBurstCount(text),
      negations: detectNegationScopes(segments),
      quotes: detectQuotedSpans(text),
      sarcasmCues: detectSarcasmCues(text, emojiSet),
      truncated,
      meta: {
        channel: payload.channel,
        userId: payload.userId,
        priorValence: svc.lookupRecentValence(payload.userId, 5),
        threadContext: payload.threadContext,
      },
    },
  };
}
