import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { io } from 'socket.io-client';
import L from 'leaflet';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';

const API_BASE = '/api';

const LOCATION_SUGGESTIONS = [
  { name: 'Koramangala', lat: 12.9352, lng: 77.6245 },
  { name: 'Bangalore Airport', lat: 13.2008, lng: 77.7060 },
  { name: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
  { name: 'MG Road', lat: 12.9762, lng: 77.6068 },
  { name: 'Whitefield', lat: 12.9698, lng: 77.7499 },
  { name: 'Electronic City', lat: 12.8458, lng: 77.6603 },
  { name: 'Cubbon Park', lat: 12.9767, lng: 77.5928 },
  { name: 'Domlur', lat: 12.9601, lng: 77.6404 },
  { name: 'Yelahanka', lat: 13.1007, lng: 77.5963 },
  { name: 'BTM Layout', lat: 12.9165, lng: 77.6101 },
  { name: 'HSR Layout', lat: 12.9113, lng: 77.6511 },
  { name: 'Kempegowda Station', lat: 13.0257, lng: 77.5631 }
];

function getDefaultTripSchedule() {
  const pickupTime = new Date();
  pickupTime.setMinutes((Math.floor(pickupTime.getMinutes() / 15) + 1) * 15, 0, 0);
  const pad = value => String(value).padStart(2, '0');
  return {
    tripDate: `${pickupTime.getFullYear()}-${pad(pickupTime.getMonth() + 1)}-${pad(pickupTime.getDate())}`,
    time: `${pad(pickupTime.getHours())}:${pad(pickupTime.getMinutes())}`
  };
}

function getStoredSession() {
  try {
    const raw = localStorage.getItem('driveease-session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (!session) {
    localStorage.removeItem('driveease-session');
    return;
  }
  localStorage.setItem('driveease-session', JSON.stringify(session));
}

function api({ method = 'get', url, data, token } = {}) {
  return axios({
    method,
    url: `${API_BASE}${url}`,
    data,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  }).then(res => res.data);
}

function apiErrorMessage(error, fallback) {
  if (error.response?.data?.error) return error.response.data.error;
  if (error.response?.status >= 500) {
    return 'DriveEase is temporarily unavailable. Check that the API and MongoDB are running, then retry.';
  }
  if (!error.response) {
    return 'Cannot reach the DriveEase API. Start the backend and retry when it is available.';
  }
  return fallback;
}

const pickupIcon = L.divIcon({ className: 'map-marker map-marker-pickup', html: 'P', iconSize: [30, 30], iconAnchor: [15, 15] });
const destinationIcon = L.divIcon({ className: 'map-marker map-marker-destination', html: 'D', iconSize: [30, 30], iconAnchor: [15, 15] });
const driverIcon = L.divIcon({ className: 'map-marker map-marker-driver', html: '🚘', iconSize: [34, 34], iconAnchor: [17, 17] });

function MapViewport({ points }) {
  const map = useMap();
  useEffect(() => {
    const bounds = points.filter(Boolean).map(point => [point.lat, point.lng]);
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 15 });
    else if (bounds.length === 1) map.setView(bounds[0], 14);
  }, [map, points]);
  return null;
}

function MapClickHandler({ onSelect }) {
  useMapEvents({
    click(event) {
      if (onSelect) onSelect(event.latlng);
    }
  });
  return null;
}

