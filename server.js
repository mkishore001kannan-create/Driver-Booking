import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import http from 'http';
import cors from 'cors';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { readStore, writeStore, id } from './db.js';
import { Booking, Driver, Emergency, RideRequest, connectMongo } from './models.js';
import {
  canTransitionBooking,
  canAccessBooking,
  distanceMetres,
  DRIVER_LOCATION_MAX_AGE_MS,
  DRIVER_LOCATION_MIN_INTERVAL_MS,
  isDriverEligibleWithinRadius,
  publicDriverMarker,
  SEARCH_RADIUS_METRES,
  toGeoPoint
} from './rideDomain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'driveease-demo-secret';
const MAX_RADIUS_KM = 1;
const BOOKING_SEARCH_TIMEOUT_MS = Math.max(15_000, Number(process.env.BOOKING_SEARCH_TIMEOUT_MS) || 60_000);
const ROUTING_BASE_URL = process.env.ROUTING_BASE_URL || 'https://router.project-osrm.org';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const requestBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.auth?.id || req.ip}:${req.path}`;
    const bucket = requestBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      requestBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }
    return next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function coordinatesFromPoint(point) {
  if (!point?.coordinates || point.coordinates.length !== 2) return null;
  return { lng: point.coordinates[0], lat: point.coordinates[1] };
}

function bookingForClient(booking, driver = null) {
  const terminal = ['completed', 'cancelled', 'expired'].includes(booking.status);
  const pickup = coordinatesFromPoint(booking.pickup);
  const destination = coordinatesFromPoint(booking.destination);
  const isRecentLocation = updatedAt => {
    const timestamp = new Date(updatedAt || 0).getTime();
    return Number.isFinite(timestamp) && timestamp <= Date.now() &&
      Date.now() - timestamp <= DRIVER_LOCATION_MAX_AGE_MS;
  };
  const currentDriverLocationIsRecent = isRecentLocation(driver?.locationUpdatedAt);
  const bookingLocationIsRecent = isRecentLocation(booking.latestDriverLocationAt);
  const latestDriverLocation = terminal ? null : currentDriverLocationIsRecent
    ? coordinatesFromPoint(driver.location)
    : bookingLocationIsRecent ? coordinatesFromPoint(booking.latestDriverLocation) : null;
  return {
    id: booking.id,
    userId: booking.customerId,
    serviceType: booking.serviceType,
    pickup: { ...pickup, address: booking.pickup.address },
    destination: { ...destination, address: booking.destination.address },
    tripDate: booking.tripDate
      ? new Date(booking.tripDate.getTime() - Number(booking.timezoneOffsetMinutes || 0) * 60_000).toISOString().slice(0, 10)
      : booking.tripDate,
    time: booking.time,
    durationMinutes: booking.durationMinutes,
    distanceKm: booking.distanceKm,
    fare: booking.fare,
    paymentMethod: booking.paymentMethod,
    paymentStatus: booking.paymentStatus || 'pending',
    paidAt: booking.paidAt || null,
    review: booking.review || null,
    status: booking.status,
    driverId: driver?.id || booking.assignedDriverId || null,
    driverDistanceKm: booking.assignmentDistanceMetres == null ? null : booking.assignmentDistanceMetres / 1000,
    driver: driver ? {
      id: driver.id,
      name: driver.name,
      vehicle: driver.vehicle,
      location: terminal || !currentDriverLocationIsRecent ? null : coordinatesFromPoint(driver.location),
      locationUpdatedAt: driver.locationUpdatedAt
    } : null,
    latestDriverLocation,
    latestDriverLocationAt: booking.latestDriverLocationAt,
    searchExpiresAt: booking.searchExpiresAt,
    assignedAt: booking.assignedAt,
    arrivedAt: booking.arrivedAt,
    startedAt: booking.startedAt,
    completedAt: booking.completedAt,
    cancelledAt: booking.cancelledAt,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt
  };
}

async function driverForBooking(booking) {
  if (!booking.assignedDriverId) return null;
  return Driver.findOne({ id: booking.assignedDriverId }).lean();
}

async function loadMongoBookingForUser(bookingId, userId, roleName) {
  const booking = await Booking.findOne({ id: bookingId }).lean();
  if (!booking) return null;
  const driver = await Driver.findOne({ userId }).select('id').lean();
  const allowed = canAccessBooking(userId, roleName, booking, driver?.id);
  return allowed ? booking : false;
}

async function fetchDrivingRoute(origin, destination) {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${ROUTING_BASE_URL.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Routing provider returned ${response.status}`);
  const result = await response.json();
  if (result.code !== 'Ok' || !result.routes?.[0]) {
    throw new Error('Routing provider could not find a driving route for these locations');
  }
  const route = result.routes[0];
  return {
    distanceKm: Number((route.distance / 1000).toFixed(2)),
    durationMinutes: Math.max(1, Math.ceil(route.duration / 60)),
    geometry: route.geometry
  };
}

async function syncLegacyDriverProfile(userId) {
  const legacy = findDriverByUser(readStore(), userId);
  if (!legacy) return null;
  return Driver.findOneAndUpdate(
    { userId },
    {
      $set: {
        name: legacy.name,
        vehicle: {
          make: legacy.vehicle?.make || '',
          model: legacy.vehicle?.model || '',
          color: legacy.vehicle?.color || ''
        },
        verificationStatus: legacy.verificationStatus || 'pending'
      },
      $setOnInsert: {
        id: legacy.id,
        userId,
        status: 'offline',
        serviceTypes: [],
        rating: Number(legacy.rating || 0),
        ratingCount: Number(legacy.ratingCount || 0)
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function publishBookingUpdate(booking, driver = null) {
  const payload = bookingForClient(booking, driver);
  io.to(`booking:${booking.id}`).emit('booking:update', payload);
  io.to(`user:${booking.customerId}`).emit('booking:update', payload);
  const assignedDriver = driver || await driverForBooking(booking);
  if (assignedDriver?.userId) io.to(`user:${assignedDriver.userId}`).emit('booking:update', payload);
  return payload;
}

function normalizeUserRole(value) {
  if (value === 'user') return 'customer';
  return value === 'customer' || value === 'driver' || value === 'admin' ? value : 'customer';
}

const publicUser = user => ({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: normalizeUserRole(user.role) });
const tokenFor = user => jwt.sign({ id: user.id, role: normalizeUserRole(user.role) }, JWT_SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    req.auth.role = normalizeUserRole(req.auth.role);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));
      socket.data.auth = jwt.verify(token, JWT_SECRET);
      socket.join(`user:${socket.data.auth.id}`);
      return next();
    } catch {
      return next(new Error('Invalid or expired token'));
    }
  });
}

function role(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.auth.role)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function findUser(store, userId) {
  return store.users.find(user => user.id === userId) || null;
}

function findDriverByUser(store, userId) {
  return store.drivers.find(driver => driver.userId === userId) || null;
}

