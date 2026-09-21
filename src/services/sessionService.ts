import type { Transaction } from "firebase-admin/firestore";
import { firestore, FieldValue, Timestamp } from "../config/firebase";
import { SESSION } from "../config/env";
import { AppError } from "../utils/http/AppError";
import { STATUS } from "../utils/http/statusCodes";
import {
  isLive,
  type MatchSession,
  type SessionPreferences,
  type SessionStatus,
} from "../types/session";
import {
  assertParticipant,
  expireInTransaction,
  getSession,
  getSessionInTransaction,
  hasExpired,
  newSessionRef,
  sessionRef,
} from "../repositories/sessionRepository";
import {
  coupleRef,
  membersOf,
  partnerOf,
  requireCoupleFor,
  type Couple,
} from "../repositories/coupleRepository";
import { findCandidatePlaces } from "../repositories/placeRepository";
import { getUser } from "../repositories/userRepository";
import {
  createUpcomingInTransaction,
  newUpcomingRef,
} from "../repositories/upcomingRepository";
import { buildDeck } from "./deckService";
import {
  notifyPartner,
  sessionInvitePush,
  sessionMatchedPush,
  sessionReadyPush,
} from "./notificationService";

const minutesFromNow = (minutes: number) =>
  Timestamp.fromMillis(Date.now() + minutes * 60_000);

const emptyMember = () => ({
  joinedAt: null,
  lastSeenAt: null,
  ready: false,
});

const emptySwipes = () => ({ seen: [] as string[], yes: [] as string[] });

/**
 * A partner counts as present if their heartbeat is recent. Used only to decide
 * whether a push is worth sending — never to gate a state transition, because a
 * backgrounded app stops heartbeating while still being perfectly able to act.
 */
const isPresent = (session: MatchSession, uid: string): boolean => {
  const lastSeenAt = session.members?.[uid]?.lastSeenAt;
  if (!lastSeenAt) return false;

  return Date.now() - lastSeenAt.toMillis() < SESSION.presenceWindowSeconds * 1000;
};

const assertActionable = (session: MatchSession): MatchSession => {
  if (session.status === "cancelled") {
    throw new AppError("This session was cancelled", STATUS.GONE);
  }

  if (session.status === "expired") {
    throw new AppError("This session expired", STATUS.GONE);
  }

  return session;
};

/**
 * Loads a session inside a transaction, expiring it first if its TTL has passed.
 *
 * Every write path goes through here, which is what makes lazy expiry reliable
 * without a scheduler: an abandoned session cannot be resurrected by a late
 * client, it gets reaped on first touch.
 */
const loadForWrite = async (
  transaction: Transaction,
  sessionId: string,
  uid: string,
): Promise<MatchSession> => {
  const session = assertParticipant(
    await getSessionInTransaction(transaction, sessionId),
    uid,
  );

  if (hasExpired(session)) {
    expireInTransaction(transaction, session);
    throw new AppError("This session expired", STATUS.GONE);
  }

  return assertActionable(session);
};

const bump = (session: MatchSession, fields: Record<string, unknown>) => ({
  ...fields,
  updatedAt: Timestamp.now(),
  version: (session.version ?? 0) + 1,
});

// ---------------------------------------------------------------------------
// Create / read
// ---------------------------------------------------------------------------

/**
 * Starts a session, or returns the couple's existing live one.
 *
 * Idempotency comes from the couple document: both partners tapping "Decide
 * with Partner" at the same instant contend on `couples/{id}`, Firestore
 * serialises the two transactions, and the loser sees `activeSessionId` already
 * set and returns that session instead of creating a second one.
 */
