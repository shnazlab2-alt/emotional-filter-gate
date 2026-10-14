import { describe, expect, it } from "vitest";
import { classifyValenceState } from "../src/classify.js";
import {
  applyOverrides,
  containsCrisisSignal,
  emojiValence,
  evaluateThresholds,
  resolveAmbiguousState,
} from "../src/decide.js";
import { fakeAnalyzer, harness, parsed, reading } from "./helpers.js";

describe("classifyValenceState", () => {
  const { ctx } = harness();
  const cls = (r = reading(), p = parsed()) => classifyValenceState(r, p, ctx);

  it("UNSUPPORTED for low language confidence", () =>
    expect(cls(reading(), parsed({ lang: { code: "en", confidence: 0.3 } })).state).toBe("UNSUPPORTED"));
  it("UNSUPPORTED for unsupported language code", () =>
    expect(cls(reading(), parsed({ lang: { code: "ja", confidence: 0.9 } })).state).toBe("UNSUPPORTED"));
  it("UNCERTAIN for low confidence", () =>
    expect(cls(reading({ confidence: 0.4 }))).toEqual({ state: "UNCERTAIN", reasons: ["LOW_CONFIDENCE"] }));
  it("UNCERTAIN for analyzer disagreement", () =>
    expect(cls(reading({ disagreement: 0.5 }))).toEqual({
      state: "UNCERTAIN",
      reasons: ["ANALYZER_DISAGREEMENT"],
    }));
  it("SARCASTIC from model probability", () =>
    expect(cls(reading({ sarcasmProb: 0.7 })).state).toBe("SARCASTIC"));
  it("SARCASTIC from two rule cues with positive valence", () =>
    expect(cls(reading({ valence: 0.5 }), parsed({ sarcasmCues: ["a", "b"] })).state).toBe("SARCASTIC"));
  it("two sarcasm cues with negative valence are not sarcastic", () =>
    expect(cls(reading({ valence: -0.5 }), parsed({ sarcasmCues: ["a", "b"] })).state).toBe("NEGATIVE"));
  it("MIXED when both poles are strong", () =>
    expect(cls(reading({ posMass: 0.5, negMass: 0.5 })).state).toBe("MIXED"));
  it("NEUTRAL inside the band", () => expect(cls(reading({ valence: 0.1 })).state).toBe("NEUTRAL"));
  it("POSITIVE", () => expect(cls(reading({ valence: 0.6 })).state).toBe("POSITIVE"));
  it("NEGATIVE", () => expect(cls(reading({ valence: -0.6 })).state).toBe("NEGATIVE"));
  it("respects per-tenant threshold overrides", () => {
    const h = harness({ config: { thresholds: { ...harness().ctx.config.thresholds, NEUTRAL_BAND: 0.7 } } });
    expect(classifyValenceState(reading({ valence: 0.6 }), parsed(), h.ctx).state).toBe("NEUTRAL");
  });
});

describe("containsCrisisSignal", () => {
  it("despair > 0.6", () => expect(containsCrisisSignal(reading({ emotions: { despair: 0.7 } }))).toBe(true));
  it("fear needs very negative valence", () => {
    expect(containsCrisisSignal(reading({ valence: -0.9, emotions: { fear: 0.9 } }))).toBe(true);
    expect(containsCrisisSignal(reading({ valence: -0.5, emotions: { fear: 0.9 } }))).toBe(false);
  });
  it("low self-harm threshold", () =>
    expect(containsCrisisSignal(reading({ emotions: { self_harm_intent: 0.35 } }))).toBe(true));
  it("false for ordinary anger", () => expect(containsCrisisSignal(reading({ emotions: { anger: 0.9 } }))).toBe(false));
});

describe("evaluateThresholds", () => {
  const { ctx } = harness();
  const ev = (o: Parameters<typeof reading>[0]) => evaluateThresholds(reading(o), ctx);

  it("BLOCK at hard-block valence", () =>
    expect(ev({ valence: -0.85 })).toEqual({ decision: "BLOCK", reasons: ["NEG_HARD_BLOCK"] }));
  it("hard-block boundary is inclusive", () => expect(ev({ valence: -0.8 }).decision).toBe("BLOCK"));
  it("REDIRECT for hard-block with crisis signal", () =>
    expect(ev({ valence: -0.9, emotions: { despair: 0.9 } })).toEqual({
      decision: "REDIRECT",
      reasons: ["NEG_HARD_BLOCK", "CRISIS_SIGNAL"],
    }));
  it("REDIRECT for crisis signal even at moderate valence", () =>
    expect(ev({ valence: -0.5, emotions: { self_harm_intent: 0.5 } }).decision).toBe("REDIRECT"));
  it("HOLD for negative + high arousal", () =>
    expect(ev({ valence: -0.5, arousal: 0.8 })).toEqual({
      decision: "HOLD_FOR_REVIEW",
      reasons: ["NEG_HIGH_AROUSAL"],
    }));
  it("PASS_WITH_FLAG for moderate negative", () =>
    expect(ev({ valence: -0.5, arousal: 0.2 })).toEqual({ decision: "PASS_WITH_FLAG", reasons: ["NEG_SOFT_FLAG"] }));
  it("PASS_WITH_FLAG for extreme positive + high arousal", () =>
    expect(ev({ valence: 0.95, arousal: 0.9 }).reasons).toEqual(["POS_EXTREME_HIGH_AROUSAL"]));
  it("PASS for extreme positive with calm arousal", () =>
    expect(ev({ valence: 0.95, arousal: 0.2 })).toEqual({ decision: "PASS", reasons: ["POS_NOTED"] }));
  it("PASS within band", () => expect(ev({ valence: 0.2 })).toEqual({ decision: "PASS", reasons: ["WITHIN_BAND"] }));
});

