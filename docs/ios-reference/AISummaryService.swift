//
//  AISummaryService.swift
//  DateRecommendation
//
//  Generates a short, friendly AI summary of a place from a scraped
//  TikTok post, via Gemini Flash-Lite (Firebase AI Logic).
//
//  Fallback: returns a pre-formatted description composed from
//  deterministic caption signals if the model call fails or is
//  unreachable (offline, rate-limited, App Check rejected, etc).
//

import FirebaseAI
import Foundation

// MARK: - Result

struct PlaceSummary {
    let name: String            // AI-extracted/inferred name of the place
    let address: String         // AI-extracted/inferred address/area
    let summary: String         // Short AI-written paragraph
    let tags: [String]          // Suggested tags (exactly 4)
    let priceLevel: Int         // 1–4 estimated from description
    let isAIGenerated: Bool     // false if using fallback
}

// MARK: - Service

@MainActor
final class AISummaryService {

    static let shared = AISummaryService()
    private init() {}

    /// Last-resort label when no place name could be found anywhere.
    private static let unknownPlaceName = "this place"

    /// Skip Gemini only when the caption itself confirms the name — the tag or
    /// 📍 name also appears as a hashtag or @mention ("Masen Matcha" +
    /// #masenmatcha). A tag or 📍 line alone isn't enough: it's often just a
    /// street, mall or area, and only Gemini can tell that from the caption.
    /// Saves quota where it's safe; set to false to always ask Gemini.
    private static let skipGeminiWhenNameConfirmed = true

    // MARK: - Generate Summary

    /// Generates a concise, date-friendly summary from scraped TikTok metadata.
    /// - Parameters:
    ///   - placeName: TikTok's POI name, only if the creator attached a location.
    ///   - address: Full address string.
    ///   - caption: Original TikTok caption / video description.
    ///   - authorNickname: The creator's display name, passed to the model so
    ///     it doesn't mistake the account name for the place name.
    /// - Returns: A `PlaceSummary` with AI content or a graceful fallback.
    func generateSummary(
        placeName: String?,
        address: String?,
        caption: String?,
        authorNickname: String? = nil
    ) async -> PlaceSummary {

        // Only a real POI name counts as an already-known title. This used to
        // be `placeName ?? "this place"`, and the scraper passed the page's
        // og:title when there was no POI — both never empty, so the 📍 parser
        // below never ran and that title always beat Gemini's name.
        let name = placeName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let addr = address   ?? ""
        // Gemini's context window comfortably fits a full TikTok caption —
        // no need for the aggressive truncation the old on-device model needed.
        let cap = String((caption ?? "").prefix(4000))

        // Deterministic pre-parse: "📍 Name, Area" lines, mentions, hashtags,
        // prices. Free hints — the name candidate is only trusted on its own
        // when the caption confirms it; otherwise Gemini reads the caption.
        let signals = parseSignals(title: name, caption: cap)

        // The caption confirms the name (hashtag / @mention), it isn't a
        // street, mall or area, and we know where it is. No Gemini needed.
        let nameConfirmed = signals.nameCandidate.map { candidate in
            !looksLikeLocation(candidate)
                && Self.isConfirmed(candidate, by: signals.hashtags + signals.mentions)
        } ?? false
        let locationKnown = signals.addressCandidate != nil || !addr.isEmpty

        if Self.skipGeminiWhenNameConfirmed && nameConfirmed && locationKnown {
            print("AISummaryService: name confirmed by a hashtag/mention — skipping Gemini")
        } else if let result = await runGemini(
            name: name,
            address: addr,
            caption: cap,
            authorNickname: authorNickname,
            signals: signals
        ) {
            return result
        }

        // No-Gemini path: the location was already known, or Gemini failed.
        // Composed from parsed signals, never the raw caption.
        let fallbackName = signals.nameCandidate ?? Self.unknownPlaceName
        let fallbackAddress = signals.addressCandidate ?? addr
        let fallbackPrice = signals.priceLevel ?? inferPriceLevel(from: cap)

        // On-device Foundation Models can still write a real description from
        // the few facts we have. Only with a real name — "this place is a
        // budget-friendly spot…" reads worse than the template.
        var summary = fallbackSummary(name: fallbackName, address: fallbackAddress, caption: cap)
        var isAIGenerated = false
        if signals.nameCandidate != nil,
           let written = await PlaceDescriptionWriter.describe(
               PlaceFacts(
                   name: fallbackName,
                   area: fallbackAddress,
                   category: nil,
                   specialty: "",
                   vibes: [],
                   setting: nil,
                   highlights: [],
                   priceLevel: fallbackPrice
               )
           ) {
            summary = written
            isAIGenerated = true
        }

        return PlaceSummary(
            name: fallbackName,
            address: fallbackAddress,
            summary: summary,
            tags: inferTags(from: cap + " " + name + " " + signals.hashtags.joined(separator: " ")),
            priceLevel: fallbackPrice,
            isAIGenerated: isAIGenerated
        )
    }

