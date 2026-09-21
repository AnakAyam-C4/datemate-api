import { SESSION } from "../config/env";
import type { Place } from "../repositories/placeRepository";
import type {
  DeckCard,
  DeckStrategy,
  SessionPreferences,
} from "../types/session";
import { distanceKm, midpoint, type LatLng } from "../utils/geo";
import { seededRandom, shuffle } from "../utils/random";

type ScoredPlace = { card: DeckCard; place: Place };

type BuildDeckInput = {
  sessionId: string;
  places: Place[];
  preferences: Record<string, SessionPreferences>;
  participants: string[];
  deckSize?: number;
};

export type BuildDeckResult = {
  deck: DeckCard[];
  strategy: DeckStrategy;
};

/** Passes are tried in order until the deck is full; each one relaxes a filter. */
const PASSES: DeckStrategy[] = [
  "strict",
  "relaxed-tags",
  "widened-radius",
  "fallback-any",
];

const normaliseTag = (tag: string) => tag.trim().toLowerCase();

const buildTagWeights = (
  preferences: Record<string, SessionPreferences>,
): Map<string, number> => {
  const weights = new Map<string, number>();

  for (const preference of Object.values(preferences)) {
    for (const tag of preference?.tags ?? []) {
      const key = normaliseTag(tag);
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }

  return weights;
};

const collectPriceLevels = (
  preferences: Record<string, SessionPreferences>,
): Set<number> => {
  const levels = new Set<number>();

  for (const preference of Object.values(preferences)) {
    for (const level of preference?.priceLevels ?? []) levels.add(level);
  }

  return levels;
};

const radiiFrom = (preferences: Record<string, SessionPreferences>) => {
  const radii = Object.values(preferences)
    .map((preference) => preference?.maxDistanceKm)
    .filter((value): value is number => Number.isFinite(value) && value > 0);

  if (radii.length === 0) {
    return { tight: SESSION.defaultRadiusKm, loose: SESSION.defaultRadiusKm * 2 };
  }

  // Strict pass respects the stricter partner; later passes open up to the
  // more relaxed one rather than leaving the deck half empty.
  return { tight: Math.min(...radii), loose: Math.max(...radii) * 2 };
};

const originFrom = (
  preferences: Record<string, SessionPreferences>,
): LatLng | null =>
  midpoint(
    Object.values(preferences)
      .filter(
        (preference) =>
          Number.isFinite(preference?.lat) && Number.isFinite(preference?.lng),
      )
      .map((preference) => ({
        lat: preference.lat as number,
        lng: preference.lng as number,
      })),
  );

/**
 * Score is intentionally simple and explainable: a place both partners tagged
 * for beats a place only one of them did, and nearer beats further.
 */
const scorePlace = (
  place: Place,
  context: {
    tagWeights: Map<string, number>;
    priceLevels: Set<number>;
    origin: LatLng | null;
    looseRadius: number;
  },
): { score: number; distance: number | null } => {
  const tags = (place.tags ?? []).map(normaliseTag);

  // 2 points when both partners asked for the tag, 1 when only one did.
  const tagScore = tags.reduce(
    (sum, tag) => sum + (context.tagWeights.get(tag) ?? 0),
    0,
  );

  const priceScore =
    context.priceLevels.size === 0 ||
    (place.priceLevel !== null &&
      place.priceLevel !== undefined &&
      context.priceLevels.has(place.priceLevel))
      ? 1
      : 0;

  const distance =
    context.origin &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng)
      ? distanceKm(context.origin, {
          lat: place.lat as number,
          lng: place.lng as number,
        })
      : null;

  // Linear decay to zero at the loose radius; unknown distance scores neutral
  // so a place with no coordinates is neither promoted nor buried.
  const proximityScore =
    distance === null
      ? 0.5
      : Math.max(0, 1 - distance / Math.max(context.looseRadius, 1));

  const score = tagScore * 3 + proximityScore * 2 + priceScore;

  return { score: Number(score.toFixed(4)), distance };
};

const toCard = (
  place: Place,
  score: number,
  distance: number | null,
): DeckCard => ({
  placeId: place.id,
  ownerId: place.savedBy,
  title: place.title,
  desc: place.desc ?? null,
  url: place.url ?? null,
  thumbnailUrl: place.thumbnailUrl ?? null,
  address: place.address ?? null,
  tags: place.tags ?? [],
  priceLevel: place.priceLevel ?? null,
  lat: place.lat ?? null,
  lng: place.lng ?? null,
  distanceKm: distance === null ? null : Number(distance.toFixed(2)),
  score,
});

