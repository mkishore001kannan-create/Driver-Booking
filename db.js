import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');

export function makeSeed() {
  const passwordHash = bcrypt.hashSync('demo123', 10);
  const adminHash = bcrypt.hashSync('admin123', 10);
  const driverHash = bcrypt.hashSync('driver123', 10);
  const now = new Date().toISOString();

  return {
    users: [
      { id: 'user-demo', name: 'Arjun Sharma', email: 'arjun@velo.local', phone: '+91 98765 43210', passwordHash, role: 'customer', createdAt: now },
      { id: 'admin-demo', name: 'Velo Admin', email: 'admin@velo.local', phone: '', passwordHash: adminHash, role: 'admin', createdAt: now },
      { id: 'driver-user-rohan', name: 'Rohan Kumar', email: 'rohan@velo.local', phone: '+91 90000 10001', passwordHash: driverHash, role: 'driver', createdAt: now },
      { id: 'driver-user-meera', name: 'Meera Nair', email: 'meera@velo.local', phone: '+91 90000 10002', passwordHash: driverHash, role: 'driver', createdAt: now },
      { id: 'driver-user-sameer', name: 'Sameer Ali', email: 'sameer@velo.local', phone: '+91 90000 10003', passwordHash: driverHash, role: 'driver', createdAt: now }
    ],
    drivers: [
      { id: 'driver-rohan', userId: 'driver-user-rohan', name: 'Rohan Kumar', phone: '+91 90000 10001', vehicle: { make: 'Honda City', plate: 'KA 03 MJ 4821', color: 'White' }, documents: { license: 'DL-KA-2021-88921', identity: 'AADHAAR-XXXX-2190', insurance: 'INS-2026-8831' }, verificationStatus: 'verified', verifiedAt: now, verifiedBy: 'admin-demo', status: 'available', location: { lat: 12.9719, lng: 77.6412 }, rating: 4.9, ratingCount: 128 },
      { id: 'driver-meera', userId: 'driver-user-meera', name: 'Meera Nair', phone: '+91 90000 10002', vehicle: { make: 'Hyundai Verna', plate: 'KA 05 PR 7314', color: 'Silver' }, documents: { license: 'DL-KA-2022-88442', identity: 'AADHAAR-XXXX-4412', insurance: 'INS-2026-1009' }, verificationStatus: 'verified', verifiedAt: now, verifiedBy: 'admin-demo', status: 'available', location: { lat: 12.9746, lng: 77.6385 }, rating: 4.8, ratingCount: 96 },
      { id: 'driver-sameer', userId: 'driver-user-sameer', name: 'Sameer Ali', phone: '+91 90000 10003', vehicle: { make: 'Toyota Etios', plate: 'KA 04 QL 1902', color: 'Black' }, documents: { license: 'DL-KA-2020-44291', identity: 'AADHAAR-XXXX-8901', insurance: 'INS-2026-3401' }, verificationStatus: 'verified', verifiedAt: now, verifiedBy: 'admin-demo', status: 'available', location: { lat: 12.9688, lng: 77.6344 }, rating: 4.7, ratingCount: 71 }
    ],
    bookings: [],
    payments: [],
    reviews: [],
    notifications: [],
    emergencies: [],
    fareConfig: {
      baseFare: 149,
      perKm: 18,
      perMinute: 1.8,
      serviceTypeMultiplier: { 'personal-driver': 1.3, 'cab-driver': 1.0 },
      nightSurcharge: 0.15,
      outstationSurcharge: 0.1,
      taxRate: 0.05,
      cancellationFee: 79
    }
  };
}

export function ensureStore() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(makeSeed(), null, 2));
  }
}

export function readStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  let changed = false;

  if (!store.users) store.users = [];
  if (!store.drivers) store.drivers = [];
  if (!store.bookings) store.bookings = [];
  if (!store.notifications) store.notifications = [];
  if (!store.payments) store.payments = [];
  if (!store.reviews) store.reviews = [];
  if (!store.emergencies) store.emergencies = [];

  store.users.forEach(user => {
    if (user.role === 'user') {
      user.role = 'customer';
      changed = true;
    }
  });

  if (!store.fareConfig) {
    store.fareConfig = {
      baseFare: 149,
      perKm: 18,
      perMinute: 1.8,
      serviceTypeMultiplier: { 'personal-driver': 1.3, 'cab-driver': 1.0 },
      nightSurcharge: 0.15,
      outstationSurcharge: 0.1,
      taxRate: 0.05,
      cancellationFee: 79
    };
    changed = true;
  }

  const driverAccounts = [
    { id: 'driver-user-rohan', name: 'Rohan Kumar', email: 'rohan@velo.local', phone: '+91 90000 10001' },
    { id: 'driver-user-meera', name: 'Meera Nair', email: 'meera@velo.local', phone: '+91 90000 10002' },
    { id: 'driver-user-sameer', name: 'Sameer Ali', email: 'sameer@velo.local', phone: '+91 90000 10003' }
  ];

  driverAccounts.forEach(account => {
    if (!store.users.some(user => user.id === account.id)) {
      store.users.push({ ...account, passwordHash: bcrypt.hashSync('driver123', 10), role: 'driver', createdAt: new Date().toISOString() });
      changed = true;
    }
  });

  if (!store.drivers.some(d => d.userId === 'driver-user-rohan')) {
    store.drivers.push({ id: 'driver-rohan', userId: 'driver-user-rohan', name: 'Rohan Kumar', phone: '+91 90000 10001', vehicle: { make: 'Honda City', plate: 'KA 03 MJ 4821', color: 'White' }, documents: { license: 'DL-KA-2021-88921', identity: 'AADHAAR-XXXX-2190', insurance: 'INS-2026-8831' }, verificationStatus: 'verified', verifiedAt: nowIso(), verifiedBy: 'admin-demo', status: 'available', location: { lat: 12.9719, lng: 77.6412 }, rating: 4.9, ratingCount: 128 });
    changed = true;
  }

  if (changed) writeStore(store);
  return store;
}

export function writeStore(store) {
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
  return store;
}

export function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}
