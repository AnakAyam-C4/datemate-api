//
//  CollecionService.swift
//  DateRecommendation
//
//  Created by Kezia Meilany Tandapai on 08/07/26.
//

import FirebaseFirestore

final class PlaceService {
    
    static let shared = PlaceService()
    
    private let db = Firestore.firestore()
    private let placeRef = Firestore.firestore().collection("places")
    
    private init() {}
    
    // MARK: - Get All Places
    
    func getPlaces(
        userId: String,
        completion: @escaping (Result<[Place], Error>) -> Void
    ) {
        
        placeRef
            .whereField("savedBy", isEqualTo: userId)
            .getDocuments { snapshot, error in
                
                if let error {
                    completion(.failure(error))
                    return
                }
                
                guard let documents = snapshot?.documents else {
                    completion(.success([]))
                    return
                }
                
                DispatchQueue.main.async {
                    do {
                        let places = try documents.compactMap {
                            try $0.data(as: Place.self)
                        }
                        
                        completion(.success(places))
                        
                    } catch {
                        completion(.failure(error))
                    }
                }
            }
    }
    
    func getPlaces(
        userIds: [String],
        completion: @escaping (Result<[Place], Error>) -> Void
    ) {
        
        placeRef
            .whereField("savedBy", in: userIds)
            .getDocuments { snapshot, error in
                
                if let error {
                    completion(.failure(error))
                    return
                }
                
                guard let documents = snapshot?.documents else {
                    completion(.success([]))
                    return
                }
                
                DispatchQueue.main.async {
                    do {
                        let places = try documents.compactMap {
                            try $0.data(as: Place.self)
                        }
                        
                        completion(.success(places))
                        
                    } catch {
                        completion(.failure(error))
                    }
                }
            }
    }
    
    // MARK: - Get Place
    
    func getPlace(
        id: String,
        completion: @escaping (Result<Place, Error>) -> Void
    ) {
        
        placeRef.document(id).getDocument { snapshot, error in
            
            if let error {
                completion(.failure(error))
                return
            }
            
            guard let snapshot else {
                completion(.failure(NSError()))
                return
            }
            
            DispatchQueue.main.async {
                do {
                    let place = try snapshot.data(as: Place.self)
                    completion(.success(place))
                } catch {
                    completion(.failure(error))
                }
            }
        }
    }
    
    // MARK: - Add Place
    
    func addPlace(
        _ place: Place,
        completion: @escaping (Error?) -> Void
    ) {
        do {
            try placeRef
                .document(place.id)
                .setData(from: place)

            completion(nil)
        } catch {
            completion(error)
        }
    }
    
    // MARK: - Update Place

    func updatePlace(
        _ place: Place,
        completion: @escaping (Error?) -> Void
    ) {

        do {

            try placeRef
                .document(place.id)
                .setData(from: place)

            completion(nil)

        } catch {

            completion(error)
        }
    }
    
    // MARK: - Delete Place

    func deletePlace(
        id: String,
        completion: @escaping (Error?) -> Void
    ) {

        placeRef
            .document(id)
            .delete { error in
                completion(error)
            }
    }
    
    // MARK: - Mark As Visited
    
    func markVisited(
        placeId: String,
        visited: Bool,
        completion: @escaping (Error?) -> Void
    ) {

        placeRef
            .document(placeId)
            .updateData([
                "hasVisited": visited
            ]) { error in
                completion(error)
            }
    }
    
    // MARK: - Move Collection
    
    func moveCollection(
        placeId: String,
        to collectionId: String,
        completion: @escaping (Error?) -> Void
    ) {

        placeRef
            .document(placeId)
            .updateData([
                "collectionId": collectionId
            ]) { error in
                completion(error)
            }
    }
    
    // MARK: - Search Places
    
    func searchPlaces(
        keyword: String,
        userIds: [String],
        completion: @escaping (Result<[Place], Error>) -> Void
    ) {

        getPlaces(userIds: userIds) { result in

            switch result {

            case .failure(let error):
                completion(.failure(error))

            case .success(let places):

                let keyword = keyword.lowercased()

                let filtered = places.filter {

                    $0.title.lowercased().contains(keyword)

                    ||

                    ($0.desc?.lowercased().contains(keyword) ?? false)

                    ||

                    $0.tags.contains {
                        $0.lowercased().contains(keyword)
                    }

                }

                completion(.success(filtered))
            }
        }
    }
    
    // MARK: - Filter Places
    
    func filterPlaces(
        userIds: [String],
        collectionIds: [String],
        completion: @escaping (Result<[Place], Error>) -> Void
    ) {

        getPlaces(userIds: userIds) { result in

            switch result {

            case .failure(let error):
                completion(.failure(error))

            case .success(let places):

                if collectionIds.isEmpty {

                    completion(.success(places))
                    return
                }

                let filtered = places.filter {

                    collectionIds.contains($0.collectionId)

                }

                completion(.success(filtered))
            }
        }
    }
}
