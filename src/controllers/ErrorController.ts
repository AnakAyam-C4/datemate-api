import { AppError } from "../utils/http/AppError";
import { ErrorRequestHandler } from "express";
import { IS_PRODUCTION } from "../config/env";

/**
 * Error Handling middleware
 */
const errorHandler: ErrorRequestHandler = async (
  error: AppError | Error,
  request,
  response,
  __,
) => {
  if (error instanceof AppError) {
    // Expected failures (401, 409, ...) are part of the API contract, so they
    // are not logged as incidents.
    response.status(error.statusCode).send({
      status: error.status,
      statusCode: error.statusCode,
      message: error.message,
      ...(IS_PRODUCTION ? {} : { stack: error.stack }),
    });

    return;
  }

  // Anything reaching here is a bug or an outage. Log it: on a serverless host
  // this line is the only trace of what happened, and without it a 500 shows up
  // in the dashboard with an error id and no cause attached to it.
  console.error(
    JSON.stringify({
      level: "error",
      message: "Unhandled error",
      method: request.method,
      path: request.originalUrl,
      error: error.message,
      stack: error.stack,
    }),
  );

  response.status(500).send({
    status: "fail",
    statusCode: 500,
    message: "Oops, Something went very wrong!",
    ...(IS_PRODUCTION ? {} : { stack: error.stack }),
  });
};

export default errorHandler;
