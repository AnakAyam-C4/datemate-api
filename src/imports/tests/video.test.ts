import assert from "node:assert/strict";
import { test } from "node:test";
import { buildYtDlpArgs, classifyYtDlpError, downloadVideo } from "../4-video/video";

test("the URL is the last argument, after --, and never shell-interpreted", () => {
  const args = buildYtDlpArgs("https://www.tiktok.com/@a/video/7312345678901234567", "/tmp/x/video.%(ext)s", { maxBytes: 30e6, maxSeconds: 180 });
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "https://www.tiktok.com/@a/video/7312345678901234567");
  assert.ok(args.includes("--ignore-config"));
  assert.deepEqual(args.slice(args.indexOf("--use-extractors"), args.indexOf("--use-extractors") + 2), ["--use-extractors", "TikTok"]);
  assert.equal(args[args.indexOf("--match-filter") + 1], "duration <=? 180");
});

test("yt-dlp failures are classified, not swallowed", () => {
  assert.equal(classifyYtDlpError("ERROR: [TikTok] 123: Your IP address is blocked from accessing this post"), "blocked");
  assert.equal(classifyYtDlpError("ERROR: HTTP Error 403: Forbidden"), "blocked");
  assert.equal(classifyYtDlpError("ERROR: [TikTok] 123: Video unavailable"), "unavailable");
  assert.equal(classifyYtDlpError("[download] video does not pass filter (duration <=? 180), skipping .."), "too_long");
  assert.equal(classifyYtDlpError("File is larger than max-filesize (31457280 bytes > 30000000 bytes). Aborting."), "too_large");
  assert.equal(classifyYtDlpError("ERROR: Unable to extract universal data for rehydration"), "extractor");
});

test("photo slideshows skip the download entirely", async () => {
  const result = await downloadVideo(
    { videoId: "7312345678901234567", kind: "photo", canonicalUrl: "https://www.tiktok.com/@a/photo/7312345678901234567", username: "a", hops: 0 },
    { maxBytes: 1, maxSeconds: 1, timeoutMs: 1 },
  );
  assert.deepEqual({ ok: result.ok, failure: !result.ok && result.failure }, { ok: false, failure: "photo_post" });
});

test("a missing yt-dlp binary is reported as not_installed", async () => {
  const previous = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const result = await downloadVideo(
      { videoId: "7312345678901234567", kind: "video", canonicalUrl: "https://www.tiktok.com/@a/video/7312345678901234567", username: "a", hops: 0 },
      { maxBytes: 1e6, maxSeconds: 60, timeoutMs: 5_000 },
    );
    assert.equal(!result.ok && result.failure, "not_installed");
  } finally {
    process.env.PATH = previous;
  }
});