    // MARK: - Deterministic caption signals (no AI)

    struct CaptionSignals {
        var nameCandidate: String?
        var addressCandidate: String?
        var mentions: [String] = []
        var hashtags: [String] = []
        var priceLevel: Int?
    }

    /// Popular date-spot areas, most-specific first. Keys match both prose
    /// ("di gading serpong") and hashtags ("#gadingserpong"); canonical
    /// strings are verified to geocode to the right coordinates.
    private static let knownAreas: [(keys: [String], canonical: String)] = [
        (["gading serpong", "gadingserpong", "gadser"], "Gading Serpong, Tangerang"),
        (["bsd city", "bsdcity", "bsd"], "Serpong, Tangerang Selatan"),
        (["pantai indah kapuk", "pantaiindahkapuk", "pik 2", "pik2", "pik"], "Pantai Indah Kapuk, Jakarta Utara"),
        (["alam sutera", "alamsutera", "alsut"], "Alam Sutera, Tangerang"),
        (["kelapa gading", "kelapagading"], "Kelapa Gading, Jakarta Utara"),
        (["pondok indah", "pondokindah"], "Pondok Indah, Jakarta Selatan"),
        (["blok m", "blokm"], "Blok M, Jakarta Selatan"),
        (["kota tua", "kotatua"], "Kota Tua, Jakarta"),
        (["senopati"], "Senopati, Jakarta Selatan"),
        (["kemang"], "Kemang, Jakarta Selatan"),
        (["menteng"], "Menteng, Jakarta Pusat"),
        (["scbd", "senayan"], "Senayan, Jakarta"),
        (["sudirman"], "Sudirman, Jakarta"),
        (["thamrin"], "Thamrin, Jakarta"),
        (["kuningan"], "Kuningan, Jakarta Selatan"),
        (["tebet"], "Tebet, Jakarta Selatan"),
        (["cikini"], "Cikini, Jakarta Pusat"),
        (["bintaro"], "Bintaro, Tangerang Selatan"),
        (["karawaci"], "Karawaci, Tangerang"),
        (["serpong"], "Serpong, Tangerang Selatan"),
        (["tangerang selatan", "tangsel"], "Tangerang Selatan"),
        (["tangerang"], "Tangerang"),
        (["jakarta selatan", "jaksel"], "Jakarta Selatan"),
        (["jakarta utara", "jakut"], "Jakarta Utara"),
        (["jakarta barat", "jakbar"], "Jakarta Barat"),
        (["jakarta timur", "jaktim"], "Jakarta Timur"),
        (["jakarta pusat", "jakpus"], "Jakarta Pusat"),
        (["jakarta"], "Jakarta"),
        (["bekasi"], "Bekasi"),
        (["depok"], "Depok"),
        (["bogor"], "Bogor"),
        (["dago"], "Dago, Bandung"),
        (["lembang"], "Lembang, Bandung"),
        (["bandung"], "Bandung"),
        (["jogja", "yogyakarta", "yogya"], "Yogyakarta"),
        (["semarang"], "Semarang"),
        (["malang"], "Malang"),
        (["surabaya"], "Surabaya"),
        (["canggu"], "Canggu, Bali"),
        (["ubud"], "Ubud, Bali"),
        (["seminyak"], "Seminyak, Bali"),
        (["uluwatu"], "Uluwatu, Bali"),
        (["kuta"], "Kuta, Bali"),
        (["bali"], "Bali"),
    ]

