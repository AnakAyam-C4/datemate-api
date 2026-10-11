# iOS reference (read-only snapshot)

Swift sources from the DateMate iOS app that this backend ports. They are NOT compiled and NOT a dependency; read them for behaviour only.

Snapshot: branch devs @ c9ee75e (6 files) and branch kezia @ c75fd73 (GeocodingService, PlaceImportService).

| File | Why it matters |
|---|---|
| Place.swift | Contract of the Firestore places document. lat/lng are non-optional Double; createdAt is seconds since epoch as a Double |
| SwiftSoupService.swift | TikTok page scrape: which JSON keys are read (caption, creator nickname, cover, poi.name, poi.address) |
| AISummaryService.swift | Deterministic signals (parseSignals, knownAreas, price regex), buildTags, blockedTags |
| GeminiPlaceExtractor.swift | Gemini response schema, category/vibe/setting enums and their tagWord mappings, system instruction |
| GeocodingService.swift | Layered geocoding and verification rules (from branch kezia, not yet on devs) |
| PlaceImportService.swift | Pipeline order and the unresolved-location sentinel (-6.302, 106.652) (from branch kezia) |
| CloudinaryService.swift | Thumbnail re-host and delete; currently signs with the API secret on the client, to be moved server-side |
| PlacesService.swift | How places are written to Firestore |

Intentionally NOT included: Config.swift (it holds the Cloudinary API secret).
