import type { NextFunction, Request, Response } from "express";
import { auth } from "../config/firebase";
import { AppError } from "../utils/http/AppError";
import { STATUS } from "../utils/http/statusCodes";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `requireAuth`. Never trust a uid from the body. */
      uid?: string;
    }
  }
}

/**
 * Verifies the Firebase ID token the iOS app already obtains from Sign in with
 * Apple. The uid always comes from the verified token, never from the request
 * body, so a client cannot act on behalf of their partner.
 */
export const requireAuth = async (
  request: Request,
  _response: Response,
  next: NextFunction,
) => {
  try {
    const header = request.headers.authorization ?? "";

    if (!header.startsWith("Bearer ")) {
      throw new AppError("Missing bearer token", STATUS.UNAUTHORIZED);
    }

    const token = header.slice("Bearer ".length).trim();

    if (!token) {
      throw new AppError("Missing bearer token", STATUS.UNAUTHORIZED);
    }

    const decoded = await auth.verifyIdToken(token);
    request.uid = decoded.uid;

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    next(new AppError("Invalid or expired token", STATUS.UNAUTHORIZED));
  }
};

/** Narrows `request.uid` for handlers that run behind `requireAuth`. */
export const currentUid = (request: Request): string => {
  if (!request.uid) {
    throw new AppError("Not authenticated", STATUS.UNAUTHORIZED);
  }

  return request.uid;
};
