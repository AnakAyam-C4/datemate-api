/**
 * Deterministic caption signals — no AI, no network.
 *
 * Ported from docs/ios-reference/AISummaryService.swift (`parseSignals`,
 * `knownAreas`, `buildTags`, `inferTags`, `inferPriceLevel`), PlaceImportService
 * (`cleanPlaceName`) and GeocodingService (`expandAreaAliases`). Behaviour must
 * match Swift exactly; `tests/signals.swift-diff.test.ts` runs the real Swift code on
 * the same inputs and fails on any difference.
 *
 * Why the patterns look different from the Swift source: NSRegularExpression
 * (ICU) treats `\w`, `\b` and `\d` as Unicode-aware, while in JavaScript they
 * are ASCII-only — even with the `u` flag. A literal copy would, for example,
 * read "#fypシ" as "#fyp". So each ICU construct is rebuilt from explicit
 * Unicode property classes below.
 */

import type { PlaceCategory, PlaceSetting, PlaceVibe } from "../shared/vocabulary";
import { categoryTag, settingTag, vibeTag } from "../shared/vocabulary";

// --- ICU equivalents --------------------------------------------------------

/** ICU `\w`: [\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}‌‍]. */
const W = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍`;
/** ICU `\s`: [\t\n\f\r\p{Z}]. */
const S = String.raw`[\t\n\f\r\p{Z}]`;
/** ICU `\d`: \p{Nd}. */
const D = String.raw`\p{Nd}`;
/** ICU `\b` immediately before a word character. */
const B_BEFORE_WORD = `(?<![${W}])`;
/** ICU `\b` immediately after a word character. */
const B_AFTER_WORD = `(?![${W}])`;

const isWordChar = (char: string) => new RegExp(`^[${W}]$`, "u").test(char);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `\b<literal>\b` with ICU semantics, for a literal of any shape. */
const boundedLiteral = (literal: string): string => {
  const chars = Array.from(literal);
  const first = chars[0] ?? "";
  const last = chars[chars.length - 1] ?? "";
  const before = isWordChar(first) ? B_BEFORE_WORD : `(?<=[${W}])`;
  const after = isWordChar(last) ? B_AFTER_WORD : `(?=[${W}])`;
  return `${before}${escapeRegExp(literal)}${after}`;
};

/** Every match of `pattern` (case-insensitive, like the Swift helper), as group `group`. */
const regexMatches = (pattern: string, text: string, group = 0): string[] => {
  const regex = new RegExp(pattern, "giu");
  const results: string[] = [];
  for (const match of text.matchAll(regex)) {
    const value = match[group];
    if (value !== undefined) results.push(value);
  }
  return results;
};

// --- Foundation CharacterSet equivalents -------------------------------------

/** CharacterSet.whitespacesAndNewlines: Z*, U+0009–U+000D, U+0085. */
const WHITESPACE_AND_NEWLINES = /^[\t\n\v\f\r\u0085\p{Z}]+|[\t\n\v\f\r\u0085\p{Z}]+$/gu;
/** CharacterSet.whitespaces: Zs plus tab. */
const WHITESPACES = /^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu;

const trimWhitespacesAndNewlines = (text: string) => text.replace(WHITESPACE_AND_NEWLINES, "");
const trimWhitespaces = (text: string) => text.replace(WHITESPACES, "");

const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(graphemeSegmenter.segment(text), (part) => part.segment);

/** Swift `String.count` counts grapheme clusters, not UTF-16 units. */
const graphemeCount = (text: string) => graphemes(text).length;

/**
 * Swift `String.contains(_:)`: compares whole characters (grapheme clusters)
 * under canonical equivalence. So "cafe\u0301" (é as e + accent) does NOT
 * contain "cafe" in Swift, while JavaScript's `includes` says it does.
 */
const swiftContains = (haystack: string, needle: string): boolean => {
  const hay = graphemes(haystack).map((g) => g.normalize("NFC"));
  const pin = graphemes(needle).map((g) => g.normalize("NFC"));
  if (pin.length === 0) return true;
  outer: for (let start = 0; start + pin.length <= hay.length; start += 1) {
    for (let offset = 0; offset < pin.length; offset += 1) {
      if (hay[start + offset] !== pin[offset]) continue outer;
    }
    return true;
  }
  return false;
};

/** Swift `String ==` and `Set<String>` membership use canonical equivalence. */
const canonical = (text: string) => text.normalize("NFC");

/**
 * Swift `Double(String)` for a string already reduced to [0-9.]:
 * accepts "25", "1.5", "5." and ".5"; rejects "", "." and "1.2.3".
 */
const swiftDouble = (digits: string): number | null =>
  /^(?:\d+\.?\d*|\.\d+)$/.test(digits) ? Number.parseFloat(digits) : null;

// --- Patterns ----------------------------------------------------------------

const MENTION = `@[${W}][${W}. ]{1,29}`;
const HASHTAG = `#[${W}]+`;
const LOCATION_LINE =
  `(?:📍|${B_BEFORE_WORD}loc(?:ation)?${S}*[:=]|${B_BEFORE_WORD}lokasi${S}*[:=]?|${B_BEFORE_WORD}alamat${S}*[:=]?)` +
  `${S}*([^#\\n!?📍]{3,70})`;
