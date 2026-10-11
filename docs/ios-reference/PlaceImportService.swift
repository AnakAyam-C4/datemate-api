//
//  PlaceImportService.swift
//  DateRecommendation
//
//  TikTok link → Place pipeline: scrape → AI summary → thumbnail upload →
//  geocode → clean title → persist. Pure orchestration with no view state;
//  PlacesViewModel owns the "Reading post.." placeholder around this call.
//

import Foundation

final class PlaceImportService {

    static let shared = PlaceImportService()
    private init() {}

    /// Coordinates meaning "location unresolved". The rest of the app
    /// (distanceString, map pins) treats this exact pair as "no location",
    /// so it must stay in sync with those checks.
    private let unresolvedCoordinate = (lat: -6.302, lng: 106.652)

    /// Runs the full import and writes the resulting Place to Firestore.
    /// The caller's Firestore listener surfaces it — no manual insert needed.
    func importPlace(from url: String, savedBy userId: String) async throws -> Place {
        // 1. Scrape TikTok page
        let metadata = try await SwiftSoupService.shared.extractMetadata(from: url)

        // 2. AI summary + name/area extraction
        let aiResult = await AISummaryService.shared.generateSummary(
            placeName: metadata.title,
            address: metadata.address,
            caption: metadata.caption,
            authorNickname: metadata.authorNickname
        )

        // 3. Thumbnail → Cloudinary (fall back to the raw URL on failure)
        var thumbnailURL: String? = nil
        if let rawThumb = metadata.thumbnailURL {
            do {
                thumbnailURL = try await CloudinaryService.shared.uploadThumbnail(from: rawThumb).secureURL
            } catch {
                print("PlaceImportService: Cloudinary failed, using raw thumbnail: \(error.localizedDescription)")
                thumbnailURL = rawThumb
            }
        }

        // 4. Geocode — scraped POI address (creator-attached) beats AI guesses
        var lat = unresolvedCoordinate.lat
        var lng = unresolvedCoordinate.lng
        var address = aiResult.address

        print("PlaceImportService: geocoding name='\(aiResult.name)' area='\(aiResult.address)' scrapedPOI='\(metadata.address ?? "-")'")
        if let match = await GeocodingService.shared.geocode(
            name: aiResult.name,
            area: aiResult.address,
            scrapedAddress: metadata.address
        ) {
            lat = match.coordinate.latitude
            lng = match.coordinate.longitude
            address = match.address ?? aiResult.address
            print("PlaceImportService: geocoded to \(lat),\(lng) — \(address)")
        }

        // 5. Build the Place
        let place = Place(
            id: UUID().uuidString,
            savedBy: userId,
            collectionId: "",   // unassigned until the user files it
            title: cleanPlaceName(aiResult.name),
            url: url,
            desc: aiResult.summary,
            tags: aiResult.tags,
            priceLevel: aiResult.priceLevel,
            thumbnailUrl: thumbnailURL,
            address: address,
            lat: lat,
            lng: lng,
            hasVisited: false
        )

        // 6. Persist
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PlaceService.shared.addPlace(place) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }

        return place
    }

    /// Strips "(…)", "[…]" and " - | : / @ " suffixes creators tack onto names.
    private func cleanPlaceName(_ name: String) -> String {
        var cleaned = name
        if let index = cleaned.firstIndex(where: { $0 == "(" || $0 == "[" }) {
            cleaned = String(cleaned[..<index])
        }
        let separators = [" - ", " | ", " : ", " / ", " @ "]
        for separator in separators {
            if let range = cleaned.range(of: separator) {
                cleaned = String(cleaned[..<range.lowerBound])
            }
        }
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
