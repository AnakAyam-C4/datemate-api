/**
 * Tier 2 video download via yt-dlp.
 *
 * Downloading TikTok videos is against TikTok's terms. This is isolated here
 * and behind VIDEO_ANALYSIS_ENABLED so the pipeline degrades cleanly to
 * caption + cover when it is off, blocked, or unavailable.
 *
 * Command-injection rules:
 *   - spawn() with an argument array — never a shell string
 *   - the URL comes after `--`, and is rebuilt from validated parts
 *     (numeric id + [A-Za-z0-9._] username), never the user's raw input
 *   - --ignore-config, and HOME pointed at the job's temp dir, so no user
 *     config, cookies or plugins are loaded
 *   - a stripped environment: API keys and service-account secrets in this
 *     process's env are never handed to the child
 *   - one temp dir per job, removed by the caller's cleanup() in `finally`
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedVideo } from "../1-tiktok/tiktok";

export type DownloadFailure =
  | "not_installed"
  | "photo_post"
  | "blocked"
  | "unavailable"
  | "too_long"
  | "too_large"
  | "timeout"
  | "extractor"
  | "no_output";

export type DownloadResult =
  | { ok: true; filePath: string; mimeType: string; bytes: number; ms: number; cleanup: () => Promise<void> }
  | { ok: false; failure: DownloadFailure; detail: string; ms: number };

export type DownloadLimits = { maxBytes: number; maxSeconds: number; timeoutMs: number };

const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";

/** Exported for tests: the exact argv handed to yt-dlp. */
export const buildYtDlpArgs = (canonicalUrl: string, outputTemplate: string, limits: Omit<DownloadLimits, "timeoutMs">): string[] => [
  "--ignore-config",
  "--no-cache-dir",
  "--no-playlist",
  "--no-warnings",
  "--no-progress",
  "--no-part",
  "--no-mtime",
  "--use-extractors", "TikTok",
  "--socket-timeout", "20",
  "--max-filesize", String(Math.floor(limits.maxBytes)),
  // `<=?` also passes when TikTok omits the duration; the byte cap still applies.
  "--match-filter", `duration <=? ${Math.floor(limits.maxSeconds)}`,
  // "b" = best single file that already has audio + video, so no ffmpeg merge.
  "-f", "b[ext=mp4]/b",
  "-o", outputTemplate,
  "--print", "after_move:filepath",
  "--",
  canonicalUrl,
];

/** Exported for tests: maps yt-dlp's stderr to a failure class. */
export const classifyYtDlpError = (stderr: string): DownloadFailure => {
  const text = stderr.toLowerCase();
  if (/ip address is blocked|http error 403|your ip|captcha|login required|rate.?limit|http error 429/.test(text)) return "blocked";
  if (/video unavailable|http error 404|private|not available in your|has been removed|status code 10204|unable to find video/.test(text)) return "unavailable";
  if (/does not pass filter|duration/.test(text)) return "too_long";
  if (/larger than max-filesize|max-filesize/.test(text)) return "too_large";
  return "extractor";
};

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError: NodeJS.ErrnoException | null };

const run = (args: string[], cwd: string, timeoutMs: number): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(YT_DLP, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" },
    });
    let stdout = "";
    let stderr = "";
    const cap = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-16_384);
    child.stdout.on("data", (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr, chunk); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });

export const ytDlpVersion = async (): Promise<string | null> => {
  const dir = await mkdtemp(path.join(tmpdir(), "datemate-ytdlp-"));
  try {
    const result = await run(["--version"], dir, 10_000);
    return result.code === 0 ? result.stdout.trim() : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const MIME_BY_EXTENSION: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };

export const downloadVideo = async (video: ResolvedVideo, limits: DownloadLimits): Promise<DownloadResult> => {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (video.kind === "photo") return { ok: false, failure: "photo_post", detail: "Photo slideshow, no video", ms: 0 };

  const dir = await mkdtemp(path.join(tmpdir(), "datemate-video-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const result = await run(buildYtDlpArgs(video.canonicalUrl, path.join(dir, "video.%(ext)s"), limits), dir, limits.timeoutMs);

    if (result.spawnError?.code === "ENOENT") {
      await cleanup();
      return { ok: false, failure: "not_installed", detail: "yt-dlp is not installed", ms: elapsed() };
    }
    if (result.timedOut) {
      await cleanup();
      return { ok: false, failure: "timeout", detail: `yt-dlp exceeded ${limits.timeoutMs} ms`, ms: elapsed() };
    }

    const file = (await readdir(dir)).find((name) => name.startsWith("video.") && MIME_BY_EXTENSION[path.extname(name)]);
    if (result.code !== 0 || !file) {
      await cleanup();
      const failure = result.code !== 0 ? classifyYtDlpError(result.stderr) : classifyYtDlpError(`${result.stderr} ${result.stdout}`);
      return {
        ok: false,
        failure: result.code === 0 && failure === "extractor" ? "no_output" : failure,
        detail: result.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300),
        ms: elapsed(),
      };
    }

    const filePath = path.join(dir, file);
    const { size } = await stat(filePath);
    if (size > limits.maxBytes) {
      await cleanup();
      return { ok: false, failure: "too_large", detail: `${size} bytes`, ms: elapsed() };
    }
    return { ok: true, filePath, mimeType: MIME_BY_EXTENSION[path.extname(file)]!, bytes: size, ms: elapsed(), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
