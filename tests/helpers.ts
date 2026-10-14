import { vi } from "vitest";
import {
  DEFAULT_CONFIG,
  type Analyzer,
  type AuditRecord,
  type GateConfig,
  type GateContext,
  type ParsedInput,
  type Payload,
  type ReviewTicket,
  type RouteTarget,
  type SentimentReading,
  type Services,
} from "../src/types.js";

export function reading(over: Partial<SentimentReading> = {}): SentimentReading {
  return {
    valence: 0,
    arousal: 0.3,
    confidence: 0.9,
    posMass: 0.1,
    negMass: 0.1,
    emotions: {},
    sarcasmProb: 0,
    language: "en",
    source: "test",
    disagreement: 0,
    ...over,
  };
}

export function fakeAnalyzer(
  id: string,
  result: SentimentReading | ((p: ParsedInput) => SentimentReading | Promise<SentimentReading>) | Error,
): Analyzer & { score: ReturnType<typeof vi.fn> } {
  return {
    id,
    supports: () => true,
    score: vi.fn(async (p: ParsedInput) => {
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result(p) : result;
    }),
  };
}

export function parsed(over: Partial<ParsedInput> = {}): ParsedInput {
  return {
    text: "hello world",
    segments: ["hello world"],
    lang: { code: "en", confidence: 0.95 },
    emojiSet: [],
    capsRatio: 0,
    punctBurst: 0,
    negations: [],
    quotes: [],
    sarcasmCues: [],
    truncated: false,
    meta: { priorValence: null },
    ...over,
  };
}

export interface Harness {
  ctx: GateContext;
  audits: AuditRecord[];
  tickets: ReviewTicket[];
  queues: Array<{ queue: string; ticket: ReviewTicket }>;
  notifications: Array<{ channel: string; body: Record<string, unknown> }>;
  metrics: Record<string, number>;
  services: Services;
}

export function harness(
  opts: {
    analyzers?: Analyzer[];
    deepAnalyzer?: Analyzer;
    config?: Partial<GateConfig>;
    payload?: Partial<Payload>;
    recentValence?: number | null;
    recentFlags?: number;
    trustLevel?: number;
    channel?: string;
    deepBudget?: boolean;
  } = {},
): Harness {
  const audits: AuditRecord[] = [];
  const tickets: ReviewTicket[] = [];
  const queues: Harness["queues"] = [];
  const notifications: Harness["notifications"] = [];
  const metrics: Record<string, number> = {};
  let ticketSeq = 0;
  let clock = 1000;

  const services: Services = {
    analyzers: opts.analyzers ?? [fakeAnalyzer("a", reading())],
    deepAnalyzer: opts.deepAnalyzer,
    deepBudgetAllows: () => opts.deepBudget ?? true,
    router: {
      forward: (to, _p, o): RouteTarget => ({ kind: "forward", to, priority: o?.priority, metadata: o?.metadata }),
      hold: (_p, o): RouteTarget => ({ kind: "hold", ...o }),
      terminate: (_p, code, userMessage): RouteTarget => ({ kind: "terminate", code, userMessage }),
      createReviewTicket: (t) => {
        const ticket = { ...t, id: `T-${++ticketSeq}` };
        tickets.push(ticket);
        return ticket;
      },
      enqueue: (queue, ticket) => void queues.push({ queue, ticket }),
      notify: (channel, body) => void notifications.push({ channel, body }),
    },
    writeAudit: (r) => void audits.push(r),
    incrementMetric: (n) => void (metrics[n] = (metrics[n] ?? 0) + 1),
    recordHistogram: () => {},
    alertOncallIfRateExceeds: vi.fn(),
    lookupRecentValence: () => opts.recentValence ?? null,
    countRecentFlags: () => opts.recentFlags ?? 0,
    hashUserId: (u) => `h(${u})`,
    newAuditId: () => "audit-1",
    nowMs: () => clock++, // advances 1ms per call, deterministic
    sleep: vi.fn(async () => {}),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };

  const ctx: GateContext = {
    payload: { id: "p1", content: "Some ordinary message.", userId: "u1", channel: opts.channel, ...opts.payload },
    config: { ...DEFAULT_CONFIG, ...opts.config },
    services,
    userId: "u1",
    channel: opts.channel,
    sender: opts.trustLevel !== undefined ? { trustLevel: opts.trustLevel } : undefined,
    flags: { deepDone: false },
  };
  return { ctx, audits, tickets, queues, notifications, metrics, services };
}
