/**
 * TikTok: link → video id → metadata.
 *
 * Replaces SwiftSoupService. The iOS scraper flattened every JSON blob on the
 * page into a dictionary capped at 150 fields and then picked "the first key
 * that contains 'desc'". Swift randomises dictionary order per launch, so the
 * same link could yield a different caption — or lose the POI tag — from one
 * run to the next. Here the known path is read directly:
 *   __UNIVERSAL_DATA_FOR_REHYDRATION__ → __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
 * with the older SIGI_STATE layout as a fallback.
 */

import { z } from "zod";
import { SafeFetchError, safeFetch, validateUrl } from "../shared/safeFetch";

const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"]);
const SHORT_LINK_HOSTS = new Set(["vt.tiktok.com", "vm.tiktok.com"]);
export const isTikTokHost = (host: string) => TIKTOK_HOSTS.has(host);

const CDN_SUFFIXES = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "ibyteimg.com", "byteimg.com", "muscdn.com"];
export const isTikTokCdnHost = (host: string) =>
  CDN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));

/**
 * Desktop Safari, deliberately NOT the iPhone identity the iOS app used.
 * Measured 2026-10-11: for an iPhone User-Agent TikTok serves a stripped
 * "reflow" page whose JSON has no `webapp.video-detail` at all — no caption,
 * no POI tag, not even og:title. The desktop page carries the full itemStruct.
 */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  Referer: "https://www.tiktok.com/",
};

/** The iOS app's identity — only used by the spike, to measure what the app sees. */
const IPHONE_HEADERS = {
  ...BROWSER_HEADERS,
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

export class TikTokError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_URL" | "VIDEO_UNAVAILABLE" | "UPSTREAM_BLOCKED" | "UPSTREAM_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "TikTokError";
  }
}

// --- Link → video id -----------------------------------------------------------

const USERNAME = /^[A-Za-z0-9._]{1,64}$/;
const VIDEO_ID = /^\d{8,25}$/;

export type ResolvedVideo = {
  videoId: string;
  kind: "video" | "photo";
  /** Rebuilt from validated parts only — safe to hand to yt-dlp. */
  canonicalUrl: string;
  username: string | null;
  hops: number;
};

const fromPath = (url: URL): Omit<ResolvedVideo, "hops"> | null => {
  const segments = url.pathname.split("/").filter(Boolean);

  // /@user/video/123  ·  /@user/photo/123
  if (segments.length >= 3 && segments[0]!.startsWith("@") && (segments[1] === "video" || segments[1] === "photo")) {
    const username = segments[0]!.slice(1);
    const videoId = segments[2]!;
    if (!VIDEO_ID.test(videoId)) return null;
    const user = USERNAME.test(username) ? username : null;
    const kind = segments[1] as "video" | "photo";
    return { videoId, kind, username: user, canonicalUrl: `https://www.tiktok.com/@${user ?? "_"}/${kind}/${videoId}` };
  }

  // /v/123.html  ·  /video/123  ·  /embed/v2/123  ·  /embed/123
  const loose = url.pathname.match(/^\/(?:v|video|embed(?:\/v2)?)\/(\d{8,25})(?:\.html)?\/?$/);
  if (loose) {
    return { videoId: loose[1]!, kind: "video", username: null, canonicalUrl: `https://www.tiktok.com/@_/video/${loose[1]}` };
  }
  return null;
};

const isShortLink = (url: URL) =>
  SHORT_LINK_HOSTS.has(url.hostname) || (url.hostname.endsWith("tiktok.com") && url.pathname.startsWith("/t/"));

/**
 * Accepts what users actually paste — full links, vt./vm. short links,
 * tiktok.com/t/ links, links buried in share text — and returns the numeric id.
 */
