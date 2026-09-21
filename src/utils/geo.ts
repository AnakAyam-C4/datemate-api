export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in kilometres.
 * Accurate enough for "is this date spot nearby?" and cheap enough to run over
 * a few hundred candidate places inside a single request.
 */
export const distanceKm = (from: LatLng, to: LatLng): number => {
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(deltaLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Midpoint between the two partners' locations, so neither partner's side of
 * town dominates the deck. Falls back to whichever point exists.
 */
export const midpoint = (points: LatLng[]): LatLng | null => {
  const valid = points.filter(
    (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng),
  );

  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  // Averaging in Cartesian space avoids the antimeridian problem that plain
  // lat/lng averaging has. Overkill locally, correct everywhere.
  const cartesian = valid.map(({ lat, lng }) => {
    const latRad = toRadians(lat);
    const lngRad = toRadians(lng);

    return {
      x: Math.cos(latRad) * Math.cos(lngRad),
      y: Math.cos(latRad) * Math.sin(lngRad),
      z: Math.sin(latRad),
    };
  });

  const x = cartesian.reduce((sum, p) => sum + p.x, 0) / cartesian.length;
  const y = cartesian.reduce((sum, p) => sum + p.y, 0) / cartesian.length;
  const z = cartesian.reduce((sum, p) => sum + p.z, 0) / cartesian.length;

  return {
    lat: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  };
};
