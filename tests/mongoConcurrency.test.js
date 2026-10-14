import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Booking, Driver } from '../models.js';
import { toGeoPoint } from '../rideDomain.js';

const mongoTestUri = process.env.MONGO_TEST_URI;

test('Mongo atomic claims allow only one concurrent driver to accept a booking', {
  skip: !mongoTestUri && 'Set MONGO_TEST_URI to a dedicated test database to run Mongo concurrency tests'
}, async t => {
  const databaseName = new URL(mongoTestUri).pathname.slice(1);
  assert.match(databaseName, /test/i, 'MONGO_TEST_URI must use a database name containing "test"');

  await mongoose.connect(mongoTestUri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([Booking.init(), Driver.init()]);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bookingId = `booking-test-${suffix}`;
  const driverIds = [`driver-test-a-${suffix}`, `driver-test-b-${suffix}`];
  const now = new Date();

  t.after(async () => {
    await Booking.deleteOne({ id: bookingId });
    await Driver.deleteMany({ id: { $in: driverIds } });
    await mongoose.disconnect();
  });

  await Booking.create({
    id: bookingId,
    customerId: 'customer-test',
    serviceType: 'cab-driver',
    pickup: { type: 'Point', coordinates: [77.6, 12.9], address: 'Test pickup' },
    destination: { type: 'Point', coordinates: [77.7, 13], address: 'Test destination' },
    tripDate: now,
    time: '09:00',
    durationMinutes: 20,
    distanceKm: 5,
    fare: 200,
    status: 'searching',
    searchExpiresAt: new Date(now.getTime() + 60_000)
  });
  await Driver.create(driverIds.map((id, index) => ({
    id,
    userId: `user-${id}`,
    name: `Test Driver ${index}`,
    verificationStatus: 'verified',
    status: 'available',
    serviceTypes: ['cab-driver'],
    location: toGeoPoint(12.9, 77.6),
    locationUpdatedAt: now
  })));

  const claims = await Promise.all(driverIds.map(assignedDriverId => Booking.findOneAndUpdate({
    id: bookingId,
    status: 'searching',
    assignedDriverId: null,
    searchExpiresAt: { $gt: new Date() }
  }, {
    $set: { status: 'driver_assigned', assignedDriverId, assignedAt: new Date() }
  }, { new: true }).lean()));

  assert.equal(claims.filter(Boolean).length, 1);
  const persisted = await Booking.findOne({ id: bookingId }).lean();
  assert.ok(driverIds.includes(persisted.assignedDriverId));
});
