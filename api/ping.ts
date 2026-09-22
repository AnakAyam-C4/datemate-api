import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Bisection probe. Imports nothing from src/ and touches no dependency, so it
 * isolates "the platform can run a function here at all" from "something in the
 * app's import chain fails to bundle".
 *
 *   /api/ping works, /health does not  -> the import chain is the problem
 *   neither works                      -> project/platform configuration
 */
export default function handler(
  _request: IncomingMessage,
  response: ServerResponse,
) {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, probe: "ping", node: process.version }));
}
