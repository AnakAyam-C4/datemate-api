/**
 * Central place for environment-derived configuration.
 * Keep every `process.env` read in this file so misconfiguration fails loudly
 * and in one place instead of deep inside a request handler.
 */

export const PORT = process.env.PORT || "3000";

export const IS_PRODUCTION = process.env.ENVIROMENT === "PROD";

/** Firebase service account used by firebase-admin. */
export const FIREBASE = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

/**
 * Tuning knobs for "Decide with Partner".
 * These are read once per cold start; a serverless instance never mutates them.
 */
export const SESSION = {
  /** How many places end up in a deck. */
  deckSize: Number(process.env.DECK_SIZE ?? 6),

  /** A session is abandoned if it is not resolved within this window. */
  ttlMinutes: Number(process.env.SESSION_TTL_MINUTES ?? 30),

  /**
   * A participant counts as "online" if their `lastSeenAt` is newer than this.
   * The client computes presence from the session document, so this value must
   * match the heartbeat interval used by the iOS app (heartbeat * 3).
   */
  presenceWindowSeconds: Number(process.env.PRESENCE_WINDOW_SECONDS ?? 45),

  /** Upper bound on places read while building a deck (protects the read quota). */
  candidateReadLimit: Number(process.env.CANDIDATE_READ_LIMIT ?? 300),

  /** Default search radius when a client does not send one. */
  defaultRadiusKm: Number(process.env.DEFAULT_RADIUS_KM ?? 15),

  /** Minimum gap between "nudge your partner" pushes, to avoid spamming. */
  nudgeCooldownSeconds: Number(process.env.NUDGE_COOLDOWN_SECONDS ?? 60),
};

export const COLLECTIONS = {
  users: "users",
  couples: "couples",
  places: "places",
  collections: "collections",
  upcoming: "upcoming",
  matchSessions: "matchSessions",
} as const;
