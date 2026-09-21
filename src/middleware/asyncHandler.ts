import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 5 forwards rejected promises to the error middleware on its own, but
 * wrapping keeps the intent explicit and keeps handlers working if the app is
 * ever mounted on an older Express.
 */
export const asyncHandler =
  (
    handler: (
      request: Request,
      response: Response,
      next: NextFunction,
    ) => Promise<unknown>,
  ): RequestHandler =>
  (request, response, next) => {
    handler(request, response, next).catch(next);
  };
