export const SEARCH_RADIUS_METRES = 1000;
export const DRIVER_LOCATION_MAX_AGE_MS = 90_000;
export const DRIVER_LOCATION_MIN_INTERVAL_MS = 15_000;

export const BOOKING_TRANSITIONS = {
  searching: ['cancelled', 'expired'],
  driver_assigned: ['driver_en_route', 'cancelled'],
  driver_en_route: ['arrived_at_pickup', 'cancelled'],
  arrived_at_pickup: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  expired: []
};

export function isValidCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function toGeoPoint(lat, lng) {
  if (!isValidCoordinates(lat, lng)) {
    throw new RangeError('Latitude and longitude must be within valid coordinate ranges');
  }
  return { type: 'Point', coordinates: [lng, lat] };
}

export function distanceMetres(a, b) {
  const [lng1, lat1] = a.coordinates || [a.lng, a.lat];
  const [lng2, lat2] = b.coordinates || [b.lng, b.lat];
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(lat2 - lat1);
  const lngDelta = radians(lng2 - lng1);
  const arc = Math.sin(latDelta / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(lngDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

export function canTransitionBooking(from, to) {
  return Boolean(BOOKING_TRANSITIONS[from]?.includes(to));
}

export function isDriverEligibleWithinRadius(driver, pickup, serviceType, now = Date.now()) {
  const updatedAt = new Date(driver?.locationUpdatedAt || 0).getTime();
  return driver?.status === 'available' &&
    driver.verificationStatus === 'verified' &&
    Array.isArray(driver.serviceTypes) &&
    driver.serviceTypes.includes(serviceType) &&
    Boolean(driver.location?.coordinates) &&
    Number.isFinite(updatedAt) &&
    updatedAt <= now &&
    now - updatedAt <= DRIVER_LOCATION_MAX_AGE_MS &&
    distanceMetres(driver.location, pickup) <= SEARCH_RADIUS_METRES;
}

export function canAccessBooking(userId, role, booking, driverId) {
  return role === 'admin' || booking?.customerId === userId || booking?.assignedDriverId === driverId;
}

export function publicDriverMarker(driver, distanceMetresValue) {
  const point = driver.location?.coordinates;
  return {
    id: driver.id,
    name: driver.name,
    vehicle: {
      make: driver.vehicle?.make || '',
      model: driver.vehicle?.model || '',
      color: driver.vehicle?.color || ''
    },
    location: point ? {
      type: 'Point',
      coordinates: [Number(point[0].toFixed(3)), Number(point[1].toFixed(3))]
    } : null,
    distanceMetres: Math.round(distanceMetresValue)
  };
}