function RideMap({ pickup, destination, driver, nearbyDrivers = [], routeGeometry, scanning = false, onMapSelect }) {
  const points = useMemo(() => [pickup, destination, driver, ...nearbyDrivers.map(item => item.location ? {
    lat: item.location.coordinates[1],
    lng: item.location.coordinates[0]
  } : null)], [pickup, destination, driver, nearbyDrivers]);
  const routePositions = routeGeometry?.coordinates?.map(([lng, lat]) => [lat, lng]) || [];

  return (
    <div className="relative z-0 h-80 overflow-hidden rounded-2xl border border-slate-200">
      <MapContainer
        center={pickup ? [pickup.lat, pickup.lng] : [12.9716, 77.5946]}
        zoom={13}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport points={points} />
        <MapClickHandler onSelect={onMapSelect} />
        {pickup && (
          <>
            <Circle center={[pickup.lat, pickup.lng]} radius={1000} pathOptions={{ color: '#059669', weight: 2, fillOpacity: 0.08 }} />
            {scanning && <Circle center={[pickup.lat, pickup.lng]} radius={650} className="radar-pulse" pathOptions={{ color: '#10b981', weight: 3, fillOpacity: 0.12 }} />}
            <Marker position={[pickup.lat, pickup.lng]} icon={pickupIcon}><Popup>Pickup</Popup></Marker>
          </>
        )}
        {destination && <Marker position={[destination.lat, destination.lng]} icon={destinationIcon}><Popup>Destination</Popup></Marker>}
        {routePositions.length > 1 && <Polyline positions={routePositions} pathOptions={{ color: '#0f766e', weight: 5, opacity: 0.85 }} />}
        {driver && <Marker position={[driver.lat, driver.lng]} icon={driverIcon}><Popup>Assigned driver{driver.updatedAt ? ` · Updated ${new Date(driver.updatedAt).toLocaleTimeString()}` : ''}</Popup></Marker>}
        {nearbyDrivers.map(item => item.location && (
          <Marker key={item.id} position={[item.location.coordinates[1], item.location.coordinates[0]]} icon={driverIcon}>
            <Popup>{item.name} · {item.distanceMetres} m away</Popup>
          </Marker>
        ))}
      </MapContainer>
      <div className="absolute bottom-3 left-3 z-[1000] rounded-lg bg-white/95 px-3 py-2 text-xs font-semibold text-slate-700 shadow">
        {scanning ? 'Searching within 1 km' : '1 km driver search radius'}
      </div>
      {scanning && <div className="sr-only" role="status" aria-live="polite">Finding nearby drivers. The map animation shows the search area, not detected drivers.</div>}
    </div>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(52,211,153,0.2),_transparent_16%),linear-gradient(120deg,#f8fafc_0%,#ecfeff_50%,#eef2ff_100%)] text-slate-900">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-950 text-lg font-black text-emerald-300">D</div>
          <div>
            <div className="text-xl font-black tracking-tight">DriveEase</div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Premium mobility</div>
          </div>
        </div>
        <nav className="hidden items-center gap-8 text-sm text-slate-600 md:flex">
          <a href="#services" className="transition hover:text-slate-900">Services</a>
          <a href="#features" className="transition hover:text-slate-900">Features</a>
          <a href="#security" className="transition hover:text-slate-900">Security</a>
          <Link to="/auth" className="primary-btn">Get started</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-20 pt-10">
        <section className="grid items-center gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="mb-4 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Verified driver booking
            </div>
            <h1 className="max-w-xl text-5xl font-black leading-tight tracking-tight text-slate-950 md:text-6xl">
              Book a smarter ride in minutes.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-slate-600">
              DriveEase helps customers secure personal drivers or cab + driver rides with transparent pricing, live booking updates, verified professionals, and a premium driver experience.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link to="/auth" className="primary-btn">Book a ride</Link>
              <Link to="/driver" className="secondary-btn">Join as driver</Link>
            </div>
            <div className="mt-10 grid max-w-lg grid-cols-3 gap-4 text-left">
              {[
                ['1 km', 'nearby driver search'],
                ['Real routes', 'fare estimates'],
                ['Live', 'trip updates']
              ].map(([value, label]) => (
                <div key={label} className="rounded-2xl border border-slate-200 bg-white/80 p-4">
                  <div className="text-2xl font-black text-slate-950">{value}</div>
                  <div className="text-xs uppercase tracking-[0.15em] text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card-surface p-6">
            <div className="rounded-[28px] bg-slate-950 p-5 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-300">Illustrative fare</div>
                  <div className="mt-2 text-3xl font-black">₹1,280</div>
                </div>
                <div className="rounded-2xl bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-300">Sample trip</div>
              </div>
              <div className="mt-8 space-y-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>Pickup</span>
                    <span>12 min</span>
                  </div>
                  <div className="mt-2 text-lg font-bold">Koramangala</div>
                </div>
                <div className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>Destination</span>
                    <span>18 km</span>
                  </div>
                  <div className="mt-2 text-lg font-bold">Bangalore Airport</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="services" className="mt-16 grid gap-6 md:grid-cols-3">
          {[
            ['Personal driver', 'A professional driver for your own vehicle; ideal for business travel and daily commuting.'],
            ['Cab + driver', 'Comfortable rides with an experienced driver and ready-to-go vehicle booking.'],
            ['Corporate trips', 'Scheduled travel management for teams, airport transfers, and executive mobility.']
          ].map(([title, copy]) => (
            <div key={title} className="card-surface p-6">
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-xl text-emerald-700">✓</div>
              <h3 className="text-xl font-bold text-slate-900">{title}</h3>
              <p className="mt-3 text-sm text-slate-600">{copy}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', role: 'customer' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';
      const payload = mode === 'login'
        ? { email: form.email, password: form.password }
        : { name: form.name, email: form.email, password: form.password, phone: form.phone, role: form.role };

      const data = await api({ method: 'post', url: endpoint, data: payload });
      saveSession({ token: data.token, user: data.user });
      const target = data.user.role === 'admin' ? '/admin' : data.user.role === 'driver' ? '/driver' : '/customer';
      navigate(target);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not sign in. Check your details and try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card-surface w-full max-w-md p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-600">DriveEase</div>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">{mode === 'login' ? 'Welcome back' : 'Create account'}</h1>
          </div>
          <Link to="/" className="text-sm font-semibold text-slate-500">Home</Link>
        </div>

        <div className="mb-6 flex rounded-2xl border border-slate-200 bg-slate-100 p-1">
          {['login', 'register'].map(item => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${mode === item ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              {item === 'login' ? 'Login' : 'Register'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <>
              <div>
                <label className="text-sm font-medium text-slate-700">Full name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="input-shell" placeholder="Aisha Kapoor" required />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Phone</label>
                <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="input-shell" placeholder="+91 98xxx xxxxx" />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Account type</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} className="input-shell">
                  <option value="customer">Customer</option>
                  <option value="driver">Driver</option>
                </select>
              </div>
            </>
          )}

          <div>
            <label className="text-sm font-medium text-slate-700">Email</label>
            <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="input-shell" placeholder="you@example.com" required />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700">Password</label>
            <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} className="input-shell" placeholder="••••••••" required />
          </div>

          {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <button disabled={loading} className="primary-btn w-full disabled:cursor-not-allowed disabled:opacity-75">
            {loading ? 'Please wait...' : mode === 'login' ? 'Login' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

function ProtectedRoute({ role, children }) {
  const session = getStoredSession();
  const currentRole = session?.user?.role;

  if (!session?.token) return <Navigate to="/auth" replace />;
  if (role && currentRole !== role) return <Navigate to={currentRole === 'driver' ? '/driver' : currentRole === 'admin' ? '/admin' : '/customer'} replace />;
  return children;
}

function AppShell({ children, user, onLogout }) {
  const session = getStoredSession();
  const token = session?.token;
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);

  const navItems = useMemo(() => {
    if (user?.role === 'driver') return [{ label: 'Driver dashboard', to: '/driver' }, { label: 'My trips', to: '/driver#driver-trips' }];
    if (user?.role === 'admin') return [{ label: 'Admin dashboard', to: '/admin' }];
    return [{ label: 'Customer dashboard', to: '/customer' }, { label: 'Booking history', to: '/customer#booking-history' }];
  }, [user]);

  useEffect(() => {
    if (!token || !session?.user?.id) return;

    const fetchNotifications = async () => {
      try {
        const data = await api({ method: 'get', url: '/notifications', token });
        setNotifications(data.notifications || []);
      } catch {
        setNotifications([]);
      }
    };

    fetchNotifications();
    const socket = io({ auth: { token }, transports: ['websocket'] });
    socket.emit('join:user', session.user.id);
    socket.on('notification', notification => {
      setNotifications(prev => [notification, ...prev].slice(0, 10));
    });

    return () => socket.disconnect();
  }, [token, session?.user?.id]);

  const unreadCount = notifications.filter(item => !item.read).length;

  return (
    <div className="min-h-screen bg-slate-50/80 text-slate-900">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6 md:py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-emerald-300">D</div>
            <div>
              <div className="text-lg font-black tracking-tight">DriveEase</div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{user?.role || 'customer'}</div>
            </div>
          </div>
          <nav className="order-3 flex w-full items-center justify-center gap-6 text-xs font-medium text-slate-600 md:order-none md:w-auto md:gap-8 md:text-sm">
            {navItems.map(item => (
              <Link key={`${item.label}-${item.to}`} to={item.to} className="transition hover:text-slate-900">{item.label}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            {token && (
              <div className="relative">
                <button onClick={() => setShowNotifications(v => !v)} className="secondary-btn relative">
                  Alerts
                  {unreadCount > 0 && <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold text-white">{unreadCount}</span>}
                </button>
                {showNotifications && (
                  <div className="absolute right-0 top-14 z-20 w-80 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-bold text-slate-900">Notifications</div>
                      <button onClick={() => setShowNotifications(false)} className="text-xs text-slate-500">Close</button>
                    </div>
                    <div className="max-h-72 space-y-2 overflow-auto">
                      {notifications.length === 0 ? (
                        <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">No new notifications.</div>
                      ) : (
                        notifications.map(item => (
                          <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <div className="text-sm font-bold text-slate-900">{item.title}</div>
                            <div className="mt-1 text-xs text-slate-600">{item.message}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            <button onClick={onLogout} className="secondary-btn">Logout</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}

function BookingDetailPage() {
  const session = getStoredSession();
  const token = session?.token;
  const navigate = useNavigate();
  const { id } = useParams();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [liveLocation, setLiveLocation] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const lastRouteRequestRef = useRef(null);
  const routeRequestIdRef = useRef(0);

  useEffect(() => {
    if (!token) return navigate('/auth');
    let cancelled = false;
    const socket = io({ auth: { token } });
    const load = async () => {
      try {
        const data = await api({ method: 'get', url: `/bookings/${id}`, token });
        if (!cancelled) {
          setLoadError('');
          setBooking(data.booking);
          setLiveLocation(data.booking.latestDriverLocation || data.booking.driver?.location || null);
        }
      } catch (error) {
        if (!cancelled) {
          setBooking(null);
          setLoadError(apiErrorMessage(error, 'Could not load this booking.'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    socket.on('connect', () => socket.emit('booking:join', id));
    socket.on('booking:state', next => {
      if (next.id === id) setBooking(next);
    });
    socket.on('booking:update', next => {
      if (next.id === id) setBooking(next);
    });
    socket.on('ride:assigned', next => {
      if (next.id === id) setBooking(next);
    });
    socket.on('driver:location', event => {
      if (event.bookingId === id) {
        setLiveLocation(event.location);
        setBooking(previous => previous ? {
          ...previous,
          latestDriverLocation: event.location,
          latestDriverLocationAt: event.updatedAt
        } : previous);
      }
    });
    socket.on('booking:error', event => {
      if (event.bookingId === id) setRouteError(event.error);
    });
    return () => {
      cancelled = true;
      socket.emit('booking:leave', id);
      socket.disconnect();
    };
  }, [id, token, navigate, reloadCount]);

  useEffect(() => {
    if (!token || !booking) return;
    const isDriver = session?.user?.role === 'driver';
    const driverIsTravellingToPickup = isDriver && ['driver_assigned', 'driver_en_route'].includes(booking.status);
    const origin = driverIsTravellingToPickup
      ? (liveLocation || booking.driver?.location || booking.pickup)
      : booking.pickup;
    const destination = driverIsTravellingToPickup ? booking.pickup : booking.destination;
    const previousRequest = lastRouteRequestRef.current;
    if (driverIsTravellingToPickup && liveLocation && previousRequest?.mode === 'driver-to-pickup') {
      const movementMetres = Math.hypot(
        (origin.lat - previousRequest.lat) * 111_000,
        (origin.lng - previousRequest.lng) * 111_000
      );
      if (Date.now() - previousRequest.requestedAt < 30_000 || movementMetres < 200) return undefined;
    }
    lastRouteRequestRef.current = {
      mode: driverIsTravellingToPickup ? 'driver-to-pickup' : 'trip',
      lat: origin.lat,
      lng: origin.lng,
      requestedAt: Date.now()
    };
    const requestId = ++routeRequestIdRef.current;
    const query = new URLSearchParams({
      originLat: String(origin.lat),
      originLng: String(origin.lng),
      destinationLat: String(destination.lat),
      destinationLng: String(destination.lng)
    });
    api({ url: `/routes?${query}`, token })
      .then(data => {
        if (requestId === routeRequestIdRef.current) {
          setRoute(data);
          setRouteError('');
        }
      })
      .catch(error => {
        if (requestId === routeRequestIdRef.current) {
          setRouteError(apiErrorMessage(error, 'Unable to load the road route.'));
        }
      });
  }, [booking?.id, booking?.status, booking?.pickup?.lat, booking?.pickup?.lng, booking?.destination?.lat, booking?.destination?.lng, booking?.driver?.location?.lat, booking?.driver?.location?.lng, liveLocation?.lat, liveLocation?.lng, token]);

  useEffect(() => () => {
    routeRequestIdRef.current += 1;
  }, []);

  if (!token) return null;

  const timeline = ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed'];
  const currentIndex = timeline.indexOf(booking?.status || 'pending');
  const terminalState = ['completed', 'cancelled', 'expired'].includes(booking?.status);
  const mapPickup = booking?.pickup;
  const mapDestination = booking?.destination;
  const driverLocation = liveLocation && {
    lat: liveLocation.lat,
    lng: liveLocation.lng,
    updatedAt: booking?.latestDriverLocationAt || booking?.driver?.locationUpdatedAt
  };
  const changeTripStatus = async status => {
    try {
      const result = await api({
        method: session?.user?.role === 'driver' ? 'post' : 'post',
        url: session?.user?.role === 'driver' ? `/bookings/${id}/status` : `/bookings/${id}/cancel`,
        data: session?.user?.role === 'driver' ? { status } : {},
        token
      });
      setBooking(result.booking);
    } catch (error) {
      setRouteError(apiErrorMessage(error, 'Could not update this trip.'));
    }
  };
  const nextDriverStatus = {
    driver_assigned: ['driver_en_route', 'Start driving to pickup'],
    driver_en_route: ['arrived_at_pickup', 'Mark arrived'],
    arrived_at_pickup: ['in_progress', 'Start trip'],
    in_progress: ['completed', 'Complete trip']
  }[booking?.status];

  return (
    <AppShell user={session?.user} onLogout={() => { saveSession(null); navigate('/auth'); }}>
      <div className="card-surface p-6">
        {loading ? (
          <div className="text-sm text-slate-500">Loading trip details...</div>
        ) : !booking ? (
          <div className="text-sm text-slate-500">
            {loadError || 'Booking not found.'}
            {loadError && <button onClick={() => setReloadCount(value => value + 1)} className="secondary-btn ml-3">Retry</button>}
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Trip detail</div>
                <h2 className="mt-2 text-3xl font-black text-slate-950">{booking.pickup?.address} → {booking.destination?.address}</h2>
              </div>
              <div className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">{booking.status}</div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="grid gap-3 sm:grid-cols-2 text-sm text-slate-600">
                    <div><span className="font-semibold text-slate-900">Service:</span> {booking.serviceType}</div>
                    <div><span className="font-semibold text-slate-900">Fare:</span> ₹{booking.fare}</div>
                    <div><span className="font-semibold text-slate-900">Pickup time:</span> {booking.tripDate} {booking.time}</div>
                    <div><span className="font-semibold text-slate-900">Payment:</span> {booking.paymentMethod}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 text-sm font-bold uppercase tracking-[0.2em] text-slate-500">Trip progress</div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {timeline.map((step, index) => (
                      <div key={step} className={`rounded-xl border p-3 ${index <= currentIndex ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500'}`}>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.18em]">{step.replaceAll('_', ' ')}</div>
                      </div>
                    ))}
                  </div>
                  {booking.status === 'cancelled' || booking.status === 'expired' ? (
                    <div className="mt-3 text-sm font-semibold text-rose-700">Trip {booking.status}.</div>
                  ) : null}
                  {session?.user?.role === 'driver' && nextDriverStatus && (
                    <button onClick={() => changeTripStatus(nextDriverStatus[0])} className="primary-btn mt-4">{nextDriverStatus[1]}</button>
                  )}
                  {session?.user?.role === 'customer' && !terminalState && booking.status !== 'in_progress' && (
                    <button onClick={() => changeTripStatus('cancelled')} className="secondary-btn mt-4">Cancel trip</button>
                  )}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-bold text-slate-800">Shared live trip map</div>
                    <div className="text-xs text-slate-500">
                      {route ? `${route.distanceKm} km · ${route.durationMinutes} min estimate` : 'Loading route…'}
                    </div>
                  </div>
                  <RideMap
                    pickup={mapPickup}
                    destination={mapDestination}
                    driver={driverLocation}
                    routeGeometry={route?.geometry}
                  />
                  {routeError && <div className="mt-2 text-sm text-rose-700" role="alert">{routeError}</div>}
                  {booking.driver && <div className="mt-2 text-sm text-slate-600">Assigned to {booking.driver.name}{booking.driver.vehicle?.make ? ` · ${booking.driver.vehicle.make} ${booking.driver.vehicle.model || ''}` : ''}. Location is shared only with trip participants.</div>}
                  {driverLocation?.updatedAt && Date.now() - new Date(driverLocation.updatedAt).getTime() > 90_000 && (
                    <div className="mt-2 text-sm text-amber-700">Driver location is stale. Waiting for the next location update.</div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-bold uppercase tracking-[0.2em] text-slate-500">Driver</div>
                  <div className="mt-3 text-lg font-bold text-slate-900">{booking.driver?.name || 'Awaiting assignment'}</div>
                  <div className="mt-2 text-sm text-slate-600">Distance: {booking.driverDistanceKm ? `${booking.driverDistanceKm.toFixed(2)} km` : 'Not assigned yet'}</div>
                  {booking.driver?.vehicle && <div className="mt-2 text-sm text-slate-600">Vehicle: {booking.driver.vehicle.make} {booking.driver.vehicle.model || ''} {booking.driver.vehicle.color || ''}</div>}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-bold uppercase tracking-[0.2em] text-slate-500">Route</div>
                  <div className="mt-3 space-y-2 text-sm text-slate-600">
                    <div><span className="font-semibold text-slate-900">From:</span> {booking.pickup?.address}</div>
                    <div><span className="font-semibold text-slate-900">To:</span> {booking.destination?.address}</div>
                    <div><span className="font-semibold text-slate-900">Distance:</span> {route ? `${route.distanceKm} km (estimated driving route)` : 'Route estimate unavailable'}</div>
                    <div><span className="font-semibold text-slate-900">ETA:</span> {route ? `${route.durationMinutes} minutes (estimate)` : '—'}</div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function CustomerDashboard() {
  const session = getStoredSession();
  const token = session?.token;
  const navigate = useNavigate();
  const [form, setForm] = useState(() => ({
    pickup: 'Koramangala',
    destination: 'Bangalore Airport',
    serviceType: 'cab-driver',
    ...getDefaultTripSchedule(),
    durationMinutes: 35,
    paymentMethod: 'UPI'
  }));
  const [fare, setFare] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [bookingsError, setBookingsError] = useState('');
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState({ rating: '5', comment: '' });
  const [mapTarget, setMapTarget] = useState('pickup');
  const [places, setPlaces] = useState({
    pickup: { ...LOCATION_SUGGESTIONS[0] },
    destination: { ...LOCATION_SUGGESTIONS[1] }
  });
  const [route, setRoute] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [searchStatus, setSearchStatus] = useState('idle');
  const [searchError, setSearchError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState(false);
  const [nearbyDrivers, setNearbyDrivers] = useState([]);
  const [searchBooking, setSearchBooking] = useState(null);
  const socketRef = useRef(null);
  const searchTimerRef = useRef(null);

  const fetchBookings = async () => {
    try {
      const data = await api({ method: 'get', url: '/bookings', token });
      const records = data.bookings || [];
      setBookings(records);
      setBookingsError('');
      const current = records.find(booking => ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(booking.status));
      if (current) {
        setSearchBooking(current);
        setSearchStatus(current.status === 'searching' ? 'searching' : 'assigned');
      }
    } catch (error) {
      setBookingsError(apiErrorMessage(error, 'Could not load your recent trips.'));
    }
  };

  useEffect(() => {
    if (!token) return navigate('/auth');
    fetchBookings();
  }, [token, navigate]);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(async () => {
      if (!token || !places.pickup || !places.destination) {
        setRoute(null);
        setFare(null);
        return;
      }
      setRouteError('');
      try {
        const query = new URLSearchParams({
          originLat: String(places.pickup.lat),
          originLng: String(places.pickup.lng),
          destinationLat: String(places.destination.lat),
          destinationLng: String(places.destination.lng)
        });
        const routeData = await api({ url: `/routes?${query}`, token });
        if (cancelled) return;
        setRoute(routeData);
        const estimate = await api({
          method: 'post',
          url: '/bookings/estimate',
          data: {
            serviceType: form.serviceType,
            distanceKm: routeData.distanceKm,
            durationMinutes: routeData.durationMinutes,
            isNightRide: form.time >= '22:00' || form.time <= '05:00',
            isOutstation: false
          },
          token
        });
        if (!cancelled) setFare(estimate.fare);
      } catch (error) {
        if (cancelled) return;
        setRoute(null);
        setFare(null);
        setRouteError(apiErrorMessage(error, 'Could not calculate a road route. Please adjust the locations and retry.'));
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [token, places, form.serviceType, form.time]);

  useEffect(() => {
    if (!token) return undefined;
    const socket = io({ auth: { token } });
    socketRef.current = socket;
    socket.on('connect', () => {
      if (searchBooking?.id) socket.emit('booking:join', searchBooking.id);
    });
    const updateBooking = booking => {
      setSearchBooking(previous => previous?.id === booking.id ? { ...previous, ...booking } : previous);
      setBookings(previous => [booking, ...previous.filter(item => item.id !== booking.id)]);
      if (['driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed'].includes(booking.status)) {
        setSearchStatus('assigned');
        clearTimeout(searchTimerRef.current);
      } else if (booking.status === 'expired') {
        setSearchStatus('timed_out');
        setSearchError('The 1 km search timed out. You can try searching again.');
      } else if (booking.status === 'cancelled') {
        setSearchStatus('cancelled');
      }
    };
    socket.on('booking:state', updateBooking);
    socket.on('booking:update', updateBooking);
    socket.on('ride:assigned', updateBooking);
    socket.on('driver:location', event => {
      if (event.bookingId !== searchBooking?.id) return;
      setSearchBooking(previous => previous ? {
        ...previous,
        latestDriverLocation: event.location,
        latestDriverLocationAt: event.updatedAt
      } : previous);
    });
    socket.on('ride:expired', event => {
      if (event.bookingId === searchBooking?.id) {
        setSearchStatus('timed_out');
        setSearchError('No driver accepted before the search expired. You can try again.');
      }
    });
    socket.on('booking:error', event => setSearchError(event.error));
    socket.on('connect_error', () => setSearchError('Live updates are reconnecting. Trip state will refresh automatically.'));
    return () => {
      clearTimeout(searchTimerRef.current);
      if (searchBooking?.id) socket.emit('booking:leave', searchBooking.id);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, searchBooking?.id]);

  const updatePlaceText = (field, text) => {
    const match = LOCATION_SUGGESTIONS.find(place => place.name.toLowerCase() === text.trim().toLowerCase());
    setForm(previous => ({ ...previous, [field]: text }));
    setPlaces(previous => ({ ...previous, [field]: match ? { ...match } : null }));
  };

  const handleMapSelect = position => {
    const field = mapTarget;
    const selected = {
      name: `Map pin (${position.lat.toFixed(5)}, ${position.lng.toFixed(5)})`,
      lat: position.lat,
      lng: position.lng
    };
    setPlaces(previous => ({ ...previous, [field]: selected }));
    setForm(previous => ({ ...previous, [field]: selected.name }));
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setSearchError('This browser does not support location access.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const selected = { name: 'My current location', lat: coords.latitude, lng: coords.longitude };
        setPlaces(previous => ({ ...previous, pickup: selected }));
        setForm(previous => ({ ...previous, pickup: selected.name }));
        setSearchError('');
      },
      error => setSearchError(error.code === error.PERMISSION_DENIED
        ? 'Location permission was denied. Select a pickup place or allow location access.'
        : 'Could not read your current location. Select a pickup place or try again.'),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 }
    );
  };

  const handleSearchDrivers = async event => {
    event.preventDefault();
    if (!places.pickup || !places.destination || !route || !fare) {
      setSearchError('Choose valid pickup and destination places and wait for the road route and fare estimate.');
      return;
    }
    const scheduledAt = new Date(`${form.tripDate}T${form.time}:00`);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      setSearchError('Pickup time must be in the future. Choose a later time.');
      return;
    }
    setLoading(true);
    setSearchError('');
    setNearbyDrivers([]);
    setSearchStatus('searching');
    try {
      if (searchBooking?.id && ['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup'].includes(searchBooking.status)) {
        await api({ method: 'post', url: `/bookings/${searchBooking.id}/cancel`, token }).catch(() => null);
      }
      const result = await api({
        method: 'post',
        url: '/driver-search',
        data: {
          pickup: { lat: places.pickup.lat, lng: places.pickup.lng, address: form.pickup },
          destination: { lat: places.destination.lat, lng: places.destination.lng, address: form.destination },
          serviceType: form.serviceType,
          tripDate: form.tripDate,
          time: form.time,
          timezoneOffsetMinutes: new Date(`${form.tripDate}T${form.time}:00`).getTimezoneOffset(),
          paymentMethod: form.paymentMethod
        },
        token
      });
      setRoute(result.route);
      setFare(result.booking.fare);
      setSearchBooking(result.booking);
      setBookings(previous => [result.booking, ...previous.filter(item => item.id !== result.booking.id)]);
      setNearbyDrivers(result.nearbyDrivers || []);
      setSearchStatus(result.nearbyDrivers?.length ? 'searching' : 'none');
      socketRef.current?.emit('booking:join', result.booking.id);
      const remaining = Math.max(0, new Date(result.timeoutAt).getTime() - Date.now());
      searchTimerRef.current = setTimeout(() => {
        setSearchStatus(previous => previous === 'searching' ? 'timed_out' : previous);
        setSearchError('The nearby-driver search timed out. Retry to start a new search.');
      }, remaining);
      if (!result.nearbyDrivers?.length) {
        setSearchError('No eligible, recently located drivers are available within 1 km right now. Retry to search again.');
      }
    } catch (error) {
      setSearchStatus('error');
      setSearchError(apiErrorMessage(error, 'Could not search for nearby drivers. Check your connection and retry.'));
    } finally {
      setLoading(false);
    }
  };

  const cancelSearch = async () => {
    if (!searchBooking?.id) return;
    try {
      await api({ method: 'post', url: `/bookings/${searchBooking.id}/cancel`, token });
      setSearchStatus('cancelled');
      setSearchError('');
      clearTimeout(searchTimerRef.current);
    } catch (error) {
      setSearchError(apiErrorMessage(error, 'Could not cancel this search.'));
    }
  };

  const activeBooking = searchBooking || bookings.find(booking => ['pending', 'accepted', 'arrived', 'in_progress', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup'].includes(booking.status)) || bookings[0] || null;

  const handlePayment = async bookingId => {
    setActionMessage('');
    setActionError(false);
    try {
      const result = await api({
        method: 'post',
        url: `/bookings/${bookingId}/payment`,
        data: { method: activeBooking?.id === bookingId ? activeBooking.paymentMethod : 'UPI' },
        token
      });
      setSearchBooking(previous => previous?.id === bookingId
        ? { ...previous, paymentStatus: 'paid', paidAt: result.payment?.paidAt }
        : previous);
      await fetchBookings();
      setActionMessage('Payment recorded.');
    } catch (error) {
      setActionMessage(apiErrorMessage(error, 'Could not process the payment.'));
      setActionError(true);
    }
  };

  const handleReview = async e => {
    e.preventDefault();
    const bookingId = activeBooking?.id;
    if (!bookingId) return;
    setActionMessage('');
    setActionError(false);
    try {
      await api({
        method: 'post',
        url: `/bookings/${bookingId}/review`,
        data: { rating: Number(review.rating), comment: review.comment },
        token
      });
      setReview({ rating: '5', comment: '' });
      await fetchBookings();
      setActionMessage('Thanks for reviewing your trip.');
    } catch (error) {
      setActionMessage(apiErrorMessage(error, 'Could not submit your review.'));
      setActionError(true);
    }
  };

  const handleEmergencyReport = async () => {
    if (!activeBooking) return;
    setActionMessage('');
    setActionError(false);
    try {
      await api({
        method: 'post',
        url: '/emergencies',
        data: {
          bookingId: activeBooking.id,
          reason: 'Safety concern reported by rider'
        },
        token
      });
      setActionMessage('Safety support has been notified.');
    } catch (error) {
      setActionMessage(apiErrorMessage(error, 'Could not send the safety alert.'));
      setActionError(true);
    }
  };

  return (
    <AppShell user={session?.user} onLogout={() => { saveSession(null); navigate('/auth'); }}>
      <div className="grid gap-6 xl:grid-cols-[1fr_0.8fr]">
        <div className="card-surface p-6">
          <div className="mb-4 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Book now</div>
          <h2 className="text-3xl font-black tracking-tight text-slate-950">Plan your next trip</h2>

          <form onSubmit={handleSearchDrivers} className="mt-6 space-y-5">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="trip-route-heading">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">1</span>
                <div>
                  <h3 id="trip-route-heading" className="font-bold text-slate-900">Choose your route</h3>
                  <p className="text-xs text-slate-500">Select suggested places or drop pins on the map below.</p>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="booking-pickup" className="text-sm font-medium text-slate-700">Pickup location</label>
                  <input
                    id="booking-pickup"
                    list="location-suggestions"
                    value={form.pickup}
                    onChange={e => updatePlaceText('pickup', e.target.value)}
                    className="input-shell"
                    autoComplete="off"
                    required
                  />
                  <button type="button" onClick={useCurrentLocation} className="mt-2 text-sm font-semibold text-emerald-700 hover:text-emerald-900">Use my current location</button>
                </div>
                <div>
                  <label htmlFor="booking-destination" className="text-sm font-medium text-slate-700">Destination</label>
                  <input
                    id="booking-destination"
                    list="location-suggestions"
                    value={form.destination}
                    onChange={e => updatePlaceText('destination', e.target.value)}
                    className="input-shell"
                    autoComplete="off"
                    required
                  />
                </div>
              </div>
              <datalist id="location-suggestions">
                {LOCATION_SUGGESTIONS.map(place => (
                  <option key={place.name} value={place.name} />
                ))}
              </datalist>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="trip-details-heading">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">2</span>
                <div>
                  <h3 id="trip-details-heading" className="font-bold text-slate-900">Trip details</h3>
                  <p className="text-xs text-slate-500">Set your pickup time and choose the service and payment method.</p>
                </div>
              </div>
              <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="booking-service" className="text-sm font-medium text-slate-700">Service</label>
                  <select id="booking-service" value={form.serviceType} onChange={e => setForm({ ...form, serviceType: e.target.value })} className="input-shell">
                    <option value="cab-driver">Cab + driver</option>
                    <option value="personal-driver">Personal driver</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="booking-payment" className="text-sm font-medium text-slate-700">Payment method</label>
                  <select id="booking-payment" value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value })} className="input-shell">
                    <option value="UPI">UPI</option>
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="booking-date" className="text-sm font-medium text-slate-700">Trip date</label>
                  <input id="booking-date" type="date" min={getDefaultTripSchedule().tripDate} value={form.tripDate} onChange={e => setForm({ ...form, tripDate: e.target.value })} className="input-shell" required />
                </div>
                <div>
                  <label htmlFor="booking-time" className="text-sm font-medium text-slate-700">Pickup time</label>
                  <input id="booking-time" type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="input-shell" required />
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5" aria-labelledby="route-map-heading">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">3</span>
                  <div>
                    <h3 id="route-map-heading" className="font-bold text-slate-900">Review route and fare</h3>
                    <p className="text-xs text-slate-500">Road distance, travel time and fare are estimates.</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setMapTarget('pickup')} aria-pressed={mapTarget === 'pickup'} className={`rounded-full px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${mapTarget === 'pickup' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600'}`}>
                    Set pickup pin
                  </button>
                  <button type="button" onClick={() => setMapTarget('destination')} aria-pressed={mapTarget === 'destination'} className={`rounded-full px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${mapTarget === 'destination' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600'}`}>
                    Set destination pin
                  </button>
                </div>
              </div>
              <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Estimated fare</div>
                  <div className="mt-1 text-3xl font-black text-slate-950">{fare == null ? '—' : `₹${fare}`}</div>
                </div>
                <div className="text-right text-sm text-slate-600">
                  <div>{route ? `${route.distanceKm} km` : 'Route unavailable'}</div>
                  <div>{route ? `${route.durationMinutes} min estimated` : '—'}</div>
                </div>
              </div>
              <RideMap
                pickup={places.pickup}
                destination={places.destination}
                routeGeometry={route?.geometry}
                nearbyDrivers={nearbyDrivers}
                scanning={searchStatus === 'searching'}
                onMapSelect={handleMapSelect}
              />
              {routeError && <p className="mt-3 text-sm text-rose-700" role="alert">{routeError}</p>}
              <p className="mt-2 text-xs text-slate-500">Click the map to place the selected pickup or destination pin.</p>
            </section>

            <div>
              <button
                type="submit"
                disabled={loading || !route || fare == null || !places.pickup || !places.destination || searchStatus === 'searching' ||
                  ['driver_assigned', 'driver_en_route', 'arrived_at_pickup', 'in_progress'].includes(activeBooking?.status)}
                className="primary-btn w-full disabled:opacity-60"
              >
                {loading || searchStatus === 'searching' ? 'Finding nearby drivers...' : 'Find drivers within 1 km'}
              </button>
              {searchStatus === 'searching' && (
                <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800" role="status" aria-live="polite">
                  <span className="flex items-center gap-2"><span className="search-spinner" aria-hidden="true" />Finding nearby drivers within exactly 1 km…</span>
                  <button type="button" onClick={cancelSearch} className="font-semibold underline">Cancel search</button>
                </div>
              )}
              {searchStatus === 'none' && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                  No eligible drivers were found within 1 km. Retry now or adjust your pickup point. The map scan is only a visual search indicator.
                </div>
              )}
              {searchError && <p className="mt-3 text-sm text-rose-700" role="alert">{searchError}</p>}
            </div>
          </form>
        </div>

        <div className="space-y-6">
          {activeBooking && (
            <div className="card-surface p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-xl font-black text-slate-950">Trip status</h3>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">{activeBooking.status}</span>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-lg font-bold text-slate-900">{activeBooking.pickup.address} → {activeBooking.destination.address}</div>
                <div className="mt-2 text-sm text-slate-600">Driver: {activeBooking.driver ? activeBooking.driver.name : 'Awaiting assignment'} • Fare: ₹{activeBooking.fare}</div>
              </div>
              {searchBooking && (
                <>
                  <div className="mt-4">
                    <RideMap
                      pickup={activeBooking.pickup}
                      destination={activeBooking.destination}
                      driver={activeBooking.latestDriverLocation}
                      nearbyDrivers={searchStatus === 'searching' || searchStatus === 'none' ? nearbyDrivers : []}
                      routeGeometry={route?.geometry}
                      scanning={searchStatus === 'searching'}
                    />
                    <div className="mt-2 text-xs text-slate-500">
                      {route ? `Driving estimate: ${route.distanceKm} km · ${route.durationMinutes} min. ` : ''}
                      {activeBooking.latestDriverLocationAt
                        ? `Driver location updated ${new Date(activeBooking.latestDriverLocationAt).toLocaleTimeString()}.`
                        : 'Driver location is shared after assignment.'}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link to={`/booking/${activeBooking.id}`} className="secondary-btn">Open live trip</Link>
                    {['searching', 'driver_assigned', 'driver_en_route', 'arrived_at_pickup'].includes(activeBooking.status) && (
                      <button onClick={cancelSearch} className="secondary-btn">Cancel trip</button>
                    )}
                  </div>
                </>
              )}

              {activeBooking.status === 'completed' && (
                <div className="mt-4 space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  {actionMessage && <div className={`text-sm font-medium ${actionError ? 'text-rose-700' : 'text-emerald-800'}`} role={actionError ? 'alert' : 'status'}>{actionMessage}</div>}
                  <p className="text-xs text-emerald-900">Prototype only: this records a demo payment state and does not charge a payment method.</p>
                  <div className="flex flex-wrap gap-3">
                    {activeBooking.paymentStatus === 'paid'
                      ? <span className="rounded-xl bg-emerald-100 px-4 py-2 text-sm font-bold text-emerald-800">Paid</span>
                      : <button onClick={() => handlePayment(activeBooking.id)} className="primary-btn">Record demo payment</button>}
                    <button onClick={handleEmergencyReport} className="secondary-btn">Report emergency</button>
                  </div>
                  <form onSubmit={handleReview} className="grid gap-3 md:grid-cols-[140px_1fr_auto]">
                    <select value={review.rating} onChange={e => setReview({ ...review, rating: e.target.value })} className="input-shell">
                      {[5,4,3,2,1].map(value => <option key={value} value={value}>{value} star{value !== 1 ? 's' : ''}</option>)}
                    </select>
                    <input value={review.comment} onChange={e => setReview({ ...review, comment: e.target.value })} className="input-shell" placeholder="Tell us about your trip" />
                    <button type="submit" className="secondary-btn">Submit review</button>
                  </form>
                </div>
              )}

              {activeBooking.status !== 'completed' && (
                <div className="mt-4">
                  {actionMessage && <div className={`mb-3 text-sm font-medium ${actionError ? 'text-rose-700' : 'text-emerald-800'}`} role={actionError ? 'alert' : 'status'}>{actionMessage}</div>}
                  <button onClick={handleEmergencyReport} className="secondary-btn">Report emergency</button>
                </div>
              )}
            </div>
          )}

          <div id="booking-history" className="card-surface p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xl font-black text-slate-950">Recent trips</h3>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{bookings.length} total</span>
            </div>

            <div className="space-y-3">
              {bookingsError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
                  {bookingsError}
                  <button onClick={fetchBookings} className="ml-3 font-semibold underline">Retry</button>
                </div>
              ) : bookings.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No bookings yet. Create your first trip.</div>
              ) : (
                bookings.slice(0, 5).map(booking => (
                  <div key={booking.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-slate-900">{booking.serviceType}</div>
                        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{booking.status}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-black text-slate-950">₹{booking.fare}</div>
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{booking.paymentMethod}</div>
                      </div>
                    </div>
                    <div className="mt-3 text-sm text-slate-600">{booking.pickup.address} → {booking.destination.address}</div>
                    <div className="mt-3 flex gap-2">
                      <Link to={`/booking/${booking.id}`} className="secondary-btn">View details</Link>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function DriverDashboard() {
  const session = getStoredSession();
  const token = session?.token;
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [requests, setRequests] = useState([]);
  const [tripList, setTripList] = useState([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [socketReady, setSocketReady] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');
  const [dashboardError, setDashboardError] = useState('');
  const [profileLoading, setProfileLoading] = useState(true);
  const [serviceTypes, setServiceTypes] = useState(['cab-driver']);
  const [form, setForm] = useState({
    make: '',
    model: '',
    plate: '',
    license: '',
    identity: '',
    insurance: '',
    phone: session?.user?.phone || ''
  });

  const refresh = async () => {
    if (!token) return;
    try {
      let profileData;
      try {
        profileData = await api({ method: 'get', url: '/drivers/me', token });
      } catch (error) {
        if (error.response?.status !== 404) throw error;
        profileData = { driver: null };
      }
      if (!profileData.driver) {
        setProfile(null);
        setRequests([]);
        setTripList([]);
        setDashboardError('');
        return;
      }
      const requestsPromise = profileData.driver.verificationStatus === 'verified' &&
        profileData.driver.status === 'available'
        ? api({ method: 'get', url: '/driver/requests', token })
        : Promise.resolve({ requests: [] });
      const [requestsData, bookingsData] = await Promise.all([
        requestsPromise,
        api({ method: 'get', url: '/bookings', token })
      ]);
      setProfile(profileData?.driver || null);
      if (profileData.driver.serviceTypes?.length) setServiceTypes(profileData.driver.serviceTypes);
      setRequests(requestsData.requests || []);
      setTripList(bookingsData.bookings || []);
      setDashboardError('');
    } catch (error) {
      setDashboardError(apiErrorMessage(error, 'Could not load your driver dashboard.'));
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return navigate('/auth');
    refresh();
  }, [token, navigate]);

  useEffect(() => {
    if (!token) return undefined;
    const socket = io({ auth: { token } });
    socket.on('connect', () => setSocketReady(true));
    socket.on('disconnect', () => setSocketReady(false));
    socket.on('ride:request', refresh);
    socket.on('booking:update', refresh);
    socket.on('ride:request-closed', refresh);
    const poll = setInterval(refresh, 15_000);
    return () => {
      clearInterval(poll);
      socket.disconnect();
      setSocketReady(false);
    };
  }, [token]);

  useEffect(() => {
    if (!token || !['available', 'on_trip'].includes(profile?.status) || !socketReady) return undefined;
    let active = true;
    const publishLocation = () => {
      if (!navigator.geolocation) {
        setLocationMessage('This browser does not provide location updates. You are being taken offline.');
        api({ method: 'patch', url: '/drivers/availability', data: { status: 'offline' }, token })
          .finally(refresh);
        return;
      }
      navigator.geolocation.getCurrentPosition(async ({ coords, timestamp }) => {
        if (!active) return;
        try {
          await api({
            method: 'post',
            url: '/driver-location',
            data: { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy, timestamp },
            token
          });
          setLocationMessage('');
        } catch (error) {
          setLocationMessage(apiErrorMessage(error, 'Location update failed.'));
        }
      }, async () => {
        if (!active) return;
        setLocationMessage('Location permission is unavailable. You are being taken offline.');
        await api({ method: 'patch', url: '/drivers/availability', data: { status: 'offline' }, token }).catch(() => null);
        await refresh();
      }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
    };
    const interval = setInterval(publishLocation, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [token, profile?.status, socketReady]);

  const handleStatusChange = async nextStatus => {
    if (!token || !profile) return;
    setStatusLoading(true);
    try {
      if (nextStatus === 'offline') {
        await api({ method: 'patch', url: '/drivers/availability', data: { status: 'offline' }, token });
        setLocationMessage('');
        await refresh();
        return;
      }
      if (!navigator.geolocation) throw new Error('This browser does not support location access.');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 0
      }));
      await api({
        method: 'patch',
        url: '/drivers/availability',
        data: {
          status: 'available',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
          serviceTypes
        },
        token
      });
      setLocationMessage('');
      await refresh();
    } catch (error) {
      setLocationMessage(apiErrorMessage(error, error.message || 'Could not update availability.'));
    } finally {
      setStatusLoading(false);
    }
  };

  const handleRegister = async e => {
    e.preventDefault();
    setRegistering(true);
    setDashboardError('');
    try {
      await api({
        method: 'post',
        url: '/drivers/register',
        data: {
          phone: form.phone,
          vehicle: { make: form.make, model: form.model, plate: form.plate },
          documents: { license: form.license, identity: form.identity, insurance: form.insurance },
          serviceTypes
        },
        token
      });
      await refresh();
    } catch (error) {
      setDashboardError(apiErrorMessage(error, 'Could not submit your driver profile.'));
    } finally {
      setRegistering(false);
    }
  };

  const acceptBooking = async bookingId => {
    try {
      await api({ method: 'post', url: `/bookings/${bookingId}/accept`, token });
      await refresh();
    } catch (error) {
      setLocationMessage(apiErrorMessage(error, 'Could not accept this request.'));
      await refresh();
    }
  };

  const handleBookingStatusUpdate = async (bookingId, nextStatus) => {
    try {
      await api({ method: 'post', url: `/bookings/${bookingId}/status`, data: { status: nextStatus }, token });
      await refresh();
    } catch (error) {
      setLocationMessage(apiErrorMessage(error, 'Could not update trip status.'));
    }
  };

  const rejectBooking = async bookingId => {
    try {
      await api({ method: 'post', url: `/bookings/${bookingId}/reject`, token });
      await refresh();
    } catch (error) {
      setLocationMessage(apiErrorMessage(error, 'Could not reject this request.'));
    }
  };

  const handleDriverEmergencyReport = async bookingId => {
    try {
      await api({
        method: 'post',
        url: '/emergencies',
        data: {
          bookingId,
          reason: 'Safety concern reported by driver',
          ...(profile?.location ? { location: profile.location } : {})
        },
        token
      });
      setLocationMessage('Safety support has been notified.');
    } catch (error) {
      setLocationMessage(apiErrorMessage(error, 'Could not send the safety alert.'));
    }
  };

  const isVerified = profile?.verificationStatus === 'verified';
  const availabilityLabel = profile?.status === 'available' ? 'Online' : profile?.status === 'on_trip' ? 'On trip' : 'Offline';
  const handleLogout = () => {
    if (['available', 'on_trip'].includes(profile?.status)) {
      api({ method: 'patch', url: '/drivers/availability', data: { status: 'offline' }, token }).catch(() => null);
    }
    saveSession(null);
    navigate('/auth');
  };

  return (
    <AppShell user={session?.user} onLogout={handleLogout}>
      {dashboardError && profile && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">
          {dashboardError}
          <button onClick={refresh} className="ml-3 font-semibold underline">Retry</button>
        </div>
      )}
      {profileLoading && !profile ? (
        <div className="card-surface p-6 text-sm text-slate-600" role="status">Loading driver profile…</div>
      ) : dashboardError && !profile ? (
        <div className="card-surface max-w-2xl p-6">
          <div className="text-sm text-rose-700" role="alert">{dashboardError}</div>
          <button onClick={refresh} className="primary-btn mt-4">Retry</button>
        </div>
      ) : profile ? (
        <>
          <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
            <div className="card-surface p-6">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Driver status</div>
                  <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">{availabilityLabel}</h2>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${profile.verificationStatus === 'verified' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {profile.verificationStatus}
                </span>
              </div>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    disabled={statusLoading || !isVerified || profile.status === 'on_trip'}
                    onClick={() => handleStatusChange(profile.status === 'available' ? 'offline' : 'available')}
                    className="primary-btn disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {statusLoading ? 'Updating...' : profile.status === 'on_trip' ? 'On trip' : profile.status === 'available' ? 'Go offline' : 'Go online'}
                  </button>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Services you accept</div>
                    {['cab-driver', 'personal-driver'].map(service => (
                      <label key={service} className="mr-3 inline-flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          disabled={profile.status !== 'offline'}
                          checked={serviceTypes.includes(service)}
                          onChange={event => setServiceTypes(previous => event.target.checked
                            ? [...new Set([...previous, service])]
                            : previous.filter(item => item !== service))}
                        />
                        {service === 'cab-driver' ? 'Cab + driver' : 'Personal driver'}
                      </label>
                    ))}
                    {profile.status !== 'offline' && (
                      <div className="mt-2 text-xs text-slate-500">Go offline before changing your accepted services.</div>
                    )}
                  </div>
                </div>

                {locationMessage && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">{locationMessage}</div>}
                {profile.status === 'available' && (
                  <div className="text-xs text-slate-500" role="status">
                    Location is sent only while you are online and connected. Latest fix: {profile.locationUpdatedAt ? new Date(profile.locationUpdatedAt).toLocaleTimeString() : 'waiting for a fresh GPS fix'}.
                  </div>
                )}
                {!isVerified && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Your driver profile is pending admin approval. Once approved, you can go online and receive requests.
                  </div>
                )}
              </div>
            </div>

            <div className="card-surface p-6">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Profile</div>
              <h3 className="mt-2 text-2xl font-black text-slate-950">{profile.name}</h3>
              <div className="mt-5 space-y-3 text-sm text-slate-600">
                <div>Vehicle: {profile.vehicle?.make || '—'} {profile.vehicle?.model || ''}</div>
                <div>Plate: {profile.vehicle?.plate || '—'}</div>
                <div>Rating: {profile.rating || 0} / 5 ({profile.ratingCount || 0} reviews)</div>
                <div>Phone: {profile.phone || session?.user?.phone || '—'}</div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="card-surface max-w-2xl p-6">
          <div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Become a driver</div>
          <h2 className="text-3xl font-black tracking-tight text-slate-950">Register your profile</h2>
          <form onSubmit={handleRegister} className="mt-6 space-y-5">
            <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="driver-vehicle-heading">
              <h3 id="driver-vehicle-heading" className="font-bold text-slate-900">Vehicle details</h3>
              <p className="mt-1 text-xs text-slate-500">Tell customers which vehicle you provide.</p>
              <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="driver-vehicle-make" className="text-sm font-medium text-slate-700">Vehicle make</label>
                  <input id="driver-vehicle-make" value={form.make} onChange={e => setForm({ ...form, make: e.target.value })} className="input-shell" placeholder="Honda" autoComplete="organization" required />
                </div>
                <div>
                  <label htmlFor="driver-vehicle-model" className="text-sm font-medium text-slate-700">Vehicle model</label>
                  <input id="driver-vehicle-model" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} className="input-shell" placeholder="City" required />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="driver-vehicle-plate" className="text-sm font-medium text-slate-700">Plate number</label>
                  <input id="driver-vehicle-plate" value={form.plate} onChange={e => setForm({ ...form, plate: e.target.value })} className="input-shell" placeholder="KA 03 AB 1234" autoComplete="off" required />
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="driver-contact-heading">
              <h3 id="driver-contact-heading" className="font-bold text-slate-900">Contact and verification</h3>
              <p className="mt-1 text-xs text-slate-500">Your submitted information is used for account verification.</p>
              <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="driver-phone" className="text-sm font-medium text-slate-700">Phone</label>
                  <input id="driver-phone" type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="input-shell" placeholder="+91 98xxx xxxxx" autoComplete="tel" required />
                </div>
                <div>
                  <label htmlFor="driver-license" className="text-sm font-medium text-slate-700">License ID</label>
                  <input id="driver-license" value={form.license} onChange={e => setForm({ ...form, license: e.target.value })} className="input-shell" placeholder="DL-KA-2021-12345" autoComplete="off" required />
                </div>
                <div>
                  <label htmlFor="driver-identity" className="text-sm font-medium text-slate-700">Identity ID</label>
                  <input id="driver-identity" value={form.identity} onChange={e => setForm({ ...form, identity: e.target.value })} className="input-shell" placeholder="AADHAAR-XXXX-1234" autoComplete="off" required />
                </div>
                <div>
                  <label htmlFor="driver-insurance" className="text-sm font-medium text-slate-700">Insurance number</label>
                  <input id="driver-insurance" value={form.insurance} onChange={e => setForm({ ...form, insurance: e.target.value })} className="input-shell" placeholder="INS-2026-8831" autoComplete="off" required />
                </div>
              </div>
            </section>

            <fieldset className="rounded-2xl border border-slate-200 bg-white p-4">
              <legend className="px-1 text-sm font-bold text-slate-900">Services you provide</legend>
              <p className="text-xs text-slate-500">Select every service you’re eligible to accept.</p>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                {['cab-driver', 'personal-driver'].map(service => (
                  <label key={service} className="inline-flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={serviceTypes.includes(service)}
                      onChange={event => setServiceTypes(previous => event.target.checked
                        ? [...new Set([...previous, service])]
                        : previous.filter(item => item !== service))}
                    />
                    {service === 'cab-driver' ? 'Cab + driver' : 'Personal driver'}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" disabled={registering} className="primary-btn w-full disabled:opacity-70">
              {registering ? 'Submitting...' : 'Submit for verification'}
            </button>
          </form>
        </div>
      )}

      {profile && (
        <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="card-surface p-6">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Ride queue</div>
                <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Available requests</h2>
              </div>
              <button onClick={refresh} className="secondary-btn">Refresh</button>
            </div>

            <div className="space-y-4">
              {requests.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No nearby bookings right now. Keep your status online.</div>
              ) : (
                requests.map(booking => (
                  <div key={booking.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-lg font-bold text-slate-900">{booking.pickup.address}</div>
                        <div className="mt-1 text-sm text-slate-600">→ {booking.destination.address}</div>
                        <div className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-500">{booking.serviceType} • {booking.distanceKm || 0} km away</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xl font-black text-slate-950">₹{booking.fare}</div>
                        <button onClick={() => acceptBooking(booking.id)} className="mt-3 primary-btn">Accept</button>
                        <button onClick={() => rejectBooking(booking.id)} className="mt-2 secondary-btn">Reject</button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div id="driver-trips" className="card-surface p-6">
            <div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-600">Trip board</div>
            <h3 className="text-2xl font-black text-slate-950">Assigned trips</h3>
            <div className="mt-5 space-y-3">
              {tripList.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No active trips assigned yet.</div>
              ) : (
                tripList.slice(0, 5).map(booking => (
                  <div key={booking.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-slate-900">{booking.status}</span>
                      <span className="text-xs uppercase tracking-[0.18em] text-slate-500">₹{booking.fare}</span>
                    </div>
                    <div className="mt-2 text-sm text-slate-600">{booking.pickup.address} → {booking.destination.address}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link to={`/booking/${booking.id}`} className="secondary-btn">View details</Link>
                      {booking.status !== 'completed' && booking.status !== 'cancelled' && (
                        <>
                          {booking.status === 'driver_assigned' && <button onClick={() => handleBookingStatusUpdate(booking.id, 'driver_en_route')} className="secondary-btn">Start to pickup</button>}
                          {booking.status === 'driver_en_route' && <button onClick={() => handleBookingStatusUpdate(booking.id, 'arrived_at_pickup')} className="secondary-btn">Mark arrived</button>}
                          {booking.status === 'arrived_at_pickup' && <button onClick={() => handleBookingStatusUpdate(booking.id, 'in_progress')} className="secondary-btn">Start trip</button>}
                          {booking.status === 'in_progress' && <button onClick={() => handleBookingStatusUpdate(booking.id, 'completed')} className="primary-btn">Complete trip</button>}
                          <button onClick={() => handleDriverEmergencyReport(booking.id)} className="secondary-btn">Emergency</button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function AdminDashboard() {
  const session = getStoredSession();
  const token = session?.token;
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState({ metrics: {}, pendingDrivers: [], recentBookings: [], emergencyAlerts: [] });
  const [dashboardError, setDashboardError] = useState('');

  const load = async () => {
    try {
      const data = await api({ method: 'get', url: '/admin/dashboard', token });
      setDashboard(data);
      setDashboardError('');
    } catch (error) {
      setDashboardError(apiErrorMessage(error, 'Could not load the admin dashboard.'));
    }
  };

  useEffect(() => {
    if (!token) return navigate('/auth');
    load();
  }, [token, navigate]);

  const verifyDriver = async (driverId, approved = true) => {
    try {
      await api({ method: 'patch', url: `/admin/drivers/${driverId}/verify`, data: { approved }, token });
      await load();
    } catch (error) {
      setDashboardError(apiErrorMessage(error, 'Could not update driver verification.'));
    }
  };

  return (
    <AppShell user={session?.user} onLogout={() => { saveSession(null); navigate('/auth'); }}>
      {dashboardError && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">
          {dashboardError}
          <button onClick={load} className="ml-3 font-semibold underline">Retry</button>
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-4">
        {[
          ['Users', dashboard.metrics.users || 0],
          ['Drivers', dashboard.metrics.drivers || 0],
          ['Verified', dashboard.metrics.verifiedDrivers || 0],
          ['Revenue', `₹${dashboard.metrics.revenue || 0}`]
        ].map(([label, value]) => (
          <div key={label} className="card-surface p-5">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</div>
            <div className="mt-3 text-3xl font-black text-slate-950">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="card-surface p-6">
          <h3 className="text-2xl font-black text-slate-950">Pending driver verification</h3>
          <div className="mt-5 space-y-4">
            {dashboard.pendingDrivers?.length ? dashboard.pendingDrivers.map(driver => (
              <div key={driver.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-bold text-slate-900">{driver.name}</div>
                    <div className="text-sm text-slate-600">{driver.vehicle?.make} • {driver.vehicle?.plate}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => verifyDriver(driver.id, true)} className="primary-btn">Approve</button>
                    <button onClick={() => verifyDriver(driver.id, false)} className="secondary-btn">Reject</button>
                  </div>
                </div>
              </div>
            )) : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No pending driver applications.</div>}
          </div>
        </div>

        <div className="card-surface p-6">
          <h3 className="text-2xl font-black text-slate-950">Emergency alerts</h3>
          <div className="mt-5 space-y-3">
            {dashboard.emergencyAlerts?.length ? dashboard.emergencyAlerts.slice(0, 5).map(alert => (
              <div key={alert.id} className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-bold text-rose-700">{alert.status}</span>
                  <span className="text-xs uppercase tracking-[0.18em] text-rose-500">{alert.reason}</span>
                </div>
                <div className="mt-2 text-sm text-slate-700">{alert.location ? `${alert.location.lat}, ${alert.location.lng}` : 'Location unavailable'}</div>
              </div>
            )) : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No active emergency alerts.</div>}
          </div>
        </div>

        <div className="card-surface p-6 xl:col-span-2">
          <h3 className="text-2xl font-black text-slate-950">Recent bookings</h3>
          <div className="mt-5 space-y-3">
            {dashboard.recentBookings?.length ? dashboard.recentBookings.slice(0, 5).map(booking => (
              <div key={booking.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-bold text-slate-900">{booking.serviceType}</span>
                  <span className="text-slate-500">{booking.status}</span>
                </div>
                <div className="mt-2 text-sm text-slate-600">{booking.pickup?.address || 'Pickup'} → {booking.destination?.address || 'Destination'}</div>
                <div className="mt-3"><Link to={`/booking/${booking.id}`} className="secondary-btn">View details</Link></div>
              </div>
            )) : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">No bookings found.</div>}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/customer" element={<ProtectedRoute role="customer"><CustomerDashboard /></ProtectedRoute>} />
      <Route path="/driver" element={<ProtectedRoute role="driver"><DriverDashboard /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute role="admin"><AdminDashboard /></ProtectedRoute>} />
      <Route path="/booking/:id" element={<ProtectedRoute><BookingDetailPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
