import { describe, expect, it } from "vitest";
import { emotionalFilterGate } from "../src/gate.js";
import { routeDecision } from "../src/routing.js";
import { TransientError } from "../src/types.js";
import { fakeAnalyzer, harness, reading } from "./helpers.js";

describe("routeDecision", () => {
  it("PASS forwards to the next gate", () => {
    const { ctx } = harness();
    expect(routeDecision("PASS", "POSITIVE", reading(), ctx)).toMatchObject({ kind: "forward", to: "G4_NEXT_GATE" });
  });

  it("PASS_WITH_FLAG forwards with elevated priority and top-3 emotions", () => {
    const { ctx } = harness();
    const t = routeDecision(
      "PASS_WITH_FLAG",
      "NEGATIVE",
      reading({ emotions: { a: 0.1, b: 0.9, c: 0.5, d: 0.7 } }),
      ctx,
    );
    expect(t).toMatchObject({ kind: "forward", priority: "elevated" });
    expect((t as unknown as { metadata: { topEmotions: unknown } }).metadata.topEmotions).toEqual([
      ["b", 0.9],
      ["d", 0.7],
      ["c", 0.5],
    ]);
  });

  it("HOLD_FOR_REVIEW creates a ticket with 15-min SLA on high arousal", () => {
    const h = harness();
    const t = routeDecision("HOLD_FOR_REVIEW", "NEGATIVE", reading({ arousal: 0.9, valence: -0.6 }), h.ctx);
    expect(h.tickets[0]).toMatchObject({ slaMinutes: 15, payloadRef: "p1", state: "NEGATIVE" });
    expect(h.queues[0]?.queue).toBe("human_review_queue");
    expect(t).toMatchObject({ kind: "hold", ticketId: "T-1", timeoutMinutes: 15, onTimeout: "BLOCK" });
  });

  it("HOLD_FOR_REVIEW uses 120-min SLA on low arousal", () => {
    const h = harness();
    routeDecision("HOLD_FOR_REVIEW", "MIXED", reading({ arousal: 0.2 }), h.ctx);
    expect(h.tickets[0]?.slaMinutes).toBe(120);
  });

  it("REDIRECT notifies support and bypasses to the support flow", () => {
    const h = harness();
    const t = routeDecision("REDIRECT", "NEGATIVE", reading(), h.ctx);
    expect(h.notifications).toEqual([{ channel: "support_escalation", body: { user: "u1", severity: "high" } }]);
    expect(t).toMatchObject({ kind: "forward", to: "SUPPORT_RESOURCES_FLOW" });
  });

  it("BLOCK terminates with a safe message", () => {
    const { ctx } = harness();
    expect(routeDecision("BLOCK", "NEGATIVE", reading(), ctx)).toMatchObject({
      kind: "terminate",
      code: "G3_EMOTIONAL_BLOCK",
    });
  });

  it("FAIL_SAFE holds in the fail-safe queue, even with a null reading", () => {
    const { ctx } = harness();
    expect(routeDecision("FAIL_SAFE", "UNCERTAIN", null, ctx)).toEqual({ kind: "hold", queue: "g3_fail_safe_queue" });
  });
});

