import type { Request, Response } from "express";
import { currentUid } from "../middleware/auth";
import { addFcmToken, removeFcmTokens } from "../repositories/userRepository";
import { STATUS } from "../utils/http/statusCodes";
import { requireString } from "../utils/validate";

/**
 * POST /v1/users/me/fcm-token
 *
 * The iOS app registers its APNs-backed FCM token here after sign-in and on
 * every token refresh. Without this there is no way to pull a backgrounded
 * partner into a session.
 */
export const registerFcmToken = async (request: Request, response: Response) => {
  const uid = currentUid(request);
  const token = requireString(request.body?.token, "token");

  await addFcmToken(uid, token);

  response.status(STATUS.OK).send({ status: "success", data: { registered: true } });
};

/** DELETE /v1/users/me/fcm-token — called on sign-out. */
export const unregisterFcmToken = async (
  request: Request,
  response: Response,
) => {
  const uid = currentUid(request);
  const token = requireString(request.body?.token, "token");

  await removeFcmTokens(uid, [token]);

  response.status(STATUS.OK).send({ status: "success", data: { registered: false } });
};
