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

    // MARK: - Generate Summary

    /// Generates a concise, date-friendly summary from scraped TikTok metadata.
    /// - Parameters:
    ///   - placeName: Name of the place (from POI or OG title).
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

        let name = placeName ?? "this place"
        let addr = address   ?? ""
        // Gemini's context window comfortably fits a full TikTok caption —
        // no need for the aggressive truncation the old on-device model needed.
        let cap = String((caption ?? "").prefix(4000))

        // Deterministic pre-parse: "📍 Name, Area" lines, mentions, hashtags,
        // prices. High-precision signals that don't need the model at all,
        // and win over the model's guess when both exist.
        let signals = parseSignals(title: name, caption: cap)

        if let result = await runGemini(
            name: name,
            address: addr,
            caption: cap,
            authorNickname: authorNickname,
            signals: signals
        ) {
            return result
        }

        // Heuristic fallback — composed from parsed signals, never the raw caption
        let fallbackName = signals.nameCandidate ?? name
        let fallbackAddress = signals.addressCandidate ?? addr
        return PlaceSummary(
            name: fallbackName,
            address: fallbackAddress,
            summary: fallbackSummary(name: fallbackName, address: fallbackAddress, caption: cap),
            tags: inferTags(from: cap + " " + name + " " + signals.hashtags.joined(separator: " ")),
            priceLevel: signals.priceLevel ?? inferPriceLevel(from: cap),
            isAIGenerated: false
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
        
        if title.isEmpty {
            // "📍 Kyomi Cafe, BSD City" / "lokasi: Bakmi Aloi, Ruko Glaze 2" —
            // the creator-authored location line is the most reliable signal.
            if let hint = regexMatches(
                "(?:📍|\\bloc(?:ation)?\\s*[:=]|\\blokasi\\s*[:=]?|\\balamat\\s*[:=]?)\\s*([^#\\n!?📍]{3,70})",
                in: caption,
                group: 1
            ).first {
                let parts = hint
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .components(separatedBy: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
                if let first = parts.first {
                    signals.nameCandidate = first
                    if parts.count > 1 {
                        signals.addressCandidate = parts.dropFirst().joined(separator: ", ")
                    }
                }
            }
        } else {
            signals.nameCandidate = title
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

            // The creator-authored "📍 Name, Area" line beats the model when
            // both exist — the model can drift, the location line can't.
            let modelName = extraction.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let modelAddress = extraction.address.trimmingCharacters(in: .whitespacesAndNewlines)
            var finalName = signals.nameCandidate ?? (modelName.isEmpty ? name : modelName)
            let finalAddress = (signals.addressCandidate ?? modelAddress).isEmpty
                ? address
                : (signals.addressCandidate ?? modelAddress)

            // Guardrail: never let the creator's own account name slip through
            // as the place name (the model is told not to, but names can be
            // ambiguous — e.g. a creator who names their account after their shop).
            if let authorNickname, !authorNickname.isEmpty,
               finalName.caseInsensitiveCompare(authorNickname) == .orderedSame {
                finalName = signals.nameCandidate ?? name
            }

            let summary = extraction.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let finalSummary = summary.isEmpty
                ? fallbackSummary(name: finalName, address: finalAddress, caption: caption)
                : summary

            print("AISummaryService: gemini extracted name='\(finalName)' area='\(finalAddress)' category=\(extraction.category) in \(String(format: "%.2f", elapsed))s")

            return PlaceSummary(
                name: finalName,
                address: finalAddress,
                summary: finalSummary,
                tags: buildTags(from: extraction),
                priceLevel: signals.priceLevel ?? max(1, min(4, extraction.priceLevel)),
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
        // Never dump the raw caption — compose a clean sentence instead.
        let areaPart = address.isEmpty ? "" : " in \(address)"
        return "\(name)\(areaPart) — saved from a TikTok you loved. Open the post for the full vibe, and check the map below to plan your visit."
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
