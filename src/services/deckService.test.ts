/**
 * Behaviour tests for the deck generator.
 *
 * `buildDeck` is a pure function, so these run with no Firestore and no
 * credentials — which is exactly why the ranking and fairness rules live there
 * rather than inside the transaction that stores the deck.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeck } from "./deckService";

const A = "uidAAA";
const B = "uidBBB";

// Jakarta-ish coordinates.
const base = { lat: -6.2, lng: 106.82 };
const offset = (km: number) => ({ lat: base.lat + km / 111, lng: base.lng });

const place = (id: string, savedBy: string, tags: string[], km: number, priceLevel = 2) => ({
  id, savedBy, title: `Place ${id}`, tags, priceLevel,
  hasVisited: false, ...offset(km),
});

const prefs = (tags: string[], maxDistanceKm: number, priceLevels: number[] = []) => ({
  tags, priceLevels, lat: base.lat, lng: base.lng, maxDistanceKm,
});

const participants = [A, B];

// --- deterministic ---------------------------------------------------------
test("same session id produces an identical deck (race-safe)", () => {
  const places = Array.from({ length: 20 }, (_, i) =>
    place(`p${i}`, i % 2 === 0 ? A : B, ["cozy"], i));
  const input = { sessionId: "sess-1", places, preferences: { [A]: prefs(["cozy"], 50), [B]: prefs(["cozy"], 50) }, participants };

  const first = buildDeck(input);
  const second = buildDeck(input);
  assert.deepStrictEqual(
    first.deck.map((c) => c.placeId),
    second.deck.map((c) => c.placeId),
  );
});

test("seed breaks ties differently for different session ids", () => {
  // Identical places, so score cannot order them and only the seeded shuffle can.
  const places = Array.from({ length: 20 }, (_, i) =>
    place(`p${i}`, i % 2 === 0 ? A : B, ["cozy"], 2));
  const prefsBoth = { [A]: prefs(["cozy"], 50), [B]: prefs(["cozy"], 50) };
  const one = buildDeck({ sessionId: "sess-1", places, preferences: prefsBoth, participants });
  const two = buildDeck({ sessionId: "sess-9", places, preferences: prefsBoth, participants });
  assert.notDeepStrictEqual(one.deck.map((c) => c.placeId), two.deck.map((c) => c.placeId));
});

// --- fairness --------------------------------------------------------------
test("one partner with many saves cannot monopolise the deck", () => {
  const places = [
    ...Array.from({ length: 30 }, (_, i) => place(`a${i}`, A, ["cozy"], 1)),
    ...Array.from({ length: 3 }, (_, i) => place(`b${i}`, B, ["cozy"], 1)),
  ];
  const { deck } = buildDeck({ sessionId: "s", places, preferences: { [A]: prefs(["cozy"], 50), [B]: prefs(["cozy"], 50) }, participants });
  const fromB = deck.filter((c) => c.ownerId === B).length;
  assert.strictEqual(deck.length, 6);
  assert.strictEqual(fromB, 3, `expected all 3 of B's places, got ${fromB}`);
});

// --- ranking ---------------------------------------------------------------
test("a tag both partners picked outranks one only a single partner picked", () => {
  const places = [place("shared", A, ["ramen"], 1), place("solo", B, ["museum"], 1)];
  const { deck } = buildDeck({
    sessionId: "s", places, participants,
    preferences: { [A]: prefs(["ramen", "museum"], 50), [B]: prefs(["ramen"], 50) },
  });
  assert.strictEqual(deck[0].placeId, "shared");
});

test("nearer beats further when tags are equal", () => {
  const places = [place("far", A, ["cozy"], 40), place("near", A, ["cozy"], 1)];
  const { deck } = buildDeck({ sessionId: "s", places, participants: [A], preferences: { [A]: prefs(["cozy"], 50) } });
  assert.strictEqual(deck[0].placeId, "near");
});

// --- progressive relaxation ------------------------------------------------
test("strict pass when preferences match plenty of places", () => {
  const places = Array.from({ length: 10 }, (_, i) => place(`p${i}`, i % 2 ? A : B, ["cozy"], 2));
  const { strategy, deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["cozy"], 20), [B]: prefs(["cozy"], 20) } });
  assert.strictEqual(strategy, "strict");
  assert.strictEqual(deck.length, 6);
});

test("falls back rather than returning an empty deck", () => {
  // Nothing matches the tags, and everything is far outside the radius.
  const places = Array.from({ length: 8 }, (_, i) => place(`p${i}`, i % 2 ? A : B, ["karaoke"], 400));
  const { strategy, deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["ramen"], 5), [B]: prefs(["museum"], 5) } });
  assert.strictEqual(deck.length, 6, "deck should still be filled");
  assert.strictEqual(strategy, "fallback-any");
});

test("respects the stricter partner's radius while the strict pass can fill", () => {
  const places = [
    ...Array.from({ length: 6 }, (_, i) => place(`near${i}`, i % 2 ? A : B, ["cozy"], 2)),
    ...Array.from({ length: 6 }, (_, i) => place(`far${i}`, i % 2 ? A : B, ["cozy"], 30)),
  ];
  const { deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["cozy"], 5), [B]: prefs(["cozy"], 100) } });
  assert.ok(deck.every((c) => c.placeId.startsWith("near")), deck.map((c) => c.placeId).join(","));
});

test("price level filter excludes then relaxes", () => {
  const places = [
    ...Array.from({ length: 6 }, (_, i) => place(`cheap${i}`, i % 2 ? A : B, ["cozy"], 2, 1)),
    ...Array.from({ length: 6 }, (_, i) => place(`lux${i}`, i % 2 ? A : B, ["cozy"], 2, 4)),
  ];
  const { deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["cozy"], 50, [1]), [B]: prefs(["cozy"], 50, [1]) } });
  assert.ok(deck.every((c) => c.priceLevel === 1), deck.map((c) => c.priceLevel).join(","));
});

test("deck never repeats a place", () => {
  const places = Array.from({ length: 4 }, (_, i) => place(`p${i}`, i % 2 ? A : B, ["cozy"], 2));
  const { deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["ramen"], 1), [B]: prefs(["ramen"], 1) } });
  assert.strictEqual(new Set(deck.map((c) => c.placeId)).size, deck.length);
  assert.strictEqual(deck.length, 4, "cannot invent places that do not exist");
});

test("handles places with no coordinates", () => {
  const places = [{ id: "nogeo", savedBy: A, title: "No geo", tags: ["cozy"], hasVisited: false }];
  const { deck } = buildDeck({ sessionId: "s", places, participants, preferences: { [A]: prefs(["cozy"], 10) } });
  assert.strictEqual(deck.length, 1);
  assert.strictEqual(deck[0].distanceKm, null);
});