    private func regexMatches(_ pattern: String, in text: String, group: Int = 0) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges > group,
                  let r = Range(match.range(at: group), in: text) else { return nil }
            return String(text[r])
        }
    }

    func parseSignals(title: String, caption: String) -> CaptionSignals {
        var signals = CaptionSignals()

        signals.mentions = regexMatches("@[\\w][\\w. ]{1,29}", in: caption)
        signals.hashtags = regexMatches("#\\w+", in: caption)
        
        // TikTok's location tag (only when the creator attached one).
        let poiName = title.isEmpty ? nil : title

        // "📍 Kyomi Cafe, BSD City" / "lokasi: Bakmi Aloi, Ruko Glaze 2" —
        // the creator-authored location line.
        if let hint = regexMatches(Self.locationLinePattern, in: caption, group: 1).first {
            // Without line breaks the pin text runs on into the next sentence;
            // a double space is where a line break used to be.
            let locationLine = (hint.components(separatedBy: "  ").first ?? hint)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let parts = locationLine
                .components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }

            // A name on its own line, then "📍 <mall or area>": the pin line is
            // where the place is, so the name is next to it — not the first part
            // of the pin. (A tagged location only counts when it is itself a
            // location — a tag that names the venue should stay the name.)
            let poiIsLocation = poiName.map { looksLikeLocation($0) && locationLine.localizedCaseInsensitiveContains($0) } ?? false
            let pinIsLocation = poiIsLocation || looksLikeLocation(parts.first ?? "")

            // The name next to the pin: first the text just before it on the
            // same line (captions don't always keep their line breaks, so the
            // name and the pin can end up on one line), then the line above.
            let nameNearPin = [textBeforeLocationMarker(in: caption), lineAbove(locationLine, in: caption)]
                .compactMap { $0 }
                .first(where: looksLikeName)

            if pinIsLocation, let nameNearPin {
                signals.nameCandidate = nameNearPin
                signals.addressCandidate = locationLine
                print("AISummaryService: name from the text next to the 📍 line")
            } else if let poiName, !poiIsLocation {
                // A tag that names the venue, not a mall or area.
                signals.nameCandidate = poiName
                print("AISummaryService: name from TikTok's location tag")
            } else if pinIsLocation {
                // The pin (and any tag) only say WHERE it is — a mall or an area,
                // not the place. Leave the name to Gemini, which reads the whole
                // caption, instead of saving the mall as the place.
                signals.addressCandidate = locationLine
                print("AISummaryService: 📍 line is a location with no name next to it — Gemini will find the name")
            } else if let first = parts.first {
                signals.nameCandidate = first
                if parts.count > 1 {
                    signals.addressCandidate = parts.dropFirst().joined(separator: ", ")
                }
                print("AISummaryService: name from the 📍 line itself (pin is location: \(pinIsLocation), name near pin: \(nameNearPin ?? "none"))")
            }
        } else if let poiName, looksLikeLocation(poiName) {
            // The tag is a street, mall or area — keep it as the location only.
            signals.addressCandidate = poiName
            print("AISummaryService: no 📍 line — TikTok's location tag is a location, not a name")
        } else {
            signals.nameCandidate = poiName
            print("AISummaryService: no 📍 line — name from TikTok's location tag: \(poiName ?? "none")")
        }

        // All-caps names read better capitalized ("NAMA TOKO" → "Nama Toko")
        if let name = signals.nameCandidate, name == name.uppercased(), name.contains(where: \.isLetter) {
            signals.nameCandidate = name.capitalized
        }

        // Known-area scan: catches "#gadingserpong", "di PIK", etc. even when
        // there's no 📍 line and the model call fails.
        if signals.addressCandidate == nil {
            let haystack = caption + " " + title
            outer: for entry in Self.knownAreas {
                for key in entry.keys {
                    let pattern = "\\b" + NSRegularExpression.escapedPattern(for: key) + "\\b"
                    if !regexMatches(pattern, in: haystack).isEmpty {
                        signals.addressCandidate = entry.canonical
                        break outer
                    }
                }
            }
        }

        // Price mentions: "25k", "99rb", "25 ribu", "1,5 juta" → rough level
        if let priceMatch = regexMatches("(\\d+[.,]?\\d*)\\s*(k\\b|rb\\b|ribu|jt\\b|juta)", in: caption).first {
            let digits = priceMatch.replacingOccurrences(of: ",", with: ".")
                .components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
                .joined()
            if let value = Double(digits) {
                let rupiah = priceMatch.lowercased().contains("j") ? value * 1_000_000 : value * 1_000
                switch rupiah {
                case ..<40_000:    signals.priceLevel = 1
                case ..<150_000:   signals.priceLevel = 2
                case ..<400_000:   signals.priceLevel = 3
                default:           signals.priceLevel = 4
                }
            }
        }

        return signals
    }

    /// "📍 Kyomi Cafe, BSD City" / "lokasi: Bakmi Aloi" — group 1 is the text after the marker.
    /// "lokasi"/"alamat" must be whole words ("lokasinya:" is allowed explicitly):
    /// without the \b, "Lokasinya 📍 …" matched "lokasi" and returned "nya".
    /// "•" and "|" end the text too — they separate caption sections.
    private static let locationLinePattern =
        "(?:📍|\\bloc(?:ation)?\\s*[:=]|\\blokasi(?:nya)?\\b\\s*[:=]?|\\balamat(?:nya)?\\b\\s*[:=]?)\\s*([^#\\n!?📍•|]{3,70})"

    /// The text just before the 📍 / "lokasi:" marker on the same line, back to
    /// the previous sentence end or emoji: "…buka besok! NAMA TOKO 📍 <location>"
    /// gives "NAMA TOKO". nil when the marker starts its line.
    private func textBeforeLocationMarker(in caption: String) -> String? {
        guard
            let regex = try? NSRegularExpression(pattern: Self.locationLinePattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: caption, range: NSRange(caption.startIndex..., in: caption)),
            let marker = Range(match.range, in: caption)
        else { return nil }

        var chunk: [Character] = []
        for character in caption[..<marker.lowerBound].reversed() {
            let isEmoji = character.unicodeScalars.contains { $0.properties.isEmojiPresentation }
            if character.isNewline || "!?.•#".contains(character) || isEmoji { break }
            chunk.append(character)
        }
        let text = String(chunk.reversed()).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    /// The nearest non-empty line above the one containing `text`, emoji removed.
    private func lineAbove(_ text: String, in caption: String) -> String? {
        let lines = caption.components(separatedBy: .newlines)
        guard let index = lines.firstIndex(where: { $0.contains(text) }), index > 0 else { return nil }
        for line in lines[..<index].reversed() {
            let cleaned = String(line.unicodeScalars.filter { !$0.properties.isEmojiPresentation })
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { return cleaned }
        }
        return nil
    }

    /// A short standalone line that could be a shop's name — not a sentence
    /// like "Rekomendasi cafe baru di BSD!".
    private func looksLikeName(_ line: String) -> Bool {
        let lower = line.lowercased()
        let words = line.split(separator: " ")
        guard (2...40).contains(line.count), (1...6).contains(words.count),
              line.contains(where: \.isLetter),
              !line.contains(where: { "#@!?:".contains($0) }),
              !lower.contains("http")
        else { return false }

        let filler = [" di ", "rekomendasi", "review", "tempat", "buat ", "yang ", "baru", "enak",
                      "murah", "wajib", "cobain", "nyobain", "kuliner", "the best", "must try",
                      " spot ", " date ", " vibes ", " aesthetic ",
                      // "Lokasinya 📍 …" introduces the pin; it isn't a name
                      "lokasi", "alamat", "location", "address",
                      // "nemu cafe gemes" is a reaction, not a name
                      "nemu", "gemes", "gemas"]
        return !filler.contains { (" " + lower + " ").contains($0) }
    }

    /// Lowercase letters and digits only, accents folded: "Masen Matcha",
    /// "#masenmatcha" and "@Masen_Matcha" all become "masenmatcha".
    private static func squashed(_ text: String) -> String {
        String(
            text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                .unicodeScalars
                .filter { CharacterSet.alphanumerics.contains($0) }
        )
        .lowercased()
    }

    /// True when a hashtag or @mention spells out the name — strong proof the
    /// name is the venue, since nobody hashtags the street a café is on.
    private static func isConfirmed(_ name: String, by tagsAndMentions: [String]) -> Bool {
        let target = squashed(name)
        guard target.count >= 4 else { return false }
        return tagsAndMentions.contains { squashed($0).contains(target) }
    }

    /// True when `name` really occurs in `text` — spelled out, or squashed into
    /// a hashtag, or (for longer names) with at least 60% of its words present.
    private static func appears(_ name: String, in text: String) -> Bool {
        let target = squashed(name)
        guard target.count >= 3 else { return false }
        if squashed(text).contains(target) { return true }

        let words = { (value: String) in
            Set(value.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 2 })
        }
        let nameWords = words(name)
        guard nameWords.count >= 2 else { return false }
        return Double(nameWords.intersection(words(text)).count) / Double(nameWords.count) >= 0.6
    }

    /// A mall, a junction, a ruko, a street, a known area — somewhere a place
    /// is, rather than the place itself.
    private func looksLikeLocation(_ text: String) -> Bool {
        let lower = " " + text.lowercased() + " "
        let markers = [" mall", " junction", " plaza", " square", " tower", " ruko ", " jl ", " jl.", " jalan ",
                       " lt ", " lt.", " lantai ", " blok ", " boulevard", " market", " park ", " city ",
                       " residence", " walk ", " avenue", " street"]
        if markers.contains(where: lower.contains) { return true }
        return Self.knownAreas.contains { entry in entry.keys.contains { lower.contains(" \($0) ") } }
    }

    // MARK: - Gemini (Firebase AI Logic)

    private func runGemini(
        name: String,
        address: String,
        caption: String,
        authorNickname: String?,
        signals: CaptionSignals
    ) async -> PlaceSummary? {
        do {
            let start = Date()
            let extraction = try await GeminiPlaceExtractor.shared.extract(
                name: name,
                address: address,
                caption: caption,
                authorNickname: authorNickname,
                hashtags: signals.hashtags
            )
            let elapsed = Date().timeIntervalSince(start)

            // Gemini read the whole caption, so its venue name wins over the
            // tag / 📍 line — those are often just a street, mall or area.
            // Guard: the name has to actually appear in what Gemini was given
            // (caption, hashtags, tag), so it can't make one up.
            let modelName = extraction.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let modelAddress = extraction.address.trimmingCharacters(in: .whitespacesAndNewlines)
            let givenText = [caption, name, address].joined(separator: " ")
            let modelNameIsGrounded = !modelName.isEmpty
                && !looksLikeLocation(modelName)
                && Self.appears(modelName, in: givenText)
            // Without a grounded Gemini name, fall back to the caption's own
            // candidate — but never to something that looks like a location.
            let fallbackCandidate = signals.nameCandidate.flatMap { looksLikeLocation($0) ? nil : $0 }
            var finalName = modelNameIsGrounded
                ? modelName
                : (fallbackCandidate ?? Self.unknownPlaceName)
            if !modelName.isEmpty && !modelNameIsGrounded {
                print("AISummaryService: ignoring Gemini name '\(modelName)' — not found in the caption or looks like a location")
            }
            let finalAddress = (signals.addressCandidate ?? modelAddress).isEmpty
                ? address
                : (signals.addressCandidate ?? modelAddress)

            // Guardrail: never let the creator's own account name slip through
            // as the place name (the model is told not to, but names can be
            // ambiguous — e.g. a creator who names their account after their shop).
            if let authorNickname, !authorNickname.isEmpty,
               finalName.caseInsensitiveCompare(authorNickname) == .orderedSame {
                finalName = fallbackCandidate ?? Self.unknownPlaceName
            }

            let finalPrice = signals.priceLevel ?? max(1, min(4, extraction.priceLevel))

            print("AISummaryService: gemini extracted name='\(finalName)' area='\(finalAddress)' category=\(extraction.category) in \(String(format: "%.2f", elapsed))s")

            // The description is written from the final (already corrected)
            // facts only — never from the raw caption — by on-device Foundation
            // Models. Never Gemini, to save quota; the template otherwise.
            let written = await PlaceDescriptionWriter.describe(
                PlaceFacts(
                    name: finalName,
                    area: finalAddress,
                    category: extraction.category,
                    specialty: extraction.specialty,
                    vibes: extraction.vibes,
                    setting: extraction.setting,
                    highlights: extraction.highlights,
                    priceLevel: finalPrice
                )
            )
            let finalSummary = written ?? fallbackSummary(name: finalName, address: finalAddress, caption: caption)
            print("AISummaryService: description from \(written == nil ? "template" : "Foundation Models")")

            return PlaceSummary(
                name: finalName,
                address: finalAddress,
                summary: finalSummary,
                tags: buildTags(from: extraction),
                priceLevel: finalPrice,
                isAIGenerated: true
            )
        } catch {
            print("AISummaryService: Gemini extraction failed — \(Self.describe(error))")
            return nil
        }
    }

    /// `GenerateContentError` is a plain `enum: Error` with no `LocalizedError`
    /// conformance, so `localizedDescription` on it is Foundation's useless
    /// "The operation couldn't be completed." The real cause — an HTTP status
    /// and a backend message, e.g. an unknown model id or an App Check
    /// rejection — sits in the wrapped `underlying` error, which does carry a
    /// description. Unwrap one level so failures are actually diagnosable.
    private static func describe(_ error: Error) -> String {
        guard case GenerateContentError.internalError(let underlying) = error else {
            return "\(error)"
        }

        return "\(underlying.localizedDescription) [\(underlying)]"
    }

    // MARK: - Tag assembly (deterministic, from constrained facts)

    private let blockedTags: Set<String> = [
        "foodreview", "fyp", "bakal", "madura", "review", "kuliner", "enak", "makan",
        "tempat", "rekomendasi", "buat", "dan", "yang", "untuk", "dari", "bisa", "kamu",
        "kita", "ada", "guys", "nyobain", "wajib", "sini", "sih", "banget", "sangat",
        "bestie", "besti", "bunda", "ini", "nemu", "temen", "tonton", "video", "baru",
        "sana", "situ", "fypシ", "jalan", "makanan", "minuman"
    ]

    private func buildTags(from extraction: GeminiPlaceExtraction) -> [String] {
        // Priority order: category > specialty > vibes > setting
        var tags: [String] = [extraction.category.tagWord]

        let specialty = extraction.specialty
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
        if !specialty.isEmpty, specialty.count >= 3, !blockedTags.contains(specialty) {
            tags.append(specialty)
        }

        tags.append(contentsOf: extraction.vibes.map(\.tagWord))
        tags.append(extraction.setting.tagWord)

        var seen = Set<String>()
        var result = tags.filter { seen.insert($0).inserted }

        let defaults = ["date-spot", "cozy", "aesthetic", "casual"]
        var index = 0
        while result.count < 4 {
            let candidate = defaults[index % defaults.count]
            if !result.contains(candidate) {
                result.append(candidate)
            }
            index += 1
        }
        return Array(result.prefix(4))
    }

    // MARK: - Fallback helpers

    private func fallbackSummary(name: String, address: String, caption: String) -> String {
        // Never dump the raw caption — compose a plain sentence instead.
        let place = name == Self.unknownPlaceName ? "This spot" : name
        let areaPart = address.isEmpty ? "" : " in \(address)"
        return "\(place)\(areaPart), saved for your next date together. Open the map below to plan your visit."
    }

    private func inferTags(from text: String) -> [String] {
        let lower = text.lowercased()

        let candidateTags = [
            // Culinary
            "bakmi", "coffee", "dessert", "cookies", "dinner", "chinese", "indonesian", "japanese", "cozy", "cafe", "tea", "pasta", "burger", "pizza",
            // Entertainment
            "nature", "park", "relax", "activity", "outdoor", "indoor", "museum", "arcade", "gallery", "beach", "sunset", "view", "aesthetic"
        ]

        var tags: [String] = []
        for candidate in candidateTags {
            if lower.contains(candidate) {
                // Mutual exclusivity for indoor/outdoor
                if candidate == "indoor" && tags.contains("outdoor") { continue }
                if candidate == "outdoor" && tags.contains("indoor") { continue }
                tags.append(candidate)
            }
            if tags.count >= 4 { break }
        }

        // Pad using standard default list if less than 4
        let defaults = ["date-spot", "cozy", "aesthetic", "casual"]
        var index = 0
        while tags.count < 4 {
            let candidate = defaults[index % defaults.count]
            if !tags.contains(candidate) {
                tags.append(candidate)
            }
            index += 1
        }

        return Array(tags.prefix(4))
    }

    private func inferPriceLevel(from text: String) -> Int {
        let lower = text.lowercased()
        if lower.contains("premium") || lower.contains("fine dining") || lower.contains("mewah") || lower.contains("fancy") { return 3 }
        if lower.contains("murah") || lower.contains("affordable") || lower.contains("budget") || lower.contains("cuan") { return 1 }
        return 2
    }
}
