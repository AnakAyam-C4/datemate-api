/**
 * Deterministic caption signals — no AI, no network.
 *
 * Ported from docs/ios-reference/AISummaryService.swift (`parseSignals` and its
 * name-vs-location helpers, `knownAreas`, `buildTags`, `inferTags`,
 * `inferPriceLevel`, `isConfirmed`, `appears`), PlaceImportService
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
/**
 * "lokasi"/"alamat" must be whole words ("lokasinya:" is allowed explicitly):
 * without the boundary, "Lokasinya 📍 …" matched "lokasi" and returned "nya".
 * "•" and "|" end the location text too — they separate caption sections.
 */
const LOCATION_LINE =
  `(?:📍|${B_BEFORE_WORD}loc(?:ation)?${S}*[:=]|${B_BEFORE_WORD}lokasi(?:nya)?${B_AFTER_WORD}${S}*[:=]?|${B_BEFORE_WORD}alamat(?:nya)?${B_AFTER_WORD}${S}*[:=]?)` +
  `${S}*([^#\\n!?📍•|]{3,70})`;
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
 * `title` is TikTok's location tag (POI name) or "" — never the page's
 * og:title. The candidate it returns is only a hint: a location tag or a 📍
 * line is often just a street, mall or area, so the pipeline trusts it on its
 * own only when a hashtag/@mention confirms it (`isConfirmed`), and otherwise
 * lets Gemini pick the venue from the whole caption.
 */
