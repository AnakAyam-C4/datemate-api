import assert from "node:assert/strict";
import { test } from "node:test";
import { type EvidenceSource, type GeminiFacts, sanitize, tokenOverlap, verifyEvidence } from "../3-gemini/gemini";
import { canonicalArea } from "../2-caption/signals";

const facts = (overrides: Partial<GeminiFacts> & { source?: EvidenceSource; quote?: string }): GeminiFacts => ({
  name: "Masen Matcha",
  area: "BSD City",
  nameEvidence: { source: overrides.source ?? "hashtag", quote: overrides.quote ?? "#masenmatcha" },
  confidence: 0.9,
  category: "cafe",
  specialty: "matcha",
  vibes: ["cozy", "aesthetic"],
  setting: "indoor",
  highlights: [],
  priceLevel: 2,
  ...overrides,
});

const context = {
  inputText: "nemu matcha enak bgt di bsd 😭 #masenmatcha #bsd #fyp",
  allowedSources: new Set<EvidenceSource>(["caption", "hashtag", "cover_text"]),
  creatorNames: ["Kezia Eats", "keziaeats"],
  minConfidence: 0.7,
};

test("a hashtag quote that really appears in the caption supports the squashed name", () => {
  assert.deepEqual(verifyEvidence(facts({}), context), { accepted: true, source: "hashtag", reason: "ok" });
});

test("an invented quote is rejected even when everything else looks right", () => {
  const verdict = verifyEvidence(facts({ source: "caption", quote: "Masen Matcha, BSD" }), context);
  assert.deepEqual(verdict, { accepted: false, reason: "quote_not_in_input" });
});

test("adjacent hashtags cannot be glued together into a fake quote", () => {
  assert.equal(verifyEvidence(facts({ source: "hashtag", quote: "#masenmatcha #bsd" }), context).accepted, true);
  assert.equal(verifyEvidence(facts({ source: "hashtag", quote: "#masenmatchabsd" }), context).reason, "quote_not_in_input");
  assert.equal(verifyEvidence(facts({ source: "caption", quote: "MASEN   matcha" }), context).reason, "quote_not_in_input");
});

test("a real quote that does not mention the name does not count as evidence", () => {
  const verdict = verifyEvidence(facts({ source: "caption", quote: "nemu matcha enak bgt" }), context);
  assert.deepEqual(verdict, { accepted: false, reason: "quote_does_not_support_name" });
});

test("empty name, source none, generic and creator names are rejected", () => {
  assert.equal(verifyEvidence(facts({ name: "", source: "none", quote: "" }), context).reason, "no_name");
  assert.equal(verifyEvidence(facts({ name: "Hidden Gem", quote: "#hiddengem" }), context).reason, "generic_name");
  assert.equal(verifyEvidence(facts({ name: "Kezia Eats", quote: "Kezia Eats" }), context).reason, "creator_name");
});

test("sources the request could not have used are rejected", () => {
  const verdict = verifyEvidence(facts({ source: "speech", quote: "masen matcha" }), context);
  assert.deepEqual(verdict, { accepted: false, reason: "source_not_allowed" });
});

test("cover and on-screen quotes must at least contain the name", () => {
  assert.equal(verifyEvidence(facts({ source: "cover_text", quote: "MASEN MATCHA · BSD" }), context).accepted, true);
  assert.equal(verifyEvidence(facts({ source: "cover_text", quote: "best matcha in town" }), context).reason, "quote_does_not_support_name");
});

test("a street or a bare area is never accepted as the place name", () => {
  for (const name of ["Jl. Kemang Raya", "Jalan Sudirman 5", "BSD City", "Gading Serpong, Tangerang"]) {
    assert.equal(verifyEvidence(facts({ name, source: "cover_text", quote: name }), context).reason, "location_not_name", name);
  }
});

test("a venue named after its area or mall is still accepted", () => {
  for (const name of ["Mie Gacoan Bintaro", "Masen Matcha BSD", "Starbucks Plaza Senayan"]) {
    assert.equal(verifyEvidence(facts({ name, source: "cover_text", quote: name.toUpperCase() }), context).accepted, true, name);
  }
});

test("low confidence keeps the name out of geocoding", () => {
  assert.deepEqual(verifyEvidence(facts({ confidence: 0.5 }), context), { accepted: false, reason: "low_confidence" });
});

test("sanitize strips control and bidi characters and clamps length", () => {
  assert.equal(sanitize("ok\u0000‮evil\u0007", 100), "okevil");
  assert.equal(sanitize("  padded  ", 100), "padded");
  assert.equal(sanitize("x".repeat(500), 10).length, 10);
  assert.equal(sanitize("line one\nline two", 100), "line one\nline two");
});

test("token overlap follows the iOS POI rule (tokens of length ≥ 2)", () => {
  assert.equal(tokenOverlap("Masen Matcha", "Masen Matcha BSD"), 1);
  assert.equal(tokenOverlap("Kopi Kenangan Senayan", "Kopi Kenangan"), 2 / 3);
  assert.equal(tokenOverlap("A", "A"), 0);
});

test("bare area names resolve to their known canonical form", () => {
  assert.equal(canonicalArea("Kemang"), "Kemang, Jakarta Selatan");
  assert.equal(canonicalArea("di #gadingserpong"), "Gading Serpong, Tangerang");
  assert.equal(canonicalArea("BSD City"), "Serpong, Tangerang Selatan");
  assert.equal(canonicalArea("Medan"), "Medan");
});