export const createOrGetSession = async (
  uid: string,
  coupleId?: string | null,
): Promise<{ session: MatchSession; created: boolean }> => {
  const couple = await requireCoupleFor(uid, coupleId);
  const partnerId = partnerOf(couple, uid);
  const participants = membersOf(couple);

  const outcome = await firestore.runTransaction(async (transaction) => {
    const coupleSnapshot = await transaction.get(coupleRef(couple.id));
    const activeSessionId = (coupleSnapshot.data() as Couple | undefined)
      ?.activeSessionId;

    if (activeSessionId) {
      const existingSnapshot = await transaction.get(sessionRef(activeSessionId));

      if (existingSnapshot.exists) {
        const existing = {
          id: existingSnapshot.id,
          ...existingSnapshot.data(),
        } as MatchSession;

        if (isLive(existing.status) && !hasExpired(existing)) {
          return { session: existing, created: false };
        }

        // Stale pointer: reap it, then fall through and create a fresh session.
        if (hasExpired(existing)) expireInTransaction(transaction, existing);
      }
    }

    const ref = newSessionRef();
    const now = Timestamp.now();

    const session: MatchSession = {
      id: ref.id,
      coupleId: couple.id,
      participants,
      initiatorId: uid,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
      expiresAt: minutesFromNow(SESSION.ttlMinutes),
      version: 1,
      members: Object.fromEntries(
        participants.map((participant) => [
          participant,
          participant === uid
            ? { joinedAt: now, lastSeenAt: now, ready: false }
            : emptyMember(),
        ]),
      ),
      preferences: {},
      swipes: Object.fromEntries(
        participants.map((participant) => [participant, emptySwipes()]),
      ),
      deck: null,
      deckGeneratedAt: null,
      deckStrategy: null,
      result: null,
      upcomingId: null,
      cancelledBy: null,
      cancelReason: null,
      lastNudgeAt: null,
    };

    const { id: _id, ...document } = session;

    transaction.set(ref, document);
    transaction.set(
      coupleRef(couple.id),
      { activeSessionId: ref.id },
      { merge: true },
    );

    return { session, created: true };
  });

  if (outcome.created) {
    const initiator = await getUser(uid);
    const name = initiator?.name?.trim() || "Your partner";

    await notifyPartner(partnerId, sessionInvitePush(outcome.session.id, name));
  }

  return outcome;
};

/** Read path, with the same lazy expiry as the write paths. */
export const readSession = async (
  uid: string,
  sessionId: string,
): Promise<MatchSession> => {
  const session = await getSession(sessionId);

  if (!session) throw new AppError("Session not found", STATUS.NOT_FOUND);

  assertParticipant(session, uid);

  if (!hasExpired(session)) return session;

  return firestore.runTransaction(async (transaction) => {
    const fresh = await getSessionInTransaction(transaction, sessionId);
    if (!hasExpired(fresh)) return fresh;

    return expireInTransaction(transaction, fresh);
  });
};

