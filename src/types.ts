// ---------- Core enums (string unions) ----------

export type ValenceState =
  | "POSITIVE"
  | "NEGATIVE"
  | "NEUTRAL"
  | "MIXED"
  | "SARCASTIC"
  | "UNCERTAIN"
  | "UNSUPPORTED";

export type Decision =
  | "PASS"
  | "PASS_WITH_FLAG"
  | "HOLD_FOR_REVIEW"
  | "REDIRECT"
  | "BLOCK"
  | "FAIL_SAFE";

export type AmbiguousState = Extract<
  ValenceState,
  "MIXED" | "SARCASTIC" | "UNCERTAIN" | "UNSUPPORTED"
>;

// ---------- Thresholds & config ----------

export interface Thresholds {
  NEG_HARD_BLOCK: number;
  NEG_SOFT_FLAG: number;
  POS_SOFT_FLAG: number;
  POS_MANIA_CAP: number;
  NEUTRAL_BAND: number;
  AROUSAL_HIGH: number;
  CONFIDENCE_MIN: number;
  AMBIGUITY_SPREAD: number;
  MIXED_POLE_MIN: number;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  NEG_HARD_BLOCK: -0.8,
  NEG_SOFT_FLAG: -0.45,
  POS_SOFT_FLAG: 0.45,
  POS_MANIA_CAP: 0.9,
  NEUTRAL_BAND: 0.15,
  AROUSAL_HIGH: 0.75,
  CONFIDENCE_MIN: 0.55,
  AMBIGUITY_SPREAD: 0.3,
  MIXED_POLE_MIN: 0.35,
});

export const GATE_ID = "G3_EMOTIONAL_FILTER";
export const SCHEMA_VERSION = "1.2";
export const MAX_INPUT_CHARS = 10_000;
export const DEFAULT_TIMEOUT_MS = 800;
export const MAX_RETRIES = 2;

export interface GateConfig {
  thresholds: Thresholds;
  timeoutMs: number;
  maxInputChars: number;
  maxRetries: number;
  supportedLanguages: string[];
  venting_channels: string[];
  /** Decision used when an UNCERTAIN state cannot be resolved. */
  uncertainDefault: Decision;
  /** If true, unsupported-language content is held instead of flagged. */
  strict: boolean;
  /** "closed" => FAIL_SAFE hold; "open" => PASS_WITH_FLAG. */
  failMode: "closed" | "open";
  failSafeQueue: string;
  reviewTimeoutAction: Decision;
  nextGate: string;
  supportFlow: string;
  /** Alert if more than this many failures occur per minute. */
  failureAlertPerMinute: number;
}

export const DEFAULT_CONFIG: Readonly<GateConfig> = Object.freeze({
  thresholds: DEFAULT_THRESHOLDS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxInputChars: MAX_INPUT_CHARS,
  maxRetries: MAX_RETRIES,
  supportedLanguages: ["en", "es", "fr", "de", "pt"],
  venting_channels: [],
  uncertainDefault: "PASS_WITH_FLAG" as Decision,
  strict: false,
  failMode: "closed" as const,
  failSafeQueue: "g3_fail_safe_queue",
  reviewTimeoutAction: "BLOCK" as Decision,
  nextGate: "G4_NEXT_GATE",
  supportFlow: "SUPPORT_RESOURCES_FLOW",
  failureAlertPerMinute: 10,
});

// ---------- Sentiment ----------

export interface SentimentReading {
  valence: number; // -1..+1
  arousal: number; // 0..1
  confidence: number; // 0..1
  posMass: number;
  negMass: number;
  emotions: Record<string, number>;
  sarcasmProb: number;
  language: string;
  source: string;
  /** Spread between analyzers; set by reconcileReadings (0 for a single reading). */
  disagreement?: number;
}

// ---------- Input ----------

export interface Payload {
  id: string;
  content: string | Uint8Array | null | undefined;
  channel?: string;
  userId?: string;
  threadContext?: string;
}

export interface LanguageGuess {
  code: string;
  confidence: number;
}