const passesFilter = (
  strategy: DeckStrategy,
  place: Place,
  distance: number | null,
  context: {
    tagWeights: Map<string, number>;
    priceLevels: Set<number>;
    tightRadius: number;
    looseRadius: number;
  },
): boolean => {
  if (strategy === "fallback-any") return true;

  const withinRadius = (radius: number) =>
    distance === null ? true : distance <= radius;

  if (strategy === "widened-radius") return withinRadius(context.looseRadius);

  if (!withinRadius(context.tightRadius)) return false;

  const priceOk =
    context.priceLevels.size === 0 ||
    (place.priceLevel !== null &&
      place.priceLevel !== undefined &&
      context.priceLevels.has(place.priceLevel));

  if (!priceOk) return false;

  if (strategy === "relaxed-tags") return true;

  // strict: at least one tag either partner asked for.
  if (context.tagWeights.size === 0) return true;

  return (place.tags ?? []).some((tag) =>
    context.tagWeights.has(normaliseTag(tag)),
  );
};

/**
 * Alternates between the two partners' saved places.
 *
 * Without this, one partner who saves a lot of spots would fill the whole deck,
 * and the other would never see their own picks — which reads as unfair in a
 * two-person game even when the ranking is technically correct.
 */
const interleaveByOwner = (
  candidates: ScoredPlace[],
  participants: string[],
  deckSize: number,
  random: () => number,
): DeckCard[] => {
  const queues = new Map<string, ScoredPlace[]>();

  for (const owner of participants) queues.set(owner, []);

  for (const candidate of candidates) {
    const queue = queues.get(candidate.card.ownerId);
    if (queue) queue.push(candidate);
    else queues.set(candidate.card.ownerId, [candidate]);
  }

  // Coin flip decides who leads, seeded so both clients agree.
  const order = random() < 0.5 ? participants : [...participants].reverse();
  const deck: DeckCard[] = [];

  while (deck.length < deckSize) {
    const before = deck.length;

    for (const owner of order) {
      if (deck.length >= deckSize) break;

      const next = queues.get(owner)?.shift();
      if (next) deck.push(next.card);
    }

    // Everyone's queue is empty — stop rather than spin.
    if (deck.length === before) break;
  }

  return deck;
};

/**
 * Builds the deck both partners will swipe on.
 *
 * Deterministic for a given (sessionId, places, preferences): if both clients
 * race to generate, they produce byte-identical decks, so the transaction that
 * loses the race discards work rather than causing a visible conflict.
 */
export const buildDeck = ({
  sessionId,
  places,
  preferences,
  participants,
  deckSize = SESSION.deckSize,
}: BuildDeckInput): BuildDeckResult => {
  const tagWeights = buildTagWeights(preferences);
  const priceLevels = collectPriceLevels(preferences);
  const origin = originFrom(preferences);
  const { tight, loose } = radiiFrom(preferences);

  const random = seededRandom(sessionId);

  // Shuffle first so equal-scoring places do not always resolve in document-id
  // order — the sort below is stable, so the shuffle survives as the tiebreak.
  const scored: ScoredPlace[] = shuffle(places, random)
    .map((place) => {
      const { score, distance } = scorePlace(place, {
        tagWeights,
        priceLevels,
        origin,
        looseRadius: loose,
      });

      return { place, distance, card: toCard(place, score, distance) };
    })
    .sort((a, b) => b.card.score - a.card.score);

  const chosen = new Set<string>();
  const deck: DeckCard[] = [];
  let strategy: DeckStrategy = "strict";

  for (const pass of PASSES) {
    if (deck.length >= deckSize) break;

    const eligible = scored.filter((candidate) => {
      if (chosen.has(candidate.card.placeId)) return false;

      const distance = candidate.card.distanceKm;

      return passesFilter(pass, candidate.place, distance, {
        tagWeights,
        priceLevels,
        tightRadius: tight,
        looseRadius: loose,
      });
    });

    const filled = interleaveByOwner(
      eligible,
      participants,
      deckSize - deck.length,
      random,
    )
      // Interleaving decides *which* cards get in, so both partners are
      // represented. Ordering is a separate concern: show the strongest match
      // first. The sort is stable, so equally-scored cards keep alternating
      // between partners. Sorting per pass rather than globally keeps
      // preference-matching cards ahead of relaxed-filter filler.
      .sort((a, b) => b.score - a.score);

    for (const card of filled) {
      chosen.add(card.placeId);
      deck.push(card);
    }

    // Record the deepest pass that actually contributed a card, so the UI can
    // be honest about having widened the search.
    if (filled.length > 0) strategy = pass;
  }

  return { deck, strategy };
};
