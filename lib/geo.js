// Geografické pomocné funkce — výpočet vzdálenosti a bounding boxu.

const EARTH_RADIUS_KM = 6371;

/** Vzdálenost dvou GPS bodů v km (haversine formula). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/** Obdélníkový box (min/max lat/lng) opsaný kružnici o daném poloměru kolem bodu. */
export function boundingBox(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lonMin: lon - lonDelta,
    lonMax: lon + lonDelta,
  };
}
