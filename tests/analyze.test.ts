import { describe, expect, it, vi } from "vitest";
import { callWithRetry, reconcileReadings, runAnalyzers, validateReading } from "../src/analyze.js";
import { AnalyzerUnavailable, GateTimeoutError, TransientError } from "../src/types.js";
import { fakeAnalyzer, harness, parsed, reading } from "./helpers.js";

describe("validateReading", () => {
  it("accepts a valid reading", () => expect(validateReading(reading())).toBe(true));
  it.each([
    ["null", null],
    ["valence > 1", reading({ valence: 1.2 })],
    ["negative arousal", reading({ arousal: -0.1 })],
    ["confidence > 1", reading({ confidence: 2 })],
    ["NaN valence", reading({ valence: NaN })],
  ])("rejects %s", (_n, r) => expect(validateReading(r)).toBe(false));
});

describe("reconcileReadings", () => {
  it("returns single reading with zero disagreement", () => {
    expect(reconcileReadings([reading({ valence: 0.4 })])).toMatchObject({ valence: 0.4, disagreement: 0 });
  });

  it("throws on empty input", () => expect(() => reconcileReadings([])).toThrow());

  it("weights by confidence", () => {
    const m = reconcileReadings([
      reading({ valence: 1, confidence: 0.9 }),
      reading({ valence: -1, confidence: 0.1 }),
    ]);
    expect(m.valence).toBeCloseTo(0.8);
  });

  it("falls back to uniform weights if all confidences are zero", () => {
    const m = reconcileReadings([
      reading({ valence: 0.2, confidence: 0 }),
      reading({ valence: 0.4, confidence: 0 }),
    ]);
    expect(m.valence).toBeCloseTo(0.3);
  });

  it("penalizes confidence by spread and records disagreement", () => {
    const m = reconcileReadings([
      reading({ valence: 0.8, confidence: 0.8 }),
      reading({ valence: -0.2, confidence: 0.8 }),
    ]);
    expect(m.disagreement).toBeCloseTo(1.0);
    expect(m.confidence).toBeCloseTo(0.8 * (1 - 0.5));
  });

  it("takes max sarcasm probability and merges emotions", () => {
    const m = reconcileReadings([
      reading({ sarcasmProb: 0.2, confidence: 0.5, emotions: { anger: 0.8 } }),
      reading({ sarcasmProb: 0.7, confidence: 0.5, emotions: { anger: 0.4, joy: 0.2 } }),
    ]);
    expect(m.sarcasmProb).toBe(0.7);
    expect(m.emotions["anger"]).toBeCloseTo(0.6);
    expect(m.emotions["joy"]).toBeCloseTo(0.1);
  });
});

describe("callWithRetry", () => {
  it("retries transient errors with backoff and then succeeds", async () => {
    const { ctx, services } = harness();
    let n = 0;
    const a = fakeAnalyzer("flaky", () => {
      if (++n < 3) throw new TransientError("blip");
      return reading({ valence: 0.1 });
    });
    const r = await callWithRetry(a, parsed(), ctx);
    expect(r.valence).toBe(0.1);
    expect(a.score).toHaveBeenCalledTimes(3);
    expect(services.sleep).toHaveBeenNthCalledWith(1, 50);
    expect(services.sleep).toHaveBeenNthCalledWith(2, 150);
  });

  it("throws AnalyzerUnavailable after exhausting retries", async () => {
    const { ctx } = harness();
    const a = fakeAnalyzer("down", new TransientError("x"));
    await expect(callWithRetry(a, parsed(), ctx)).rejects.toBeInstanceOf(AnalyzerUnavailable);
    expect(a.score).toHaveBeenCalledTimes(ctx.config.maxRetries + 1);
  });

  it("does not retry non-transient errors", async () => {
    const { ctx } = harness();
    const a = fakeAnalyzer("bad", new Error("boom"));
    await expect(callWithRetry(a, parsed(), ctx)).rejects.toThrow("boom");
    expect(a.score).toHaveBeenCalledTimes(1);
  });
});

describe("runAnalyzers", () => {
  it("collects valid readings and drops invalid ones", async () => {
    const h = harness({
      analyzers: [fakeAnalyzer("ok", reading({ valence: 0.2 })), fakeAnalyzer("bad", reading({ valence: 5 }))],
    });
    const out = await runAnalyzers(parsed(), h.ctx);
    expect(out).toHaveLength(1);
    expect(h.services.logWarn).toHaveBeenCalled();
  });

  it("throws AnalyzerUnavailable when no analyzer supports the language", async () => {
    const a = fakeAnalyzer("en-only", reading());
    a.supports = (l: string) => l === "en";
    const h = harness({ analyzers: [a] });
    await expect(runAnalyzers(parsed({ lang: { code: "ja", confidence: 0.9 } }), h.ctx)).rejects.toBeInstanceOf(
      AnalyzerUnavailable,
    );
  });

  it("throws GateTimeoutError when every analyzer hangs", async () => {
    vi.useFakeTimers();
    try {
      const hang = fakeAnalyzer("slow", () => new Promise<never>(() => {}));
      // real clock for nowMs so the deadline actually elapses under fake timers
      const h = harness({ analyzers: [hang], config: { timeoutMs: 100 } });
      h.services.nowMs = () => Date.now();
      const p = runAnalyzers(parsed(), h.ctx);
      const assertion = expect(p).rejects.toBeInstanceOf(GateTimeoutError);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps fast readings when a slow analyzer times out", async () => {
    vi.useFakeTimers();
    try {
      const fast = fakeAnalyzer("fast", reading({ valence: 0.3 }));
      const slow = fakeAnalyzer("slow", () => new Promise<never>(() => {}));
      const h = harness({ analyzers: [fast, slow], config: { timeoutMs: 100 } });
      h.services.nowMs = () => Date.now();
      const p = runAnalyzers(parsed(), h.ctx);
      await vi.advanceTimersByTimeAsync(150);
      const out = await p;
      expect(out.map((r) => r.valence)).toEqual([0.3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces AnalyzerUnavailable when all analyzers are down (no timeout)", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("d", new TransientError("x"))] });
    await expect(runAnalyzers(parsed(), h.ctx)).rejects.toBeInstanceOf(AnalyzerUnavailable);
  });
});
