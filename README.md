# DriveEase

DriveEase is a React + Vite booking app with an Express, Socket.IO, and MongoDB/Mongoose backend. Customer searches, driver offers, assignments, trip state, payment and review state, emergency alerts, and active-trip location snapshots are stored in MongoDB. The existing JSON store remains for the prototype's authentication accounts, legacy records, and admin notifications.

## Local setup (Windows PowerShell)

1. Install Node.js 18 or newer, MongoDB Community Server locally, or create a MongoDB Atlas database.
2. From the project folder:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

3. Edit `.env` and set `MONGODB_URI` to a reachable database and replace `JWT_SECRET` with a long random value.
4. Start the app:

   ```powershell
   npm run dev
   ```

Open `http://localhost:5173`. The API listens on `http://localhost:3000`.

Demo accounts:

- Customer: `arjun@velo.local` / `demo123`
- Admin: `admin@velo.local` / `admin123`
- Verified driver: `rohan@velo.local` / `driver123`

MongoDB must be reachable before the API starts. The server creates the required schema indexes, including the driver's `2dsphere` location index. Existing JSON-seeded driver coordinates are not copied into MongoDB or treated as live locations. Drivers start offline and must explicitly go online after granting browser location permission.

## Nearby driver matching and live trips

- Pick a suggested Bengaluru place, use browser current location, or click the Leaflet map to set pickup and destination.
- Route geometry, driving distance, duration, and the server-calculated fare come from the configured OSRM-compatible routing service. The customer search uses the exact 1,000-metre pickup radius; this is a proximity search, not a claim that a driver's driving route is under 1 km.
- Only verified, explicitly online drivers with a selected matching service and a location updated within 90 seconds are eligible.
- Driver location is sent every 30 seconds while online/on-trip, with browser permission, and only while the authenticated Socket.IO connection is active. Stale drivers are taken offline.
- Customer searches expire after `BOOKING_SEARCH_TIMEOUT_MS` (default 60 seconds). No-driver and network failures are shown in the UI, and customers can retry.
- A MongoDB conditional update makes assignment first-wins. The server rechecks the driver's eligibility, current position, and exact radius before assignment.
- Socket.IO authenticates connections and authorizes each booking room. Precise driver location is only sent to assigned trip participants and is removed from the booking snapshot after completion or cancellation.
- Trip states are validated server-side: `searching`, `driver_assigned`, `driver_en_route`, `arrived_at_pickup`, `in_progress`, then `completed`; cancellation and expiry are also supported.
- The animated scan indicates an active search only. Nearby driver markers are based on actual server results, and their pre-assignment coordinates are rounded to reduce location exposure.
- The landing-page fare and route card is an illustrative sample, not a live ride or quote. The payment action records a demo payment state only; no payment processor is integrated, so it must not be used to collect real payments.

## Configuration

`.env.example` lists the supported variables:

- `MONGODB_URI`: required MongoDB connection string
- `JWT_SECRET`: JWT signing key; use a strong, unique value outside local development
- `ROUTING_BASE_URL`: OSRM-compatible service base URL; defaults to the public OSRM demo service
- `BOOKING_SEARCH_TIMEOUT_MS`: search expiry in milliseconds; minimum effective value is 15 seconds
- `PORT`: API port (default `3000`)

The default public OSRM endpoint is suitable for local evaluation only. For production, configure a routing provider with appropriate availability, usage limits, and terms. The map uses OpenStreetMap tiles and includes attribution.

## API surface

Protected endpoints use `Authorization: Bearer <JWT>`.

- `GET /api/routes`: fetch a real driving route between coordinates
- `POST /api/driver-search`: persist a booking, calculate fare from the server route, and offer it to eligible drivers in 1 km
- `GET /api/drivers/nearby`: return at most 50 eligible customer-facing map markers within 1 km
- `PATCH /api/drivers/availability`: explicitly go online/offline; online requires a recent browser location and selected services
- `POST /api/driver-location`: rate-limited driver GPS update
- `GET /api/driver/requests`: recover still-open offers after reconnecting
- `POST /api/bookings/:id/accept`, `POST /api/bookings/:id/reject`
- `POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/status`
- `POST /api/bookings/:id/payment`, `POST /api/bookings/:id/review`, `POST /api/emergencies`
- `GET /api/bookings`, `GET /api/bookings/:id`: recover authorized persistent state

Socket.IO events include `ride:request`, `ride:request-closed`, `ride:assigned`, `ride:expired`, `booking:state`, `booking:update`, and `driver:location`. Clients authenticate with the socket `auth.token`; booking room membership is authorized by the server.

## Tests and build

```powershell
npm test
npm run build
```

The default test suite covers coordinate validation and order, the 1 km boundary, stale/unavailable/ineligible drivers, safe map markers, trip transitions, socket booking authorization, and model indexes. The concurrent MongoDB acceptance test is skipped unless `MONGO_TEST_URI` points at a dedicated database whose name contains `test`:

```powershell
$env:MONGO_TEST_URI = "mongodb://127.0.0.1:27017/driveease-test"
npm test
```

Do not use a production database for integration tests.