describe("resolveAmbiguousState", () => {
  describe("MIXED", () => {
    const segs = (vals: number[]) =>
      harness({
        analyzers: [
          fakeAnalyzer("seg", (p) => reading({ valence: vals[Number(p.text.replace(/\D/g, ""))] ?? 0 })),
        ],
      });
    const p = parsed({ segments: ["s0", "s1"] });

    it("HOLD when worst segment is severe", async () => {
      const h = segs([0.8, -0.9]);
      const o = await resolveAmbiguousState("MIXED", reading(), p, h.ctx);
      expect(o).toEqual({ decision: "HOLD_FOR_REVIEW", reasons: ["MIXED_WORST_SEGMENT_SEVERE"] });
    });
    it("PASS_WITH_FLAG when worst segment is moderately negative", async () => {
      const o = await resolveAmbiguousState("MIXED", reading(), p, segs([0.8, -0.5]).ctx);
      expect(o.decision).toBe("PASS_WITH_FLAG");
    });
    it("PASS when all segments are benign", async () => {
      const o = await resolveAmbiguousState("MIXED", reading(), p, segs([0.8, 0.1]).ctx);
      expect(o).toEqual({ decision: "PASS", reasons: ["MIXED_BENIGN"] });
    });
  });

  describe("SARCASTIC", () => {
    const { ctx } = harness();
    it("HOLD when damped inversion is strongly negative", async () => {
      const o = await resolveAmbiguousState("SARCASTIC", reading({ valence: 0.8 }), parsed(), ctx);
      expect(o).toEqual({ decision: "HOLD_FOR_REVIEW", reasons: ["SARCASM_INVERTED_DAMPED"] });
    });
    it("PASS_WITH_FLAG when inversion is mild (0.5 * -0.7 = -0.35)", async () => {
      const o = await resolveAmbiguousState("SARCASTIC", reading({ valence: 0.5 }), parsed(), ctx);
      expect(o.decision).toBe("PASS_WITH_FLAG");
    });
  });

  describe("UNCERTAIN", () => {
    it("HOLD with negative history and non-positive valence", async () => {
      const h = harness();
      const o = await resolveAmbiguousState(
        "UNCERTAIN",
        reading({ valence: -0.1 }),
        parsed({ meta: { priorValence: -0.6 } }),
        h.ctx,
      );
      expect(o.reasons).toEqual(["UNCERTAIN_NEGATIVE_HISTORY"]);
    });

    it("uses the deep analyzer once when budget allows and resolves", async () => {
      const deep = fakeAnalyzer("deep", reading({ valence: -0.9, confidence: 0.95, emotions: { despair: 0.9 } }));
      const h = harness({ deepAnalyzer: deep });
      const o = await resolveAmbiguousState("UNCERTAIN", reading({ confidence: 0.3 }), parsed(), h.ctx);
      expect(o.decision).toBe("REDIRECT");
      expect(o.reasons[0]).toBe("DEEP_ANALYZER_RESOLVED");
      expect(h.ctx.flags.deepDone).toBe(true);

      // second call must not invoke the deep analyzer again
      await resolveAmbiguousState("UNCERTAIN", reading({ confidence: 0.3 }), parsed(), h.ctx);
      expect(deep.score).toHaveBeenCalledTimes(1);
    });

    it("skips deep analyzer when budget disallows", async () => {
      const deep = fakeAnalyzer("deep", reading());
      const h = harness({ deepAnalyzer: deep, deepBudget: false });
      const o = await resolveAmbiguousState("UNCERTAIN", reading({ confidence: 0.3 }), parsed(), h.ctx);
      expect(deep.score).not.toHaveBeenCalled();
      expect(o).toEqual({ decision: "PASS_WITH_FLAG", reasons: ["UNCERTAIN_UNRESOLVED"] });
    });

    it("falls back to default when deep analyzer is also low confidence", async () => {
      const deep = fakeAnalyzer("deep", reading({ confidence: 0.2 }));
      const h = harness({ deepAnalyzer: deep, config: { uncertainDefault: "HOLD_FOR_REVIEW" } });
      const o = await resolveAmbiguousState("UNCERTAIN", reading({ confidence: 0.3 }), parsed(), h.ctx);
      expect(o).toEqual({ decision: "HOLD_FOR_REVIEW", reasons: ["UNCERTAIN_UNRESOLVED"] });
    });

    it("falls back (does not throw) if deep analyzer errors", async () => {
      const h = harness({ deepAnalyzer: fakeAnalyzer("deep", new Error("boom")) });
      const o = await resolveAmbiguousState("UNCERTAIN", reading({ confidence: 0.3 }), parsed(), h.ctx);
      expect(o.reasons).toEqual(["UNCERTAIN_UNRESOLVED"]);
    });
  });

  describe("UNSUPPORTED", () => {
    it("HOLD when emoji are strongly negative", async () => {
      const { ctx } = harness();
      const o = await resolveAmbiguousState("UNSUPPORTED", reading(), parsed({ emojiSet: ["😡", "🤬"] }), ctx);
      expect(o.decision).toBe("HOLD_FOR_REVIEW");
    });
    it("PASS_WITH_FLAG by default", async () => {
      const { ctx } = harness();
      expect((await resolveAmbiguousState("UNSUPPORTED", reading(), parsed(), ctx)).decision).toBe("PASS_WITH_FLAG");
    });
    it("HOLD in strict mode", async () => {
      const { ctx } = harness({ config: { strict: true } });
      expect((await resolveAmbiguousState("UNSUPPORTED", reading(), parsed(), ctx)).decision).toBe("HOLD_FOR_REVIEW");
    });
  });

  it("emojiValence averages known emoji", () => expect(emojiValence(["😡", "😀"])).toBeCloseTo(-0.1));
});

