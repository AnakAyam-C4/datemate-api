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
- Publish `firestore.rules` — the complete rule set for all collections. The
  iOS app talks to Firestore directly, so these rules are the only thing
  protecting user data; the backend's service account bypasses them.

## Known workaround: the `jwks-rsa` override

`package.json` pins `overrides: { "jwks-rsa": "3.2.0" }`. Do not remove it
without testing a deploy.

`firebase-admin@14` depends on `jwks-rsa@4`, which depends on `jose@6` — a pure
ESM package with no `require` condition at all. `firebase-admin/lib/utils/jwt.js`
does a **top-level** `require("jwks-rsa")`, so merely importing
`firebase-admin/auth` pulls ESM into a CommonJS require chain.

Node 22.12+ resolves that transparently, which is why it never fails locally.
Vercel's serverless runtime uses a patched module loader (with bytecode caching)
that rejects it, so every request died during module initialisation with
`ERR_REQUIRE_ESM` — including `/health`, because the crash happens at import time
before Express exists.

`jwks-rsa@3.2.0` is the same API on `jose@4`, which ships CJS. Verified: all four
`firebase-admin` subpaths load with `require(esm)` disabled, and the
`getSigningKeys()` / `getPublicKey()` surface firebase-admin actually calls works
against Google's live key endpoint.

Reproduce the failure mode locally with:

```bash
node --no-experimental-require-module -e "require('firebase-admin/auth')"
```

Drop the override once Vercel's loader supports `require(esm)`, or once
`jwks-rsa` stops requiring ESM synchronously.


## Configuration

Service account via `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` /
`FIREBASE_PRIVATE_KEY`. Set `ENVIROMENT=PROD` in production so error responses
stop including stack traces. Everything else is optional tuning — see
`.env.example` and `src/config/env.ts`.