function distanceKm(a, b) {
  const toRadians = value => (value * Math.PI) / 180;
  const latDelta = toRadians(b.lat - a.lat);
  const lngDelta = toRadians(b.lng - a.lng);
  const h =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function safeDriver(driver, distance = 0) {
  return {
    id: driver.id,
    name: driver.name,
    vehicle: driver.vehicle,
    verificationStatus: driver.verificationStatus,
    verified: driver.verificationStatus === 'verified',
    rating: driver.rating || 0,
    ratingCount: driver.ratingCount || 0,
    status: driver.status,
    location: driver.location,
    distanceKm: Number(distance.toFixed(2))
  };
}

function normalizeBookingStatus(value) {
  const map = {
    pending: 'pending',
    assigned: 'assigned',
    accepted: 'accepted',
    arrived: 'arrived',
    in_progress: 'in_progress',
    started: 'in_progress',
    completed: 'completed',
    cancelled: 'cancelled'
  };

  return map[String(value || '').trim()] || String(value || '').trim() || 'pending';
}

function normalizeDriverStatus(value) {
  const map = {
    offline: 'offline',
    available: 'available',
    busy: 'on_trip',
    on_trip: 'on_trip',
    trip: 'on_trip'
  };

  return map[String(value || '').trim()] || String(value || '').trim() || 'offline';
}

function toBookingClient(record, store) {
  const normalizedStatus = normalizeBookingStatus(record.status);
  const driver = record.driverId ? store.drivers.find(item => item.id === record.driverId) : null;
  return {
    ...record,
    status: normalizedStatus,
    driver: driver ? safeDriver(driver, record.driverDistanceKm || 0) : null
  };
}

function calculateFare({ serviceType, distanceKm, durationMinutes, isNightRideFlag = false, isOutstation = false, store }) {
  const config = store.fareConfig || {
    baseFare: 149,
    perKm: 18,
    perMinute: 1.8,
    serviceTypeMultiplier: { 'personal-driver': 1.3, 'cab-driver': 1.0 },
    nightSurcharge: 0.15,
    outstationSurcharge: 0.1,
    taxRate: 0.05,
    cancellationFee: 79
  };

  const multiplier = config.serviceTypeMultiplier?.[serviceType] || 1;
  const subtotal = config.baseFare * multiplier + distanceKm * config.perKm + durationMinutes * config.perMinute;
  const nightCharge = isNightRideFlag ? subtotal * config.nightSurcharge : 0;
  const outstationCharge = isOutstation ? subtotal * config.outstationSurcharge : 0;
  const tax = (subtotal + nightCharge + outstationCharge) * config.taxRate;
  return Number((subtotal + nightCharge + outstationCharge + tax).toFixed(2));
}

function sendNotification(store, userId, title, message, bookingId = null) {
  const notification = {
    id: id('notification'),
    userId,
    title,
    message,
    bookingId,
    read: false,
    createdAt: new Date().toISOString()
  };

  store.notifications.unshift(notification);
  io.to(`user:${userId}`).emit('notification', notification);
  return notification;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'driveease-api', maxDriverRadiusKm: MAX_RADIUS_KM, mongo: mongoose.connection.readyState === 1 });
});

app.get('/api/routes', auth, rateLimit({ windowMs: 60_000, max: 30 }), asyncRoute(async (req, res) => {
  const origin = { lat: Number(req.query.originLat), lng: Number(req.query.originLng) };
  const destination = { lat: Number(req.query.destinationLat), lng: Number(req.query.destinationLng) };
  const valid = point => Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
  if (!valid(origin) || !valid(destination)) {
    return res.status(400).json({ error: 'Valid origin and destination coordinates are required.' });
  }
  try {
    res.json(await fetchDrivingRoute(origin, destination));
  } catch (error) {
    console.error('Route lookup failed:', error.message);
    res.status(502).json({ error: error.message });
  }
}));

app.post('/api/driver-search', auth, role('customer'), rateLimit({ windowMs: 60_000, max: 6 }), asyncRoute(async (req, res) => {
  try {
    const { pickup, destination, serviceType, tripDate, time, paymentMethod = 'UPI' } = req.body;
    const validPlace = place => place?.lat != null && place?.lng != null &&
      Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng)) &&
      Number(place.lat) >= -90 && Number(place.lat) <= 90 &&
      Number(place.lng) >= -180 && Number(place.lng) <= 180 &&
      typeof place.address === 'string' && place.address.trim().length > 0;
    if (!validPlace(pickup) || !validPlace(destination)) {
      return res.status(400).json({ error: 'Select valid pickup and destination locations with coordinates.' });
    }
    if (!['personal-driver', 'cab-driver'].includes(serviceType)) {
      return res.status(400).json({ error: 'Choose a supported ride service.' });
    }
    if (!['UPI', 'cash', 'card'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Choose a supported payment method.' });
    }
    const requestedDate = String(tripDate || new Date().toISOString().slice(0, 10));
    const requestedTime = String(time || '09:00');
    const timezoneOffsetMinutes = req.body.timezoneOffsetMinutes == null
      ? 0
      : Number(req.body.timezoneOffsetMinutes);
    const validCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) &&
      !Number.isNaN(Date.parse(`${requestedDate}T00:00:00Z`)) &&
      new Date(`${requestedDate}T00:00:00Z`).toISOString().slice(0, 10) === requestedDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ||
        !validCalendarDate ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedTime) ||
        !Number.isInteger(timezoneOffsetMinutes) || timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) {
      return res.status(400).json({ error: 'A valid trip date and pickup time are required.' });
    }
    const scheduledAt = dateTimeFromInput(requestedDate, requestedTime, timezoneOffsetMinutes);
    if (scheduledAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Pickup time must be in the future. Choose a later time.' });
    }

    const existingSearch = await Booking.findOne({
      customerId: req.auth.id,
      status: { $in: ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress'] }
    }).select('id status').lean();
    if (existingSearch) {
      return res.status(409).json({ error: 'You already have an active trip. Cancel or complete it before starting another.' });
    }

    const route = await fetchDrivingRoute(pickup, destination);
    const store = readStore();
    const fare = calculateFare({
      serviceType,
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      isNightRideFlag: Number(requestedTime.slice(0, 2)) >= 22 || Number(requestedTime.slice(0, 2)) <= 5,
      isOutstation: Boolean(req.body.isOutstation),
      store
    });
    const expiresAt = new Date(Date.now() + BOOKING_SEARCH_TIMEOUT_MS);
    const booking = await Booking.create({
      id: id('booking'),
      customerId: req.auth.id,
      serviceType,
      pickup: { type: 'Point', coordinates: [Number(pickup.lng), Number(pickup.lat)], address: pickup.address.trim() },
      destination: { type: 'Point', coordinates: [Number(destination.lng), Number(destination.lat)], address: destination.address.trim() },
      tripDate: scheduledAt,
      time: requestedTime,
      timezoneOffsetMinutes,
      durationMinutes: route.durationMinutes,
      distanceKm: route.distanceKm,
      fare,
      paymentMethod,
      status: 'searching',
      searchExpiresAt: expiresAt
    });

    const eligibleDrivers = await Driver.aggregate([
      {
        $geoNear: {
          near: toGeoPoint(Number(pickup.lat), Number(pickup.lng)),
          key: 'location',
          distanceField: 'distanceMetres',
          maxDistance: SEARCH_RADIUS_METRES,
          spherical: true,
          query: {
            status: 'available',
            verificationStatus: 'verified',
            serviceTypes: serviceType,
            locationUpdatedAt: {
              $gte: new Date(Date.now() - DRIVER_LOCATION_MAX_AGE_MS),
              $lte: new Date()
            }
          }
        }
      },
      { $limit: 50 },
      { $project: { id: 1, name: 1, vehicle: 1, location: 1, distanceMetres: 1, userId: 1 } }
    ]);

    if (eligibleDrivers.length) {
      await RideRequest.insertMany(eligibleDrivers.map(driver => ({
        bookingId: booking.id,
        driverId: driver.id,
        status: 'offered',
        distanceMetres: driver.distanceMetres,
        expiresAt
      })), { ordered: false });
      eligibleDrivers.forEach(driver => {
        io.to(`user:${driver.userId}`).emit('ride:request', {
          bookingId: booking.id,
          pickup: { ...coordinatesFromPoint(booking.pickup), address: booking.pickup.address },
          destination: { ...coordinatesFromPoint(booking.destination), address: booking.destination.address },
          serviceType,
          distanceMetres: Math.round(driver.distanceMetres),
          expiresAt
        });
      });
    }

    res.status(201).json({
      booking: bookingForClient(booking),
      route,
      searchRadiusMetres: SEARCH_RADIUS_METRES,
      nearbyDrivers: eligibleDrivers.map(driver => publicDriverMarker(driver, driver.distanceMetres)),
      timeoutAt: expiresAt
    });
  } catch (error) {
    console.error('Driver search failed:', error.message);
    res.status(error.message.includes('Routing provider') ? 502 : 500).json({
      error: error.message.includes('Routing provider') ? error.message : 'Unable to search for nearby drivers right now.'
    });
  }
}));

