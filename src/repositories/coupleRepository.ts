import type { DocumentReference } from "firebase-admin/firestore";
import { firestore } from "../config/firebase";
import { COLLECTIONS } from "../config/env";
import { AppError } from "../utils/http/AppError";
import { STATUS } from "../utils/http/statusCodes";

export type Couple = {
  id: string;
  user1Id: string;
  user2Id: string;
  anniversary?: unknown;
  /**
   * Pointer to the live session, written by the server.
   *
   * The iOS app already listens to its couple document, so this single field is
   * what pulls the partner into a session without any push dependency — FCM is
   * only needed when the app is backgrounded.
   */
  activeSessionId?: string | null;
};

export const coupleRef = (coupleId: string): DocumentReference =>
  firestore.collection(COLLECTIONS.couples).doc(coupleId);

export const partnerOf = (couple: Couple, uid: string): string => {
  if (couple.user1Id === uid) return couple.user2Id;
  if (couple.user2Id === uid) return couple.user1Id;

  throw new AppError("You are not part of this couple", STATUS.FORBIDDEN);
};

export const membersOf = (couple: Couple): string[] => [
  couple.user1Id,
  couple.user2Id,
];

export const getCouple = async (coupleId: string): Promise<Couple> => {
  const snapshot = await coupleRef(coupleId).get();

  if (!snapshot.exists) {
    throw new AppError("Couple not found", STATUS.NOT_FOUND);
  }

  return { id: snapshot.id, ...snapshot.data() } as Couple;
};

/**
 * Finds the couple a user belongs to.
 *
 * The existing schema stores the two partners as `user1Id`/`user2Id`, which
 * cannot be expressed as one equality query, so this costs two reads. Clients
 * should send `coupleId` (they already hold it) to skip this entirely.
 */
export const findCoupleForUser = async (uid: string): Promise<Couple> => {
  const collection = firestore.collection(COLLECTIONS.couples);

  const [asUser1, asUser2] = await Promise.all([
    collection.where("user1Id", "==", uid).limit(1).get(),
    collection.where("user2Id", "==", uid).limit(1).get(),
  ]);

  const doc = asUser1.docs[0] ?? asUser2.docs[0];

  if (!doc) {
    throw new AppError(
      "You are not connected to a partner yet",
      STATUS.NOT_FOUND,
    );
  }

  return { id: doc.id, ...doc.data() } as Couple;
};

/**
 * Resolves the couple for this request and asserts the caller belongs to it.
 * Every session endpoint goes through here.
 */
export const requireCoupleFor = async (
  uid: string,
  coupleId?: string | null,
): Promise<Couple> => {
  const couple = coupleId ? await getCouple(coupleId) : await findCoupleForUser(uid);

  // Throws if the caller is not one of the two partners.
  partnerOf(couple, uid);

  return couple;
};
