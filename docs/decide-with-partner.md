# Decide with Partner — backend contract

Replaces the GameKit implementation. There is no peer discovery: the couple is
already known from `couples/{coupleId}`.

**Firestore is the realtime transport. Express is the brain.**

- Clients `addSnapshotListener` on `matchSessions/{sessionId}` and get updates
  straight from Firestore.
- Express writes through firebase-admin, so those updates reach both clients
  without the server holding a connection.
- The server is only called for discrete actions. Swipes and heartbeats are
  plain client writes.

## The Spark-plan constraint that shapes everything

**No Cloud Functions.** Nothing reacts to a Firestore change on its own. So:

1. **The client must call the endpoint at the right moment.** Nothing advances
   a session while both apps sit idle.
2. **Every endpoint is idempotent.** Both partners will call the same endpoint
   at the same instant. Each one runs inside a Firestore transaction that
   re-checks the precondition, so the loser of a race returns the winner's
   result instead of duplicating work.
3. **Expiry is lazy.** A session past `expiresAt` is marked `expired` the next
   time anyone touches it (`loadForWrite`), not by a scheduler.

---

## Data model: `matchSessions/{sessionId}`

```jsonc
{
  "coupleId": "cpl_123",
  "participants": ["uidA", "uidB"],   // denormalised for rules + lookups
  "initiatorId": "uidA",
  "status": "waiting",                // see state machine below
  "version": 3,                       // bumped on every server transition

  "createdAt":  "<Timestamp>",
  "updatedAt":  "<Timestamp>",
  "expiresAt":  "<Timestamp>",        // createdAt + SESSION_TTL_MINUTES

  "members": {
    "uidA": { "joinedAt": "<ts>", "lastSeenAt": "<ts>", "ready": true },
    "uidB": { "joinedAt": null,   "lastSeenAt": null,   "ready": false }
  },

  "preferences": {
    "uidA": { "tags": ["ramen"], "priceLevels": [1,2],
              "lat": -6.2, "lng": 106.8, "maxDistanceKm": 15 }
  },

  // Denormalised place copies: the swipe UI renders from the snapshot the
  // client already has, instead of N extra reads per partner per deck.
  "deck": [
    { "placeId": "p1", "ownerId": "uidA", "title": "...", "thumbnailUrl": "...",
      "tags": ["ramen"], "priceLevel": 2, "lat": -6.2, "lng": 106.8,
      "address": "...", "distanceKm": 1.4, "score": 9.2 }
  ],
  "deckStrategy": "strict",           // how hard the generator had to work
  "deckGeneratedAt": "<ts>",

  // Written by CLIENTS, one update per swipe. Never by the server.
  "swipes": {
    "uidA": { "seen": ["p1","p2"], "yes": ["p1"] },
    "uidB": { "seen": ["p1"],      "yes": [] }
  },

  "result": { "matches": ["p1"], "decidedAt": "<ts>" },
  "upcomingId": null,
  "cancelledBy": null,
  "cancelReason": null,
  "lastNudgeAt": null
}
```

`couples/{coupleId}.activeSessionId` points at the live session. **This is how
the partner gets pulled in** — their app already listens to the couple document,
so no push is required for a foregrounded app. FCM only covers the backgrounded
case.

### State machine

```
waiting ──both joined──▶ preferences ──both ready + deck built──▶ swiping
                                                                     │
                                            both swiped whole deck ──┘
                                                     ▼
                                                 completed ──pick a match──▶ resolved
                                                                              (+ upcoming/{id})

any live state ──▶ cancelled   (someone backs out)
any live state ──▶ expired     (TTL passed; applied lazily on next touch)
```

Only the server writes `status` and `version`. Security rules enforce that.

---

## Who calls what, when

| # | Moment in the UI | Client action |
|---|---|---|
| 1 | A taps "Decide with Partner" | `POST /v1/sessions` |
| 2 | B's couple listener sees `activeSessionId`, or B taps the push | `POST /v1/sessions/:id/join` |
| 3 | Each partner confirms their tags | `POST /v1/sessions/:id/preferences` |
| 4 | *(recovery)* status still `preferences` >3s after both `ready` | `POST /v1/sessions/:id/deck` |
| 5 | Each swipe | **direct Firestore write** (below) |
| 6 | Local state shows both `seen.count == deck.count` | `POST /v1/sessions/:id/finalize` |
| 7 | They pick a match and a time | `POST /v1/sessions/:id/select` |
| 8 | Back out | `POST /v1/sessions/:id/cancel` |

Step 3 is the interesting one: **both partners call it**, and the second call is
the one that finds both sides ready and generates the deck. The client does not
need to know whether it went first.

Step 4 exists because a serverless invocation can die mid-generation and nothing
will retry it. `POST /deck` is idempotent, so calling it when it was not needed
is harmless.

Step 6: both partners call it, first wins. The client can also compute the
intersection locally from its own snapshot and render matches immediately — this
call exists to make the result authoritative and move the session out of
`swiping`.

### Swipes are direct writes

```swift
let field = "swipes.\(uid)"
var update: [String: Any] = [
  "\(field).seen": FieldValue.arrayUnion([placeId]),
  "updatedAt": FieldValue.serverTimestamp(),
]
if liked { update["\(field).yes"] = FieldValue.arrayUnion([placeId]) }

sessionRef.updateData(update)   // one write, regardless of liked/passed
```

