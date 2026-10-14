import {
  AnalyzerUnavailable,
  GateTimeoutError,
  TransientError,
  type Analyzer,
  type GateContext,
  type ParsedInput,
  type SentimentReading,
} from "./types.js";

// ---------- Validation ----------

export function validateReading(r: SentimentReading | null | undefined): r is SentimentReading {
  if (!r) return false;
  const nums = [r.valence, r.arousal, r.confidence, r.posMass, r.negMass, r.sarcasmProb];
  if (nums.some((n) => typeof n !== "number" || Number.isNaN(n))) return false;
  return (
    r.valence >= -1 && r.valence <= 1 &&
    r.arousal >= 0 && r.arousal <= 1 &&
    r.confidence >= 0 && r.confidence <= 1
  );
}

// ---------- Retry / timeout helpers ----------

export const backoffMs = (attempt: number): number => [50, 150, 450][attempt] ?? 450;

export async function callWithRetry(
  analyzer: Analyzer,
  parsed: ParsedInput,
  ctx: GateContext,
): Promise<SentimentReading> {
  const { maxRetries } = ctx.config;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await analyzer.score(parsed);
    } catch (e) {
      if (!(e instanceof TransientError)) throw e;
      if (attempt < maxRetries) await ctx.services.sleep(backoffMs(attempt));
    }
  }
  throw new AnalyzerUnavailable(analyzer.id);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new GateTimeoutError("deadline exceeded"));
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new GateTimeoutError("analyzer timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Ensemble ----------

export async function runAnalyzers(parsed: ParsedInput, ctx: GateContext): Promise<SentimentReading[]> {
  const analyzers = ctx.services.analyzers.filter((a) => a.supports(parsed.lang.code));
  if (analyzers.length === 0) {
    throw new AnalyzerUnavailable("none", `no analyzer for language ${parsed.lang.code}`);
  }

  const deadline = ctx.services.nowMs() + ctx.config.timeoutMs;
  // Start all analyzers in parallel; swallow rejections here so we can inspect each one below.
  const settled = analyzers.map((a) =>
    callWithRetry(a, parsed, ctx).then(
      (value) => ({ ok: true as const, value, id: a.id }),
      (error: unknown) => ({ ok: false as const, error, id: a.id }),
    ),
  );

  const readings: SentimentReading[] = [];
  let sawTimeout = false;
  let lastUnavailable: AnalyzerUnavailable | null = null;

  for (const s of settled) {
    const remaining = deadline - ctx.services.nowMs();
    try {
      const out = await withTimeout(s, remaining);
      if (out.ok) {
        if (validateReading(out.value)) readings.push(out.value);
        else ctx.services.logWarn?.("invalid reading", out.id);
      } else if (out.error instanceof AnalyzerUnavailable) {
        lastUnavailable = out.error;
      } else {
        ctx.services.logWarn?.("analyzer error", { id: out.id, error: out.error });
      }
    } catch (e) {
      if (e instanceof GateTimeoutError) sawTimeout = true;
      else throw e;
    }
  }

  if (readings.length === 0) {
    if (lastUnavailable && !sawTimeout) throw lastUnavailable;
    throw new GateTimeoutError("no valid readings before deadline");
  }
  return readings;
}

// ---------- Reconciliation ----------

function mergeEmotionMaps(readings: SentimentReading[], weights: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  readings.forEach((r, i) => {
    for (const [k, v] of Object.entries(r.emotions)) out[k] = (out[k] ?? 0) + (weights[i] ?? 0) * v;
  });
  return out;
}

export function reconcileReadings(readings: SentimentReading[]): SentimentReading {
  if (readings.length === 0) throw new Error("reconcileReadings requires at least one reading");
  if (readings.length === 1) return { ...(readings[0] as SentimentReading), disagreement: 0 };

  const wTotal = readings.reduce((s, r) => s + r.confidence, 0);
  const weights =
    wTotal === 0
      ? readings.map(() => 1 / readings.length)
      : readings.map((r) => r.confidence / wTotal);

  const wsum = (f: (r: SentimentReading) => number) =>
    readings.reduce((s, r, i) => s + (weights[i] ?? 0) * f(r), 0);

  const valences = readings.map((r) => r.valence);
  const spread = Math.max(...valences) - Math.min(...valences);
  const baseConf = readings.reduce((s, r) => s + r.confidence, 0) / readings.length;

  return {
    valence: wsum((r) => r.valence),
    arousal: wsum((r) => r.arousal),
    posMass: wsum((r) => r.posMass),
    negMass: wsum((r) => r.negMass),
    sarcasmProb: Math.max(...readings.map((r) => r.sarcasmProb)), // conservative
    emotions: mergeEmotionMaps(readings, weights),
    confidence: baseConf * (1 - Math.min(1, spread / 2)),
    disagreement: spread,
    language: (readings[0] as SentimentReading).language,
    source: "ensemble",
  };
}
