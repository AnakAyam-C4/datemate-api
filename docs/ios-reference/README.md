# iOS reference (read-only snapshot)

Swift sources from the DateMate iOS app that this backend ports. They are NOT compiled and NOT a dependency; read them for behaviour only.

Snapshot: branch devs @ c9ee75e (Place, CloudinaryService, PlacesService) and branch kezia @ c75fd73 (GeocodingService, PlaceImportService). Refreshed 2026-10-12 from the dev/kezia working tree (not yet committed there): AISummaryService, GeminiPlaceExtractor, SwiftSoupService, PlaceDescriptionWriter.

`src/imports/tests/signals.swift-diff.test.ts` compiles the Swift code in this folder and checks the TypeScript port against it — re-copy these files whenever the iOS logic changes.

| File | Why it matters |
|---|---|
| Place.swift | Contract of the Firestore places document. lat/lng are non-optional Double; createdAt is seconds since epoch as a Double |
| SwiftSoupService.swift | TikTok page scrape: desktop identity, the itemStruct JSON path (caption, creator nickname, cover, poi.name, poi.address) |
| AISummaryService.swift | Deterministic signals (parseSignals, the name-next-to-📍 and street/mall/area rules, knownAreas, price regex), buildTags, blockedTags, when Gemini is skipped (name confirmed by hashtag/@mention) |
| GeminiPlaceExtractor.swift | Gemini response schema, category/vibe/setting enums and their tagWord mappings, system instruction (venue vs. location) |
| PlaceDescriptionWriter.swift | The on-device Foundation Models description and the `PlaceFacts` it reads — the facts the server will save for the phone |
| GeocodingService.swift | Layered geocoding and verification rules (from branch kezia, not yet on devs) |
| PlaceImportService.swift | Pipeline order and the unresolved-location sentinel (-6.302, 106.652) (from branch kezia) |
| CloudinaryService.swift | Thumbnail re-host and delete; currently signs with the API secret on the client, to be moved server-side |
| PlacesService.swift | How places are written to Firestore |

Intentionally NOT included: Config.swift (it holds the Cloudinary API secret).
