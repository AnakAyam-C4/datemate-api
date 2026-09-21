import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { FIREBASE } from "./env";

/**
 * firebase-admin is initialised on first use, not at import time.
 *
 * Initialising eagerly meant a missing or malformed service-account key threw
 * while the module graph was still loading, which takes down every route —
 * including `/health` — with an opaque OpenSSL error. Deferring it means bad
 * credentials surface as a normal failed request on the routes that actually
 * need Firestore.
 */
let cachedApp: App | null = null;

const firebaseApp = (): App => {
  if (cachedApp) return cachedApp;

  const existing = getApps()[0];

  if (existing) {
    cachedApp = existing;
    return cachedApp;
  }

  const missing = (
    ["projectId", "clientEmail", "privateKey"] as const
  ).filter((key) => !FIREBASE[key]);

  if (missing.length > 0) {
    throw new Error(
      `Firebase is not configured: missing ${missing
        .map((key) => `FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`)
        .join(", ")}`,
    );
  }

  cachedApp = initializeApp({
    credential: cert({
      projectId: FIREBASE.projectId,
      clientEmail: FIREBASE.clientEmail,
      privateKey: FIREBASE.privateKey,
    }),
  });

  return cachedApp;
};

/**
 * Lazy handles that behave exactly like the SDK clients at every call site.
 * The proxy resolves (and memoises) the real client on first property access.
 */
const lazyClient = <T extends object>(resolve: () => T): T =>
  new Proxy({} as T, {
    get(_target, property) {
      const client = resolve();
      const value = Reflect.get(client, property);

      // Bind so SDK methods keep `this` pointing at the real client rather
      // than at this proxy, which has none of their internal state.
      return typeof value === "function" ? value.bind(client) : value;
    },
  });

let cachedFirestore: Firestore | null = null;
let cachedAuth: Auth | null = null;
let cachedMessaging: Messaging | null = null;

export const firestore = lazyClient<Firestore>(
  () => (cachedFirestore ??= getFirestore(firebaseApp())),
);

export const auth = lazyClient<Auth>(
  () => (cachedAuth ??= getAuth(firebaseApp())),
);

export const messaging = lazyClient<Messaging>(
  () => (cachedMessaging ??= getMessaging(firebaseApp())),
);

export { FieldValue, Timestamp } from "firebase-admin/firestore";
