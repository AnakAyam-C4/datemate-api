/**
 * Configuration for the TikTok import pipeline. Kept separate from
 * src/config/env.ts so Decide Together's config is untouched.
 *
 * Read lazily (a function, not constants) so scripts that load .env after
 * importing this module still see the values.
 */

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : /^(1|true|yes|on)$/i.test(value);

const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value === undefined || value === "" || !Number.isFinite(parsed) ? fallback : parsed;
};

export const importsConfig = () => ({
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    /** Caption + cover. Flash-Lite: cheaper, separate (bigger) daily allowance. */
    textModel: process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite",
    /** Video understanding. Smaller free daily allowance — only for hard cases. */
    videoModel: process.env.GEMINI_VIDEO_MODEL || "gemini-3.8-flash",
    /** A name below this confidence is never geocoded as a name. */
    nameConfidence: number(process.env.GEMINI_NAME_CONFIDENCE, 0.7),
    timeoutMs: number(process.env.GEMINI_TIMEOUT_MS, 60_000),
  },
  routing: {
    /**
     * Skip Gemini entirely when TikTok's POI tag or a 📍/lokasi line already
     * names the place. Decided 2026-10-11; flip to false to always run the
     * caption call (richer tags, costs one Flash-Lite request).
     */
    skipGeminiWhenDeterministic: bool(process.env.GEMINI_SKIP_WHEN_DETERMINISTIC, true),
  },
  video: {
    /** Kill switch for the yt-dlp + Gemini video tier (ToS / blocking / quota). */
    enabled: bool(process.env.VIDEO_ANALYSIS_ENABLED, true),
    maxSeconds: number(process.env.VIDEO_MAX_SECONDS, 180),
    maxBytes: number(process.env.VIDEO_MAX_BYTES, 30 * 1024 * 1024),
    downloadTimeoutMs: number(process.env.VIDEO_DOWNLOAD_TIMEOUT_MS, 90_000),
    /** Videos at or below this size go inline; bigger ones use the Files API. */
    inlineMaxBytes: number(process.env.VIDEO_INLINE_MAX_BYTES, 14 * 1024 * 1024),
  },
  geocoding: {
    /** Identifies us to Nominatim/Photon, as their usage policies require. */
    userAgent:
      process.env.GEOCODER_USER_AGENT ||
      "DateMate-API/0.1 (+https://github.com/AnakAyam-C4/datemate-api)",
  },
});

export type ImportsConfig = ReturnType<typeof importsConfig>;
