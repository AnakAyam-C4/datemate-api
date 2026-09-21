import { firestore, Timestamp } from "../config/firebase";
import { COLLECTIONS } from "../config/env";
import type { Transaction } from "firebase-admin/firestore";

export type UpcomingDate = {
  id: string;
  coupleId: string;
  placeId: string;
  datetime: Timestamp;
  createdBy: string;
  /** Provenance, so the app can show "decided together" on the card. */
  source: "decide-with-partner" | "manual";
  sessionId?: string | null;
  createdAt: Timestamp;
};

export const newUpcomingRef = () =>
  firestore.collection(COLLECTIONS.upcoming).doc();

/**
 * Written inside the same transaction that marks the session resolved, so a
 * session can never end up resolved without its `upcoming` row (or vice versa).
 */
export const createUpcomingInTransaction = (
  transaction: Transaction,
  data: Omit<UpcomingDate, "createdAt"> & { createdAt?: Timestamp },
): void => {
  const ref = firestore.collection(COLLECTIONS.upcoming).doc(data.id);

  transaction.set(ref, {
    ...data,
    createdAt: data.createdAt ?? Timestamp.now(),
  });
};
