//
//  CloudinaryService.swift
//  DateRecommendation
//
//  Uploads an image to Cloudinary using an unsigned upload preset
//  and returns the permanent secure URL.
//
//  Folder: datemate/   (configured in your Cloudinary upload preset)
//

import Foundation
import UIKit
import CryptoKit

// MARK: - Result

struct CloudinaryUploadResult {
    let secureURL: String
    let publicId: String
    let width: Int
    let height: Int
}

// MARK: - Errors

enum CloudinaryError: LocalizedError {
    case invalidImageData
    case networkError(Error)
    case badStatus(Int, String)
    case missingSecureURL
    case parseError
    case deleteFailed
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .invalidImageData:        return "Could not convert image to JPEG data."
        case .networkError(let e):     return "Network error: \(e.localizedDescription)"
        case .badStatus(let c, let m): return "Cloudinary returned HTTP \(c): \(m)"
        case .missingSecureURL:        return "Upload succeeded but no URL was returned."
        case .parseError:              return "Failed to parse Cloudinary URL."
        case .deleteFailed:            return "Failed to delete Cloudinary image."
        case .invalidURL:              return "Invalid URL endpoint."
        }
    }
}

// MARK: - Service

final class CloudinaryService {

    static let shared = CloudinaryService()
    private init() {}

    private let uploadURL = URL(string:
        "https://api.cloudinary.com/v1_1/\(Config.cloudinaryCloudName)/image/upload"
    )!

    // MARK: - Upload from remote URL

    /// Downloads `imageURL` and uploads it to Cloudinary.
    /// Returns a permanent Cloudinary URL — no x-expires, no expiry.
    func uploadThumbnail(from imageURL: String, folder: String = "datemate") async throws -> CloudinaryUploadResult {
        // 1. Download the image data
        guard let srcURL = URL(string: imageURL) else {
            throw CloudinaryError.invalidImageData
        }

        let (imageData, _) = try await URLSession.shared.data(from: srcURL)
        guard !imageData.isEmpty else {
            throw CloudinaryError.invalidImageData
        }

        // 2. Upload to Cloudinary
        return try await uploadData(imageData, mimeType: "image/jpeg", folder: folder)
    }

    /// Uploads a UIImage directly (e.g. from camera / photo picker).
    func uploadImage(_ image: UIImage, folder: String = "datemate", quality: CGFloat = 0.85) async throws -> CloudinaryUploadResult {
        guard let data = image.jpegData(compressionQuality: quality) else {
            throw CloudinaryError.invalidImageData
        }
        return try await uploadData(data, mimeType: "image/jpeg", folder: folder)
    }

    // MARK: - Core upload

    private func uploadData(
        _ imageData: Data,
        mimeType: String,
        folder: String
    ) async throws -> CloudinaryUploadResult {
        // Build multipart/form-data body
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()

        func append(_ string: String) {
            if let d = string.data(using: .utf8) { body.append(d) }
        }

        // upload_preset
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"upload_preset\"\r\n\r\n")
        append("\(Config.cloudinaryUploadPreset)\r\n")

        // folder
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"folder\"\r\n\r\n")
        append("\(folder)\r\n")

        // file
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"thumbnail.jpg\"\r\n")
        append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(imageData)
        append("\r\n")

        append("--\(boundary)--\r\n")

        // Build request
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        // Execute
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw CloudinaryError.networkError(error)
        }

        if let http = response as? HTTPURLResponse,
           !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CloudinaryError.badStatus(http.statusCode, body)
        }

        // Parse response
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let secureURL = json["secure_url"] as? String else {
            throw CloudinaryError.missingSecureURL
        }

        let publicId = json["public_id"] as? String ?? ""
        let width    = json["width"]  as? Int ?? 0
        let height   = json["height"] as? Int ?? 0

        return CloudinaryUploadResult(
            secureURL: secureURL,
            publicId: publicId,
            width: width,
            height: height
        )
    }

    // MARK: - Delete Image

    /// Deletes an image from Cloudinary using its secure URL
    func deleteImage(from urlString: String) async throws {
        guard !urlString.isEmpty else { return }
        
        // 1. Extract public_id
        let uploadMarker = "/upload/"
        guard let uploadRange = urlString.range(of: uploadMarker) else {
            throw CloudinaryError.parseError
        }
        
        let suffix = urlString[uploadRange.upperBound...]
        var pathComponents = suffix.components(separatedBy: "/")
        
        // Remove version number if present (starts with 'v' and followed by numbers)
        if let first = pathComponents.first, first.hasPrefix("v"), first.dropFirst().allSatisfy({ $0.isNumber }) {
            pathComponents.removeFirst()
        }
        
        let finalPath = pathComponents.joined(separator: "/")
        
        let publicId: String
        if let extRange = finalPath.range(of: ".", options: .backwards) {
            publicId = String(finalPath[..<extRange.lowerBound])
        } else {
            publicId = String(finalPath)
        }
        
        guard !publicId.isEmpty else { throw CloudinaryError.parseError }
        
        // 2. Prepare API details
        let cloudName = Config.cloudinaryCloudName
        let apiKey = Config.cloudinaryAPIKey
        let apiSecret = Config.cloudinaryAPISecret
        
        if apiKey.isEmpty || apiSecret.isEmpty || apiKey.contains("YOUR_") {
            print("⚠️ Cloudinary API Key or Secret is missing, cannot delete image from Cloudinary.")
            return
        }
        
        let timestamp = String(Int(Date().timeIntervalSince1970))
        
        // 3. Generate SHA-1 Signature
        let signatureString = "public_id=\(publicId)&timestamp=\(timestamp)\(apiSecret)"
        let digest = Insecure.SHA1.hash(data: Data(signatureString.utf8))
        let signature = digest.map { String(format: "%02hhx", $0) }.joined()
        
        // 4. Send API Request
        let endpoint = "https://api.cloudinary.com/v1_1/\(cloudName)/image/destroy"
        guard let url = URL(string: endpoint) else { throw CloudinaryError.invalidURL }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type") // Needed form-encoded for standard REST API
        
        let bodyString = "api_key=\(apiKey)&public_id=\(publicId)&signature=\(signature)&timestamp=\(timestamp)"
        request.httpBody = bodyString.data(using: .utf8)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
            print("🚨 Failed to delete Cloudinary image: \(String(data: data, encoding: .utf8) ?? "")")
            throw CloudinaryError.deleteFailed
        }
        
        print("✅ Cloudinary image deleted successfully: \(publicId)")
    }
}
