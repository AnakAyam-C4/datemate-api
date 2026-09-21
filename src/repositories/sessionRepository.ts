import type { DocumentReference, Transaction } from "firebase-admin/firestore";
import { firestore, Timestamp } from "../config/firebase";
import { COLLECTIONS } from "../config/env";
import { AppError } from "../utils/http/AppError";
import { STATUS } from "../utils/http/statusCodes";
import { isLive, type MatchSession, type SessionStatus } from "../types/session";

export const sessionRef = (sessionId: string): DocumentReference =>
  firestore.collection(COLLECTIONS.matchSessions).doc(sessionId);

export const newSessionRef = (): DocumentReference =>
  firestore.collection(COLLECTIONS.matchSessions).doc();

const toSession = (
  id: string,
  data: FirebaseFirestore.DocumentData,
): MatchSession => ({ id, ...data }) as MatchSession;

export const getSession = async (
  sessionId: string,
): Promise<MatchSession | null> => {
  const snapshot = await sessionRef(sessionId).get();
  if (!snapshot.exists) return null;

  return toSession(snapshot.id, snapshot.data()!);
};

export const getSessionInTransaction = async (
  transaction: Transaction,
  sessionId: string,
): Promise<MatchSession> => {
  const snapshot = await transaction.get(sessionRef(sessionId));

  if (!snapshot.exists) {
    throw new AppError("Session not found", STATUS.NOT_FOUND);
  }

  return toSession(snapshot.id, snapshot.data()!);
};

/** A session the caller is not part of is reported as missing, not forbidden. */
export const assertParticipant = (
  session: MatchSession,
  uid: string,
): MatchSession => {
  if (!session.participants?.includes(uid)) {
    throw new AppError("Session not found", STATUS.NOT_FOUND);
  }

  return session;
};

export const hasExpired = (session: MatchSession): boolean =>
  isLive(session.status) &&
  Boolean(session.expiresAt) &&
  session.expiresAt.toMillis() <= Date.now();

/**
 * Lazy expiry.
 *
 * Nothing runs on a schedule on the Spark plan, so an abandoned session is
 * reaped the next time anyone looks at it. This keeps the invariant "at most
 * one live session per couple" true without a cron job or a Cloud Function.
 */
export const expireInTransaction = (
  transaction: Transaction,
  session: MatchSession,
): MatchSession => {
  const now = Timestamp.now();

  transaction.update(sessionRef(session.id), {
    status: "expired" satisfies SessionStatus,
    updatedAt: now,
    version: (session.version ?? 0) + 1,
  });

  return { ...session, status: "expired", updatedAt: now };
};

/**
 * Serialises a session for the HTTP response.
 *
 * Firestore `Timestamp`s become ISO strings so the iOS app can decode a REST
 * response with a plain `JSONDecoder`, while its snapshot listener keeps
 * receiving native `Timestamp`s. Both paths end up at the same model.
 */
export const serialiseSession = (session: MatchSession) => {
  const iso = (value: Timestamp | null | undefined) =>
    value ? value.toDate().toISOString() : null;

  return {
    id: session.id,
    coupleId: session.coupleId,
    participants: session.participants,
    initiatorId: session.initiatorId,
    status: session.status,
    version: session.version ?? 0,
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
    expiresAt: iso(session.expiresAt),
    members: Object.fromEntries(
      Object.entries(session.members ?? {}).map(([uid, member]) => [
        uid,
        {
          joinedAt: iso(member.joinedAt),
          lastSeenAt: iso(member.lastSeenAt),
          ready: member.ready ?? false,
        },
      ]),
    ),
    preferences: session.preferences ?? {},
    swipes: session.swipes ?? {},
    deck: session.deck ?? null,
    deckStrategy: session.deckStrategy ?? null,
    deckGeneratedAt: iso(session.deckGeneratedAt),
    result: session.result
      ? {
          matches: session.result.matches,
          decidedAt: iso(session.result.decidedAt),
        }
      : null,
    upcomingId: session.upcomingId ?? null,
    cancelledBy: session.cancelledBy ?? null,
    cancelReason: session.cancelReason ?? null,
  };
};