`arrayUnion` is idempotent, so a double-tap or an offline replay cannot
double-count. Partners writing different map keys never conflict.

### Heartbeat

```swift
sessionRef.updateData(["members.\(uid).lastSeenAt": FieldValue.serverTimestamp()])
```

Every **30s while the session screen is foregrounded**, and nothing otherwise.
A partner is "present" if `lastSeenAt` is under `PRESENCE_WINDOW_SECONDS` (45s)
old — compute that client-side, it costs nothing.

Presence is only used to decide whether a push is worth sending. It never gates
a state transition, because a backgrounded app stops heartbeating while still
being perfectly able to act.

---

## Endpoints

All require `Authorization: Bearer <Firebase ID token>`. The uid always comes
from the verified token, never from the body, so a client cannot act as their
partner. Responses are `{ "status": "success", "data": {...} }`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/sessions` | `{ coupleId? }` → `{ session, created }`. Returns the existing live session if there is one. `201` when created, `200` when reused. |
| `GET` | `/v1/sessions/active` | Cold start / after tapping a push, when the client has no id. |
| `GET` | `/v1/sessions/:id` | → `{ session, progress }` |
| `POST` | `/v1/sessions/:id/join` | Marks joined; flips `waiting → preferences` once both are in. |
| `POST` | `/v1/sessions/:id/preferences` | `{ tags[], priceLevels[], lat, lng, maxDistanceKm }`. Generates the deck when both are ready. |
| `POST` | `/v1/sessions/:id/deck` | Idempotent generate/retry. |
| `POST` | `/v1/sessions/:id/finalize` | → `{ session, matches }`. `409` if anyone still has cards left. |
| `POST` | `/v1/sessions/:id/select` | `{ placeId, datetime }` → `{ session, upcomingId }`. Writes `upcoming/{id}`. |
| `POST` | `/v1/sessions/:id/cancel` | `{ reason? }` |
| `POST` | `/v1/sessions/:id/nudge` | Re-sends the invite push. `429` inside the cooldown. |
| `POST` | `/v1/users/me/fcm-token` | `{ token }`. **Required for push** — see client changes. |
| `DELETE` | `/v1/users/me/fcm-token` | `{ token }`. Call on sign-out. |

Status codes worth handling: `409` "not in a state where this makes sense",
`410` session expired or cancelled (start a new one), `429` nudge cooldown.

---

## Deck generation

Source: every unvisited place saved by **either** partner
(`savedBy in [uidA, uidB]`, `hasVisited == false`), capped at
`CANDIDATE_READ_LIMIT`.

**Score** = `3 × tagScore + 2 × proximity + price`, where a tag *both* partners
asked for is worth 2 and a tag only one asked for is worth 1.

**Progressive relaxation** — passes run in order until the deck is full, and
`deckStrategy` reports the deepest one used, so the UI can be honest about it:

| Pass | Filter |
|---|---|
| `strict` | matches a requested tag, price in range, within the *stricter* partner's radius |
| `relaxed-tags` | drops the tag requirement |
| `widened-radius` | opens up to 2× the *looser* partner's radius |
| `fallback-any` | anything unvisited |

**Fairness.** Cards are selected by alternating between the two partners, so a
partner who has saved 30 spots cannot crowd out a partner who saved 3. Ordering
is separate: within each pass the deck is sorted best-first, and the stable sort
keeps equally-scored cards alternating.

**Determinism.** Generation is seeded from the session id, so if both clients
race, they build byte-identical decks — a lost race discards work rather than
causing a visible inconsistency.

---

## Quota budget (Spark: 50k reads/day, 20k writes/day)

Per completed session, roughly:

| | Writes | Reads |
|---|---|---|
| create + couple pointer | 2 | 2 |
| join, preferences ×2, deck | 4 | ~3 |
| swipes (6 cards × 2 partners) | 12 | — |
| heartbeat (30s, ~5 min, 2 partners) | ~20 | — |
| candidate places query | — | 20–300 |
| both listeners observing ~25 doc changes | — | ~50 |
| finalize + select + upcoming | 4 | ~2 |
| **total** | **~42** | **~80–360** |

That lands around **400–500 sessions/day** on either quota. The two levers if
it gets tight: lengthen the heartbeat interval (halves the writes) and lower
`CANDIDATE_READ_LIMIT`.

---

## Required Firestore setup

**Composite index** — `firestore.indexes.json`:
`places` on `savedBy ASC, hasVisited ASC`.

**Security rules** — `firestore.rules` is the complete rule set for every
collection, replacing Firebase's open test-mode default. Publish it from
Firebase Console -> Firestore Database -> Rules.

Clients may only: read a session they are in, write their own `swipes` entry,
and refresh their own `lastSeenAt`. Status and version are server-only.

---

## Required iOS changes

1. **Register the FCM token** at `POST /v1/users/me/fcm-token` after sign-in and
   on every token refresh. Without it, a backgrounded partner cannot be pulled
   into a session. `users/{uid}.fcmTokens` is an array, so multiple devices work.
2. **Listen to the couple document** for `activeSessionId` — that is the primary
   invite path for a foregrounded app; push is the backup.
3. **Handle the push payloads** by `data.type`:
   `match_session_invite`, `match_session_deck_ready`, `match_session_result`,
   each with `data.sessionId`.
4. **Ignore stale snapshots** by discarding any where `version` is lower than
   the highest already seen, so the UI cannot flicker backwards through states.