export const resolveVideo = async (input: string): Promise<ResolvedVideo> => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) throw new TikTokError("UNSUPPORTED_URL", "Empty or oversized link");

  // Share sheets often send "Check this out! https://vt.tiktok.com/xyz/ #fyp".
  const candidate = trimmed.match(/https?:\/\/\S+/)?.[0] ?? trimmed;

  let url: URL;
  try {
    url = validateUrl(candidate, isTikTokHost);
  } catch {
    throw new TikTokError("UNSUPPORTED_URL", "Only TikTok links are supported");
  }

  const direct = fromPath(url);
  if (direct) return { ...direct, hops: 0 };
  if (!isShortLink(url)) throw new TikTokError("UNSUPPORTED_URL", "Not a TikTok video link");

  // Follow the short link by hand, one hop at a time, until a video path appears.
  let current = url;
  for (let hop = 1; hop <= 3; hop += 1) {
    let response;
    try {
      response = await safeFetch(current, {
        allowHost: isTikTokHost,
        followRedirects: false,
        maxBytes: 256 * 1024,
        timeoutMs: 10_000,
        headers: BROWSER_HEADERS,
      });
    } catch (error) {
      if (error instanceof SafeFetchError && error.code === "HOST_NOT_ALLOWED") {
        throw new TikTokError("UNSUPPORTED_URL", "Short link points outside TikTok");
      }
      throw new TikTokError("UPSTREAM_ERROR", `Could not resolve short link: ${(error as Error).message}`);
    }

    const location = response.headers.get("location");
    if (!location) {
      if (response.status === 403 || response.status === 429) throw new TikTokError("UPSTREAM_BLOCKED", `TikTok answered ${response.status}`);
      throw new TikTokError("VIDEO_UNAVAILABLE", "Short link did not redirect to a video");
    }

    try {
      current = validateUrl(new URL(location, current), isTikTokHost);
    } catch {
      throw new TikTokError("UNSUPPORTED_URL", "Short link points outside TikTok");
    }
    const resolved = fromPath(current);
    if (resolved) return { ...resolved, hops: hop };
  }
  throw new TikTokError("UNSUPPORTED_URL", "Too many redirects");
};

// --- oEmbed --------------------------------------------------------------------

const OEmbedSchema = z.object({
  title: z.string().optional(),
  author_name: z.string().optional(),
  author_unique_id: z.string().optional(),
  thumbnail_url: z.string().optional(),
});

export type OEmbed = {
  caption: string | null;
  authorName: string | null;
  authorUniqueId: string | null;
  thumbnailUrl: string | null;
};

