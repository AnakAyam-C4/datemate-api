//
//  SwiftSoupService.swift
//  DateRecommendation
//
//  Scrapes a TikTok video page to extract:
//  - thumbnail URL (video.originCover / video.cover)
//  - POI address (poi.address)
//  - POI name (poi.name)
//  - Caption (desc)
//

import Foundation
import SwiftSoup

// MARK: - Result model

struct TikTokMetadata {
    let title: String?          // poi.name or parsed from caption
    let caption: String?        // desc (original TikTok caption)
    let thumbnailURL: String?   // video.originCover or video.cover
    let address: String?        // poi.address
    let authorNickname: String? // author.nickname
}

// MARK: - Errors

enum SwiftSoupServiceError: LocalizedError {
    case invalidURL
    case badStatus(Int)
    case unreadableHTML
    case noUsefulData

    var errorDescription: String? {
        switch self {
        case .invalidURL:          return "Invalid TikTok URL."
        case .badStatus(let c):    return "Server returned HTTP \(c)."
        case .unreadableHTML:      return "Could not decode HTML."
        case .noUsefulData:        return "No metadata found in page."
        }
    }
}

// MARK: - Service

final class SwiftSoupService {

    static let shared = SwiftSoupService()
    private init() {}

    /// Fetches a TikTok page and returns extracted metadata.
    func extractMetadata(from rawURL: String) async throws -> TikTokMetadata {
        let html = try await fetchHTML(from: rawURL)
        return try parseMetadata(from: html)
    }

    // MARK: - Fetch

    private func fetchHTML(from rawURL: String) async throws -> String {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            throw SwiftSoupServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        // Mimick mobile Safari so TikTok serves OG/script data
        request.setValue(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            forHTTPHeaderField: "User-Agent"
        )
        request.setValue(
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            forHTTPHeaderField: "Accept"
        )
        request.setValue("en-US,en;q=0.9,id;q=0.8",    forHTTPHeaderField: "Accept-Language")
        request.setValue("https://www.tiktok.com/",      forHTTPHeaderField: "Referer")

        let (data, response) = try await URLSession.shared.data(for: request)

        if let http = response as? HTTPURLResponse,
           !(200...299).contains(http.statusCode) {
            throw SwiftSoupServiceError.badStatus(http.statusCode)
        }

        guard let html = String(data: data, encoding: .utf8) else {
            throw SwiftSoupServiceError.unreadableHTML
        }

        return html
    }

    // MARK: - Parse

    private func parseMetadata(from html: String) throws -> TikTokMetadata {
        let document = try SwiftSoup.parse(html)

        // --- Open Graph fallbacks (always available even without JS) ---
        let ogImage   = try? document.select("meta[property=og:image]").first()?.attr("content")
        let ogTitle   = try? document.select("meta[property=og:title]").first()?.attr("content")
        let ogDesc    = try? document.select("meta[property=og:description]").first()?.attr("content")

        // --- Script-based extraction (TikTok embeds JSON in script tags) ---
        var scriptFields: [String: String] = [:]
        let scripts = try document.select("script")

        for script in scripts.array() {
            let src = script.data().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !src.isEmpty else { continue }

            // Pull every __UNIVERSAL_DATA_FOR_REHYDRATION__, SIGI_STATE, __NEXT_DATA__ blob
            let markers = [
                "__UNIVERSAL_DATA_FOR_REHYDRATION__",
                "SIGI_STATE",
                "__NEXT_DATA__",
                "itemStruct",
                "ItemModule"
            ]
            for marker in markers {
                guard src.contains(marker),
                      let json = extractBalancedJSON(in: src, after: marker) else { continue }
                flattenJSON(json, path: [], into: &scriptFields, limit: 150)
            }

            // Also try bare JSON
            if (src.hasPrefix("{") || src.hasPrefix("[")) {
                if let obj = parseJSON(src) {
                    flattenJSON(obj, path: [], into: &scriptFields, limit: 150)
                }
            }
        }

        let originCover = firstScriptValue(
            keys: ["originCover", "origincover", "shareCover", "sharecover"],
            in: scriptFields
        )

        let thumbnailURL = originCover ?? ogImage ?? firstScriptValue(
            keys: ["cover", "thumbnailUrl", "thumbnailurl"],
            in: scriptFields
        )

        let caption = firstScriptValue(
            keys: ["desc", "description", "caption"],
            in: scriptFields
        ) ?? ogDesc

        let address = firstScriptValue(
            keys: ["poi.address", "poi.name", "address"],
            in: scriptFields
        )

        let poiName = firstScriptValue(
            keys: ["poi.name", "poiname"],
            in: scriptFields
        )

        let authorNickname = firstScriptValue(
            keys: ["nickname", "uniqueId", "uniqueid", "authorNickname"],
            in: scriptFields
        )

        // Use poi.name as title first, fall back to OG title
        let title = poiName ?? ogTitle

        return TikTokMetadata(
            title: title?.nilIfEmpty,
            caption: caption?.nilIfEmpty,
            thumbnailURL: thumbnailURL?.nilIfEmpty,
            address: address?.nilIfEmpty,
            authorNickname: authorNickname?.nilIfEmpty
        )
    }

