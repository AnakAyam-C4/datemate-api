import { firestore } from "../config/firebase";
import { COLLECTIONS, SESSION } from "../config/env";

export type Place = {
  id: string;
  savedBy: string;
  collectionId?: string;
  title: string;
  url?: string | null;
  desc?: string | null;
  tags?: string[];
  priceLevel?: number | null;
  thumbnailUrl?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  hasVisited?: boolean;
  createdAt?: unknown;
};

/**
 * Every unvisited place saved by either partner.
 *
 * One query for both partners (`in` with two values) rather than two queries,
 * and capped by `candidateReadLimit` so a power user with thousands of saved
 * places cannot blow a meaningful hole in the 50k/day read quota on a single
 * deck generation.
 *
 * Requires a composite index on (savedBy ASC, hasVisited ASC) — see
 * firestore.indexes.json.
 */
export const findCandidatePlaces = async (
  uids: string[],
  options?: { limit?: number },
): Promise<Place[]> => {
  const snapshot = await firestore
    .collection(COLLECTIONS.places)
    .where("savedBy", "in", uids)
    .where("hasVisited", "==", false)
    .limit(options?.limit ?? SESSION.candidateReadLimit)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Place);
};