app.patch('/api/drivers/availability', auth, role('driver'), rateLimit({ windowMs: 60_000, max: 8 }), asyncRoute(async (req, res) => {
  const { status, lat, lng, accuracy, timestamp, serviceTypes } = req.body;
  if (!['available', 'offline'].includes(status)) {
    return res.status(400).json({ error: 'Availability must be available or offline.' });
  }

  const legacyStore = readStore();
  const legacyDriver = findDriverByUser(legacyStore, req.auth.id);
  if (!legacyDriver) return res.status(404).json({ error: 'Driver profile not found.' });
  if (status === 'offline') {
    const mongoDriver = await Driver.findOne({ userId: req.auth.id }).select('id').lean();
    if (mongoDriver) {
      const activeTrip = await Booking.exists({
        assignedDriverId: mongoDriver.id,
        status: { $in: ['driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress'] }
      });
      if (activeTrip) {
        return res.status(409).json({ error: 'Finish or cancel your active trip before going offline.' });
      }
    }
    await Driver.updateOne({ userId: req.auth.id }, { $set: { status: 'offline' } });
    legacyDriver.status = 'offline';
    writeStore(legacyStore);
    return res.json({ status: 'offline' });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  const locationAccuracy = Number(accuracy);
  const gpsTimestamp = Number(timestamp);
  if (lat == null || lng == null || accuracy == null ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      !Number.isFinite(locationAccuracy) || locationAccuracy < 0 || locationAccuracy > 100 ||
      !Number.isFinite(gpsTimestamp) || gpsTimestamp < Date.now() - 45_000 || gpsTimestamp > Date.now() + 5_000) {
    return res.status(400).json({ error: 'A fresh location with accuracy of 100 metres or better is required to go online.' });
  }
  if (legacyDriver.verificationStatus !== 'verified') {
    return res.status(403).json({ error: 'Only verified drivers can go online.' });
  }
  if (!Array.isArray(serviceTypes) || serviceTypes.length === 0 ||
      serviceTypes.some(value => !['personal-driver', 'cab-driver'].includes(value))) {
    return res.status(400).json({ error: 'Select at least one supported service before going online.' });
  }

  const driver = await syncLegacyDriverProfile(req.auth.id);
  if (!driver) return res.status(404).json({ error: 'Driver profile not found.' });
  await Driver.updateOne(
    { userId: req.auth.id },
    {
      $set: {
        status: 'available',
        serviceTypes: [...new Set(serviceTypes)],
        location: toGeoPoint(latitude, longitude),
        locationUpdatedAt: new Date(),
        lastLocationRequestAt: new Date()
      }
    }
  );
  legacyDriver.status = 'available';
  writeStore(legacyStore);
  res.json({ status: 'available', locationUpdatedAt: new Date().toISOString() });
}));

app.post('/api/driver-location', auth, role('driver'), rateLimit({ windowMs: 60_000, max: 8 }), asyncRoute(async (req, res) => {
  const latitude = Number(req.body.lat);
  const longitude = Number(req.body.lng);
  const accuracy = Number(req.body.accuracy);
  const gpsTimestamp = Number(req.body.timestamp);
  const now = new Date();
  if (req.body.lat == null || req.body.lng == null || req.body.accuracy == null || req.body.timestamp == null ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100 ||
      !Number.isFinite(gpsTimestamp) || gpsTimestamp < Date.now() - 45_000 || gpsTimestamp > Date.now() + 5_000) {
    return res.status(400).json({ error: 'Location must contain valid coordinates, fresh timestamp, and accuracy of 100 metres or better.' });
  }

  const updatedDriver = await Driver.findOneAndUpdate({
    userId: req.auth.id,
    verificationStatus: 'verified',
    status: { $in: ['available', 'on_trip'] },
    $or: [
      { lastLocationRequestAt: null },
      { lastLocationRequestAt: { $lte: new Date(Date.now() - DRIVER_LOCATION_MIN_INTERVAL_MS) } }
    ]
  }, {
    $set: {
      location: toGeoPoint(latitude, longitude),
      locationUpdatedAt: now,
      lastLocationRequestAt: now
    }
  }, { new: true }).lean();
  if (!updatedDriver) {
    const driver = await Driver.findOne({ userId: req.auth.id }).lean();
    if (!driver || driver.status === 'offline') {
      return res.status(409).json({ error: 'Go online and grant location permission before sending location updates.' });
    }
    return res.status(429).json({ error: 'Location updates must be at least 15 seconds apart.' });
  }

  const activeBooking = await Booking.findOne({
    assignedDriverId: updatedDriver.id,
    status: { $in: ['driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress'] }
  });
  if (activeBooking) {
    activeBooking.latestDriverLocation = toGeoPoint(latitude, longitude);
    activeBooking.latestDriverLocationAt = now;
    await activeBooking.save();
    io.to(`booking:${activeBooking.id}`).emit('driver:location', {
      bookingId: activeBooking.id,
      location: { lat: latitude, lng: longitude },
      updatedAt: now.toISOString()
    });
  }

  res.json({ locationUpdatedAt: now.toISOString() });
}));

app.post('/api/auth/register', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
  const { name, email, password, phone, role: requestedRole } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }

  const store = readStore();
  const normalizedEmail = String(email).toLowerCase();

  if (store.users.some(user => user.email.toLowerCase() === normalizedEmail)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const user = {
    id: id('user'),
    name,
    email: normalizedEmail,
    phone: phone || '',
    passwordHash: await bcrypt.hash(password, 10),
    role: normalizeUserRole(requestedRole === 'driver' ? 'driver' : 'customer'),
    createdAt: new Date().toISOString()
  };

  store.users.push(user);
  writeStore(store);

  res.status(201).json({ user: publicUser(user), token: tokenFor(user) });
});

