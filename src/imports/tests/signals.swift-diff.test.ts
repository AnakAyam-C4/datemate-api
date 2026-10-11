/**
 * Differential test: runs the REAL Swift implementation (extracted at test time
 * from docs/ios-reference) and the TypeScript port on the same inputs, and
 * fails on any difference. This proves the port, rather than re-asserting
 * outputs someone typed by hand.
 *
 * Skipped automatically where no Swift toolchain exists (Linux CI, Vercel).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { seededRandom } from "../../utils/random";
import {
  appears,
  buildTags,
  cleanPlaceName,
  expandAreaAliases,
  inferPriceLevel,
  inferTags,
  isConfirmed,
  parseSignals,
  swiftCapitalized,
} from "../2-caption/signals";
import type { PlaceCategory, PlaceSetting, PlaceVibe } from "../shared/vocabulary";
import { PLACE_CATEGORIES, PLACE_SETTINGS, PLACE_VIBES } from "../shared/vocabulary";

const REFERENCE = path.resolve(__dirname, "../../../docs/ios-reference");

const swiftAvailable = spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;

// --- Extract the real Swift functions ----------------------------------------

const read = (file: string) => readFileSync(path.join(REFERENCE, file), "utf8");

/** Text from the line containing `start` up to (not including) the line containing `end`. */
const between = (source: string, start: string, end: string): string => {
  const lines = source.split("\n");
  const from = lines.findIndex((line) => line.includes(start));
  const to = lines.findIndex((line, index) => index > from && line.includes(end));
  assert.ok(from !== -1, `marker not found: ${start}`);
  assert.ok(to !== -1, `marker not found: ${end}`);
  return lines.slice(from, to).join("\n");
};

/** Text from the line containing `start` up to the class's closing brace (last line "}"). */
const untilClassEnd = (source: string, start: string): string => {
  const lines = source.split("\n");
  const from = lines.findIndex((line) => line.includes(start));
  const to = lines.lastIndexOf("}");
  assert.ok(from !== -1 && to > from, `marker not found: ${start}`);
  return lines.slice(from, to).join("\n");
};

