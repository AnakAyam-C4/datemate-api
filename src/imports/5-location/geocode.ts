/**
 * Geocoding behind a provider interface, with the iOS verification rules.
 *
 * Ported from GeocodingService.swift with one deliberate change: the iOS code
 * verified only some paths (the scraped POI address and "name + area with no
 * area centroid" were accepted unchecked). Here every name-level result must
 * pass the same checks:
 *   - in Indonesia
 *   - ≥60% of the name's tokens appear in the result's name
 *   - within 30 km of the area centroid, when the area is known
 * Anything that fails falls back to the area centroid ("area_only"), then to
 * nothing ("none"). A right neighbourhood beats a confident wrong pin.
 *
 * Default providers are free and keyless: Photon and Nominatim (OSM data).
 * Their usage policies require an identifying User-Agent, ≤1 request/second
 * for Nominatim, and caching — all handled here.
 */

import { distanceKm, type LatLng } from "../../utils/geo";
import { importsConfig } from "../shared/config";
import { tokenOverlap } from "../3-gemini/gemini";
import { safeFetch } from "../shared/safeFetch";
import { canonicalArea, expandAreaAliases } from "../2-caption/signals";

export type Candidate = LatLng & {
  name: string | null;
  label: string;
  countryCode: string | null;
  provider: string;
};

export interface GeocodingProvider {
  readonly id: string;
  search(query: string): Promise<Candidate[]>;
}

// --- Shared plumbing ---------------------------------------------------------------

/** Simple serial gate: at most one request per `intervalMs` for this provider. */
const rateLimiter = (intervalMs: number) => {
  let next = 0;
  let chain: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      next = Date.now() + intervalMs;
    });
    chain = run.catch(() => undefined);
    return run.then(task);
  };
};

const getJson = async (url: string, host: string): Promise<unknown> => {
  const response = await safeFetch(url, {
    allowHost: (h) => h === host,
    maxBytes: 1024 * 1024,
    timeoutMs: 10_000,
    headers: { "User-Agent": importsConfig().geocoding.userAgent, Accept: "application/json" },
  });
  if (response.status === 429) throw new Error(`${host} rate-limited us (429)`);
  if (response.status !== 200) throw new Error(`${host} answered ${response.status}`);
  return JSON.parse(response.body.toString("utf8"));
};

// Indonesia: lon 94.9–141.1, lat -11.1–6.1
const INDONESIA_BBOX = "94.9,-11.1,141.1,6.1";

// --- Photon (komoot) ------------------------------------------------------------------

