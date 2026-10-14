import test from 'node:test';
import assert from 'node:assert/strict';
import { Booking, Driver, Emergency } from '../models.js';
import {
  canAccessBooking,
  canTransitionBooking,
  distanceMetres,
  DRIVER_LOCATION_MAX_AGE_MS,
  isDriverEligibleWithinRadius,
  publicDriverMarker,
  SEARCH_RADIUS_METRES,
  toGeoPoint
} from '../rideDomain.js';

const origin = toGeoPoint(0, 0);

test('GeoJSON coordinates are longitude-first and reject out-of-range values', () => {
  assert.deepEqual(toGeoPoint(12.5, 77.6), { type: 'Point', coordinates: [77.6, 12.5] });
  assert.throws(() => toGeoPoint(91, 77), RangeError);
  assert.throws(() => toGeoPoint(12, 181), RangeError);
});

test('nearby boundary is exactly 1,000 metres', () => {
  const boundaryLatitude = SEARCH_RADIUS_METRES / 6371000 * 180 / Math.PI;
  assert.ok(distanceMetres(origin, toGeoPoint(boundaryLatitude, 0)) <= SEARCH_RADIUS_METRES);
  assert.ok(distanceMetres(origin, toGeoPoint(boundaryLatitude * 1.001, 0)) > SEARCH_RADIUS_METRES);
});

test('nearby eligibility excludes stale, offline, unverified, and wrong-service drivers', () => {
  const now = Date.now();
  const eligible = {
    status: 'available',
    verificationStatus: 'verified',
    serviceTypes: ['cab-driver'],
    location: origin,
    locationUpdatedAt: new Date(now - 10_000)
  };
  assert.equal(isDriverEligibleWithinRadius(eligible, origin, 'cab-driver', now), true);
  assert.equal(isDriverEligibleWithinRadius({ ...eligible, status: 'offline' }, origin, 'cab-driver', now), false);
  assert.equal(isDriverEligibleWithinRadius({ ...eligible, verificationStatus: 'pending' }, origin, 'cab-driver', now), false);
  assert.equal(isDriverEligibleWithinRadius({ ...eligible, serviceTypes: ['personal-driver'] }, origin, 'cab-driver', now), false);
  assert.equal(isDriverEligibleWithinRadius({
    ...eligible,
    locationUpdatedAt: new Date(now - DRIVER_LOCATION_MAX_AGE_MS - 1)
  }, origin, 'cab-driver', now), false);
  assert.equal(isDriverEligibleWithinRadius({
    ...eligible,
    locationUpdatedAt: new Date(now + 1_000)
  }, origin, 'cab-driver', now), false);
});

test('public driver marker rounds location and exposes no private contact or documents', () => {
  const marker = publicDriverMarker({
    id: 'driver-test',
    name: 'Test Driver',
    phone: '+91 99999 99999',
    documents: { license: 'private' },
    vehicle: { make: 'Test', plate: 'PRIVATE' },
    location: toGeoPoint(12.9719123, 77.6412987)
  }, 250);
  assert.deepEqual(marker.location.coordinates, [77.641, 12.972]);
  assert.equal('phone' in marker, false);
  assert.equal('documents' in marker, false);
  assert.equal(marker.vehicle.plate, undefined);
});

test('booking transitions prevent illegal and duplicate trip state changes', () => {
  assert.equal(canTransitionBooking('searching', 'driver_assigned'), false);
  assert.equal(canTransitionBooking('driver_assigned', 'driver_en_route'), true);
  assert.equal(canTransitionBooking('arrived_at_pickup', 'in_progress'), true);
  assert.equal(canTransitionBooking('in_progress', 'completed'), true);
  assert.equal(canTransitionBooking('completed', 'completed'), false);
  assert.equal(canTransitionBooking('searching', 'expired'), true);
  assert.equal(canTransitionBooking('searching', 'cancelled'), true);
});

test('booking access is limited to customer, assigned driver, or administrator', () => {
  const booking = { customerId: 'customer-1', assignedDriverId: 'driver-1' };
  assert.equal(canAccessBooking('customer-1', 'customer', booking, null), true);
  assert.equal(canAccessBooking('driver-user', 'driver', booking, 'driver-1'), true);
  assert.equal(canAccessBooking('unrelated', 'customer', booking, null), false);
  assert.equal(canAccessBooking('admin-user', 'admin', booking, null), true);
});

test('Mongo models declare geospatial and atomic-state lookup indexes', () => {
  const driverIndexes = Driver.schema.indexes();
  const bookingIndexes = Booking.schema.indexes();
  const emergencyIndexes = Emergency.schema.indexes();
  assert.ok(driverIndexes.some(([keys]) => keys.location === '2dsphere'));
  assert.ok(bookingIndexes.some(([keys, options]) => keys.id === 1 && options.unique === true));
  assert.ok(bookingIndexes.some(([keys]) => keys.status === 1 && keys.searchExpiresAt === 1));
  assert.ok(emergencyIndexes.some(([keys, options]) => keys.id === 1 && options.unique === true));
  assert.equal(Booking.schema.path('paymentStatus').defaultValue, 'pending');
  assert.ok(Booking.schema.path('review'));
});
