# datemate-api

Backend for **DateMate**, the couples date-planning iOS app.

Express + TypeScript on top of Firestore (firebase-admin). Currently it serves
one feature: **Decide with Partner** — two partners swipe the same deck of their
saved date spots and keep what they both liked.

## Architecture in one line

Firestore is the realtime transport, Express is the brain, and there are no
WebSockets: clients subscribe to the session document with `addSnapshotListener`
and the server pushes state into that document through firebase-admin.

Read **[docs/decide-with-partner.md](docs/decide-with-partner.md)** before
touching the session code — in particular the part about there being no Cloud
Functions on the Spark plan, which is why every endpoint is idempotent and the
client has to call things at the right moment.

## Layout

```
api/index.ts            serverless entry (exports the same app)
src/
  app.ts                express app: cors, json, routes, error handler
  index.ts              local entry (app.listen)
  config/               env + lazily-initialised firebase clients
  routes/               /v1/sessions, /v1/users
  controllers/          HTTP shape: parse, validate, serialise
  services/             the logic — sessions (transactions), deck, FCM
  repositories/         all Firestore access lives here
  utils/                geo, seeded RNG, validation, AppError
```

Firestore is only touched from `repositories/`. `services/deckService.ts` is a
pure function, which is why it can be tested with no credentials.

## Running it

```bash
npm install
cp .env.example .env    # fill in the service account
npm run dev
```

```bash
curl localhost:3000/health
```

`/health` deliberately touches nothing, so it works without Firebase configured
and spends no quota on uptime checks.

## Checks

```bash
npm run typecheck
```

```bash
npm test
```

## Firestore setup

- Deploy the index in `firestore.indexes.json` (`places` on `savedBy`,
  `hasVisited`).
- Merge `firestore.matchSessions.rules` into the project's existing
  `firestore.rules`. It is intentionally a separate file so deploying it whole
  cannot wipe the rules the iOS app already relies on.

## Configuration

Service account via `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
`FIREBASE_PRIVATE_KEY`. Set `ENVIROMENT=PROD` in production so error responses
stop including stack traces. Everything else is optional tuning — see
`.env.example` and `src/config/env.ts`.