export const photon = (): GeocodingProvider => {
  const limit = rateLimiter(500);
  return {
    id: "photon",
    search: (query) =>
      limit(async () => {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&bbox=${INDONESIA_BBOX}`;
        const data = (await getJson(url, "photon.komoot.io")) as { features?: Array<{ geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }> };
        return (data.features ?? []).flatMap((feature) => {
          const [lng, lat] = feature.geometry?.coordinates ?? [];
          if (typeof lat !== "number" || typeof lng !== "number") return [];
          const p = feature.properties ?? {};
          const name = typeof p["name"] === "string" ? p["name"] : null;
          const label = ["name", "street", "district", "city", "state"]
            .map((key) => p[key])
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .filter((value, index, all) => all.indexOf(value) === index)
            .join(", ");
          return [{ lat, lng, name, label, countryCode: typeof p["countrycode"] === "string" ? p["countrycode"].toUpperCase() : null, provider: "photon" }];
        });
      }),
  };
};

// --- Nominatim (OSM) --------------------------------------------------------------------

export const nominatim = (): GeocodingProvider => {
  const limit = rateLimiter(1_100); // policy: absolute maximum 1 request per second
  return {
    id: "nominatim",
    search: (query) =>
      limit(async () => {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&countrycodes=id&limit=5&addressdetails=1`;
        const data = (await getJson(url, "nominatim.openstreetmap.org")) as Array<Record<string, unknown>>;
        return (Array.isArray(data) ? data : []).flatMap((item) => {
          const lat = Number(item["lat"]);
          const lng = Number(item["lon"]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
          const address = (item["address"] ?? {}) as Record<string, unknown>;
          const code = typeof address["country_code"] === "string" ? address["country_code"].toUpperCase() : null;
          return [{
            lat, lng,
            name: typeof item["name"] === "string" && item["name"] ? item["name"] : null,
            label: typeof item["display_name"] === "string" ? item["display_name"] : "",
            countryCode: code,
            provider: "nominatim",
          }];
        });
      }),
  };
};

// --- Strategy ------------------------------------------------------------------------------

export type GeocodeMethod = "poi_search" | "poi_address" | "area_centroid";

export type GeocodeResult = LatLng & {
  method: GeocodeMethod;
  provider: string;
  address: string;
  /** Distance from the area centroid, when one was known. */
  kmFromArea: number | null;
};

export type GeocodeInput = {
  /** A name that passed evidence checks — or null. Never an unverified guess. */
  name: string | null;
  area: string | null;
  /** TikTok POI address, when the creator attached one. */
  poiAddress: string | null;
};

export type GeocodeTrace = Array<{ step: string; query: string; provider: string; outcome: string }>;

const MAX_KM_FROM_AREA = 30;
const MIN_NAME_OVERLAP = 0.6;

const withIndonesia = (query: string) => (/indonesia/i.test(query) ? query : `${query}, Indonesia`);

/** Keyed by provider + query so repeated imports of the same area cost nothing. */
export type GeocodeCache = Map<string, Candidate[]>;

export const createGeocoder = (providers: GeocodingProvider[], cache: GeocodeCache = new Map()) => {
  const search = async (provider: GeocodingProvider, query: string, trace: GeocodeTrace, step: string) => {
    const key = `${provider.id}|${query.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached) {
      trace.push({ step, query, provider: provider.id, outcome: `cache:${cached.length}` });
      return cached;
    }
    try {
      const results = (await provider.search(query)).filter((candidate) => candidate.countryCode === "ID");
      cache.set(key, results);
      trace.push({ step, query, provider: provider.id, outcome: `ok:${results.length}` });
      return results;
    } catch (error) {
      // A provider failing is recorded, never confused with "found nothing".
      trace.push({ step, query, provider: provider.id, outcome: `error:${(error as Error).message.slice(0, 80)}` });
      return [];
    }
  };

  const geocode = async (input: GeocodeInput): Promise<{ result: GeocodeResult | null; trace: GeocodeTrace }> => {
    const trace: GeocodeTrace = [];
    // Known areas first ("Kemang" → "Kemang, Jakarta Selatan"), then the
    // iOS aliases for informal names ("BSD City" → "Serpong, …").
    const area = input.area ? expandAreaAliases(canonicalArea(input.area)) : "";

    // Area centroid first: it is both a fallback and the yardstick for name results.
    let centroid: Candidate | null = null;
    if (area) {
      for (const provider of providers) {
        centroid = (await search(provider, withIndonesia(area), trace, "area"))[0] ?? null;
        if (centroid) break;
      }
    }
    const kmFromArea = (point: LatLng) => (centroid ? distanceKm(centroid, point) : null);
    const nearArea = (point: LatLng) => {
      const km = kmFromArea(point);
      return km === null || km <= MAX_KM_FROM_AREA;
    };

    // 1. Verified POI search on the name.
    if (input.name) {
      const queries = [...new Set([area ? `${input.name}, ${area}, Indonesia` : null, `${input.name}, Indonesia`].filter((q): q is string => q !== null))];
      for (const query of queries) {
        for (const provider of providers) {
          const scored = (await search(provider, query, trace, "poi_search"))
            .map((candidate) => ({ candidate, score: tokenOverlap(input.name!, candidate.name ?? candidate.label) }))
            .filter(({ candidate, score }) => score >= MIN_NAME_OVERLAP && nearArea(candidate))
            .sort((a, b) => b.score - a.score || (kmFromArea(a.candidate) ?? 0) - (kmFromArea(b.candidate) ?? 0));
          const best = scored[0]?.candidate;
          if (best) {
            return { result: { lat: best.lat, lng: best.lng, method: "poi_search", provider: best.provider, address: best.label, kmFromArea: kmFromArea(best) }, trace };
          }
        }
      }
    }

    // 2. The creator-attached TikTok POI address — now verified like everything else.
    if (input.poiAddress) {
      for (const provider of providers) {
        const hit = (await search(provider, withIndonesia(input.poiAddress), trace, "poi_address")).find(nearArea);
        if (hit) {
          return { result: { lat: hit.lat, lng: hit.lng, method: "poi_address", provider: hit.provider, address: input.poiAddress, kmFromArea: kmFromArea(hit) }, trace };
        }
      }
    }

    // 3. Right neighbourhood beats a wrong pin.
    if (centroid) {
      return { result: { lat: centroid.lat, lng: centroid.lng, method: "area_centroid", provider: centroid.provider, address: area, kmFromArea: 0 }, trace };
    }
    return { result: null, trace };
  };

  return { geocode };
};