describe("applyOverrides", () => {
  it("venting channel downgrades BLOCK to HOLD", () => {
    const { ctx } = harness({ channel: "vent", config: { venting_channels: ["vent"] } });
    const o = applyOverrides("BLOCK", ["NEG_HARD_BLOCK"], reading({ valence: -0.9 }), ctx);
    expect(o.decision).toBe("HOLD_FOR_REVIEW");
    expect(o.reasons).toContain("OVERRIDE_VENTING_CHANNEL");
  });

  it("venting channel does not downgrade crisis", () => {
    const { ctx } = harness({ channel: "vent", config: { venting_channels: ["vent"] } });
    const o = applyOverrides("REDIRECT", ["NEG_HARD_BLOCK", "CRISIS_SIGNAL"], reading({ valence: -0.9 }), ctx);
    expect(o.decision).toBe("REDIRECT");
  });

  it("trusted sender downgrades HOLD to PASS_WITH_FLAG above -0.7", () => {
    const { ctx } = harness({ trustLevel: 3 });
    expect(applyOverrides("HOLD_FOR_REVIEW", [], reading({ valence: -0.5 }), ctx).decision).toBe("PASS_WITH_FLAG");
  });

  it("trusted sender override does not apply at or below -0.7", () => {
    const { ctx } = harness({ trustLevel: 5 });
    expect(applyOverrides("HOLD_FOR_REVIEW", [], reading({ valence: -0.7 }), ctx).decision).toBe("HOLD_FOR_REVIEW");
  });

  it("untrusted sender gets no override", () => {
    const { ctx } = harness({ trustLevel: 2 });
    expect(applyOverrides("HOLD_FOR_REVIEW", [], reading({ valence: -0.5 }), ctx).decision).toBe("HOLD_FOR_REVIEW");
  });

  it("repeat flags escalate PASS_WITH_FLAG to HOLD", () => {
    const { ctx } = harness({ recentFlags: 3 });
    const o = applyOverrides("PASS_WITH_FLAG", [], reading(), ctx);
    expect(o).toEqual({ decision: "HOLD_FOR_REVIEW", reasons: ["ESCALATE_REPEAT_PATTERN"] });
  });

  it("crisis signal always forces REDIRECT", () => {
    const { ctx } = harness({ trustLevel: 5, recentFlags: 0 });
    expect(applyOverrides("PASS", ["CRISIS_SIGNAL"], reading(), ctx).decision).toBe("REDIRECT");
  });

  it("does not mutate the caller's reasons array", () => {
    const { ctx } = harness({ recentFlags: 5 });
    const reasons = ["X"];
    applyOverrides("PASS_WITH_FLAG", reasons, reading(), ctx);
    expect(reasons).toEqual(["X"]);
  });
});