const PRICE =
  `(${D}+[.,]?${D}*)${S}*(k${B_AFTER_WORD}|rb${B_AFTER_WORD}|ribu|jt${B_AFTER_WORD}|juta)`;

// --- Known areas ---------------------------------------------------------------

/**
 * Popular date-spot areas, most-specific first. Keys match both prose
 * ("di gading serpong") and hashtags ("#gadingserpong"); canonical strings are
 * the ones the iOS app verified to geocode correctly.
 */
export const KNOWN_AREAS: ReadonlyArray<{ keys: readonly string[]; canonical: string }> = [
  { keys: ["gading serpong", "gadingserpong", "gadser"], canonical: "Gading Serpong, Tangerang" },
  { keys: ["bsd city", "bsdcity", "bsd"], canonical: "Serpong, Tangerang Selatan" },
  { keys: ["pantai indah kapuk", "pantaiindahkapuk", "pik 2", "pik2", "pik"], canonical: "Pantai Indah Kapuk, Jakarta Utara" },
  { keys: ["alam sutera", "alamsutera", "alsut"], canonical: "Alam Sutera, Tangerang" },
  { keys: ["kelapa gading", "kelapagading"], canonical: "Kelapa Gading, Jakarta Utara" },
  { keys: ["pondok indah", "pondokindah"], canonical: "Pondok Indah, Jakarta Selatan" },
  { keys: ["blok m", "blokm"], canonical: "Blok M, Jakarta Selatan" },
  { keys: ["kota tua", "kotatua"], canonical: "Kota Tua, Jakarta" },
  { keys: ["senopati"], canonical: "Senopati, Jakarta Selatan" },
  { keys: ["kemang"], canonical: "Kemang, Jakarta Selatan" },
  { keys: ["menteng"], canonical: "Menteng, Jakarta Pusat" },
  { keys: ["scbd", "senayan"], canonical: "Senayan, Jakarta" },
  { keys: ["sudirman"], canonical: "Sudirman, Jakarta" },
  { keys: ["thamrin"], canonical: "Thamrin, Jakarta" },
  { keys: ["kuningan"], canonical: "Kuningan, Jakarta Selatan" },
  { keys: ["tebet"], canonical: "Tebet, Jakarta Selatan" },
  { keys: ["cikini"], canonical: "Cikini, Jakarta Pusat" },
  { keys: ["bintaro"], canonical: "Bintaro, Tangerang Selatan" },
  { keys: ["karawaci"], canonical: "Karawaci, Tangerang" },
  { keys: ["serpong"], canonical: "Serpong, Tangerang Selatan" },
  { keys: ["tangerang selatan", "tangsel"], canonical: "Tangerang Selatan" },
  { keys: ["tangerang"], canonical: "Tangerang" },
  { keys: ["jakarta selatan", "jaksel"], canonical: "Jakarta Selatan" },
  { keys: ["jakarta utara", "jakut"], canonical: "Jakarta Utara" },
  { keys: ["jakarta barat", "jakbar"], canonical: "Jakarta Barat" },
  { keys: ["jakarta timur", "jaktim"], canonical: "Jakarta Timur" },
  { keys: ["jakarta pusat", "jakpus"], canonical: "Jakarta Pusat" },
  { keys: ["jakarta"], canonical: "Jakarta" },
  { keys: ["bekasi"], canonical: "Bekasi" },
  { keys: ["depok"], canonical: "Depok" },
  { keys: ["bogor"], canonical: "Bogor" },
  { keys: ["dago"], canonical: "Dago, Bandung" },
  { keys: ["lembang"], canonical: "Lembang, Bandung" },
  { keys: ["bandung"], canonical: "Bandung" },
  { keys: ["jogja", "yogyakarta", "yogya"], canonical: "Yogyakarta" },
  { keys: ["semarang"], canonical: "Semarang" },
  { keys: ["malang"], canonical: "Malang" },
  { keys: ["surabaya"], canonical: "Surabaya" },
  { keys: ["canggu"], canonical: "Canggu, Bali" },
  { keys: ["ubud"], canonical: "Ubud, Bali" },
  { keys: ["seminyak"], canonical: "Seminyak, Bali" },
  { keys: ["uluwatu"], canonical: "Uluwatu, Bali" },
  { keys: ["kuta"], canonical: "Kuta, Bali" },
  { keys: ["bali"], canonical: "Bali" },
];

