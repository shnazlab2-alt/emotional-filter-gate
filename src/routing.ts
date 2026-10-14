import type {
  Decision,
  GateContext,
  RouteTarget,
  SentimentReading,
  ValenceState,
} from "./types.js";

function topN(emotions: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(emotions).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function severityFrom(reading: SentimentReading | null): "low" | "medium" | "high" {
  if (!reading) return "medium";
  if (reading.valence <= -0.8) return "high";
  if (reading.valence <= -0.45) return "medium";
  return "low";
}

export function routePass(ctx: GateContext): RouteTarget {
  return ctx.services.router.forward(ctx.config.nextGate, ctx.payload, {
    metadata: { valenceBand: "ok" },
  });
}

export function routeFlagged(reading: SentimentReading | null, ctx: GateContext): RouteTarget {
  return ctx.services.router.forward(ctx.config.nextGate, ctx.payload, {
    priority: "elevated",
    metadata: {
      emotionalFlag: true,
      valence: reading?.valence ?? null,
      arousal: reading?.arousal ?? null,
      topEmotions: reading ? topN(reading.emotions, 3) : [],
    },
  });
}

export function routeReview(
  reading: SentimentReading | null,
  state: ValenceState,
  ctx: GateContext,
): RouteTarget {
  const { router } = ctx.services;
  const highArousal = (reading?.arousal ?? 0) >= ctx.config.thresholds.AROUSAL_HIGH;
  const ticket = router.createReviewTicket({
    payloadRef: ctx.payload.id,
    state,
    severity: severityFrom(reading),
    slaMinutes: highArousal ? 15 : 120,
  });
  router.enqueue("human_review_queue", ticket);
  return router.hold(ctx.payload, {
    ticketId: ticket.id,
    timeoutMinutes: ticket.slaMinutes,
    onTimeout: ctx.config.reviewTimeoutAction,
  });
}

export function routeRedirect(ctx: GateContext): RouteTarget {
  const { router } = ctx.services;
  router.notify("support_escalation", { user: ctx.userId, severity: "high" });
  return router.forward(ctx.config.supportFlow, ctx.payload);
}

export function routeBlock(ctx: GateContext): RouteTarget {
  return ctx.services.router.terminate(
    ctx.payload,
    "G3_EMOTIONAL_BLOCK",
    "This content could not be accepted.",
  );
}

export function routeFailSafe(ctx: GateContext): RouteTarget {
  return ctx.services.router.hold(ctx.payload, { queue: ctx.config.failSafeQueue });
}

export function routeDecision(
  decision: Decision,
  state: ValenceState,
  reading: SentimentReading | null,
  ctx: GateContext,
): RouteTarget {
  switch (decision) {
    case "PASS": return routePass(ctx);
    case "PASS_WITH_FLAG": return routeFlagged(reading, ctx);
    case "HOLD_FOR_REVIEW": return routeReview(reading, state, ctx);
    case "REDIRECT": return routeRedirect(ctx);
    case "BLOCK": return routeBlock(ctx);
    case "FAIL_SAFE": return routeFailSafe(ctx);
  }
}
