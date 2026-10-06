const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { readStore, writeStore, id } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'velo-local-development-secret';
const MAX_RADIUS_KM = 2;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const publicUser = user => ({ id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role });
const tokenFor = user => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
const sendNotification = (store, userId, title, message, rideId) => {
  const notification = { id: id('notification'), userId, title, message, rideId: rideId || null, read: false, createdAt: new Date().toISOString() };
  store.notifications.unshift(notification);
  io.to(`user:${userId}`).emit('notification', notification);
};

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.auth = jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function role(...roles) { return (req, res, next) => roles.includes(req.auth.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' }); }
function findUser(store, userId) { return store.users.find(user => user.id === userId); }
function findDriverForUser(store, userId) { return store.drivers.find(driver => driver.userId === userId); }
function number(value, field) { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${field} must be a number`); return result; }
function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(b.lat - a.lat); const lngDelta = radians(b.lng - a.lng);
  const h = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function safeDriver(driver, distance) {
  return { id: driver.id, name: driver.name, vehicle: driver.vehicle, verificationStatus: driver.verificationStatus, verified: driver.verificationStatus === 'verified', rating: driver.rating, ratingCount: driver.ratingCount, status: driver.status, location: driver.location, distanceKm: Number(distance.toFixed(2)) };
}
function rideForClient(ride, store) {
  return { ...ride, driver: ride.driverId ? safeDriver(store.drivers.find(driver => driver.id === ride.driverId), ride.driverDistanceKm || 0) : null };
}
function broadcastRide(ride, store) { io.to(`ride:${ride.id}`).emit('ride:update', rideForClient(ride, store)); }
function validateCoordinates(body) {
  const pickup = { lat: number(body.pickup?.lat, 'pickup.lat'), lng: number(body.pickup?.lng, 'pickup.lng') };
  const destination = { lat: number(body.destination?.lat, 'destination.lat'), lng: number(body.destination?.lng, 'destination.lng') };
  return { pickup, destination };
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'velo-api', maxDriverRadiusKm: MAX_RADIUS_KM }));
app.post('/api/auth/register', async (req, res) => {
  const { name, email, phone, password, role: requestedRole } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  const store = readStore();
  if (store.users.some(user => user.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'An account with this email already exists' });
  const user = { id: id('user'), name, email: email.toLowerCase(), phone: phone || '', passwordHash: await bcrypt.hash(password, 10), role: requestedRole === 'driver' ? 'driver' : 'user', createdAt: new Date().toISOString() };
  store.users.push(user); writeStore(store);
  res.status(201).json({ user: publicUser(user), token: tokenFor(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const store = readStore(); const user = store.users.find(item => item.email === String(req.body.email || '').toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || '', user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ user: publicUser(user), token: tokenFor(user) });
});
app.get('/api/me', auth, (req, res) => { const user = findUser(readStore(), req.auth.id); res.json({ user: publicUser(user) }); });

app.post('/api/drivers/register', auth, role('driver', 'user'), (req, res) => {
  const { name, phone, vehicle, documents, location } = req.body; const store = readStore();
  if (!vehicle?.make || !vehicle?.plate || !documents?.license || !documents?.identity || !documents?.insurance) return res.status(400).json({ error: 'Vehicle and all license, identity and insurance documents are required' });
  if (store.drivers.some(driver => driver.userId === req.auth.id)) return res.status(409).json({ error: 'Driver profile already exists' });
  const driver = { id: id('driver'), userId: req.auth.id, name: name || findUser(store, req.auth.id).name, phone: phone || '', vehicle, documents, verificationStatus: 'pending', verifiedAt: null, verifiedBy: null, status: 'offline', location: location || null, rating: 0, ratingCount: 0 };
  store.drivers.push(driver); const user = findUser(store, req.auth.id); if (user) user.role = 'driver'; writeStore(store);
  res.status(201).json({ driver, message: 'Documents submitted for admin verification' });
});
app.get('/api/drivers/nearby', (req, res) => {
  try {
    const origin = { lat: number(req.query.lat, 'lat'), lng: number(req.query.lng, 'lng') }; const radius = Math.min(Number(req.query.radiusKm) || MAX_RADIUS_KM, MAX_RADIUS_KM); const store = readStore();
    const drivers = store.drivers.filter(driver => driver.verificationStatus === 'verified' && driver.status === 'available' && driver.location).map(driver => ({ driver, distance: distanceKm(origin, driver.location) })).filter(item => item.distance <= radius).sort((a, b) => a.distance - b.distance).map(item => safeDriver(item.driver, item.distance));
    res.json({ center: origin, radiusKm: radius, drivers });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.patch('/api/drivers/me/location', auth, role('driver'), (req, res) => {
  try { const store = readStore(); const driver = findDriverForUser(store, req.auth.id); if (!driver) return res.status(404).json({ error: 'Driver profile not found' }); driver.location = { lat: number(req.body.lat, 'lat'), lng: number(req.body.lng, 'lng') }; driver.status = req.body.status || 'available'; writeStore(store); io.emit('driver:location', { driverId: driver.id, location: driver.location, status: driver.status }); res.json({ driver: safeDriver(driver, 0) }); } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/drivers/me', auth, role('driver'), (req, res) => { const store = readStore(); const driver = findDriverForUser(store, req.auth.id); if (!driver) return res.status(404).json({ error: 'Driver profile not found' }); res.json({ driver: safeDriver(driver, 0) }); });

app.post('/api/rides', auth, role('user'), (req, res) => {
  try {
    const { pickup, destination } = validateCoordinates(req.body); const store = readStore();
    const nearby = store.drivers.filter(driver => driver.verificationStatus === 'verified' && driver.status === 'available' && driver.location).map(driver => ({ driver, distance: distanceKm(pickup, driver.location) })).filter(item => item.distance <= MAX_RADIUS_KM).sort((a, b) => a.distance - b.distance);
    const ride = { id: id('ride'), userId: req.auth.id, pickup: { ...pickup, address: req.body.pickup.address || 'Pinned pickup' }, destination: { ...destination, address: req.body.destination.address || 'Pinned destination' }, rideType: req.body.rideType || 'Drive for me', fare: Number(req.body.fare) || 349, paymentMethod: req.body.paymentMethod || 'cash', status: 'searching', driverId: null, driverDistanceKm: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.rides.push(ride);
    nearby.forEach(item => sendNotification(store, item.driver.userId, 'New ride nearby', `A verified rider is ${item.distance.toFixed(1)} km away`, ride.id));
    writeStore(store); res.status(201).json({ ride: rideForClient(ride, store), nearbyDrivers: nearby.map(item => safeDriver(item.driver, item.distance)) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/rides', auth, (req, res) => { const store = readStore(); const rides = req.auth.role === 'admin' ? store.rides : store.rides.filter(ride => ride.userId === req.auth.id || ride.driverId === findDriverForUser(store, req.auth.id)?.id); res.json({ rides: rides.map(ride => rideForClient(ride, store)) }); });
app.get('/api/history', auth, (req, res) => { const store = readStore(); const driver = findDriverForUser(store, req.auth.id); const rides = req.auth.role === 'admin' ? store.rides : store.rides.filter(ride => ride.userId === req.auth.id || ride.driverId === driver?.id); res.json({ rides: rides.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(ride => rideForClient(ride, store)), reviews: store.reviews.filter(review => reviewsBelongToUser(review, req.auth.id, driver?.id)) }); });
function reviewsBelongToUser(review, userId, driverId) { return review.userId === userId || review.driverId === driverId; }
app.get('/api/driver/requests', auth, role('driver'), (req, res) => { const store = readStore(); const driver = findDriverForUser(store, req.auth.id); if (!driver || driver.verificationStatus !== 'verified') return res.status(403).json({ error: 'Only verified drivers can view ride requests' }); if (driver.status === 'on_trip') return res.json({ radiusKm: MAX_RADIUS_KM, requests: [] }); const requests = store.rides.filter(ride => ride.status === 'searching').map(ride => ({ ride, distanceKm: driver.location ? distanceKm(ride.pickup, driver.location) : Infinity })).filter(item => item.distanceKm <= MAX_RADIUS_KM).sort((a, b) => a.distanceKm - b.distanceKm); res.json({ radiusKm: MAX_RADIUS_KM, requests: requests.map(item => ({ ...rideForClient(item.ride, store), distanceKm: Number(item.distanceKm.toFixed(2)) })) }); });
app.get('/api/rides/:id', auth, (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id); if (!ride) return res.status(404).json({ error: 'Ride not found' }); res.json({ ride: rideForClient(ride, store) }); });
app.post('/api/rides/:id/accept', auth, role('driver'), (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id); const driver = findDriverForUser(store, req.auth.id); if (!ride || !driver) return res.status(404).json({ error: 'Ride or driver not found' }); if (driver.verificationStatus !== 'verified') return res.status(403).json({ error: 'Only verified drivers can accept rides' }); if (ride.status !== 'searching') return res.status(409).json({ error: 'Ride is no longer available' }); const distance = distanceKm(ride.pickup, driver.location); if (distance > MAX_RADIUS_KM) return res.status(403).json({ error: 'Driver is outside the 2 km service radius' }); ride.driverId = driver.id; ride.driverDistanceKm = distance; ride.status = 'accepted'; ride.updatedAt = new Date().toISOString(); driver.status = 'on_trip'; sendNotification(store, ride.userId, 'Driver accepted', `${driver.name} accepted your request and is ${distance.toFixed(1)} km away`, ride.id); writeStore(store); broadcastRide(ride, store); res.json({ ride: rideForClient(ride, store) }); });
app.post('/api/rides/:id/reject', auth, role('driver'), (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id); if (!ride || ride.status !== 'searching') return res.status(404).json({ error: 'Ride is not available' }); sendNotification(store, ride.userId, 'Driver passed', 'The driver passed on this request. We are finding another nearby driver.', ride.id); writeStore(store); res.json({ ok: true }); });
app.patch('/api/rides/:id/status', auth, (req, res) => { const allowed = ['arriving', 'started', 'completed', 'cancelled']; const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id); if (!ride || (req.auth.role !== 'admin' && ride.userId !== req.auth.id && ride.driverId !== findDriverForUser(store, req.auth.id)?.id)) return res.status(404).json({ error: 'Ride not found' }); if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid ride status' }); ride.status = req.body.status; ride.updatedAt = new Date().toISOString(); if (ride.status === 'completed' || ride.status === 'cancelled') { const driver = store.drivers.find(item => item.id === ride.driverId); if (driver) driver.status = 'available'; } sendNotification(store, ride.userId, 'Ride updated', `Your ride is now ${ride.status}`, ride.id); writeStore(store); broadcastRide(ride, store); res.json({ ride: rideForClient(ride, store) }); });
app.patch('/api/rides/:id/location', auth, role('driver'), (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id); if (!ride || ride.driverId !== findDriverForUser(store, req.auth.id)?.id) return res.status(404).json({ error: 'Ride not found' }); ride.driverLocation = { lat: number(req.body.lat, 'lat'), lng: number(req.body.lng, 'lng') }; ride.updatedAt = new Date().toISOString(); writeStore(store); broadcastRide(ride, store); io.to(`ride:${ride.id}`).emit('driver:location', { rideId: ride.id, driverId: ride.driverId, location: ride.driverLocation, status: ride.status }); res.json({ ride: rideForClient(ride, store) }); });

app.post('/api/rides/:id/payment', auth, role('user'), (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id && item.userId === req.auth.id); if (!ride) return res.status(404).json({ error: 'Ride not found' }); if (ride.status !== 'completed') return res.status(409).json({ error: 'Payment is available after ride completion' }); if (store.payments.some(payment => payment.rideId === ride.id)) return res.status(409).json({ error: 'Ride is already paid' }); const payment = { id: id('payment'), rideId: ride.id, userId: req.auth.id, amount: ride.fare, method: req.body.method || ride.paymentMethod, status: 'paid', paidAt: new Date().toISOString() }; store.payments.push(payment); writeStore(store); res.status(201).json({ payment }); });
app.post('/api/rides/:id/review', auth, role('user'), (req, res) => { const store = readStore(); const ride = store.rides.find(item => item.id === req.params.id && item.userId === req.auth.id); const score = Number(req.body.rating); if (!ride || ride.status !== 'completed' || !ride.driverId || score < 1 || score > 5) return res.status(400).json({ error: 'A completed ride and rating from 1 to 5 are required' }); if (store.reviews.some(review => review.rideId === ride.id)) return res.status(409).json({ error: 'Ride already reviewed' }); const review = { id: id('review'), rideId: ride.id, driverId: ride.driverId, userId: req.auth.id, rating: score, comment: req.body.comment || '', createdAt: new Date().toISOString() }; const driver = store.drivers.find(item => item.id === ride.driverId); driver.rating = Number(((driver.rating * driver.ratingCount + score) / (driver.ratingCount + 1)).toFixed(2)); driver.ratingCount += 1; store.reviews.push(review); writeStore(store); res.status(201).json({ review }); });
app.get('/api/drivers/:id/reviews', (req, res) => { const store = readStore(); const driver = store.drivers.find(item => item.id === req.params.id); if (!driver) return res.status(404).json({ error: 'Driver not found' }); res.json({ driver: { id: driver.id, name: driver.name, rating: driver.rating, ratingCount: driver.ratingCount, verified: driver.verificationStatus === 'verified' }, reviews: store.reviews.filter(review => review.driverId === driver.id).map(review => ({ rating: review.rating, comment: review.comment, createdAt: review.createdAt })) }); });

app.post('/api/emergencies', auth, (req, res) => { const store = readStore(); const driver = findDriverForUser(store, req.auth.id); const ride = req.body.rideId ? store.rides.find(item => item.id === req.body.rideId) : null; if (ride && req.auth.role !== 'admin' && ride.userId !== req.auth.id && ride.driverId !== driver?.id) return res.status(403).json({ error: 'You are not part of this ride' }); const emergency = { id: id('emergency'), userId: req.auth.id, rideId: ride?.id || null, reason: req.body.reason || 'Safety concern reported', location: req.body.location || null, status: 'open', createdAt: new Date().toISOString() }; store.emergencies.push(emergency); const recipients = store.users.filter(user => user.role === 'admin' || user.id === ride?.userId || user.id === store.drivers.find(item => item.id === ride?.driverId)?.userId); recipients.forEach(user => sendNotification(store, user.id, 'Emergency alert', 'A safety concern needs immediate attention.', ride?.id)); writeStore(store); io.emit('emergency:created', emergency); res.status(201).json({ emergency, message: 'Emergency alert sent to Velo safety support' }); });

app.get('/api/notifications', auth, (req, res) => { const store = readStore(); res.json({ notifications: store.notifications.filter(item => item.userId === req.auth.id).slice(0, 50) }); });
app.get('/api/admin/dashboard', auth, role('admin'), (req, res) => { const store = readStore(); res.json({ metrics: { users: store.users.filter(user => user.role === 'user').length, drivers: store.drivers.length, verifiedDrivers: store.drivers.filter(driver => driver.verificationStatus === 'verified').length, pendingVerifications: store.drivers.filter(driver => driver.verificationStatus === 'pending').length, activeRides: store.rides.filter(ride => !['completed', 'cancelled'].includes(ride.status)).length, openEmergencies: store.emergencies.filter(item => item.status === 'open').length, revenue: store.payments.reduce((total, payment) => total + payment.amount, 0) }, pendingDrivers: store.drivers.filter(driver => driver.verificationStatus === 'pending').map(driver => ({ ...driver, documents: { ...driver.documents, identity: 'redacted' } })), recentRides: store.rides.slice(-20).reverse(), emergencies: store.emergencies.slice(-20).reverse() }); });
app.patch('/api/admin/drivers/:id/verify', auth, role('admin'), (req, res) => { const store = readStore(); const driver = store.drivers.find(item => item.id === req.params.id); if (!driver) return res.status(404).json({ error: 'Driver not found' }); const approved = req.body.approved !== false; driver.verificationStatus = approved ? 'verified' : 'rejected'; driver.verifiedAt = approved ? new Date().toISOString() : null; driver.verifiedBy = req.auth.id; driver.status = approved ? 'available' : 'offline'; sendNotification(store, driver.userId, approved ? 'Profile verified' : 'Verification needs attention', approved ? 'Your documents are verified. You can now receive ride requests.' : 'Please review your submitted documents.', null); writeStore(store); res.json({ driver }); });

io.on('connection', socket => { socket.on('join:user', userId => socket.join(`user:${userId}`)); socket.on('join:ride', rideId => socket.join(`ride:${rideId}`)); socket.on('driver:location', payload => { if (payload?.rideId) io.to(`ride:${payload.rideId}`).emit('driver:location', payload); }); });

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(PORT, () => console.log(`Velo API running at http://localhost:${PORT}`));