/**
 * Maps a free-text area onto its known canonical form ("Kemang" → "Kemang,
 * Jakarta Selatan"), using the same keys and boundaries as parseSignals.
 *
 * Not in the iOS app. Needed because geocoders resolve bare names to the wrong
 * place: measured 2026-10-11, "Kemang, Indonesia" lands on Kemang in Bogor,
 * ~27 km from Kemang in Jakarta Selatan.
 */
export const canonicalArea = (area: string): string => {
  for (const entry of KNOWN_AREAS) {
    for (const key of entry.keys) {
      if (regexMatches(boundedLiteral(key), area).length > 0) return entry.canonical;
    }
  }
  return area;
};

// --- parseSignals ------------------------------------------------------------

export type CaptionSignals = {
  nameCandidate: string | null;
  addressCandidate: string | null;
  mentions: string[];
  hashtags: string[];
  priceLevel: number | null;
};

/**
 * Port of `AISummaryService.parseSignals(title:caption:)`.
 *
 * `title` must be the TikTok POI name or "" — never the page's og:title. The
 * iOS app passes `poiName ?? ogTitle`, which makes the title non-empty on
 * nearly every video: the 📍 parser below then never runs and the og:title
 * overrides Gemini's name. The function itself is a faithful port; the bug was
 * in what the app passed in, and the import pipeline does not repeat it.
 */
export const parseSignals = (title: string, caption: string): CaptionSignals => {
  const signals: CaptionSignals = {
    nameCandidate: null,
    addressCandidate: null,
    mentions: regexMatches(MENTION, caption),
    hashtags: regexMatches(HASHTAG, caption),
    priceLevel: null,
  };

  if (title.length === 0) {
    // "📍 Kyomi Cafe, BSD City" / "lokasi: Bakmi Aloi, Ruko Glaze 2"
    const hint = regexMatches(LOCATION_LINE, caption, 1)[0];
    if (hint !== undefined) {
      const parts = trimWhitespacesAndNewlines(hint)
        .split(",")
        .map(trimWhitespaces)
        .filter((part) => part.length > 0);
      const first = parts[0];
      if (first !== undefined) {
        signals.nameCandidate = first;
        if (parts.length > 1) signals.addressCandidate = parts.slice(1).join(", ");
      }
    }
  } else {
    signals.nameCandidate = title;
  }

  if (signals.addressCandidate === null) {
    const haystack = `${caption} ${title}`;
    outer: for (const entry of KNOWN_AREAS) {
      for (const key of entry.keys) {
        if (regexMatches(boundedLiteral(key), haystack).length > 0) {
          signals.addressCandidate = entry.canonical;
          break outer;
        }
      }
    }
  }

  // "25k", "99rb", "25 ribu", "1,5 juta" → rough level
  const priceMatch = regexMatches(PRICE, caption)[0];
  if (priceMatch !== undefined) {
    const digits = priceMatch.replaceAll(",", ".").replace(/[^0-9.]/g, "");
    const value = swiftDouble(digits);
    if (value !== null) {
      const rupiah = swiftContains(priceMatch.toLowerCase(), "j") ? value * 1_000_000 : value * 1_000;
      if (rupiah < 40_000) signals.priceLevel = 1;
      else if (rupiah < 150_000) signals.priceLevel = 2;
      else if (rupiah < 400_000) signals.priceLevel = 3;
      else signals.priceLevel = 4;
    }
  }

  return signals;
};

// --- Tags --------------------------------------------------------------------

export const BLOCKED_TAGS: ReadonlySet<string> = new Set([
  "foodreview", "fyp", "bakal", "madura", "review", "kuliner", "enak", "makan",
  "tempat", "rekomendasi", "buat", "dan", "yang", "untuk", "dari", "bisa", "kamu",
  "kita", "ada", "guys", "nyobain", "wajib", "sini", "sih", "banget", "sangat",
  "bestie", "besti", "bunda", "ini", "nemu", "temen", "tonton", "video", "baru",
  "sana", "situ", "fypシ", "jalan", "makanan", "minuman",
]);

