# Velo driver booking backend

Velo is a local full-stack prototype for booking verified personal drivers. The backend is Express + Socket.IO with a JSON persistence store so it runs without a database installation.

## Run

```powershell
npm install
npm start
```

Open `http://localhost:3000` for the rider application or `http://localhost:3000/driver.html` for the separate driver application.

The seeded demo accounts are:

- User: `arjun@velo.local` / `demo123`
- Admin: `admin@velo.local` / `admin123`
- Driver: `rohan@velo.local` / `driver123`

The first server run creates `data/store.json`. That file is ignored by git and contains local development data.

## Implemented backend capabilities

- JWT authentication with `user`, `driver`, and `admin` roles
- Password hashing with bcrypt
- Driver registration requiring license, identity, and insurance document IDs
- Admin verification and rejection workflow; only verified drivers can receive or accept requests
- `verified: true` driver payloads and verified status in nearby-driver results
- Haversine nearby matching with a hard maximum of 2 km
- Separate driver portal with verified account login, online/offline presence, nearby request queue, accept flow, and driver ride history
- Driver Leaflet map with request markers, browser notifications, and OSRM best-route previews after acceptance
- Rider live tracking via Socket.IO room updates, live driver marker, and route refreshes
- Ride creation, driver accept/reject, ride status changes, cancellation, and completion
- Socket.IO rooms for live ride updates, driver location, and notifications
- Payment capture after ride completion
- UPI and cash payment selection stored with each ride
- One-to-five star reviews that update driver ratings
- Driver rating summaries and rider review lookup
- Role-aware ride history for riders and drivers
- Emergency alerts for both riders and drivers, including ride and location context
- Admin metrics, pending verifications, and recent rides
- Leaflet + OpenStreetMap map integration in the frontend
- Map click-to-drop destination pin and browser geolocation for pickup

## Main API routes

All protected routes use `Authorization: Bearer <token>`.

- `POST /api/auth/register`, `POST /api/auth/login`
- `POST /api/drivers/register`
- `GET /api/drivers/nearby?lat=12.9719&lng=77.6412&radiusKm=2`
- `PATCH /api/drivers/me/location`
- `POST /api/rides`, `GET /api/rides`, `GET /api/rides/:id`
- `POST /api/rides/:id/accept`, `POST /api/rides/:id/reject`
- `PATCH /api/rides/:id/status`, `PATCH /api/rides/:id/location`
- `POST /api/rides/:id/payment`, `POST /api/rides/:id/review`
- `GET /api/history`
- `GET /api/driver/requests`
- `GET /api/drivers/:id/reviews`
- `POST /api/emergencies`
- `GET /api/notifications`
- `GET /api/admin/dashboard`
- `PATCH /api/admin/drivers/:id/verify`

The driver app polls for new requests every 15 seconds and also listens for Socket.IO notifications. The rider joins the accepted ride room and receives driver location/status updates in real time. Route previews use the public OSRM routing service over OpenStreetMap; production deployments should use a managed routing provider with usage limits and an API key.

For production, replace the JSON store with PostgreSQL or another transactional database, set a strong `JWT_SECRET`, add a real payment provider such as Stripe or Razorpay, and use an authenticated map/geolocation policy appropriate for the deployment.