/** Used on cold start / after tapping a push, when the client has no session id. */
export const findActiveSession = async (
  uid: string,
  coupleId?: string | null,
): Promise<MatchSession | null> => {
  const couple = await requireCoupleFor(uid, coupleId);
  if (!couple.activeSessionId) return null;

  try {
    const session = await readSession(uid, couple.activeSessionId);
    return isLive(session.status) ? session : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export const joinSession = async (
  uid: string,
  sessionId: string,
): Promise<MatchSession> =>
  firestore.runTransaction(async (transaction) => {
    const session = await loadForWrite(transaction, sessionId, uid);
    const now = Timestamp.now();

    const updates: Record<string, unknown> = {
      [`members.${uid}.lastSeenAt`]: now,
    };

    if (!session.members?.[uid]?.joinedAt) {
      updates[`members.${uid}.joinedAt`] = now;
    }

    const everyoneJoined = session.participants.every(
      (participant) =>
        participant === uid || Boolean(session.members?.[participant]?.joinedAt),
    );

    const nextStatus: SessionStatus =
      session.status === "waiting" && everyoneJoined
        ? "preferences"
        : session.status;

    if (nextStatus !== session.status) updates.status = nextStatus;

    transaction.update(sessionRef(sessionId), bump(session, updates));

    return {
      ...session,
      status: nextStatus,
      members: {
        ...session.members,
        [uid]: {
          ...(session.members?.[uid] ?? emptyMember()),
          joinedAt: session.members?.[uid]?.joinedAt ?? now,
          lastSeenAt: now,
        },
      },
    };
  });

// ---------------------------------------------------------------------------
// Preferences + deck
// ---------------------------------------------------------------------------

const bothReady = (session: MatchSession): boolean =>
  session.participants.every(
    (participant) =>
      session.members?.[participant]?.ready &&
      session.members?.[participant]?.joinedAt,
  );

/**
 * Records this partner's preferences and reports whether the deck can now be
 * built. The caller generates the deck in a separate step so the transaction
 * stays short — Firestore retries transactions, and a few hundred place reads
 * inside one is exactly the kind of work that makes retries expensive.
 */
export const submitPreferences = async (
  uid: string,
  sessionId: string,
  preferences: SessionPreferences,
): Promise<{ session: MatchSession; deckReady: boolean }> =>
  firestore.runTransaction(async (transaction) => {
    const session = await loadForWrite(transaction, sessionId, uid);

    if (session.status !== "waiting" && session.status !== "preferences") {
      // Re-submitting after the deck exists is a no-op rather than an error:
      // the client may retry a request whose response was lost.
      return { session, deckReady: false };
    }

    const now = Timestamp.now();

    transaction.update(
      sessionRef(sessionId),
      bump(session, {
        [`preferences.${uid}`]: preferences,
        [`members.${uid}.ready`]: true,
        [`members.${uid}.lastSeenAt`]: now,
        [`members.${uid}.joinedAt`]: session.members?.[uid]?.joinedAt ?? now,
      }),
    );

    const updated: MatchSession = {
      ...session,
      preferences: { ...session.preferences, [uid]: preferences },
      members: {
        ...session.members,
        [uid]: {
          joinedAt: session.members?.[uid]?.joinedAt ?? now,
          lastSeenAt: now,
          ready: true,
        },
      },
    };

    return { session: updated, deckReady: bothReady(updated) };
  });

/**
 * Builds and stores the deck. Safe to call from both clients simultaneously and
 * safe to retry: the places are read outside the transaction, and the
 * transaction only claims the `deck` slot if it is still empty.
 *
 * Clients should call this explicitly when they observe both partners ready but
 * the status has not moved to `swiping` within a second or two — that is the
 * recovery path for a serverless invocation that died mid-generation.
 */
export const generateDeck = async (
  uid: string,
  sessionId: string,
): Promise<MatchSession> => {
  const session = assertActionable(await readSession(uid, sessionId));

  if (session.deck && session.deck.length > 0) return session;

  if (!bothReady(session)) {
    throw new AppError(
      "Both partners must join and pick preferences first",
      STATUS.CONFLICT,
    );
  }

  const places = await findCandidatePlaces(session.participants);

  if (places.length === 0) {
    throw new AppError(
      "Neither of you has any unvisited saved places to choose from",
      STATUS.CONFLICT,
    );
  }

  const { deck, strategy } = buildDeck({
    sessionId,
    places,
    preferences: session.preferences ?? {},
    participants: session.participants,
  });

  const result = await firestore.runTransaction(async (transaction) => {
    const fresh = await loadForWrite(transaction, sessionId, uid);

    // Someone else won the race. Their deck is identical (generation is seeded
    // by session id), so just use it.
    if (fresh.deck && fresh.deck.length > 0) {
      return { session: fresh, generated: false };
    }

    const now = Timestamp.now();

    transaction.update(
      sessionRef(sessionId),
      bump(fresh, {
        deck,
        deckStrategy: strategy,
        deckGeneratedAt: now,
        status: "swiping" satisfies SessionStatus,
        // Reset swipe state so a regenerated deck never inherits stale answers.
        swipes: Object.fromEntries(
          fresh.participants.map((participant) => [participant, emptySwipes()]),
        ),
      }),
    );

    return {
      session: {
        ...fresh,
        deck,
        deckStrategy: strategy,
        deckGeneratedAt: now,
        status: "swiping" as SessionStatus,
      },
      generated: true,
    };
  });

  if (result.generated) {
    const partnerId = session.participants.find(
      (participant) => participant !== uid,
    );

    // Only nudge a partner who is not already watching the session.
    if (partnerId && !isPresent(session, partnerId)) {
      await notifyPartner(partnerId, sessionReadyPush(sessionId));
    }
  }

  return result.session;
};

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

const deckPlaceIds = (session: MatchSession): string[] =>
  (session.deck ?? []).map((card) => card.placeId);

export const swipeProgress = (session: MatchSession) => {
  const total = deckPlaceIds(session).length;

  return Object.fromEntries(
    session.participants.map((participant) => [
      participant,
      { seen: session.swipes?.[participant]?.seen?.length ?? 0, total },
    ]),
  );
};

const everyoneFinished = (session: MatchSession): boolean => {
  const placeIds = deckPlaceIds(session);
  if (placeIds.length === 0) return false;

  return session.participants.every((participant) => {
    const seen = new Set(session.swipes?.[participant]?.seen ?? []);
    return placeIds.every((placeId) => seen.has(placeId));
  });
};

/**
 * Freezes the result once both partners have swiped the whole deck.
 *
 * The client can compute the same intersection locally from its snapshot and
 * render matches instantly — this call exists to make that result authoritative
 * and to move the session out of `swiping`. Both clients calling it is fine.
 */
export const finaliseSession = async (
  uid: string,
  sessionId: string,
): Promise<MatchSession> => {
  const outcome = await firestore.runTransaction(async (transaction) => {
    const session = await loadForWrite(transaction, sessionId, uid);

    if (session.result) return { session, finalised: false };

    if (session.status !== "swiping") {
      throw new AppError(
        `Cannot finalise a session in "${session.status}"`,
        STATUS.CONFLICT,
      );
    }

    if (!everyoneFinished(session)) {
      throw new AppError(
        "Both partners still have cards left to swipe",
        STATUS.CONFLICT,
      );
    }

    // Keep deck order so both clients render matches in the same sequence.
    const yesSets = session.participants.map(
      (participant) => new Set(session.swipes?.[participant]?.yes ?? []),
    );

    const matches = deckPlaceIds(session).filter((placeId) =>
      yesSets.every((yes) => yes.has(placeId)),
    );

    const now = Timestamp.now();
    const result = { matches, decidedAt: now };

    transaction.update(
      sessionRef(sessionId),
      bump(session, {
        result,
        status: "completed" satisfies SessionStatus,
        [`members.${uid}.lastSeenAt`]: now,
      }),
    );

    return {
      session: { ...session, result, status: "completed" as SessionStatus },
      finalised: true,
    };
  });

  if (outcome.finalised) {
    const partnerId = outcome.session.participants.find(
      (participant) => participant !== uid,
    );

    if (partnerId && !isPresent(outcome.session, partnerId)) {
      await notifyPartner(
        partnerId,
        sessionMatchedPush(sessionId, outcome.session.result?.matches.length ?? 0),
      );
    }
  }

  return outcome.session;
};

// ---------------------------------------------------------------------------
// Select a match -> upcoming
// ---------------------------------------------------------------------------

/**
 * Turns a match into a scheduled date.
 *
 * The `upcoming` row and the session's `resolved` status are written in one
 * transaction, so the two can never disagree. If both partners tap at the same
 * time the first write wins and the second call returns that same result rather
 * than creating a duplicate date.
 */
export const selectMatch = async (
  uid: string,
  sessionId: string,
  placeId: string,
  datetime: Date,
): Promise<{ session: MatchSession; upcomingId: string }> =>
  firestore.runTransaction(async (transaction) => {
    const session = await loadForWrite(transaction, sessionId, uid);
    const coupleSnapshot = await transaction.get(coupleRef(session.coupleId));

    if (session.upcomingId) {
      return { session, upcomingId: session.upcomingId };
    }

    if (session.status !== "completed") {
      throw new AppError(
        "Finish swiping before picking a date",
        STATUS.CONFLICT,
      );
    }

    if (!session.result?.matches.includes(placeId)) {
      throw new AppError("That place is not one of your matches", STATUS.BAD_REQUEST);
    }

    const upcomingId = newUpcomingRef().id;

    createUpcomingInTransaction(transaction, {
      id: upcomingId,
      coupleId: session.coupleId,
      placeId,
      datetime: Timestamp.fromDate(datetime),
      createdBy: uid,
      source: "decide-with-partner",
      sessionId,
    });

    transaction.update(
      sessionRef(sessionId),
      bump(session, {
        upcomingId,
        status: "resolved" satisfies SessionStatus,
      }),
    );

    // Release the couple's slot only if it still points at this session.
    if ((coupleSnapshot.data() as Couple | undefined)?.activeSessionId === sessionId) {
      transaction.update(coupleRef(session.coupleId), {
        activeSessionId: FieldValue.delete(),
      });
    }

    return {
      session: { ...session, upcomingId, status: "resolved" as SessionStatus },
      upcomingId,
    };
  });

// ---------------------------------------------------------------------------
// Cancel / nudge
// ---------------------------------------------------------------------------

export const cancelSession = async (
  uid: string,
  sessionId: string,
  reason: string | null,
): Promise<MatchSession> =>
  firestore.runTransaction(async (transaction) => {
    const session = assertParticipant(
      await getSessionInTransaction(transaction, sessionId),
      uid,
    );

    const coupleSnapshot = await transaction.get(coupleRef(session.coupleId));

    if (!isLive(session.status)) return session;

    transaction.update(
      sessionRef(sessionId),
      bump(session, {
        status: "cancelled" satisfies SessionStatus,
        cancelledBy: uid,
        cancelReason: reason,
      }),
    );

    if ((coupleSnapshot.data() as Couple | undefined)?.activeSessionId === sessionId) {
      transaction.update(coupleRef(session.coupleId), {
        activeSessionId: FieldValue.delete(),
      });
    }

    return { ...session, status: "cancelled" as SessionStatus, cancelledBy: uid };
  });

/** Re-sends the invite push, rate-limited so it cannot be used to spam. */
export const nudgePartner = async (
  uid: string,
  sessionId: string,
): Promise<{ sent: number }> => {
  const session = assertActionable(await readSession(uid, sessionId));

  const lastNudgeAt = session.lastNudgeAt?.toMillis() ?? 0;
  const elapsed = Date.now() - lastNudgeAt;

  if (elapsed < SESSION.nudgeCooldownSeconds * 1000) {
    throw new AppError(
      `Hold on a moment before nudging again`,
      STATUS.TOO_MANY_REQUESTS,
    );
  }

  await sessionRef(sessionId).update({ lastNudgeAt: Timestamp.now() });

  const partnerId = session.participants.find(
    (participant) => participant !== uid,
  );

  if (!partnerId) return { sent: 0 };

  const initiator = await getUser(uid);
  const name = initiator?.name?.trim() || "Your partner";

  const { sent } = await notifyPartner(
    partnerId,
    sessionInvitePush(sessionId, name),
  );

  return { sent };
};
