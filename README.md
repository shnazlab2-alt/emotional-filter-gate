# emotional-filter-gate

Author: Jeffrey Schnaus

Original creation dates (America/Denver, file timestamps): source files 2026-10-11 04:31–04:36 MDT; Eruption page sample (`eruption-sample/`) 2026-10-12 20:07 – 2026-10-13 15:00 MDT. License: MIT.


A configurable emotional filter gate for content pipelines. It parses text, runs one or more sentiment analyzers, classifies the valence state, evaluates thresholds, resolves ambiguous cases (mixed, sarcastic, uncertain, unsupported), applies overrides, and routes the result downstream.

- Zero runtime dependencies
- ESM and CommonJS builds, with TypeScript types
- Bring your own analyzers, router, audit sink, and NLP helpers (all injected)
- Node 18 or newer

## Install

```bash
npm install emotional-filter-gate
```

## Quick start

```ts
import {
  emotionalFilterGate,
  DEFAULT_CONFIG,
  type Analyzer,
  type GateContext,
  type Services,
} from "emotional-filter-gate";

// 1. Wrap your sentiment model(s) as an Analyzer.
const myModel: Analyzer = {
  id: "my-model",
  supports: (lang) => lang === "en",
  async score(parsed) {
    const out = await callMyModel(parsed.text);
    return {
      valence: out.valence, arousal: out.arousal, confidence: out.confidence,
      posMass: out.pos, negMass: out.neg, emotions: out.emotions,
      sarcasmProb: out.sarcasm, language: parsed.lang.code, source: "my-model",
    };
  },
};

// 2. Provide services (router, audit, clock, history lookups, ...).
const services: Services = { analyzers: [myModel], /* router, writeAudit, ... */ } as Services;

// 3. Run the gate.
const ctx: GateContext = {
  payload: { id: "msg-1", content: "I can't believe how great this is!", userId: "u1" },
  config: DEFAULT_CONFIG,
  services,
  userId: "u1",
  flags: { deepDone: false },
};

const result = await emotionalFilterGate(ctx);
console.log(result.decision, result.state, result.reasonCodes, result.routeTarget);
```

## Pipeline

1. Parse: normalize (NFKC), strip control characters, truncate, detect language, extract features.
2. Analyze: run supported analyzers in parallel, with retry and an overall deadline.
3. Reconcile: confidence-weighted merge. Analyzer disagreement lowers confidence.
4. Classify: `POSITIVE`, `NEGATIVE`, `NEUTRAL`, `MIXED`, `SARCASTIC`, `UNCERTAIN`, or `UNSUPPORTED`.
5. Decide: thresholds for clear states, dedicated handlers for ambiguous ones.
6. Override: venting channels, trusted senders, repeat-pattern escalation. Crisis redirects are never downgraded.
7. Route: forward, forward flagged, hold for review, redirect to support, block, or fail-safe.

## Decisions

| Decision | Meaning |
|---|---|
| `PASS` | Forward to the next gate |
| `PASS_WITH_FLAG` | Forward with elevated priority and emotional metadata |
| `HOLD_FOR_REVIEW` | Create a review ticket and hold |
| `REDIRECT` | Notify support and forward to the support flow |
| `BLOCK` | Terminate with a safe user message |
| `FAIL_SAFE` | Hold in the fail-safe queue (analyzer failure, closed mode) |

## Configuration

Pass a `GateConfig` (start from `DEFAULT_CONFIG`). Notable options:

| Option | Default | Purpose |
|---|---|---|
| `thresholds` | see `DEFAULT_THRESHOLDS` | Valence, arousal, confidence, and ambiguity cutoffs |
| `timeoutMs` | `800` | Overall analyzer deadline |
| `maxRetries` | `2` | Retries on `TransientError` |
| `failMode` | `"closed"` | `"closed"` holds on failure, `"open"` passes with a flag |
| `uncertainDefault` | `PASS_WITH_FLAG` | Decision for unresolved uncertain readings |
| `strict` | `false` | Hold (rather than flag) unsupported-language content |
| `venting_channels` | `[]` | Channels where `BLOCK` is downgraded to review |
| `reviewTimeoutAction` | `BLOCK` | Action when a review SLA expires |

The default thresholds are placeholders. Calibrate them against labeled data from your own domain before relying on them.

## Services

`Services` is the dependency-injection surface: `analyzers`, optional `deepAnalyzer`, `router`, `writeAudit`, metrics hooks, `lookupRecentValence`, `countRecentFlags`, `hashUserId`, `newAuditId`, `nowMs`, `sleep`, and optional NLP overrides (`detectLanguage`, `splitSentences`, `emojiValence`). Fakes for all of these are easy to build, see the `tests/helpers.ts` pattern in the repository.

The built-in language detector, sentence splitter, and emoji table are deliberately simple placeholders.

## Safety notes

- Raw message text is never written to the audit record. User ids are hashed through your `hashUserId`.
- This gate is a heuristic aid. It is not a substitute for human review or professional crisis response.

## Development

```bash
npm install
npm test
npm run build
npm run lint:package
```

## License

MIT

<!-- stamp -->
---
**Author: Jeff SHNaZLab (Jeffrey Schnaus) · Named credit · Created 2026-10-11 04:41 MDT · First public 2026-10-14 00:26:20 MDT · 🟢 green originality mark**  
_Concept and direction: Jeffrey Schnaus; AI-assisted build._
<!-- /stamp -->