export const fetchOEmbed = async (video: ResolvedVideo): Promise<OEmbed> => {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(video.canonicalUrl)}`;
  const response = await safeFetch(endpoint, { allowHost: isTikTokHost, maxBytes: 512 * 1024, timeoutMs: 10_000 });

  if (response.status === 404 || response.status === 400) throw new TikTokError("VIDEO_UNAVAILABLE", `oEmbed ${response.status}`);
  if (response.status === 403 || response.status === 429) throw new TikTokError("UPSTREAM_BLOCKED", `oEmbed ${response.status}`);
  if (response.status !== 200) throw new TikTokError("UPSTREAM_ERROR", `oEmbed ${response.status}`);

  let parsed: z.infer<typeof OEmbedSchema>;
  try {
    parsed = OEmbedSchema.parse(JSON.parse(response.body.toString("utf8")));
  } catch {
    throw new TikTokError("UPSTREAM_ERROR", "oEmbed returned unexpected JSON");
  }
  return {
    caption: parsed.title?.trim() || null,
    authorName: parsed.author_name?.trim() || null,
    authorUniqueId: parsed.author_unique_id?.trim() || null,
    thumbnailUrl: parsed.thumbnail_url?.trim() || null,
  };
};

// --- Page JSON -------------------------------------------------------------------

export type PageOutcome = "ok" | "blocked" | "no_data" | "removed";

export type PageMetadata = {
  outcome: PageOutcome;
  httpStatus: number;
  caption: string | null;
  authorNickname: string | null;
  authorUniqueId: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  poi: { name: string | null; address: string | null; city: string | null } | null;
  /** True when TikTok served the stripped mobile "reflow" page instead of the full one. */
  reflow: boolean;
  /** og:title — kept only so the spike can reproduce the iOS app's old behaviour. */
  ogTitle: string | null;
  ogImage: string | null;
};

const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const metaContent = (html: string, property: string): string | null => {
  const escaped = property.replace(/[.:]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]!).trim() || null;
  }
  return null;
};

const scriptJson = (html: string, id: string): unknown => {
  const match = html.match(new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i"));
  if (!match) return null;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return null;
  }
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

type ItemStruct = Record<string, unknown>;

type Lookup = { item: ItemStruct | null; removed: boolean; hasDataScript: boolean; reflow: boolean };

const findItemStruct = (html: string, videoId: string): Lookup => {
  const universal = obj(scriptJson(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__"));
  const scope = obj(universal?.["__DEFAULT_SCOPE__"]);
  const detail = obj(scope?.["webapp.video-detail"]);
  if (detail) {
    const status = num(detail["statusCode"]);
    const item = obj(obj(detail["itemInfo"])?.["itemStruct"]);
    return { item, removed: status !== null && status !== 0 && !item, hasDataScript: true, reflow: false };
  }

  const sigi = obj(scriptJson(html, "SIGI_STATE"));
  const legacy = obj(obj(sigi?.["ItemModule"])?.[videoId]);
  const reflow = scope !== null && Object.keys(scope).some((key) => key.startsWith("webapp.reflow."));
  return { item: legacy, removed: false, hasDataScript: universal !== null || sigi !== null, reflow };
};

export const fetchPage = async (video: ResolvedVideo, identity: "desktop" | "iphone" = "desktop"): Promise<PageMetadata> => {
  const response = await safeFetch(video.canonicalUrl, {
    allowHost: isTikTokHost,
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 15_000,
    headers: identity === "iphone" ? IPHONE_HEADERS : BROWSER_HEADERS,
  });
  const html = response.body.toString("utf8");

  const empty: PageMetadata = {
    outcome: "no_data", httpStatus: response.status, caption: null, authorNickname: null, authorUniqueId: null,
    coverUrl: null, durationSec: null, poi: null, reflow: false,
    ogTitle: metaContent(html, "og:title"), ogImage: metaContent(html, "og:image"),
  };

  if (response.status === 403 || response.status === 429) return { ...empty, outcome: "blocked" };
  if (response.status === 404) return { ...empty, outcome: "removed" };

  const { item, removed, hasDataScript, reflow } = findItemStruct(html, video.videoId);
  if (!item) {
    if (removed) return { ...empty, outcome: "removed" };
    // A normal page mentions "captcha" in its scripts, so the word alone proves
    // nothing. Only a page with no data script at all counts as a challenge.
    if (!hasDataScript) return { ...empty, outcome: "blocked" };
    return { ...empty, outcome: "no_data", reflow };
  }

  const author = obj(item["author"]);
  const media = obj(item["video"]);
  const poi = obj(item["poi"]);
  const poiName = str(poi?.["name"]);
  const poiAddress = str(poi?.["address"]);

  return {
    ...empty,
    outcome: "ok",
    caption: str(item["desc"]),
    authorNickname: str(author?.["nickname"]),
    authorUniqueId: str(author?.["uniqueId"]),
    coverUrl: str(media?.["originCover"]) ?? str(media?.["cover"]) ?? str(media?.["dynamicCover"]),
    durationSec: num(media?.["duration"]),
    poi: poiName || poiAddress ? { name: poiName, address: poiAddress, city: str(poi?.["city"]) } : null,
  };
};

// --- Cover image -----------------------------------------------------------------

const GEMINI_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export const fetchCoverImage = async (coverUrl: string): Promise<{ data: Buffer; mimeType: string } | null> => {
  const response = await safeFetch(coverUrl, { allowHost: isTikTokCdnHost, maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000 });
  if (response.status !== 200) return null;
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!GEMINI_IMAGE_TYPES.has(mimeType)) return null;
  return { data: response.body, mimeType };
};
