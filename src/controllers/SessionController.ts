import type { Request, Response } from "express";
import { SESSION } from "../config/env";
import { currentUid } from "../middleware/auth";
import { STATUS } from "../utils/http/statusCodes";
import { serialiseSession } from "../repositories/sessionRepository";
import {
  cancelSession,
  createOrGetSession,
  finaliseSession,
  findActiveSession,
  generateDeck,
  joinSession,
  nudgePartner,
  readSession,
  selectMatch,
  submitPreferences,
  swipeProgress,
} from "../services/sessionService";
import {
  optionalNumber,
  optionalNumberArray,
  optionalString,
  optionalStringArray,
  pathParam,
  queryString,
  requireFutureDate,
  requireString,
} from "../utils/validate";

const ok = (response: Response, body: unknown, statusCode: number = STATUS.OK) =>
  response.status(statusCode).send({ status: "success", data: body });

/** Route params are always single-valued here; this keeps that explicit. */
const sessionIdOf = (request: Request) =>
  pathParam(request.params.sessionId, "sessionId");

/** POST /v1/sessions — start a session, or return the couple's live one. */
export const create = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const coupleId = optionalString(request.body?.coupleId, "coupleId");

  const { session, created } = await createOrGetSession(uid, coupleId);

  ok(
    response,
    { session: serialiseSession(session), created },
    created ? STATUS.CREATED : STATUS.OK,
  );
};

/** GET /v1/sessions/active — cold-start lookup when the client has no id. */
export const active = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const coupleId = queryString(request.query?.coupleId, "coupleId");

  const session = await findActiveSession(uid, coupleId);

  ok(response, { session: session ? serialiseSession(session) : null });
};

/** GET /v1/sessions/:sessionId */
export const show = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const session = await readSession(uid, sessionIdOf(request));

  ok(response, {
    session: serialiseSession(session),
    progress: swipeProgress(session),
  });
};

/** POST /v1/sessions/:sessionId/join */
export const join = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const session = await joinSession(uid, sessionIdOf(request));

  ok(response, { session: serialiseSession(session) });
};

/**
 * POST /v1/sessions/:sessionId/preferences
 *
 * Both partners call this. The second call is the one that finds both sides
 * ready and generates the deck, so the client does not need to know whether it
 * went first or second.
 */
export const preferences = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const sessionId = sessionIdOf(request);

  const payload = {
    tags: optionalStringArray(request.body?.tags, "tags", { maxLength: 20 }),
    priceLevels: optionalNumberArray(request.body?.priceLevels, "priceLevels", {
      min: 0,
      max: 4,
    }),
    lat: optionalNumber(request.body?.lat, "lat", { min: -90, max: 90 }),
    lng: optionalNumber(request.body?.lng, "lng", { min: -180, max: 180 }),
    maxDistanceKm:
      optionalNumber(request.body?.maxDistanceKm, "maxDistanceKm", {
        min: 0.5,
        max: 500,
      }) ?? SESSION.defaultRadiusKm,
  };

  const { session, deckReady } = await submitPreferences(
    uid,
    sessionId,
    payload,
  );

  if (!deckReady) {
    ok(response, { session: serialiseSession(session), deckReady: false });
    return;
  }

  const withDeck = await generateDeck(uid, sessionId);

  ok(response, { session: serialiseSession(withDeck), deckReady: true });
};

/**
 * POST /v1/sessions/:sessionId/deck
 *
 * Explicit generate/retry. Idempotent — call it if the status is still
 * `preferences` a couple of seconds after both partners went ready, which is
 * how a serverless invocation that died mid-generation gets recovered.
 */
export const deck = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const session = await generateDeck(uid, sessionIdOf(request));

  ok(response, { session: serialiseSession(session) });
};

/** POST /v1/sessions/:sessionId/finalize */
export const finalize = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const session = await finaliseSession(uid, sessionIdOf(request));

  ok(response, {
    session: serialiseSession(session),
    matches: session.result?.matches ?? [],
  });
};

/** POST /v1/sessions/:sessionId/select */
export const select = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const placeId = requireString(request.body?.placeId, "placeId");
  const datetime = requireFutureDate(request.body?.datetime, "datetime");

  const { session, upcomingId } = await selectMatch(
    uid,
    sessionIdOf(request),
    placeId,
    datetime,
  );

  ok(response, { session: serialiseSession(session), upcomingId });
};

/** POST /v1/sessions/:sessionId/cancel */
export const cancel = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const reason = optionalString(request.body?.reason, "reason");

  const session = await cancelSession(uid, sessionIdOf(request), reason);

  ok(response, { session: serialiseSession(session) });
};

/** POST /v1/sessions/:sessionId/nudge */
export const nudge = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const result = await nudgePartner(uid, sessionIdOf(request));

  ok(response, result);
};
