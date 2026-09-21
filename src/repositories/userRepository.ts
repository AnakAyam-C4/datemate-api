import { firestore, FieldValue } from "../config/firebase";
import { COLLECTIONS } from "../config/env";

export type UserProfile = {
  id: string;
  name?: string;
  surname?: string;
  connectCode?: string;
  avatarUrl?: string;
  /** Device tokens for FCM. An array because a user may have several devices. */
  fcmTokens?: string[];
};

export const userRef = (uid: string) =>
  firestore.collection(COLLECTIONS.users).doc(uid);

export const getUser = async (uid: string): Promise<UserProfile | null> => {
  const snapshot = await userRef(uid).get();
  if (!snapshot.exists) return null;

  return { id: snapshot.id, ...snapshot.data() } as UserProfile;
};

export const getUsers = async (uids: string[]): Promise<UserProfile[]> => {
  if (uids.length === 0) return [];

  const snapshots = await firestore.getAll(...uids.map(userRef));

  return snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }) as UserProfile);
};

export const addFcmToken = async (uid: string, token: string): Promise<void> => {
  await userRef(uid).set(
    { fcmTokens: FieldValue.arrayUnion(token) },
    { merge: true },
  );
};

/** Called when FCM reports a token as unregistered, so it is not retried forever. */
export const removeFcmTokens = async (
  uid: string,
  tokens: string[],
): Promise<void> => {
  if (tokens.length === 0) return;

  await userRef(uid).set(
    { fcmTokens: FieldValue.arrayRemove(...tokens) },
    { merge: true },
  );
};