export const parseSignals = (title: string, caption: string): CaptionSignals => {
  const signals: CaptionSignals = {
    nameCandidate: null,
    addressCandidate: null,
    mentions: regexMatches(MENTION, caption),
    hashtags: regexMatches(HASHTAG, caption),
    priceLevel: null,
  };

  // TikTok's location tag (only when the creator attached one).
  const poiName = title.length === 0 ? null : title;

  // "📍 Kyomi Cafe, BSD City" / "lokasi: Bakmi Aloi, Ruko Glaze 2"
  const hint = regexMatches(LOCATION_LINE, caption, 1)[0];
  if (hint !== undefined) {
    // Without line breaks the pin text runs on into the next sentence; a
    // double space is where a line break used to be.
    const locationLine = trimWhitespacesAndNewlines(hint.split("  ")[0] ?? hint);
    const parts = locationLine.split(",").map(trimWhitespaces).filter((part) => part.length > 0);

    // A name on its own line, then "📍 <mall or area>": the pin line is where
    // the place is, so the name is next to it. A tagged location only counts
    // as a location when it is itself one — a tag naming the venue stays the name.
    const poiIsLocation =
      poiName !== null && looksLikeLocation(poiName) && localizedCaseInsensitiveContains(locationLine, poiName);
    const pinIsLocation = poiIsLocation || looksLikeLocation(parts[0] ?? "");

    // The text just before the pin on the same line first (captions don't
    // always keep their line breaks), then the line above.
    const nameNearPin =
      [textBeforeLocationMarker(caption), lineAbove(locationLine, caption)]
        .filter((candidate): candidate is string => candidate !== null)
        .find(looksLikeName) ?? null;

    if (pinIsLocation && nameNearPin !== null) {
      signals.nameCandidate = nameNearPin;
      signals.addressCandidate = locationLine;
    } else if (poiName !== null && !poiIsLocation) {
      signals.nameCandidate = poiName;
    } else if (pinIsLocation) {
      // The pin (and any tag) only say WHERE it is — leave the name to Gemini.
      signals.addressCandidate = locationLine;
    } else if (parts[0] !== undefined) {
      signals.nameCandidate = parts[0];
      if (parts.length > 1) signals.addressCandidate = parts.slice(1).join(", ");
    }
  } else if (poiName !== null && looksLikeLocation(poiName)) {
    // The tag is a street, mall or area — keep it as the location only.
    signals.addressCandidate = poiName;
  } else {
    signals.nameCandidate = poiName;
  }

  // All-caps names read better capitalized ("NAMA TOKO" → "Nama Toko").
  const candidate = signals.nameCandidate;
  if (candidate !== null && candidate === candidate.toUpperCase() && graphemes(candidate).some(isLetterGrapheme)) {
    signals.nameCandidate = swiftCapitalized(candidate);
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

// --- Name vs location helpers --------------------------------------------------

/** Swift `Character.isNewline` (judged by the character's first scalar). */
const isNewlineGrapheme = (g: string) => /^[\n\v\f\r\u0085\u2028\u2029]/u.test(g);
/** Swift `Character.isLetter` (judged by the character's first scalar). */
const isLetterGrapheme = (g: string) => /^\p{Alphabetic}/u.test(g);
const hasEmojiPresentation = (text: string) => /\p{Emoji_Presentation}/u.test(text);
const stripEmojiPresentation = (text: string) => Array.from(text).filter((cp) => !hasEmojiPresentation(cp)).join("");

/** Swift `localizedCaseInsensitiveContains`. */
const localizedCaseInsensitiveContains = (haystack: string, needle: string) =>
  swiftContains(haystack.toLocaleLowerCase(), needle.toLocaleLowerCase());

/**
 * Foundation `String.capitalized`. A character starts a word — and is
 * upper-cased — unless the one before it is a letter or an apostrophe:
 * "KOPI-KITA" → "Kopi-Kita" and "7ELEVEN" → "7Eleven", but "MCDONALD'S" →
 * "Mcdonald's". Verified against Swift in tests/signals.swift-diff.test.ts.
 */
export const swiftCapitalized = (text: string): string => {
  let result = "";
  let previous = "";
  for (const g of graphemes(text)) {
    const startsWord = previous === "" || !/^[\p{L}'’]/u.test(previous);
    result += startsWord ? g.toUpperCase() : g.toLowerCase();
    previous = g;
  }
  return result;
};

/**
 * The text just before the 📍 / "lokasi:" marker on the same line, back to the
 * previous sentence end or emoji: "…buka besok! NAMA TOKO 📍 <location>" gives
 * "NAMA TOKO". null when the marker starts its line.
 */
const textBeforeLocationMarker = (caption: string): string | null => {
  const match = new RegExp(LOCATION_LINE, "iu").exec(caption);
  if (!match) return null;

  const chunk: string[] = [];
  for (const g of graphemes(caption.slice(0, match.index)).reverse()) {
    if (isNewlineGrapheme(g) || ["!", "?", ".", "•", "#"].includes(canonical(g)) || hasEmojiPresentation(g)) break;
    chunk.push(g);
  }
  const text = trimWhitespaces(chunk.reverse().join(""));
  return text.length > 0 ? text : null;
};

/** The nearest non-empty line above the one containing `text`, emoji removed. */
const lineAbove = (text: string, caption: string): string | null => {
  // CharacterSet.newlines: each of these splits, so "\r\n" leaves an empty line between.
  const lines = caption.split(/[\n\v\f\r\u0085\u2028\u2029]/u);
  const index = lines.findIndex((line) => swiftContains(line, text));
  if (index <= 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const cleaned = trimWhitespacesAndNewlines(stripEmojiPresentation(lines[i] ?? ""));
    if (cleaned.length > 0) return cleaned;
  }
  return null;
};

const NAME_FILLER = [
  " di ", "rekomendasi", "review", "tempat", "buat ", "yang ", "baru", "enak",
  "murah", "wajib", "cobain", "nyobain", "kuliner", "the best", "must try",
  " spot ", " date ", " vibes ", " aesthetic ",
  // "Lokasinya 📍 …" introduces the pin; it isn't a name
  "lokasi", "alamat", "location", "address",
  // "nemu cafe gemes" is a reaction, not a name
  "nemu", "gemes", "gemas",
];

/** A short standalone line that could be a shop's name — not a sentence like "Rekomendasi cafe baru di BSD!". */
const looksLikeName = (line: string): boolean => {
  const lower = line.toLowerCase();
  const words = line.split(" ").filter((word) => word.length > 0);
  const length = graphemeCount(line);
  if (length < 2 || length > 40 || words.length < 1 || words.length > 6) return false;
  if (!graphemes(line).some(isLetterGrapheme)) return false;
  if (graphemes(line).some((g) => ["#", "@", "!", "?", ":"].includes(g))) return false;
  if (swiftContains(lower, "http")) return false;
  const padded = ` ${lower} `;
  return !NAME_FILLER.some((filler) => swiftContains(padded, filler));
};

const LOCATION_MARKERS = [
  " mall", " junction", " plaza", " square", " tower", " ruko ", " jl ", " jl.", " jalan ",
  " lt ", " lt.", " lantai ", " blok ", " boulevard", " market", " park ", " city ",
  " residence", " walk ", " avenue", " street",
];

/** A mall, a junction, a ruko, a street, a known area — somewhere a place is, rather than the place itself. */
export const looksLikeLocation = (text: string): boolean => {
  const lower = ` ${text.toLowerCase()} `;
  if (LOCATION_MARKERS.some((marker) => swiftContains(lower, marker))) return true;
  return KNOWN_AREAS.some((entry) => entry.keys.some((key) => swiftContains(lower, ` ${key} `)));
};

/** Letters and digits only, lower-cased, accents folded: "Masen Matcha", "#masenmatcha" → "masenmatcha". */
const squashed = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "").toLowerCase();

/**
 * True when a hashtag or @mention spells out the name — strong proof the name
 * is the venue, since nobody hashtags the street a café is on. The only case
 * where a tag/📍 name is trusted without asking Gemini.
 */
export const isConfirmed = (name: string, tagsAndMentions: readonly string[]): boolean => {
  const target = squashed(name);
  if (graphemeCount(target) < 4) return false;
  return tagsAndMentions.some((tag) => swiftContains(squashed(tag), target));
};

/** True when `name` really occurs in `text` — spelled out, squashed into a hashtag, or ≥60% of its words present. */
export const appears = (name: string, text: string): boolean => {
  const target = squashed(name);
  if (graphemeCount(target) < 3) return false;
  if (swiftContains(squashed(text), target)) return true;

  const words = (value: string) =>
    new Set(value.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((word) => graphemeCount(word) >= 2));
  const nameWords = words(name);
  if (nameWords.size < 2) return false;
  const textWords = words(text);
  let hits = 0;
  for (const word of nameWords) if (textWords.has(word)) hits += 1;
  return hits / nameWords.size >= 0.6;
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