    // MARK: - JSON helpers

    private func extractBalancedJSON(in text: String, after marker: String) -> Any? {
        guard let markerRange = text.range(of: marker) else { return nil }
        let afterMarker = text[markerRange.upperBound...]

        for opening: Character in ["{", "["] {
            let closing: Character = opening == "{" ? "}" : "]"
            guard let startIdx = afterMarker.firstIndex(of: opening) else { continue }
            var depth = 0
            var inString = false
            var escaped = false
            var idx = startIdx

            while idx < text.endIndex {
                let ch = text[idx]
                if inString {
                    if escaped    { escaped = false }
                    else if ch == "\\" { escaped = true }
                    else if ch == "\"" { inString = false }
                } else {
                    if ch == "\""     { inString = true }
                    else if ch == opening  { depth += 1 }
                    else if ch == closing {
                        depth -= 1
                        if depth == 0 {
                            let snippet = String(text[startIdx...idx])
                            return parseJSON(snippet)
                        }
                    }
                }
                idx = text.index(after: idx)
            }
        }
        return nil
    }

    private func parseJSON(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private func flattenJSON(
        _ value: Any,
        path: [String],
        into fields: inout [String: String],
        limit: Int
    ) {
        guard fields.count < limit else { return }

        if let dict = value as? [String: Any] {
            for (k, v) in dict {
                flattenJSON(v, path: path + [k], into: &fields, limit: limit)
            }
        } else if let arr = value as? [Any] {
            for (i, v) in arr.prefix(5).enumerated() {
                flattenJSON(v, path: path + ["[\(i)]"], into: &fields, limit: limit)
            }
        } else {
            guard let last = path.last,
                  isInteresting(key: last) else { return }
            let label = compactLabel(for: path)
            let valueStr: String
            if let s = value as? String, !s.isEmpty { valueStr = s }
            else if let n = value as? NSNumber    { valueStr = n.stringValue }
            else { return }
            fields[label] = valueStr
        }
    }

    private let interestingKeys: Set<String> = [
        "desc", "description", "caption", "title",
        "nickname", "uniqueid", "uniqueId",
        "cover", "origincover", "originCover", "dynamiccover", "thumbnailurl",
        "address", "name",
        "playcount", "diggcount", "sharecount", "commentcount"
    ]

    private func isInteresting(key: String) -> Bool {
        interestingKeys.contains(key.lowercased())
    }

    private func compactLabel(for path: [String]) -> String {
        path.filter { !$0.hasPrefix("[") }.suffix(4).joined(separator: ".")
    }

    private func firstScriptValue(keys: [String], in fields: [String: String]) -> String? {
        for key in keys {
            // Exact match first
            if let v = fields[key] { return v }
            // Suffix match
            if let (_, v) = fields.first(where: { $0.key.lowercased().hasSuffix(key.lowercased()) }) {
                return v
            }
            // Contains match
            if let (_, v) = fields.first(where: { $0.key.lowercased().contains(key.lowercased()) }) {
                return v
            }
        }
        return nil
    }
}

private extension String {
    var nilIfEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
