import { describe, expect, it } from "vitest";
import {
  capsRatio,
  collapseWhitespace,
  detectSarcasmCues,
  extractEmoji,
  parseInput,
  punctBurstCount,
  smartTruncate,
} from "../src/parse.js";
import { harness } from "./helpers.js";

describe("parseInput", () => {
  it("rejects null payload and null content", () => {
    const { ctx } = harness();
    expect(parseInput(null, ctx)).toEqual({ ok: false, error: "EMPTY_PAYLOAD" });
    expect(parseInput({ id: "x", content: null }, ctx)).toEqual({ ok: false, error: "EMPTY_PAYLOAD" });
  });

  it("rejects non-string, non-bytes content", () => {
    const { ctx } = harness();
    const bad = { id: "x", content: 42 as unknown as string };
    expect(parseInput(bad, ctx)).toEqual({ ok: false, error: "UNSUPPORTED_TYPE" });
  });

  it("flags heavily corrupted byte input", () => {
    const { ctx } = harness();
    const bytes = new Uint8Array([0xff, 0xfe, 0xff, 0xfe, 0xff, 0x41]);
    expect(parseInput({ id: "x", content: bytes }, ctx)).toEqual({ ok: false, error: "ENCODING_CORRUPT" });
  });

  it("decodes valid UTF-8 bytes", () => {
    const { ctx } = harness();
    const r = parseInput({ id: "x", content: new TextEncoder().encode("Hello there.") }, ctx);
    expect(r.ok && r.value.text).toBe("Hello there.");
  });

  it("returns EMPTY_AFTER_NORMALIZATION for whitespace/control-only text", () => {
    const { ctx } = harness();
    expect(parseInput({ id: "x", content: " \u0000\u0007 \n\t " }, ctx)).toEqual({
      ok: false,
      error: "EMPTY_AFTER_NORMALIZATION",
    });
  });

  it("applies NFKC normalization and collapses whitespace", () => {
    const { ctx } = harness();
    const r = parseInput({ id: "x", content: "ｆｕｌｌ   width\n\ntext" }, ctx);
    expect(r.ok && r.value.text).toBe("full width text");
  });

  it("truncates long input at a sentence boundary and marks it", () => {
    const { ctx } = harness({ config: { maxInputChars: 50 } });
    const content = "First sentence is here. Second sentence is here. Third one goes past the limit.";
    const r = parseInput({ id: "x", content }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.truncated).toBe(true);
      expect(r.value.text.length).toBeLessThanOrEqual(50);
      expect(r.value.text.endsWith(".")).toBe(true);
    }
  });

  it("extracts features and prior valence metadata", () => {
    const { ctx } = harness({ recentValence: -0.5 });
    const r = parseInput(
      { id: "x", content: 'I do NOT like this!! He said "never again". Yeah right 🙃', userId: "u1", channel: "dm" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.punctBurst).toBe(1);
      expect(r.value.quotes).toEqual(["never again"]);
      expect(r.value.negations.length).toBeGreaterThan(0);
      expect(r.value.emojiSet).toContain("🙃");
      expect(r.value.sarcasmCues.length).toBeGreaterThanOrEqual(2);
      expect(r.value.meta).toMatchObject({ priorValence: -0.5, channel: "dm", userId: "u1" });
    }
  });

  it("uses injected language detector", () => {
    const { ctx, services } = harness();
    services.detectLanguage = () => ({ code: "fr", confidence: 0.99 });
    const r = parseInput({ id: "x", content: "Bonjour" }, ctx);
    expect(r.ok && r.value.lang.code).toBe("fr");
  });
});

describe("text helpers", () => {
  it("collapseWhitespace", () => expect(collapseWhitespace("  a \n b\t")).toBe("a b"));
  it("capsRatio handles no letters", () => expect(capsRatio("123 !!!")).toBe(0));
  it("capsRatio counts uppercase", () => expect(capsRatio("ABcd")).toBe(0.5));
  it("punctBurstCount", () => expect(punctBurstCount("what?! no!!! ok.")).toBe(2));
  it("extractEmoji", () => expect(extractEmoji("hi 😀 there 😡")).toEqual(["😀", "😡"]));
  it("smartTruncate falls back to hard cut when no boundary", () =>
    expect(smartTruncate("a".repeat(100), 10)).toBe("a".repeat(10)));
  it("detectSarcasmCues finds '/s'", () => expect(detectSarcasmCues("great job /s", [])).toHaveLength(1));
});
