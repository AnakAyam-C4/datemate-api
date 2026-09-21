/**
 * Vercel serverless entry point.
 *
 * Vercel's Node runtime accepts an Express app as the default export and calls
 * it as `(req, res)`. `src/index.ts` stays the local `app.listen` entry so the
 * two environments share one app definition and nothing drifts between them.
 */
import "dotenv/config";
import app from "../src/app";

export default app;
