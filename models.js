import mongoose from 'mongoose';

const { Schema } = mongoose;

const coordinatesSchema = new Schema({
  type: { type: String, enum: ['Point'], default: 'Point', required: true },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator(value) {
      return Array.isArray(value) && value.length === 2 &&
          Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 &&
          Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
      },
      message: 'Coordinates must be [longitude, latitude] within valid ranges'
    }
  }
}, { _id: false });

const vehicleSchema = new Schema({
  make: { type: String, trim: true, maxlength: 80 },
  model: { type: String, trim: true, maxlength: 80 },
  color: { type: String, trim: true, maxlength: 50 }
}, { _id: false });

const driverSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  vehicle: { type: vehicleSchema, default: () => ({}) },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending', index: true },
  status: { type: String, enum: ['offline', 'available', 'on_trip'], default: 'offline', index: true },
  serviceTypes: { type: [String], enum: ['personal-driver', 'cab-driver'], default: [] },
  rating: { type: Number, min: 0, max: 5, default: 0 },
  ratingCount: { type: Number, min: 0, default: 0 },
  location: { type: coordinatesSchema, default: undefined },
  locationUpdatedAt: { type: Date, default: null, index: true },
  lastLocationRequestAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

driverSchema.index({ location: '2dsphere' });
driverSchema.index({ status: 1, verificationStatus: 1, serviceTypes: 1, locationUpdatedAt: -1 });

const placeSchema = new Schema({
  type: { type: String, enum: ['Point'], default: 'Point', required: true },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator(value) {
      return Array.isArray(value) && value.length === 2 &&
          Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 &&
          Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
      },
      message: 'Coordinates must be [longitude, latitude] within valid ranges'
    }
  },
  address: { type: String, required: true, trim: true, maxlength: 300 }
}, { _id: false });

const reviewSchema = new Schema({
  id: { type: String, required: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true, maxlength: 500, default: '' },
  createdAt: { type: Date, required: true }
}, { _id: false });

const bookingSchema = new Schema({
  id: { type: String, required: true, unique: true, index: true },
  customerId: { type: String, required: true, index: true },
  serviceType: { type: String, enum: ['personal-driver', 'cab-driver'], required: true },
  pickup: { type: placeSchema, required: true },
  destination: { type: placeSchema, required: true },
  tripDate: { type: Date, required: true },
  time: { type: String, required: true },
  timezoneOffsetMinutes: { type: Number, min: -840, max: 840, default: 0 },
  durationMinutes: { type: Number, min: 1, required: true },
  distanceKm: { type: Number, min: 0, required: true },
  fare: { type: Number, min: 0, required: true },
  paymentMethod: { type: String, enum: ['UPI', 'cash', 'card'], default: 'UPI' },
  paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date, default: null },
  review: { type: reviewSchema, default: null },
  status: {
    type: String,
    enum: ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed', 'cancelled', 'expired'],
    default: 'searching',
    index: true
  },
  searchExpiresAt: { type: Date, required: true, index: true },
  assignedDriverId: { type: String, default: null, index: true },
  assignmentDistanceMetres: { type: Number, default: null },
  assignedAt: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  latestDriverLocation: { type: coordinatesSchema, default: undefined },
  latestDriverLocationAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

bookingSchema.index({ customerId: 1, createdAt: -1 });
bookingSchema.index({ assignedDriverId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ status: 1, searchExpiresAt: 1 });

const rideRequestSchema = new Schema({
  bookingId: { type: String, required: true, index: true },
  driverId: { type: String, required: true, index: true },
  status: { type: String, enum: ['offered', 'accepted', 'rejected', 'expired', 'lost'], default: 'offered', index: true },
  distanceMetres: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true, index: true },
  respondedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

rideRequestSchema.index({ bookingId: 1, driverId: 1 }, { unique: true });
rideRequestSchema.index({ driverId: 1, status: 1, expiresAt: 1 });

const emergencySchema = new Schema({
  id: { type: String, required: true, unique: true },
  reporterUserId: { type: String, required: true, index: true },
  bookingId: { type: String, default: null, index: true },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  location: { type: coordinatesSchema, default: undefined },
  status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true }
}, { timestamps: true, versionKey: false });

emergencySchema.index({ createdAt: -1, status: 1 });

export const Driver = mongoose.models.Driver || mongoose.model('Driver', driverSchema);
export const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
export const RideRequest = mongoose.models.RideRequest || mongoose.model('RideRequest', rideRequestSchema);
export const Emergency = mongoose.models.Emergency || mongoose.model('Emergency', emergencySchema);

export async function connectMongo(uri = process.env.MONGODB_URI) {
  if (!uri) {
    throw new Error('MONGODB_URI is required to start DriveEase');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([Driver.init(), Booking.init(), RideRequest.init(), Emergency.init()]);
}
