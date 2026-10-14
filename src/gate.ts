import { reconcileReadings, runAnalyzers } from "./analyze.js";
import { classifyValenceState } from "./classify.js";
import { applyOverrides, evaluateThresholds, isAmbiguous, resolveAmbiguousState } from "./decide.js";
import { parseInput } from "./parse.js";
import { routeDecision } from "./routing.js";
import {
  AnalyzerUnavailable,
  GATE_ID,
  GateTimeoutError,
  SCHEMA_VERSION,
  type Decision,
  type GateContext,
  type GateResult,
  type ParseErrorCode,
  type SentimentReading,
  type ValenceState,
} from "./types.js";

// ---------- Audit ----------

const bucket = (v: number, step = 0.2) => Number((Math.round(v / step) * step).toFixed(2));

function emitAudit(result: GateResult, ctx: GateContext): void {
  const { services } = ctx;
  services.writeAudit({
    auditId: result.auditId,
    gate: GATE_ID,
    schema: SCHEMA_VERSION,
    decision: result.decision,
    state: result.state,
    reasonCodes: result.reasonCodes,
    valenceBucket: result.reading ? bucket(result.reading.valence) : null,
    confidence: result.reading?.confidence ?? null,
    latencyMs: result.latencyMs,
    routeTarget: result.routeTarget,
    // never log raw text
    userRef: ctx.userId ? services.hashUserId(ctx.userId) : null,
  });
  services.incrementMetric(`g3.decision.${result.decision}`);
  services.recordHistogram("g3.latency_ms", result.latencyMs);
}

function finalize(
  decision: Decision,
  state: ValenceState,
  reading: SentimentReading | null,
  reasons: string[],
  ctx: GateContext,
  auditId: string,
  start: number,
): GateResult {
  const result: GateResult = {
    gateId: GATE_ID,
    decision,
    state,
    reading,
    reasonCodes: reasons,
    routeTarget: routeDecision(decision, state, reading, ctx),
    auditId,
    latencyMs: ctx.services.nowMs() - start,
  };
  emitAudit(result, ctx);
  return result;
}

// ---------- Error paths ----------

export function handleParseError(
  error: ParseErrorCode,
  ctx: GateContext,
  auditId: string,
  start: number,
): GateResult {
  switch (error) {
    case "EMPTY_PAYLOAD":
    case "EMPTY_AFTER_NORMALIZATION":
      return finalize("PASS", "NEUTRAL", null, ["NO_TEXT_TO_EVALUATE"], ctx, auditId, start);
    case "ENCODING_CORRUPT":
    case "UNSUPPORTED_TYPE":
      return finalize("HOLD_FOR_REVIEW", "UNCERTAIN", null, [error], ctx, auditId, start);
  }
}

export function failSafe(reason: string, ctx: GateContext, auditId: string, start: number): GateResult {
  const decision: Decision = ctx.config.failMode === "closed" ? "FAIL_SAFE" : "PASS_WITH_FLAG";
  ctx.services.alertOncallIfRateExceeds("G3_failures", ctx.config.failureAlertPerMinute);
  return finalize(decision, "UNCERTAIN", null, [reason], ctx, auditId, start);
}

// ---------- Main entry point ----------

export async function emotionalFilterGate(ctx: GateContext): Promise<GateResult> {
  const start = ctx.services.nowMs();
  const auditId = ctx.services.newAuditId();

  try {
    const parsed = parseInput(ctx.payload, ctx);
    if (!parsed.ok) return handleParseError(parsed.error, ctx, auditId, start);

    const readings = await runAnalyzers(parsed.value, ctx);
    const reading = reconcileReadings(readings);

    const { state, reasons } = classifyValenceState(reading, parsed.value, ctx);

    let decision: Decision;
    const outReasons = [...reasons];
    if (isAmbiguous(state)) {
      const o = await resolveAmbiguousState(state, reading, parsed.value, ctx);
      decision = o.decision;
      outReasons.push(...o.reasons);
    } else {
      const o = evaluateThresholds(reading, ctx);
      decision = o.decision;
      outReasons.push(...o.reasons);
    }

    const overridden = applyOverrides(decision, outReasons, reading, ctx);
    return finalize(overridden.decision, state, reading, overridden.reasons, ctx, auditId, start);
  } catch (e) {
    if (e instanceof GateTimeoutError) return failSafe("ANALYZER_TIMEOUT", ctx, auditId, start);
    if (e instanceof AnalyzerUnavailable) return failSafe(`ANALYZER_DOWN:${e.service}`, ctx, auditId, start);
    ctx.services.logError?.(auditId, e);
    const name = e instanceof Error ? e.name : typeof e;
    return failSafe(`UNEXPECTED:${name}`, ctx, auditId, start);
  }
}
