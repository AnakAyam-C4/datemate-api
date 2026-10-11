//
//  Place.swift
//  DateRecommendation
//
//  Created by Fathan Naufal Adhitama on 02/07/26.
//

import Foundation

struct Place: Identifiable, Codable, Hashable {
    var id: String
    var savedBy: String
    
    var collectionId: String
    var title: String
    var url: String?
    
    var desc: String?
    var tags: [String]
    var priceLevel: Int
    var thumbnailUrl: String?
    
    var address: String?
    var lat: Double
    var lng: Double
    
    var hasVisited: Bool
    var createdAt: Double? = Date().timeIntervalSince1970
}