app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const store = readStore();
  const email = String(req.body.email || '').toLowerCase();
  const password = String(req.body.password || '');
  const user = store.users.find(item => item.email === email);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  user.role = normalizeUserRole(user.role);
  writeStore(store);
  res.json({ user: publicUser(user), token: tokenFor(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = findUser(readStore(), req.auth.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

app.get('/api/drivers/me', auth, role('driver'), asyncRoute(async (req, res) => {
  const store = readStore();
  const driver = findDriverByUser(store, req.auth.id);
  if (!driver) return res.status(404).json({ error: 'Driver profile not found' });
  const current = await syncLegacyDriverProfile(req.auth.id);
  res.json({
    driver: {
      ...driver,
      status: current.status,
      serviceTypes: current.serviceTypes,
      rating: current.rating,
      ratingCount: current.ratingCount,
      location: coordinatesFromPoint(current.location),
      locationUpdatedAt: current.locationUpdatedAt
    }
  });
}));

app.post('/api/drivers/register', auth, role('driver', 'customer'), (req, res) => {
  const { vehicle, documents, phone, serviceTypes = ['cab-driver'] } = req.body;
  const store = readStore();

  if (store.drivers.some(driver => driver.userId === req.auth.id)) {
    return res.status(409).json({ error: 'Driver profile already exists' });
  }

  if (!vehicle?.make || !vehicle?.plate || !documents?.license || !documents?.identity || !documents?.insurance) {
    return res.status(400).json({ error: 'Vehicle and all required documents are required' });
  }
  if (!Array.isArray(serviceTypes) || !serviceTypes.length ||
      serviceTypes.some(value => !['personal-driver', 'cab-driver'].includes(value))) {
    return res.status(400).json({ error: 'Select at least one supported driver service.' });
  }

  const user = findUser(store, req.auth.id);
  const driver = {
    id: id('driver'),
    userId: req.auth.id,
    name: user?.name || req.body.name || 'Driver',
    phone: phone || user?.phone || '',
    vehicle,
    documents,
    verificationStatus: 'pending',
    verifiedAt: null,
    verifiedBy: null,
    status: 'offline',
    location: null,
    serviceTypes: [...new Set(serviceTypes)],
    rating: 0,
    ratingCount: 0
  };

  store.drivers.push(driver);
  if (user) user.role = 'driver';
  writeStore(store);

  res.status(201).json({ driver, message: 'Driver profile submitted for verification' });
});

app.patch('/api/drivers/me/status', auth, role('driver'), asyncRoute(async (req, res) => {
  const store = readStore();
  const driver = findDriverByUser(store, req.auth.id);
  if (!driver) return res.status(404).json({ error: 'Driver profile not found' });

  const nextStatus = normalizeDriverStatus(req.body.status);
  if (nextStatus !== 'offline') {
    return res.status(409).json({ error: 'Use PATCH /api/drivers/availability after granting location permission.' });
  }

  driver.status = nextStatus;
  await Driver.updateOne({ userId: req.auth.id }, { $set: { status: 'offline' } });
  writeStore(store);
  res.json({ driver });
}));

app.patch('/api/drivers/me/location', auth, role('driver'), (req, res) => {
  res.status(410).json({ error: 'This endpoint is retired. Use POST /api/driver-location while online.' });
});

app.get('/api/drivers/nearby', auth, role('customer'), rateLimit({ windowMs: 60_000, max: 20 }), asyncRoute(async (req, res) => {
  try {
    const origin = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
    const serviceType = String(req.query.serviceType || '');
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) ||
        origin.lat < -90 || origin.lat > 90 || origin.lng < -180 || origin.lng > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    if (!['personal-driver', 'cab-driver'].includes(serviceType)) {
      return res.status(400).json({ error: 'A supported serviceType is required.' });
    }
    const drivers = await Driver.aggregate([
      {
        $geoNear: {
          near: toGeoPoint(origin.lat, origin.lng),
          key: 'location',
          distanceField: 'distanceMetres',
          maxDistance: SEARCH_RADIUS_METRES,
          spherical: true,
          query: {
            status: 'available',
            verificationStatus: 'verified',
            serviceTypes: serviceType,
            locationUpdatedAt: {
              $gte: new Date(Date.now() - DRIVER_LOCATION_MAX_AGE_MS),
              $lte: new Date()
            }
          }
        }
      },
      { $limit: 50 },
      { $project: { id: 1, name: 1, vehicle: 1, location: 1, distanceMetres: 1 } }
    ]);
    res.json({
      center: origin,
      radiusMetres: SEARCH_RADIUS_METRES,
      drivers: drivers.map(driver => publicDriverMarker(driver, driver.distanceMetres))
    });
  } catch (error) {
    console.error('Nearby driver lookup failed:', error.message);
    res.status(500).json({ error: 'Unable to search for nearby drivers right now.' });
  }
}));

app.post('/api/bookings/estimate', auth, rateLimit({ windowMs: 60_000, max: 30 }), (req, res) => {
  const store = readStore();
  const { serviceType } = req.body;
  const distanceKm = Number(req.body.distanceKm);
  const durationMinutes = Number(req.body.durationMinutes);
  const isNightRideFlag = req.body.isNightRide === true;
  const isOutstation = req.body.isOutstation === true;
  if (!['personal-driver', 'cab-driver'].includes(serviceType) ||
      !Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 5000 ||
      !Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440 ||
      (req.body.isNightRide != null && typeof req.body.isNightRide !== 'boolean') ||
      (req.body.isOutstation != null && typeof req.body.isOutstation !== 'boolean')) {
    return res.status(400).json({ error: 'Provide a supported service, positive route distance and duration, and valid fare options.' });
  }

  const fare = calculateFare({
    serviceType,
    distanceKm,
    durationMinutes,
    isNightRideFlag,
    isOutstation,
    store
  });

  res.json({ fare, currency: 'INR', breakdown: { distanceKm, durationMinutes, serviceType, isNightRideFlag, isOutstation } });
});

app.post('/api/bookings', auth, role('customer'), (req, res) => {
  res.status(410).json({ error: 'Use POST /api/driver-search to create a persistent booking and search for nearby drivers.' });
});

app.get('/api/bookings', auth, asyncRoute(async (req, res) => {
  const store = readStore();
  const driver = findDriverByUser(store, req.auth.id);
  const legacyRecords = req.auth.role === 'admin'
    ? store.bookings
    : store.bookings.filter(booking => booking.userId === req.auth.id || booking.driverId === driver?.id);

  const mongoDriver = await Driver.findOne({ userId: req.auth.id }).select('id').lean();
  const mongoFilter = req.auth.role === 'admin'
    ? {}
    : { $or: [{ customerId: req.auth.id }, { assignedDriverId: mongoDriver?.id || '__none__' }] };
  const mongoRecords = await Booking.find(mongoFilter).sort({ createdAt: -1 }).limit(100).lean();
  const mongoBookings = await Promise.all(mongoRecords.map(async booking =>
    bookingForClient(booking, await driverForBooking(booking))
  ));
  const legacyBookings = legacyRecords.map(booking => toBookingClient(booking, store));
  res.json({
    bookings: [...mongoBookings, ...legacyBookings]
      .sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0))
  });
}));

app.get('/api/bookings/:id', auth, asyncRoute(async (req, res) => {
  const mongoBooking = await loadMongoBookingForUser(req.params.id, req.auth.id, req.auth.role);
  if (mongoBooking === false) return res.status(403).json({ error: 'You are not authorized to view this booking' });
  if (mongoBooking) {
    return res.json({ booking: bookingForClient(mongoBooking, await driverForBooking(mongoBooking)) });
  }
  const store = readStore();
  const booking = store.bookings.find(item => item.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const driver = findDriverByUser(store, req.auth.id);
  if (req.auth.role !== 'admin' && booking.userId !== req.auth.id && booking.driverId !== driver?.id) {
    return res.status(403).json({ error: 'You are not authorized to view this booking' });
  }

  res.json({ booking: toBookingClient(booking, store) });
}));

app.get('/api/driver/requests', auth, role('driver'), asyncRoute(async (req, res) => {
  const driver = findDriverByUser(readStore(), req.auth.id);
  if (!driver || driver.verificationStatus !== 'verified') {
    return res.status(403).json({ error: 'Only verified drivers can view booking requests' });
  }

  const mongoDriver = await Driver.findOne({ userId: req.auth.id }).lean();
  if (mongoDriver?.status !== 'available' || !mongoDriver || mongoDriver.verificationStatus !== 'verified') {
    return res.json({ radiusMetres: SEARCH_RADIUS_METRES, radiusKm: MAX_RADIUS_KM, requests: [] });
  }

  const mongoRequests = await RideRequest.find({
    driverId: mongoDriver.id,
    status: 'offered',
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 }).limit(50).lean();
  const offeredBookings = await Promise.all(mongoRequests.map(async request => {
    const booking = await Booking.findOne({
      id: request.bookingId,
      status: 'searching',
      searchExpiresAt: { $gt: new Date() }
    }).lean();
    return booking ? {
      ...bookingForClient(booking),
      distanceKm: Number((request.distanceMetres / 1000).toFixed(2)),
      requestExpiresAt: request.expiresAt
    } : null;
  }));

  res.json({
    radiusKm: MAX_RADIUS_KM,
    radiusMetres: SEARCH_RADIUS_METRES,
    requests: offeredBookings.filter(Boolean)
  });
}));

app.post('/api/bookings/:id/accept', auth, role('driver'), asyncRoute(async (req, res) => {
  const mongoBooking = await Booking.findOne({ id: req.params.id }).lean();
  if (mongoBooking) {
    const driver = await Driver.findOne({ userId: req.auth.id }).lean();
    if (!driver) return res.status(404).json({ error: 'Driver profile not found.' });
    if (mongoBooking.assignedDriverId === driver.id) {
      return res.json({ booking: bookingForClient(mongoBooking, driver), idempotent: true });
    }
    if (mongoBooking.status !== 'searching' || mongoBooking.searchExpiresAt <= new Date()) {
      return res.status(409).json({ error: 'This ride request is no longer open.' });
    }

    const request = await RideRequest.findOne({
      bookingId: mongoBooking.id,
      driverId: driver.id,
      status: 'offered',
      expiresAt: { $gt: new Date() }
    }).lean();
    if (!request) return res.status(403).json({ error: 'This ride was not offered to your account.' });
    const pickup = mongoBooking.pickup;
    const distance = driver.location ? distanceMetres(driver.location, pickup) : Infinity;
    if (distance > SEARCH_RADIUS_METRES) {
      return res.status(403).json({ error: 'Your latest location is outside the 1 km search radius.' });
    }
    if (!isDriverEligibleWithinRadius(driver, pickup, mongoBooking.serviceType)) {
      return res.status(409).json({ error: 'You are no longer eligible or your location is stale. Update availability and location first.' });
    }

    const now = new Date();
    const claimedDriver = await Driver.findOneAndUpdate({
      id: driver.id,
      status: 'available',
      verificationStatus: 'verified',
      serviceTypes: mongoBooking.serviceType,
      locationUpdatedAt: driver.locationUpdatedAt,
      'location.coordinates': driver.location.coordinates
    }, { $set: { status: 'on_trip' } }, { new: true }).lean();
    if (!claimedDriver) {
      const latest = await Booking.findOne({ id: mongoBooking.id }).lean();
      if (latest?.assignedDriverId === driver.id) {
        return res.json({ booking: bookingForClient(latest, driver), idempotent: true });
      }
      return res.status(409).json({ error: 'Your availability changed. Refresh and try again.' });
    }

    const assigned = await Booking.findOneAndUpdate({
      id: mongoBooking.id,
      status: 'searching',
      assignedDriverId: null,
      searchExpiresAt: { $gt: now }
    }, {
      $set: {
        status: 'driver_assigned',
        assignedDriverId: driver.id,
        assignmentDistanceMetres: Math.round(distance),
        assignedAt: now,
        latestDriverLocation: driver.location,
        latestDriverLocationAt: driver.locationUpdatedAt
      }
    }, { new: true }).lean();

    if (!assigned) {
      await Driver.updateOne({ id: driver.id, status: 'on_trip' }, { $set: { status: 'available' } });
      const current = await Booking.findOne({ id: mongoBooking.id }).lean();
      if (current?.assignedDriverId === driver.id) {
        return res.json({ booking: bookingForClient(current, driver), idempotent: true });
      }
      return res.status(409).json({ error: 'Another driver has already accepted this ride.' });
    }

    const offeredRequests = await RideRequest.find({ bookingId: assigned.id, status: 'offered' }).select('driverId').lean();
    await RideRequest.updateMany(
      { bookingId: assigned.id, status: 'offered' },
      { $set: { status: 'lost', respondedAt: now } }
    );
    await RideRequest.updateOne({ bookingId: assigned.id, driverId: driver.id }, { $set: { status: 'accepted', respondedAt: now } });
    const otherDrivers = await Driver.find({ id: { $in: offeredRequests.map(item => item.driverId) } }).select('id userId').lean();
    otherDrivers.forEach(item => {
      io.to(`user:${item.userId}`).emit('ride:request-closed', {
        bookingId: assigned.id,
        acceptedBy: driver.id,
        message: item.id === driver.id ? 'Your acceptance was confirmed.' : 'Another driver accepted this ride.'
      });
    });
    const store = readStore();
    sendNotification(store, assigned.customerId, 'Driver assigned', `${driver.name} accepted your trip.`, assigned.id);
    writeStore(store);
    const payload = await publishBookingUpdate(assigned, claimedDriver);
    io.to(`booking:${assigned.id}`).emit('ride:assigned', payload);
    return res.json({ booking: payload });
  }

  return res.status(409).json({ error: 'This is a legacy booking and cannot use live driver matching. Start a new nearby-driver search.' });
}));

app.post('/api/bookings/:id/reject', auth, role('driver'), asyncRoute(async (req, res) => {
  const driver = await Driver.findOne({ userId: req.auth.id }).select('id').lean();
  if (!driver) return res.status(404).json({ error: 'Driver profile not found.' });
  const result = await RideRequest.updateOne(
    { bookingId: req.params.id, driverId: driver.id, status: 'offered', expiresAt: { $gt: new Date() } },
    { $set: { status: 'rejected', respondedAt: new Date() } }
  );
  if (!result.modifiedCount) return res.status(409).json({ error: 'Ride request is no longer available.' });
  return res.json({ rejected: true, bookingId: req.params.id });
}));

app.post('/api/bookings/:id/cancel', auth, role('customer'), asyncRoute(async (req, res) => {
  const now = new Date();
  const cancelled = await Booking.findOneAndUpdate({
    id: req.params.id,
    customerId: req.auth.id,
    status: { $in: ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup'] }
  }, {
    $set: { status: 'cancelled', cancelledAt: now, cancelledBy: req.auth.id, latestDriverLocationAt: null },
    $unset: { latestDriverLocation: 1 }
  }, { new: true }).lean();
  if (!cancelled) {
    const exists = await Booking.exists({ id: req.params.id });
    return res.status(exists ? 409 : 404).json({ error: exists ? 'This trip can no longer be cancelled.' : 'Booking not found.' });
  }
  if (cancelled.assignedDriverId) {
    await Driver.updateOne({ id: cancelled.assignedDriverId, status: 'on_trip' }, { $set: { status: 'available' } });
  }
  const offeredRequests = await RideRequest.find({ bookingId: cancelled.id, status: 'offered' }).select('driverId').lean();
  await RideRequest.updateMany({ bookingId: cancelled.id, status: 'offered' }, { $set: { status: 'expired', respondedAt: now } });
  const offeredDrivers = await Driver.find({ id: { $in: offeredRequests.map(item => item.driverId) } }).select('userId').lean();
  offeredDrivers.forEach(driver => io.to(`user:${driver.userId}`).emit('ride:request-closed', { bookingId: cancelled.id, message: 'The customer cancelled this ride.' }));
  const driver = await driverForBooking(cancelled);
  const payload = await publishBookingUpdate(cancelled, driver);
  io.to(`booking:${cancelled.id}`).emit('ride:cancelled', payload);
  return res.json({ booking: payload });
}));

app.post('/api/bookings/:id/status', auth, role('driver'), asyncRoute(async (req, res) => {
  const nextStatus = String(req.body.status || '');
  const driver = await Driver.findOne({ userId: req.auth.id }).lean();
  if (!driver) return res.status(404).json({ error: 'Driver profile not found.' });
  const current = await Booking.findOne({ id: req.params.id, assignedDriverId: driver.id }).lean();
  if (!current) return res.status(404).json({ error: 'Assigned booking not found.' });
  if (!canTransitionBooking(current.status, nextStatus)) {
    return res.status(409).json({ error: `Cannot change trip from ${current.status} to ${nextStatus}.` });
  }
  const now = new Date();
  const timestamps = {};
  if (nextStatus === 'arrived_at_pickup') timestamps.arrivedAt = now;
  if (nextStatus === 'in_progress') timestamps.startedAt = now;
  if (nextStatus === 'completed') timestamps.completedAt = now;
  const updated = await Booking.findOneAndUpdate({
    id: current.id,
    assignedDriverId: driver.id,
    status: current.status
  }, {
    $set: { status: nextStatus, ...timestamps, ...(nextStatus === 'completed' ? { latestDriverLocationAt: null } : {}) },
    ...(nextStatus === 'completed' ? { $unset: { latestDriverLocation: 1 } } : {})
  }, { new: true }).lean();
  if (!updated) return res.status(409).json({ error: 'Trip state changed. Refresh and try again.' });
  if (nextStatus === 'completed') {
    await Driver.updateOne({ id: driver.id }, { $set: { status: 'offline' } });
  }
  const payload = await publishBookingUpdate(updated, driver);
  io.to(`booking:${updated.id}`).emit('ride:status', payload);
  return res.json({ booking: payload });
}));

app.patch('/api/bookings/:id/status', auth, (req, res) => {
  res.status(410).json({ error: 'Direct booking status updates are retired. Use the server-validated trip status endpoint.' });
});

app.post('/api/bookings/:id/payment', auth, role('customer'), asyncRoute(async (req, res) => {
  const mongoBooking = await Booking.findOne({ id: req.params.id, customerId: req.auth.id }).lean();
  if (mongoBooking) {
    if (mongoBooking.status !== 'completed') {
      return res.status(409).json({ error: 'Payment is available only after trip completion' });
    }
    if (mongoBooking.paymentStatus === 'paid') {
      return res.json({ payment: {
        id: `payment-${mongoBooking.id}`,
        bookingId: mongoBooking.id,
        userId: req.auth.id,
        amount: mongoBooking.fare,
        method: mongoBooking.paymentMethod,
        status: 'paid',
        paidAt: mongoBooking.paidAt
      } });
    }

    const paidBooking = await Booking.findOneAndUpdate(
      { id: mongoBooking.id, status: 'completed', paymentStatus: { $ne: 'paid' } },
      { $set: { paymentStatus: 'paid', paidAt: new Date() } },
      { new: true }
    ).lean();
    if (!paidBooking) {
      const current = await Booking.findOne({ id: mongoBooking.id }).lean();
      if (current?.paymentStatus !== 'paid') {
        return res.status(409).json({ error: 'Booking payment state changed. Please refresh and try again.' });
      }
      return res.json({ payment: {
        id: `payment-${current.id}`,
        bookingId: current.id,
        userId: req.auth.id,
        amount: current.fare,
        method: current.paymentMethod,
        status: 'paid',
        paidAt: current.paidAt
      } });
    }
    return res.status(201).json({ payment: {
      id: `payment-${paidBooking.id}`,
      bookingId: paidBooking.id,
      userId: req.auth.id,
      amount: paidBooking.fare,
      method: paidBooking.paymentMethod,
      status: 'paid',
      paidAt: paidBooking.paidAt
    } });
  }

  const store = readStore();
  const booking = store.bookings.find(item => item.id === req.params.id && item.userId === req.auth.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'completed') return res.status(409).json({ error: 'Payment is available only after trip completion' });

  const payment = {
    id: id('payment'),
    bookingId: booking.id,
    userId: req.auth.id,
    amount: Number(req.body.amount || booking.fare),
    method: req.body.method || booking.paymentMethod,
    status: 'paid',
    paidAt: new Date().toISOString()
  };

  store.payments.push(payment);
  writeStore(store);
  res.status(201).json({ payment });
}));

app.post('/api/bookings/:id/review', auth, role('customer'), asyncRoute(async (req, res) => {
  const mongoBooking = await Booking.findOne({ id: req.params.id, customerId: req.auth.id }).lean();
  if (mongoBooking) {
    const score = Number(req.body.rating);
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    if (mongoBooking.status !== 'completed' || !mongoBooking.assignedDriverId ||
        !Number.isInteger(score) || score < 1 || score > 5 || comment.length > 500) {
      return res.status(400).json({ error: 'A completed booking and valid rating are required' });
    }
    if (mongoBooking.review) return res.status(409).json({ error: 'Booking already reviewed' });

    const review = {
      id: id('review'),
      rating: score,
      comment,
      createdAt: new Date()
    };
    const reviewedBooking = await Booking.findOneAndUpdate({
      id: mongoBooking.id,
      customerId: req.auth.id,
      status: 'completed',
      assignedDriverId: mongoBooking.assignedDriverId,
      review: null
    }, { $set: { review } }, { new: true }).lean();
    if (!reviewedBooking) return res.status(409).json({ error: 'Booking already reviewed or no longer eligible for review' });

    const updatedDriver = await Driver.findOneAndUpdate(
      { id: mongoBooking.assignedDriverId },
      [{
        $set: {
          ratingCount: { $add: [{ $ifNull: ['$ratingCount', 0] }, 1] },
          rating: {
            $round: [{
              $divide: [{
                $add: [
                  { $multiply: [{ $ifNull: ['$rating', 0] }, { $ifNull: ['$ratingCount', 0] }] },
                  score
                ]
              }, { $add: [{ $ifNull: ['$ratingCount', 0] }, 1] }]
            }, 2]
          }
        }
      }],
      { new: true }
    ).lean();
    if (!updatedDriver) {
      console.error(`Review ${review.id} persisted but assigned driver ${mongoBooking.assignedDriverId} was not found.`);
      return res.status(500).json({ error: 'Review was saved, but driver rating could not be updated.' });
    }
    return res.status(201).json({ review: { ...review, bookingId: mongoBooking.id, driverId: mongoBooking.assignedDriverId, userId: req.auth.id } });
  }

  const store = readStore();
  const booking = store.bookings.find(item => item.id === req.params.id && item.userId === req.auth.id);
  const score = Number(req.body.rating);

  if (!booking || booking.status !== 'completed' || !booking.driverId ||
      !Number.isInteger(score) || score < 1 || score > 5 ||
      (typeof req.body.comment === 'string' && req.body.comment.length > 500)) {
    return res.status(400).json({ error: 'A completed booking and valid rating are required' });
  }

  if (store.reviews.some(review => review.bookingId === booking.id)) {
    return res.status(409).json({ error: 'Booking already reviewed' });
  }

  const review = {
    id: id('review'),
    bookingId: booking.id,
    driverId: booking.driverId,
    userId: req.auth.id,
    rating: score,
    comment: req.body.comment || '',
    createdAt: new Date().toISOString()
  };

  const driver = store.drivers.find(item => item.id === booking.driverId);
  if (driver) {
    driver.rating = Number(((driver.rating * driver.ratingCount + score) / (driver.ratingCount + 1)).toFixed(2));
    driver.ratingCount += 1;
  }

  store.reviews.push(review);
  writeStore(store);
  res.status(201).json({ review });
}));

app.get('/api/drivers/:id/reviews', asyncRoute(async (req, res) => {
  const store = readStore();
  const driver = store.drivers.find(item => item.id === req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const mongoReviews = await Booking.find({
    assignedDriverId: driver.id,
    'review.id': { $exists: true }
  }).select('review').lean();
  const mongoDriver = await Driver.findOne({ id: driver.id }).select('rating ratingCount').lean();
  res.json({
    driver: {
      id: driver.id,
      name: driver.name,
      rating: mongoDriver?.rating ?? driver.rating,
      ratingCount: mongoDriver?.ratingCount ?? driver.ratingCount,
      verified: driver.verificationStatus === 'verified'
    },
    reviews: [
      ...store.reviews.filter(review => review.driverId === driver.id).map(review => ({ rating: review.rating, comment: review.comment, createdAt: review.createdAt })),
      ...mongoReviews.map(({ review }) => ({ rating: review.rating, comment: review.comment, createdAt: review.createdAt }))
    ]
  });
}));

app.get('/api/notifications', auth, (req, res) => {
  const store = readStore();
  res.json({ notifications: store.notifications.filter(item => item.userId === req.auth.id).slice(0, 50) });
});

app.get('/api/admin/dashboard', auth, role('admin'), asyncRoute(async (req, res) => {
  const store = readStore();
  const [mongoRevenue, mongoEmergencies, mongoActiveBookings, mongoRecentRecords] = await Promise.all([
    Booking.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$fare' } } }
    ]),
    Emergency.find().sort({ createdAt: -1 }).limit(20).lean(),
    Booking.countDocuments({ status: { $nin: ['completed', 'cancelled', 'expired'] } }),
    Booking.find().sort({ createdAt: -1 }).limit(20).lean()
  ]);
  const mongoRecentBookings = await Promise.all(mongoRecentRecords.map(async booking =>
    bookingForClient(booking, await driverForBooking(booking))
  ));
  const recentBookings = [
    ...store.bookings.map(booking => ({ ...booking, createdAt: booking.createdAt || booking.updatedAt })),
    ...mongoRecentBookings
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 20);
  res.json({
    metrics: {
      users: store.users.filter(user => user.role === 'customer').length,
      drivers: store.drivers.length,
      verifiedDrivers: store.drivers.filter(driver => driver.verificationStatus === 'verified').length,
      pendingVerifications: store.drivers.filter(driver => driver.verificationStatus === 'pending').length,
      activeBookings: store.bookings.filter(booking =>
        !['completed', 'cancelled', 'expired'].includes(normalizeBookingStatus(booking.status))
      ).length + mongoActiveBookings,
      revenue: store.payments.reduce((total, payment) => total + Number(payment.amount || 0), 0) +
        Number(mongoRevenue[0]?.total || 0)
    },
    pendingDrivers: store.drivers.filter(driver => driver.verificationStatus === 'pending').map(driver => ({ ...driver, documents: { ...driver.documents, identity: 'redacted' } })),
    recentBookings,
    emergencyAlerts: [
      ...store.emergencies,
      ...mongoEmergencies.map(emergency => ({
        id: emergency.id,
        bookingId: emergency.bookingId,
        reason: emergency.reason,
        status: emergency.status,
        location: coordinatesFromPoint(emergency.location),
        createdAt: emergency.createdAt
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20)
  });
}));

app.patch('/api/admin/drivers/:id/verify', auth, role('admin'), (req, res) => {
  const store = readStore();
  const driver = store.drivers.find(item => item.id === req.params.id);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const approved = req.body.approved !== false;
  driver.verificationStatus = approved ? 'verified' : 'rejected';
  driver.verifiedAt = approved ? new Date().toISOString() : null;
  driver.verifiedBy = req.auth.id;
  driver.status = 'offline';

  sendNotification(store, driver.userId, approved ? 'Profile verified' : 'Verification needs attention', approved ? 'You can now receive bookings.' : 'Please update your documents and try again.', null);
  writeStore(store);
  Driver.updateOne(
    { id: driver.id },
    { $set: { verificationStatus: driver.verificationStatus, status: approved ? 'offline' : 'offline' } }
  ).then(() => res.json({ driver })).catch(error => {
    console.error('Driver Mongo profile verification update failed:', error.message);
    res.status(500).json({ error: 'Driver verification was saved but live profile update failed.' });
  });
});

app.post('/api/emergencies', auth, rateLimit({ windowMs: 60_000, max: 5 }), asyncRoute(async (req, res) => {
  if (!['customer', 'driver', 'admin'].includes(req.auth.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const store = readStore();
  const bookingId = typeof req.body.bookingId === 'string' ? req.body.bookingId.trim() : '';
  if (!bookingId && req.auth.role !== 'admin') {
    return res.status(400).json({ error: 'A booking is required to report an emergency.' });
  }
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : 'Safety concern reported';
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'Emergency reason must be between 1 and 500 characters.' });
  }

  let mongoBooking = null;
  let legacyBooking = null;
  let assignedDriver = null;
  let location = null;
  if (bookingId) {
    mongoBooking = await Booking.findOne({ id: bookingId }).lean();
    if (mongoBooking) {
      const driver = req.auth.role === 'driver'
        ? await Driver.findOne({ userId: req.auth.id }).select('id location locationUpdatedAt').lean()
        : null;
      if (!canAccessBooking(req.auth.id, req.auth.role, mongoBooking, driver?.id)) {
        return res.status(403).json({ error: 'You are not part of this booking' });
      }
      assignedDriver = mongoBooking.assignedDriverId
        ? await Driver.findOne({ id: mongoBooking.assignedDriverId }).select('userId').lean()
        : null;
      const recentPoint = (point, updatedAt) => {
        const timestamp = new Date(updatedAt || 0).getTime();
        return point?.coordinates && timestamp <= Date.now() &&
          Date.now() - timestamp <= DRIVER_LOCATION_MAX_AGE_MS ? point : null;
      };
      const locationPoint = req.auth.role === 'driver' && driver?.id === mongoBooking.assignedDriverId
        ? (recentPoint(driver.location, driver.locationUpdatedAt) ||
          recentPoint(mongoBooking.latestDriverLocation, mongoBooking.latestDriverLocationAt) ||
          mongoBooking.pickup)
        : mongoBooking.pickup;
      location = locationPoint?.coordinates ? locationPoint : null;
    } else {
      legacyBooking = store.bookings.find(item => item.id === bookingId) || null;
      if (!legacyBooking) return res.status(404).json({ error: 'Booking not found.' });
      const legacyDriver = findDriverByUser(store, req.auth.id);
      if (req.auth.role !== 'admin' && legacyBooking.userId !== req.auth.id && legacyBooking.driverId !== legacyDriver?.id) {
        return res.status(403).json({ error: 'You are not part of this booking' });
      }
      assignedDriver = store.drivers.find(item => item.id === legacyBooking.driverId) || null;
      const place = legacyBooking.pickup;
      if (Number.isFinite(Number(place?.lat)) && Number.isFinite(Number(place?.lng)) &&
          Number(place.lat) >= -90 && Number(place.lat) <= 90 &&
          Number(place.lng) >= -180 && Number(place.lng) <= 180) {
        location = toGeoPoint(Number(place.lat), Number(place.lng));
      }
    }
  }

  const createdAt = new Date();
  const emergency = await Emergency.create({
    id: id('emergency'),
    reporterUserId: req.auth.id,
    bookingId: mongoBooking?.id || legacyBooking?.id || null,
    reason,
    location,
    status: 'open'
  });
  const publicEmergency = {
    id: emergency.id,
    bookingId: emergency.bookingId,
    reason: emergency.reason,
    status: emergency.status,
    location: coordinatesFromPoint(emergency.location),
    createdAt: emergency.createdAt
  };
  const participantIds = new Set(store.users
    .filter(user => user.role === 'admin')
    .map(user => user.id));
  if (mongoBooking) {
    participantIds.add(mongoBooking.customerId);
    if (assignedDriver?.userId) participantIds.add(assignedDriver.userId);
  } else if (legacyBooking) {
    participantIds.add(legacyBooking.userId);
    const legacyAssignedDriver = store.drivers.find(item => item.id === legacyBooking.driverId);
    if (legacyAssignedDriver?.userId) participantIds.add(legacyAssignedDriver.userId);
  }
  participantIds.add(req.auth.id);
  for (const userId of participantIds) {
    sendNotification(store, userId, 'Emergency alert', 'A safety concern needs immediate attention.', publicEmergency.bookingId);
  }
  writeStore(store);
  const eventPayload = { id: emergency.id, bookingId: emergency.bookingId, status: emergency.status, createdAt };
  for (const userId of participantIds) io.to(`user:${userId}`).emit('emergency:created', eventPayload);

  res.status(201).json({ emergency: publicEmergency, message: 'Emergency alert sent to DriveEase safety support' });
}));

io.on('connection', socket => {
  const authenticatedUserId = socket.data.auth.id;
  socket.on('join:user', userId => {
    if (userId === authenticatedUserId) socket.join(`user:${authenticatedUserId}`);
  });
  socket.on('booking:join', async bookingId => {
    if (typeof bookingId !== 'string' || bookingId.length > 100) return;
    try {
      const booking = await Booking.findOne({ id: bookingId }).lean();
      if (booking) {
        const driver = await Driver.findOne({ userId: authenticatedUserId }).select('id').lean();
        if (!canAccessBooking(authenticatedUserId, socket.data.auth.role, booking, driver?.id)) {
          socket.emit('booking:error', { bookingId, error: 'You are not authorized to access this trip.' });
          return;
        }
        socket.join(`booking:${bookingId}`);
        socket.emit('booking:state', bookingForClient(booking, await driverForBooking(booking)));
        return;
      }
      const legacyStore = readStore();
      const legacyBooking = legacyStore.bookings.find(item => item.id === bookingId);
      const legacyDriver = findDriverByUser(legacyStore, authenticatedUserId);
      if (legacyBooking && (legacyBooking.userId === authenticatedUserId || legacyBooking.driverId === legacyDriver?.id)) {
        socket.join(`booking:${bookingId}`);
        socket.emit('booking:state', toBookingClient(legacyBooking, legacyStore));
        return;
      }
      socket.emit('booking:error', { bookingId, error: 'Trip not found or access denied.' });
    } catch (error) {
      console.error('Socket booking authorization failed:', error.message);
      socket.emit('booking:error', { bookingId, error: 'Unable to load trip state.' });
    }
  });
  socket.on('booking:leave', bookingId => {
    if (typeof bookingId === 'string') socket.leave(`booking:${bookingId}`);
  });
});

const bookingExpiryTimer = setInterval(async () => {
  const now = new Date();
  try {
    await Driver.updateMany({
      status: 'available',
      locationUpdatedAt: { $lt: new Date(now.getTime() - DRIVER_LOCATION_MAX_AGE_MS) }
    }, { $set: { status: 'offline' } });
    const expired = await Booking.find({
      status: 'searching',
      searchExpiresAt: { $lte: now }
    }).limit(100).lean();
    if (!expired.length) return;
    const expiredRequests = await RideRequest.find({
      bookingId: { $in: expired.map(item => item.id) },
      status: 'offered'
    }).select('bookingId driverId').lean();
    await Booking.updateMany(
      { id: { $in: expired.map(item => item.id) }, status: 'searching' },
      { $set: { status: 'expired' } }
    );
    await RideRequest.updateMany(
      { bookingId: { $in: expired.map(item => item.id) }, status: 'offered' },
      { $set: { status: 'expired', respondedAt: now } }
    );
    const notifiedDrivers = await Driver.find({
      id: { $in: expiredRequests.map(item => item.driverId) }
    }).select('id userId').lean();
    expiredRequests.forEach(request => {
      const driver = notifiedDrivers.find(item => item.id === request.driverId);
      if (driver) io.to(`user:${driver.userId}`).emit('ride:request-closed', {
        bookingId: request.bookingId,
        message: 'This ride request expired.'
      });
    });
    expired.forEach(booking => {
      io.to(`user:${booking.customerId}`).emit('ride:expired', { bookingId: booking.id });
      io.to(`booking:${booking.id}`).emit('ride:expired', { bookingId: booking.id });
    });
  } catch (error) {
    console.error('Booking expiry sweep failed:', error.message);
  }
}, 10_000);
bookingExpiryTimer.unref();

function dateTimeFromInput(tripDate, time, timezoneOffsetMinutes = 0) {
  if (!tripDate) return new Date();
  const dateValue = new Date(`${tripDate}T${time || '00:00'}:00Z`);
  if (Number.isNaN(dateValue.getTime())) return new Date();
  dateValue.setMinutes(dateValue.getMinutes() + timezoneOffsetMinutes);
  return dateValue;
}

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const malformedJson = error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body');
  console.error(`Request failed (${req.method} ${req.path}): ${error.message}`);
  res.status(malformedJson ? 400 : 500).json({
    error: malformedJson ? 'Request body must contain valid JSON.' : 'An unexpected server error occurred.'
  });
});

connectMongo()
  .then(() => server.listen(PORT, () => {
    console.log(`DriveEase API running at http://localhost:${PORT}`);
  }))
  .catch(error => {
    console.error(`DriveEase startup failed: ${error.message}`);
    process.exitCode = 1;
  });
