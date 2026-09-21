import type { Timestamp } from "firebase-admin/firestore";

/**
 * Lifecycle of `matchSessions/{sessionId}`.
 *
 * There are no Cloud Functions on the Spark plan, so nothing advances these
 * states on its own — every transition below is caused by a client calling an
 * endpoint. Each transition is therefore written inside a Firestore transaction
 * and is safe to invoke twice (both partners may call at the same moment).
 *
 *   waiting     both partners invited, at least one has not joined yet
 *   preferences both joined, collecting preference tags
 *   swiping     deck generated, partners are swiping
 *   completed   both finished the deck, matches computed
 *   resolved    a match was chosen and written to `upcoming`
 *   cancelled   someone backed out
 *   expired     nobody finished before `expiresAt` (evaluated lazily on read)
 */
export type SessionStatus =
  | "waiting"
  | "preferences"
  | "swiping"
  | "completed"
  | "resolved"
  | "cancelled"
  | "expired";

/** Statuses where the session is still worth listening to. */
export const LIVE_STATUSES: SessionStatus[] = [
  "waiting",
  "preferences",
  "swiping",
  "completed",
];

export const isLive = (status: SessionStatus) => LIVE_STATUSES.includes(status);

export type SessionMember = {
  joinedAt: Timestamp | null;
  /** Refreshed by the client heartbeat; presence is derived from this. */
  lastSeenAt: Timestamp | null;
  /** True once this partner has submitted their preference tags. */
  ready: boolean;
};

export type SessionPreferences = {
  tags: string[];
  priceLevels: number[];
  lat: number | null;
  lng: number | null;
  maxDistanceKm: number;
};

/**
 * Denormalised copy of a place, embedded in the session document.
 *
 * Embedding rather than storing ids means the swiping UI renders from the one
 * snapshot listener the client already has: no N extra reads per partner per
 * deck, which matters against a 50k/day read quota.
 */
export type DeckCard = {
  placeId: string;
  ownerId: string;
  title: string;
  desc: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  address: string | null;
  tags: string[];
  priceLevel: number | null;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  /** Ranking score, exposed for debugging and for "why am I seeing this?" copy. */
  score: number;
};

/**
 * How hard the generator had to work to fill the deck. The app can use this to
 * set honest copy ("we widened the search to fill your deck").
 */
export type DeckStrategy =
  | "strict"
  | "relaxed-tags"
  | "widened-radius"
  | "fallback-any";

export type SessionSwipes = {
  /** Every card this partner has resolved, yes or no. Drives the progress bar. */
  seen: string[];
  /** Cards this partner said yes to. Intersection of both = matches. */
  yes: string[];
};

export type MatchSession = {
  id: string;
  coupleId: string;
  /** Both uids, denormalised for `array-contains` lookups and security rules. */
  participants: string[];
  initiatorId: string;
  status: SessionStatus;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;

  /**
   * Incremented on every server-side transition. Lets the iOS listener discard
   * an out-of-order snapshot instead of flickering backwards through states.
   */
  version: number;

  members: Record<string, SessionMember>;
  preferences: Record<string, SessionPreferences>;
  /** Written directly by clients (one update per swipe), never by the server. */
  swipes: Record<string, SessionSwipes>;

  deck: DeckCard[] | null;
  deckGeneratedAt: Timestamp | null;
  deckStrategy: DeckStrategy | null;

  result: { matches: string[]; decidedAt: Timestamp } | null;
  upcomingId: string | null;

  cancelledBy: string | null;
  cancelReason: string | null;
  lastNudgeAt: Timestamp | null;
};
