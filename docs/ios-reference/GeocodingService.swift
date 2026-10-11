//
//  GeocodingService.swift
//  DateRecommendation
//
//  Resolves a place name + area (+ optional scraped address) to coordinates.
//  Apple's Indonesia data is patchy — MKLocalSearch happily returns random
//  streets and "BSD City" geocodes to Ambon — so every layer is verified
//  before its result is trusted.
//

import CoreLocation
import Foundation
import MapKit

struct GeocodeMatch {
    let coordinate: CLLocationCoordinate2D
    let address: String?
}

final class GeocodingService {

    static let shared = GeocodingService()
    private init() {}

    /// Greater-Jakarta centre used to bias POI search toward where most
    /// saved places are.
    private let biasCenter = CLLocationCoordinate2D(latitude: -6.302, longitude: 106.652)

    // MARK: - Public

    /// Strategy, in order — each layer must pass its own check:
    ///  1. MKLocalSearch POI, accepted only on real name overlap + country ID
    ///  1b. Scraped TikTok POI address via CLGeocoder (creator-attached, reliable)
    ///  2. Area centroid via CLGeocoder (right neighbourhood beats wrong POI)
    ///  3. "name + area" street-level, accepted only within 30 km of that centroid
    func geocode(name: String, area: String, scrapedAddress: String? = nil) async -> GeocodeMatch? {
        let expandedArea = expandAreaAliases(area)

        // 1. Verified POI search
        if let poi = await searchVerifiedPOI(name: name, area: expandedArea) {
            print("GeocodingService: hit via verified POI search")
            return poi
        }

        let geocoder = CLGeocoder()

        func geocode(_ query: String) async -> CLPlacemark? {
            do {
                let placemarks = try await geocoder.geocodeAddressString(query)
                return placemarks.first { $0.isoCountryCode == "ID" && $0.location != nil }
            } catch {
                print("GeocodingService: CLGeocoder failed for '\(query)' — \(error.localizedDescription)")
                return nil
            }
        }

        // 1b. Scraped TikTok POI address
        if let scrapedAddress, !scrapedAddress.isEmpty {
            let query = scrapedAddress.lowercased().contains("indonesia")
                ? scrapedAddress
                : "\(scrapedAddress), Indonesia"
            if let p = await geocode(query), let loc = p.location {
                print("GeocodingService: hit via scraped POI address")
                return GeocodeMatch(
                    coordinate: loc.coordinate,
                    address: formattedAddress(p) ?? scrapedAddress
                )
            }
        }

        // 2. Area centroid
        var areaMatch: GeocodeMatch?
        if !expandedArea.isEmpty {
            let query = expandedArea.lowercased().contains("indonesia")
                ? expandedArea
                : "\(expandedArea), Indonesia"
            if let p = await geocode(query), let loc = p.location {
                areaMatch = GeocodeMatch(
                    coordinate: loc.coordinate,
                    address: formattedAddress(p) ?? expandedArea
                )
            }
        }

        // 3. Street-level, sanity-checked against the centroid
        if !name.isEmpty {
            let query = expandedArea.isEmpty
                ? "\(name), Indonesia"
                : "\(name), \(expandedArea), Indonesia"
            if let p = await geocode(query), let loc = p.location {
                let match = GeocodeMatch(coordinate: loc.coordinate, address: formattedAddress(p))
                if let areaMatch {
                    let centroid = CLLocation(
                        latitude: areaMatch.coordinate.latitude,
                        longitude: areaMatch.coordinate.longitude
                    )
                    if loc.distance(from: centroid) <= 30_000 {
                        print("GeocodingService: hit via name+area street-level")
                        return match
                    }
                } else {
                    print("GeocodingService: hit via name+area (no centroid check)")
                    return match
                }
            }
        }

        if areaMatch == nil {
            print("GeocodingService: all attempts failed for \(name), \(area)")
        } else {
            print("GeocodingService: fell back to area centroid")
        }
        return areaMatch
    }

    // MARK: - Layers

    /// MKLocalSearch with strict verification — only returns a POI whose name
    /// genuinely matches the place (≥60% token overlap) and sits in Indonesia.
    private func searchVerifiedPOI(name: String, area: String) async -> GeocodeMatch? {
        func tokens(_ s: String) -> Set<String> {
            Set(
                s.lowercased()
                    .components(separatedBy: CharacterSet.alphanumerics.inverted)
                    .filter { $0.count >= 2 }
            )
        }

        let nameTokens = tokens(name)
        guard !nameTokens.isEmpty else { return nil }

        let biasRegion = MKCoordinateRegion(
            center: biasCenter,
            span: MKCoordinateSpan(latitudeDelta: 3.0, longitudeDelta: 3.0)
        )

        let queries = [
            area.isEmpty ? "\(name), Indonesia" : "\(name), \(area), Indonesia",
            "\(name), Indonesia",
        ]

        for query in queries {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = query
            request.region = biasRegion
            guard let response = try? await MKLocalSearch(request: request).start() else { continue }

            let scored: [(item: MKMapItem, score: Double)] = response.mapItems.compactMap { item in
                guard item.placemark.isoCountryCode == "ID", let itemName = item.name else { return nil }
                let overlap = nameTokens.intersection(tokens(itemName))
                let score = Double(overlap.count) / Double(nameTokens.count)
                return score >= 0.6 ? (item, score) : nil
            }

            if let best = scored.max(by: { $0.score < $1.score })?.item {
                return GeocodeMatch(
                    coordinate: best.placemark.coordinate,
                    address: best.placemark.title
                )
            }
        }
        return nil
    }

    /// Informal Jakarta-area names that Apple's geocoder doesn't know.
    private func expandAreaAliases(_ area: String) -> String {
        let aliases: [(pattern: String, replacement: String)] = [
            ("bsd city", "Serpong, Tangerang Selatan"),
            ("bsd", "Serpong, Tangerang Selatan"),
            ("pik 2", "Pantai Indah Kapuk 2, Jakarta Utara"),
            ("pik", "Pantai Indah Kapuk, Jakarta Utara"),
            ("gadser", "Gading Serpong, Tangerang"),
        ]
        for (pattern, replacement) in aliases {
            guard let regex = try? NSRegularExpression(
                pattern: "\\b\(pattern)\\b",
                options: [.caseInsensitive]
            ) else { continue }
            let range = NSRange(area.startIndex..., in: area)
            if regex.firstMatch(in: area, range: range) != nil {
                return regex.stringByReplacingMatches(in: area, range: range, withTemplate: replacement)
            }
        }
        return area
    }

    private func formattedAddress(_ p: CLPlacemark) -> String? {
        var parts: [String] = []
        for candidate in [p.name, p.subLocality, p.locality, p.administrativeArea] {
            if let candidate, !candidate.isEmpty, !parts.contains(candidate) {
                parts.append(candidate)
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}