describe("emotionalFilterGate (end to end)", () => {
  it("passes an ordinary positive message to the next gate", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", reading({ valence: 0.6 }))] });
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "PASS", state: "POSITIVE", auditId: "audit-1" });
    expect(r.routeTarget).toMatchObject({ kind: "forward", to: "G4_NEXT_GATE" });
    expect(h.metrics["g3.decision.PASS"]).toBe(1);
  });

  it("blocks severe negative content", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", reading({ valence: -0.9 }))] });
    const r = await emotionalFilterGate(h.ctx);
    expect(r.decision).toBe("BLOCK");
    expect(r.routeTarget.kind).toBe("terminate");
  });

  it("redirects crisis content to support and never blocks it", async () => {
    const h = harness({
      analyzers: [fakeAnalyzer("a", reading({ valence: -0.95, emotions: { despair: 0.9 } }))],
      config: { venting_channels: ["vent"] },
      channel: "vent",
    });
    const r = await emotionalFilterGate(h.ctx);
    expect(r.decision).toBe("REDIRECT");
    expect(r.reasonCodes).toContain("CRISIS_SIGNAL");
  });

  it("holds sarcastic text with strongly positive surface valence", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", reading({ valence: 0.9, sarcasmProb: 0.8 }))] });
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "HOLD_FOR_REVIEW", state: "SARCASTIC" });
    expect(r.reasonCodes).toEqual(["SARCASM_SUSPECTED", "SARCASM_INVERTED_DAMPED"]);
  });

  it("routes disagreeing analyzers through the UNCERTAIN path", async () => {
    const h = harness({
      analyzers: [fakeAnalyzer("a", reading({ valence: 0.5 })), fakeAnalyzer("b", reading({ valence: 0.1 }))],
    });
    const r = await emotionalFilterGate(h.ctx);
    expect(r.state).toBe("UNCERTAIN");
    expect(r.reasonCodes).toContain("ANALYZER_DISAGREEMENT");
  });

  it("empty content passes with NO_TEXT_TO_EVALUATE", async () => {
    const h = harness({ payload: { content: "   " } });
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "PASS", reasonCodes: ["NO_TEXT_TO_EVALUATE"], reading: null });
  });

  it("corrupt bytes are held for review", async () => {
    const h = harness({ payload: { content: new Uint8Array([0xff, 0xff, 0xff, 0xff]) } });
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "HOLD_FOR_REVIEW", reasonCodes: ["ENCODING_CORRUPT"] });
  });

  it("fails closed when analyzers are down", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", new TransientError("x"))] });
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "FAIL_SAFE", reasonCodes: ["ANALYZER_DOWN:a"] });
    expect(r.routeTarget).toEqual({ kind: "hold", queue: "g3_fail_safe_queue" });
    expect(h.services.alertOncallIfRateExceeds).toHaveBeenCalledWith("G3_failures", 10);
  });

  it("fails open when configured", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", new TransientError("x"))], config: { failMode: "open" } });
    const r = await emotionalFilterGate(h.ctx);
    expect(r.decision).toBe("PASS_WITH_FLAG");
    expect(r.routeTarget).toMatchObject({ kind: "forward", priority: "elevated" });
  });

  it("converts unexpected errors into fail-safe results and logs them", async () => {
    const h = harness();
    h.services.lookupRecentValence = () => {
      throw new RangeError("db exploded");
    };
    const r = await emotionalFilterGate(h.ctx);
    expect(r).toMatchObject({ decision: "FAIL_SAFE", reasonCodes: ["UNEXPECTED:RangeError"] });
    expect(h.services.logError).toHaveBeenCalled();
  });

  it("writes an audit record without raw text and with a hashed user", async () => {
    const h = harness({
      payload: { content: "super secret text" },
      analyzers: [fakeAnalyzer("a", reading({ valence: 0.55 }))],
    });
    await emotionalFilterGate(h.ctx);
    expect(h.audits).toHaveLength(1);
    const rec = h.audits[0]!;
    expect(rec).toMatchObject({ gate: "G3_EMOTIONAL_FILTER", userRef: "h(u1)", valenceBucket: 0.6 });
    expect(JSON.stringify(rec)).not.toContain("super secret");
  });

  it("repeat-pattern escalation applies end to end", async () => {
    const h = harness({ analyzers: [fakeAnalyzer("a", reading({ valence: -0.5 }))], recentFlags: 4 });
    const r = await emotionalFilterGate(h.ctx);
    expect(r.decision).toBe("HOLD_FOR_REVIEW");
    expect(r.reasonCodes).toEqual(["NEG_SOFT_FLAG", "ESCALATE_REPEAT_PATTERN"]);
  });
});