export interface ParsedInput {
  text: string;
  segments: string[];
  lang: LanguageGuess;
  emojiSet: string[];
  capsRatio: number;
  punctBurst: number;
  negations: string[];
  quotes: string[];
  sarcasmCues: string[];
  truncated: boolean;
  meta: {
    channel?: string;
    userId?: string;
    priorValence: number | null;
    threadContext?: string;
  };
}

export type ParseErrorCode =
  | "EMPTY_PAYLOAD"
  | "ENCODING_CORRUPT"
  | "UNSUPPORTED_TYPE"
  | "EMPTY_AFTER_NORMALIZATION";

export type ParseResult =
  | { ok: true; value: ParsedInput }
  | { ok: false; error: ParseErrorCode };

// ---------- Analyzer + services ----------

export interface Analyzer {
  id: string;
  supports(lang: string): boolean;
  score(parsed: ParsedInput): Promise<SentimentReading>;
}

export class TransientError extends Error {
  override name = "TransientError";
}
export class GateTimeoutError extends Error {
  override name = "GateTimeoutError";
}
export class AnalyzerUnavailable extends Error {
  override name = "AnalyzerUnavailable";
  constructor(
    public readonly service: string,
    message?: string,
  ) {
    super(message ?? `Analyzer unavailable: ${service}`);
  }
}

export type RouteTarget =
  | { kind: "forward"; to: string; priority?: "normal" | "elevated"; metadata?: Record<string, unknown> }
  | { kind: "hold"; queue?: string; ticketId?: string; timeoutMinutes?: number; onTimeout?: Decision }
  | { kind: "terminate"; code: string; userMessage: string };

export interface ReviewTicket {
  id: string;
  payloadRef: string;
  state: ValenceState;
  severity: "low" | "medium" | "high";
  slaMinutes: number;
}

export interface Router {
  forward(
    to: string,
    payload: Payload,
    opts?: { priority?: "normal" | "elevated"; metadata?: Record<string, unknown> },
  ): RouteTarget;
  hold(
    payload: Payload,
    opts: { queue?: string; ticketId?: string; timeoutMinutes?: number; onTimeout?: Decision },
  ): RouteTarget;
  terminate(payload: Payload, code: string, userMessage: string): RouteTarget;
  createReviewTicket(t: Omit<ReviewTicket, "id">): ReviewTicket;
  enqueue(queue: string, ticket: ReviewTicket): void;
  notify(channel: string, body: Record<string, unknown>): void;
}

export interface AuditRecord {
  auditId: string;
  gate: string;
  schema: string;
  decision: Decision;
  state: ValenceState;
  reasonCodes: string[];
  valenceBucket: number | null;
  confidence: number | null;
  latencyMs: number;
  routeTarget: RouteTarget;
  userRef: string | null;
}

export interface Services {
  analyzers: Analyzer[];
  deepAnalyzer?: Analyzer;
  deepBudgetAllows?: () => boolean;
  router: Router;
  writeAudit(record: AuditRecord): void;
  incrementMetric(name: string): void;
  recordHistogram(name: string, value: number): void;
  alertOncallIfRateExceeds(name: string, perMinute: number): void;
  lookupRecentValence(userId: string | undefined, window: number): number | null;
  countRecentFlags(userId: string | undefined, window: string): number;
  hashUserId(userId: string): string;
  newAuditId(): string;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  logWarn?(msg: string, extra?: unknown): void;
  logError?(auditId: string, err: unknown): void;
  /** Optional overrides for NLP helpers. */
  detectLanguage?(text: string): LanguageGuess;
  splitSentences?(text: string, lang: string): string[];
  emojiValence?(emoji: string[]): number;
}

export interface GateContext {
  payload: Payload;
  config: GateConfig;
  services: Services;
  userId?: string;
  channel?: string;
  sender?: { trustLevel: number };
  flags: { deepDone: boolean };
}

export interface GateResult {
  gateId: string;
  decision: Decision;
  state: ValenceState;
  reading: SentimentReading | null;
  reasonCodes: string[];
  routeTarget: RouteTarget;
  auditId: string;
  latencyMs: number;
}
