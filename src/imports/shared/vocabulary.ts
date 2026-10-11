/**
 * Constrained vocabulary for imported places.
 *
 * Ported verbatim from docs/ios-reference/GeminiPlaceExtractor.swift. The raw
 * values are the exact enum strings Gemini is allowed to return, and `tagWord`
 * is the tag the app shows. Keep both identical to Swift: the iOS app files
 * places under these tags, and a renamed value silently splits a category in two.
 */

export const PLACE_CATEGORIES = [
  "cafe",
  "restaurant",
  "bakery",
  "dessert",
  "streetFood",
  "park",
  "nature",
  "museum",
  "gallery",
  "arcade",
  "activity",
  "shopping",
  "beach",
  "viewpoint",
  "bar",
] as const;

export const PLACE_VIBES = [
  "cozy",
  "aesthetic",
  "romantic",
  "casual",
  "fancy",
  "fun",
  "relax",
  "hiddenGem",
] as const;

export const PLACE_SETTINGS = ["indoor", "outdoor"] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];
export type PlaceVibe = (typeof PLACE_VIBES)[number];
export type PlaceSetting = (typeof PLACE_SETTINGS)[number];

const CATEGORY_TAG: Record<PlaceCategory, string> = {
  cafe: "cafe",
  restaurant: "restaurant",
  bakery: "bakery",
  dessert: "dessert",
  streetFood: "street-food",
  bar: "bar",
  park: "park",
  nature: "nature",
  museum: "museum",
  gallery: "gallery",
  arcade: "arcade",
  activity: "activity",
  shopping: "shopping",
  beach: "beach",
  viewpoint: "view",
};

const VIBE_TAG: Record<PlaceVibe, string> = {
  cozy: "cozy",
  aesthetic: "aesthetic",
  romantic: "romantic",
  casual: "casual",
  fancy: "fancy",
  fun: "fun",
  relax: "relax",
  hiddenGem: "hidden-gem",
};

export const categoryTag = (category: PlaceCategory): string => CATEGORY_TAG[category];
export const vibeTag = (vibe: PlaceVibe): string => VIBE_TAG[vibe];
export const settingTag = (setting: PlaceSetting): string => setting;

/**
 * Where an imported place's coordinates came from. Additive field on
 * `places/{id}`; Swift's Codable ignores it until the app reads it.
 */
export const LOCATION_SOURCES = [
  "poi_tag",
  "caption",
  "cover_text",
  "video_text",
  "video_speech",
  "cache",
  "user_corrected",
  "area_only",
  "none",
] as const;

export type LocationSource = (typeof LOCATION_SOURCES)[number];

/**
 * The "no location" coordinate pair. The app hides the distance and the map
 * pin for exactly this pair (PlacesViewModel.swift, MapView.swift), so it must
 * match Swift bit for bit — never round or re-derive it.
 */
export const UNRESOLVED_COORDINATE = { lat: -6.302, lng: 106.652 } as const;