const DEFAULT_TAGS = ["date-spot", "cozy", "aesthetic", "casual"] as const;

const padToFour = (tags: string[]): string[] => {
  const result = [...tags];
  let index = 0;
  while (result.length < 4) {
    const candidate = DEFAULT_TAGS[index % DEFAULT_TAGS.length]!;
    if (!result.some((tag) => canonical(tag) === candidate)) result.push(candidate);
    index += 1;
  }
  return result.slice(0, 4);
};

export type TagFacts = {
  category: PlaceCategory;
  specialty: string;
  vibes: PlaceVibe[];
  setting: PlaceSetting;
};

/** Port of `AISummaryService.buildTags(from:)`. Priority: category > specialty > vibes > setting. */
export const buildTags = (facts: TagFacts): string[] => {
  const tags: string[] = [categoryTag(facts.category)];

  const specialty = trimWhitespacesAndNewlines(facts.specialty).toLowerCase().replaceAll(" ", "-");
  if (specialty.length > 0 && graphemeCount(specialty) >= 3 && !BLOCKED_TAGS.has(canonical(specialty))) {
    tags.push(specialty);
  }

  tags.push(...facts.vibes.map(vibeTag));
  tags.push(settingTag(facts.setting));

  const seen = new Set<string>();
  const unique = tags.filter((tag) => {
    const key = canonical(tag);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return padToFour(unique);
};

const INFER_CANDIDATES = [
  // Culinary
  "bakmi", "coffee", "dessert", "cookies", "dinner", "chinese", "indonesian", "japanese", "cozy", "cafe", "tea", "pasta", "burger", "pizza",
  // Entertainment
  "nature", "park", "relax", "activity", "outdoor", "indoor", "museum", "arcade", "gallery", "beach", "sunset", "view", "aesthetic",
] as const;

/** Port of `AISummaryService.inferTags(from:)` — keyword tags when no model ran. */
export const inferTags = (text: string): string[] => {
  const lower = text.toLowerCase();
  const tags: string[] = [];

  for (const candidate of INFER_CANDIDATES) {
    if (swiftContains(lower, candidate)) {
      const excluded =
        (candidate === "indoor" && tags.includes("outdoor")) ||
        (candidate === "outdoor" && tags.includes("indoor"));
      if (!excluded) tags.push(candidate);
    }
    if (tags.length >= 4) break;
  }

  return padToFour(tags);
};

/** Port of `AISummaryService.inferPriceLevel(from:)`. */
export const inferPriceLevel = (text: string): number => {
  const lower = text.toLowerCase();
  if (["premium", "fine dining", "mewah", "fancy"].some((word) => swiftContains(lower, word))) return 3;
  if (["murah", "affordable", "budget", "cuan"].some((word) => swiftContains(lower, word))) return 1;
  return 2;
};

// --- Names and areas ---------------------------------------------------------

/** Port of `cleanPlaceName`: strips "(…)", "[…]" and " - | : / @ " suffixes. */
export const cleanPlaceName = (name: string): string => {
  let cleaned = name;
  const bracket = cleaned.search(/[([]/);
  if (bracket !== -1) cleaned = cleaned.slice(0, bracket);
  for (const separator of [" - ", " | ", " : ", " / ", " @ "]) {
    const index = cleaned.indexOf(separator);
    if (index !== -1) cleaned = cleaned.slice(0, index);
  }
  return trimWhitespacesAndNewlines(cleaned);
};

const AREA_ALIASES: ReadonlyArray<{ pattern: string; replacement: string }> = [
  { pattern: "bsd city", replacement: "Serpong, Tangerang Selatan" },
  { pattern: "bsd", replacement: "Serpong, Tangerang Selatan" },
  { pattern: "pik 2", replacement: "Pantai Indah Kapuk 2, Jakarta Utara" },
  { pattern: "pik", replacement: "Pantai Indah Kapuk, Jakarta Utara" },
  { pattern: "gadser", replacement: "Gading Serpong, Tangerang" },
];

/**
 * Port of `expandAreaAliases`: informal names geocoders don't know
 * ("BSD City" famously geocodes to Ambon). First alias that matches wins and
 * replaces every occurrence of itself.
 */
export const expandAreaAliases = (area: string): string => {
  for (const { pattern, replacement } of AREA_ALIASES) {
    const regex = new RegExp(boundedLiteral(pattern), "giu");
    if (regex.test(area)) {
      regex.lastIndex = 0;
      return area.replace(regex, () => replacement);
    }
  }
  return area;
};
