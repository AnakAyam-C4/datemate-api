/**
 * Configure enviroment variables
 */
import "dotenv/config";

/////////////////////////////

import app from "./app";
import { PORT } from "./config/env";

/**
 * Local development entry point. On Vercel the app is exported from
 * `api/index.ts` instead and this file never runs.
 *
 * `chalk` was dropped here: v6 is ESM-only and this package is CommonJS, so
 * importing it breaks both `tsc --noEmit` and the Vercel build.
 */
app.listen(Number(PORT), () => {
  console.log(`[SERVER] DateMate API listening on port ${PORT}`);
});