/** One balanced `{ … }` declaration, skipping braces inside strings and comments. */
const balancedDecl = (source: string, signature: string): string => {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `signature not found: ${signature}`);
  let depth = 0;
  let inString = false;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      depth += 1;
      opened = true;
    } else if (ch === "}") {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced declaration: ${signature}`);
};

const buildSwiftHarness = (): string => {
  const summary = read("AISummaryService.swift");
  const extractor = read("GeminiPlaceExtractor.swift");
  const importer = read("PlaceImportService.swift");
  const geocoder = read("GeocodingService.swift");

  return `import Foundation

/// The Swift code logs its decisions with print(); silence it so stdout is only the JSON.
func print(_ items: Any..., separator: String = " ", terminator: String = "\\n") {}

${between(extractor, "enum PlaceCategory", "enum GeminiPlaceExtractorError")}

final class Port {
${between(summary, "struct CaptionSignals {", "// MARK: - Gemini (Firebase AI Logic)")}
${between(summary, "private let blockedTags", "// MARK: - Fallback helpers")}
${untilClassEnd(summary, "private func inferTags")}
${untilClassEnd(importer, "private func cleanPlaceName")}
    ${balancedDecl(geocoder, "private func expandAreaAliases")}
}

struct Case: Decodable {
    let kind: String
    let title: String?
    let caption: String?
    let text: String?
    let list: [String]?
    let extraction: GeminiPlaceExtraction?
}

extension Port {
    func run(_ c: Case) -> Any {
        switch c.kind {
        case "signals":
            let s = parseSignals(title: c.title ?? "", caption: c.caption ?? "")
            return [
                "nameCandidate": s.nameCandidate as Any? ?? NSNull(),
                "addressCandidate": s.addressCandidate as Any? ?? NSNull(),
                "mentions": s.mentions,
                "hashtags": s.hashtags,
                "priceLevel": s.priceLevel as Any? ?? NSNull(),
            ] as [String: Any]
        case "tags": return buildTags(from: c.extraction!)
        case "infer": return inferTags(from: c.text ?? "")
        case "price": return inferPriceLevel(from: c.text ?? "")
        case "clean": return cleanPlaceName(c.text ?? "")
        case "alias": return expandAreaAliases(c.text ?? "")
        case "confirm": return Port.isConfirmed(c.title ?? "", by: c.list ?? [])
        case "appears": return Port.appears(c.title ?? "", in: c.text ?? "")
        case "capitalize": return (c.text ?? "").capitalized
        default: return NSNull()
        }
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let cases = try! JSONDecoder().decode([Case].self, from: input)
let port = Port()
let output = cases.map { port.run($0) }
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
};

/** Compiles once per harness version; the binary is cached in the OS temp dir. */
const compileHarness = (): string => {
  const source = buildSwiftHarness();
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = path.join(tmpdir(), "datemate-swift-diff");
  const binary = path.join(dir, `harness-${hash}`);
  if (existsSync(binary)) return binary;

  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `harness-${hash}.swift`);
  writeFileSync(file, source);
  execFileSync("swiftc", ["-O", "-swift-version", "5", "-o", binary, file], { stdio: "pipe" });
  return binary;
};

// --- Corpus ------------------------------------------------------------------

type Case =
  | { kind: "signals"; title: string; caption: string }
  | { kind: "tags"; extraction: Extraction }
  | { kind: "infer" | "price" | "clean" | "alias" | "capitalize"; text: string }
  | { kind: "confirm"; title: string; list: string[] }
  | { kind: "appears"; title: string; text: string };

type Extraction = {
  name: string;
  address: string;
  category: PlaceCategory;
  specialty: string;
  vibes: PlaceVibe[];
  setting: PlaceSetting;
  highlights: string[];
  priceLevel: number;
  summary: string;
};

const CAPTIONS = [
  "",
  "📍 Kyomi Cafe, BSD City",
  "nemu cafe gemes bgt 😭 📍 Kyomi Cafe, BSD City\nharga mulai 25k #bsd #cafebsd",
  "lokasi: Bakmi Aloi, Ruko Glaze 2, PIK 2",
  "Lokasi : Bakmi Aloi",
  "LOKASI=Warung Sate, Jaksel!",
  "alamat Jl. Kemang Raya No. 5, Kemang",
  "Location: Masen Matcha, Gading Serpong #gadingserpong",
  "loc= Kopi Kenangan",
  "locate this! no colon",
  "allocation: should not match",
  "📍📍 double pin",
  "📍ab",
  "📍 " + "x".repeat(90),
  "📍 Cafe A, , , Area B,",
  "📍 Cafe #hashtag stops here",
  "📍 Name?question",
  "📍\tTabbed Name　, Ideographic Area",
  "📍 Café Olé, Senopati",
  "📍 café decomposed, Kemang",
  "#fypシ #kopiβ #カフェ @Masen Matcha bsd",
  "@a @ab @user.name_1 hello @Masen Matcha BSD City lorem ipsum dolor sit amet",
  "di PIK enak bgt", "pik2 baru buka", "PIK 2 viewnya", "bsd_city bukan", "abcbsd bukan", "bsdcity!",
  "ke Kemang. lalu Tebet", "Kuta, Bali", "kutabaru bukan", "tangsel area", "#jaksel #fyp",
  "harga 25k", "25K aja", "25 k", "99rb", "25 ribu", "1,5 juta", "1.5jt", "Rp 25.000", "2.500k",
  "50kg beras", "10k steps", "150rb-200rb", "IDR35k", "5.k murah", "٢٥k arabic digits", "２５ｋ full width",
  "price 0k", "400k mahal", "39.9k", "40k", "149k", "150k", "399k", "1 juta", ".5jt",
  "premium fine dining mewah", "murah meriah", "affordable cuan", "biasa aja",
  "bakmi coffee dessert cookies dinner", "outdoor indoor park", "indoor outdoor museum", "sunset view aesthetic",
  // Canonical equivalence and grapheme boundaries
  "café kopi", "café kopi", "outdoõr", "premiüm", "muráh", "teh teá", "bakmi‍",
  "1́,5 juta", "25ḱ", "jakartá", "#bsd́",
];

/** Name next to the pin vs. a pin that is only a location (made-up names). */
const NAME_CAPTIONS = [
  "Dessert baru di Gading Serpong! 🥭 buka besok!\n\nKEDAI SORE\n📍 Grand Junction, Gading Serpong\n\nKuliner gading serpong • #dessert",
  "Dessert baru di Gading Serpong! 🥭 buka besok!  KEDAI SORE 📍 Grand Junction, Gading Serpong  Kuliner gading serpong • #dessert",
  "KEDAI SORE 📍 Grand Junction, Gading Serpong",
  "Lokasinya 📍 Grand Junction, Gading Serpong",
  "Lokasinya: Kopi Senja, Kemang",
  "alamatnya Jl. Pahlawan Seribu, BSD City",
  "enak bgt\n📍 Grand Junction, Gading Serpong",
  "nemu cafe gemes 📍 Plaza Senayan, Jakarta",
  "Kopi Pagi\r\n📍 Ruko Golden 8, Gading Serpong",
  "KOPI-KITA\n📍 Jl. Kemang Raya No. 5",
  "MCDONALD'S\n📍 Mall Kelapa Gading",
  "CAFE 9\n📍 Tower A, Lt. 2, Senayan",
  "TOKO ÉCLAIR\n📍 Grand Junction",
  "café olé\n📍 Plaza Senayan",
  "📍 Kopi Senja | Kemang",
  "📍 Kopi Senja • Kemang",
  "Best dessert!! 📍 Kopi Senja, Kemang",
];

const TITLES = ["", "Kyomi Cafe", "Kafe di Kemang", "bsd", "Jl. Kemang Raya No. 5", "Grand Junction", "KEDAI SORE"];

const CONFIRM_NAMES = ["Masen Matcha", "Kopi Senja", "Jl. Kemang Raya", "KEDAI SORE", "Café Olé", "abc", "Kopi"];
const CONFIRM_LISTS = [["#masenmatcha", "#bsd"], ["@Masen Matcha bsd"], ["#kopisenjakemang"], ["#kopi"], ["#cafeole"], ["#kedaisore"], []];
const APPEAR_TEXTS = [
  "KEDAI SORE\n📍 Jl. Pahlawan Seribu #kedaisore",
  "nemu masen matcha di bsd",
  "Café Olé di Senopati",
  "kopi senja enak",
  "#masenmatcha",
];

const SPECIALTIES = ["", "  Sunset View ", "fyp", "ab", "abc", "cafe", "🍵🍵🍵", "café", "café", "シシシ", "Japanese", "fypシ", "street food", "áb"];

const buildCorpus = (): Case[] => {
  const cases: Case[] = [];

  for (const caption of [...CAPTIONS, ...NAME_CAPTIONS]) {
    for (const title of TITLES) cases.push({ kind: "signals", title, caption });
    cases.push({ kind: "infer", text: caption });
    cases.push({ kind: "price", text: caption });
  }

  // Seeded fuzz: stitch tricky fragments into captions neither side has seen.
  const random = seededRandom("signals-diff-v1");
  const pieces = [
    "📍", "lokasi:", "alamat ", "Location=", " ", ",", "\n", "#", "@", "!", "?", "bsd", "PIK", "pik 2",
    "gading serpong", "25k", "1,5 juta", "99rb", "シ", "é", "é", "😭", "_", ".", "Kemang", "caf", "\t",
  ];
  for (let i = 0; i < 400; i += 1) {
    const length = 1 + Math.floor(random() * 12);
    let caption = "";
    for (let j = 0; j < length; j += 1) caption += pieces[Math.floor(random() * pieces.length)];
    cases.push({ kind: "signals", title: random() < 0.2 ? "Kyomi" : "", caption });
  }

  for (const specialty of SPECIALTIES) {
    for (const category of PLACE_CATEGORIES) {
      cases.push({
        kind: "tags",
        extraction: {
          name: "x", address: "", category, specialty,
          vibes: [PLACE_VIBES[(category.length) % PLACE_VIBES.length]!, "cozy"],
          setting: PLACE_SETTINGS[category.length % 2]!,
          highlights: [], priceLevel: 2, summary: "",
        },
      });
    }
  }
  // Duplicates and every vibe/setting pair.
  for (const vibe of PLACE_VIBES) {
    for (const setting of PLACE_SETTINGS) {
      cases.push({
        kind: "tags",
        extraction: {
          name: "x", address: "", category: "cafe", specialty: "cafe",
          vibes: [vibe, vibe], setting, highlights: [], priceLevel: 2, summary: "",
        },
      });
    }
  }

  for (const text of [
    "Kyomi Cafe (BSD)", "Bakmi [Halal] - Jakarta", "A | B : C", "Name @ Place", "Name - ", "Cafe/Resto",
    "  spaced  ", "(leading)", "Kopi / Teh - Senayan", "Plain Name",
  ]) cases.push({ kind: "clean", text });

  for (const text of [
    "BSD City, Tangerang", "bsd", "PIK 2", "pik", "Gadser", "PIK2", "bsd city bsd", "Serpong",
    "near BSD", "pik pik", "", "BSDCITY",
  ]) cases.push({ kind: "alias", text });

  for (const text of [
    "KOPI-KITA", "MCDONALD'S", "O’NEIL", "KOPI/TEH", "7ELEVEN", "CAFE 9", "(KOPI)", "KOPI_KITA", "KOPI.ID",
    "ÉCLAIR", "TOKO  DUA", "A-B-C", "X&Y", "KOPI,TEH", "KOPI\tTEH", "9AM CAFE", "kopi kita", "KÖPI",
  ]) cases.push({ kind: "capitalize", text });

  for (const title of CONFIRM_NAMES) {
    for (const list of CONFIRM_LISTS) cases.push({ kind: "confirm", title, list });
    for (const text of APPEAR_TEXTS) cases.push({ kind: "appears", title, text });
  }

  return cases;
};

const runTypeScript = (c: Case): unknown => {
  switch (c.kind) {
    case "signals": return parseSignals(c.title, c.caption);
    case "tags": return buildTags(c.extraction);
    case "infer": return inferTags(c.text);
    case "price": return inferPriceLevel(c.text);
    case "clean": return cleanPlaceName(c.text);
    case "alias": return expandAreaAliases(c.text);
    case "confirm": return isConfirmed(c.title, c.list);
    case "appears": return appears(c.title, c.text);
    case "capitalize": return swiftCapitalized(c.text);
  }
};

/** Same key order as Swift's .sortedKeys, so comparison is structural. */
const normalise = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v,
));

test("TypeScript signals port matches the Swift implementation", { skip: !swiftAvailable && "no Swift toolchain" }, () => {
  const binary = compileHarness();
  const corpus = buildCorpus();

  const swiftRun = spawnSync(binary, [], { input: JSON.stringify(corpus), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(swiftRun.status, 0, `Swift harness failed: ${swiftRun.stderr?.toString()}`);
  const swiftResults = JSON.parse(swiftRun.stdout.toString()) as unknown[];

  const mismatches: string[] = [];
  corpus.forEach((c, index) => {
    const expected = normalise(swiftResults[index]);
    const actual = normalise(runTypeScript(c));
    try {
      assert.deepEqual(actual, expected);
    } catch {
      mismatches.push(
        `#${index} ${JSON.stringify(c)}\n    swift: ${JSON.stringify(expected)}\n    ts:    ${JSON.stringify(actual)}`,
      );
    }
  });

  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length}/${corpus.length} cases differ:\n${mismatches.slice(0, 15).join("\n")}`,
  );
});
