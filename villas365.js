'use strict';

/**
 * 365Villas / GuestWisely PMS adapter.
 *
 * The PMS exposes ONE action-dispatched endpoint:
 *   POST https://secure.365villas.com/vros/external-booking/
 *   body: { key, pass, action, ...params }   -> JSON { status, message, data }
 *
 * Auth is stateless: every request carries `key` + `pass` (account-scoped).
 *
 * IMPORTANT — fields behind the gated API doc:
 * The exact ACTION names and PARAM names for "look up a booking by reference"
 * and the guest/villa field names are documented on the account's gated
 * "API & Integrations" page. They are ALL configurable via env vars below so
 * you can correct them in 60 seconds without touching code. The defaults are
 * best-effort from the public docs. See README "Confirming the API mapping".
 *
 * Until real credentials are set, run with V365_MOCK=1 to use sample data.
 */

const CFG = {
  baseUrl: process.env.V365_BASE_URL || 'https://secure.365villas.com/vros/external-booking/',
  key: process.env.V365_KEY || '',
  pass: process.env.V365_PASS || '',
  ownerToken: process.env.V365_OWNER_TOKEN || '',
  username: process.env.V365_USERNAME || '',
  mock: String(process.env.V365_MOCK || '') === '1',

  // --- Action names (confirm on the gated API page; override via env) ---
  actionBookingInfo: process.env.V365_ACTION_BOOKING_INFO || 'getbooking',
  actionPropertyInfo: process.env.V365_ACTION_PROPERTY_INFO || 'getinfo',
  actionPropertyPhotos: process.env.V365_ACTION_PROPERTY_PHOTOS || 'getphoto',

  // --- Param names ---
  paramReference: process.env.V365_PARAM_REFERENCE || 'bookingId',
  paramPropertyId: process.env.V365_PARAM_PROPERTY_ID || 'propertyId',

  // --- Response field names (dot paths into the `data` object) ---
  fieldGuestFirst: process.env.V365_FIELD_GUEST_FIRST || 'firstName',
  fieldGuestLast: process.env.V365_FIELD_GUEST_LAST || 'lastName',
  fieldGuestEmail: process.env.V365_FIELD_GUEST_EMAIL || 'email',
  fieldGuestPhone: process.env.V365_FIELD_GUEST_PHONE || 'phone',
  fieldCheckin: process.env.V365_FIELD_CHECKIN || 'checkin',
  fieldCheckout: process.env.V365_FIELD_CHECKOUT || 'checkout',
  fieldAdults: process.env.V365_FIELD_ADULTS || 'numberofadults',
  fieldChildren: process.env.V365_FIELD_CHILDREN || 'numberofchildren',
  fieldPropertyId: process.env.V365_FIELD_PROPERTY_ID || 'propertyId',
  fieldPropertyName: process.env.V365_FIELD_PROPERTY_NAME || 'propertyName',
  fieldStatus: process.env.V365_FIELD_STATUS || 'status',

  timeoutMs: Number(process.env.V365_TIMEOUT_MS || 12000),
};

function isConfigured() {
  return !!(CFG.mock || (CFG.key && CFG.pass));
}

function get(obj, path, dflt) {
  if (!obj) return dflt;
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  return v == null ? dflt : v;
}

async function callApi(action, params = {}) {
  if (CFG.mock) throw new Error('callApi must not be reached in mock mode');
  const body = {
    key: CFG.key,
    pass: CFG.pass,
    owner_token: CFG.ownerToken || undefined,
    username: CFG.username || undefined,
    action,
    format: 'json',
    ...params,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  let res;
  try {
    res = await fetch(CFG.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`365Villas returned non-JSON for action "${action}" (HTTP ${res.status}). First 120 chars: ${text.slice(0, 120)}`);
  }
  // PMS wraps payload as { status, message, data }. status may be "1"/"success"/true.
  const ok = json && (json.status === 1 || json.status === '1' || json.status === true || /^(ok|success|true)$/i.test(String(json.status)));
  if (!ok) {
    const msg = (json && (json.message || json.error)) || 'unknown error';
    const err = new Error(`365Villas action "${action}" failed: ${msg}`);
    err.apiMessage = msg;
    throw err;
  }
  return json.data != null ? json.data : json;
}

/** Fetch a single booking by its reference/confirmation code. */
async function getBookingByReference(reference) {
  return callApi(CFG.actionBookingInfo, { [CFG.paramReference]: reference });
}

/** Fetch property details (name, description, location, amenities, etc.). */
async function getProperty(propertyId) {
  return callApi(CFG.actionPropertyInfo, { [CFG.paramPropertyId]: propertyId });
}

/** Fetch property photo gallery. Returns whatever the PMS returns (array/obj). */
async function getPropertyPhotos(propertyId) {
  try {
    return await callApi(CFG.actionPropertyPhotos, { [CFG.paramPropertyId]: propertyId });
  } catch (e) {
    return null; // photos are non-fatal
  }
}

function nightsBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

/**
 * Normalize raw PMS data into the canonical "stay" object the frontend renders.
 * Anything the PMS doesn't return falls back to safe defaults, so the app never
 * breaks even if a field name needs confirming.
 */
function buildStay(bookingRaw, propertyRaw, photosRaw) {
  const firstName = get(bookingRaw, CFG.fieldGuestFirst, '');
  const lastName = get(bookingRaw, CFG.fieldGuestLast, '');
  const arrive = get(bookingRaw, CFG.fieldCheckin, null);
  const depart = get(bookingRaw, CFG.fieldCheckout, null);
  const propertyId = get(bookingRaw, CFG.fieldPropertyId, get(propertyRaw, 'propertyId', null));

  // Photos can come back many shapes; coerce to an array of URLs.
  let gallery = [];
  if (Array.isArray(photosRaw)) gallery = photosRaw.map(p => (typeof p === 'string' ? p : (p.url || p.src || p.image || p.photo))).filter(Boolean);
  else if (photosRaw && Array.isArray(photosRaw.photos)) gallery = photosRaw.photos.map(p => p.url || p.src || p).filter(Boolean);

  const villaName = get(bookingRaw, CFG.fieldPropertyName, get(propertyRaw, CFG.fieldPropertyName, 'Your villa'));

  return {
    source: 'live',
    guest: {
      firstName,
      lastName,
      family: lastName || firstName || 'Guest',
      email: get(bookingRaw, CFG.fieldGuestEmail, ''),
      phone: get(bookingRaw, CFG.fieldGuestPhone, ''),
    },
    booking: {
      reference: get(bookingRaw, CFG.paramReference, get(bookingRaw, 'bookingId', '')),
      status: get(bookingRaw, CFG.fieldStatus, 'Published'),
      arrive,
      depart,
      nights: nightsBetween(arrive, depart),
      arriveTime: get(bookingRaw, 'checkinTime', '15:00'),
      checkInTime: get(propertyRaw, 'checkInTime', '3:00 PM'),
      checkOutTime: get(propertyRaw, 'checkOutTime', '11:00 AM'),
      adults: Number(get(bookingRaw, CFG.fieldAdults, 0)) || null,
      children: Number(get(bookingRaw, CFG.fieldChildren, 0)) || 0,
      airport: get(bookingRaw, 'airport', 'LRM'),
      flight: get(bookingRaw, 'flight', ''),
      transferArranged: !!get(bookingRaw, 'transferArranged', false),
    },
    villa: {
      id: propertyId,
      name: villaName,
      area: get(propertyRaw, 'area', get(propertyRaw, 'location', 'Casa de Campo')),
      view: get(propertyRaw, 'view', ''),
      suites: get(propertyRaw, 'bedrooms', get(propertyRaw, 'suites', null)),
      sleeps: get(propertyRaw, 'maxOccupancy', get(propertyRaw, 'sleeps', null)),
      hero: gallery[0] || get(propertyRaw, 'mainPhoto', ''),
      gallery,
      amenities: get(propertyRaw, 'amenities', []),
      staffIncluded: get(propertyRaw, 'staff', []),
      description: get(propertyRaw, 'description', ''),
    },
    // Stay-config overlay (welcome msg, offered add-ons, concierge) is editable
    // by staff in the Concierge Console; until that store exists it defaults here.
    concierge: { name: 'Ivonna', phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
    welcomeMessage: '',
    raw: process.env.V365_DEBUG === '1' ? { bookingRaw, propertyRaw } : undefined,
  };
}

/** End-to-end: verify a booking + assemble the stay. Returns null if not found. */
async function lookupStay(reference) {
  const booking = await getBookingByReference(reference);
  if (!booking) return null;
  const propertyId = get(booking, CFG.fieldPropertyId, null);
  let property = null, photos = null;
  if (propertyId != null) {
    [property, photos] = await Promise.all([
      getProperty(propertyId).catch(() => null),
      getPropertyPhotos(propertyId),
    ]);
  }
  return buildStay(booking, property, photos);
}

// ---------------------------------------------------------------------------
// MOCK MODE — sample stay so the app runs end-to-end with no credentials.
// Mirrors the prototype's Casa Bahía Azul / Hartley demo.
// ---------------------------------------------------------------------------
const MOCK_BOOKINGS = {
  'CDC-2026-0741': {
    reference: 'CDC-2026-0741',
    lastName: 'Hartley',
  },
};

function mockStay(reference) {
  const today = new Date();
  const arrive = new Date(today.getTime() + 5 * 86400000);
  const depart = new Date(arrive.getTime() + 5 * 86400000);
  const iso = d => d.toISOString().slice(0, 10);
  const CDN = 'https://secure.365villas.com';
  return {
    source: 'mock',
    guest: { firstName: 'Andrew', lastName: 'Hartley', family: 'Hartley', email: 'guest@example.com', phone: '' },
    booking: {
      reference, status: 'Published',
      arrive: iso(arrive), depart: iso(depart), nights: 5,
      arriveTime: '15:00', checkInTime: '3:00 PM', checkOutTime: '11:00 AM',
      adults: 6, children: 0, airport: 'LRM', flight: '', transferArranged: true,
    },
    villa: {
      id: 123, name: 'Casa Bahía Azul', area: 'Punta Minitas', view: 'Oceanfront',
      suites: 5, sleeps: 10,
      hero: '',
      gallery: [],
      amenities: ['Private pool', 'Private pier', 'Beach access'],
      staffIncluded: ['Chef', 'Butler', 'Housekeeping'],
      description: 'Oceanfront estate on Punta Minitas with a private pier.',
    },
    concierge: { name: 'Ivonna', phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
    welcomeMessage: 'On file: Andrew & Claire Hartley. We will match guest names to your booking and prepare the right welcome.',
  };
}

function mockVerify(reference, lastName) {
  const b = MOCK_BOOKINGS[String(reference).trim().toUpperCase()];
  if (!b) return null;
  if (String(lastName).trim().toLowerCase() !== b.lastName.toLowerCase()) return false;
  return mockStay(b.reference);
}

// TEMP diagnostic: try one action name and return the PMS status/message (no throw, no guest data).
async function probeAction(action) {
  try {
    const body = { key: CFG.key, pass: CFG.pass, owner_token: CFG.ownerToken || undefined, username: CFG.username || undefined, action, format: 'json', [CFG.paramReference]: 'PROBE-NONE' };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    let res; try { res = await fetch(CFG.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }); } finally { clearTimeout(t); }
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch (e) { return { action, http: res.status, parse: 'non-json', sample: text.slice(0, 60) }; }
    return { action, http: res.status, status: j.status, message: (j.message || j.error || '').slice(0, 80) };
  } catch (e) { return { action, err: e.message }; }
}

// TEMP diagnostic: reveal a response's STRUCTURE only (key names + value types), never actual values.
function redact(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return { _array: true, length: v.length, sample: (v.length && depth < 4) ? redact(v[0], depth + 1) : undefined };
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = redact(v[k], depth + 1); return o; }
  return typeof v;
}
async function schemaProbe(action, extra) {
  try {
    const body = Object.assign({ key: CFG.key, pass: CFG.pass, owner_token: CFG.ownerToken || undefined, username: CFG.username || undefined, action, format: 'json' }, extra || {});
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    let res; try { res = await fetch(CFG.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }); } finally { clearTimeout(t); }
    const text = await res.text(); let j; try { j = JSON.parse(text); } catch (e) { return { action, parse: 'non-json', sample: text.slice(0, 80) }; }
    return { action, extra: extra || null, status: j.status, message: (j.message || '').slice(0, 80), shape: redact(j.data) };
  } catch (e) { return { action, err: e.message }; }
}

// TEMP diagnostic: return status/message + a SHORT preview (<=300 chars) of data, to learn the real shape.
async function rawProbe(action, extra) {
  try {
    const body = Object.assign({ key: CFG.key, pass: CFG.pass, owner_token: CFG.ownerToken || undefined, username: CFG.username || undefined, action, format: 'json' }, extra || {});
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    let res; try { res = await fetch(CFG.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }); } finally { clearTimeout(t); }
    const text = await res.text(); let j; try { j = JSON.parse(text); } catch (e) { return { extra: extra || null, parse: 'non-json', sample: text.slice(0, 120) }; }
    const dataPreview = JSON.stringify(j.data === undefined ? null : j.data).slice(0, 300);
    return { extra: extra || null, status: j.status, message: (j.message || '').slice(0, 80), keys: Object.keys(j || {}), dataPreview };
  } catch (e) { return { extra: extra || null, err: e.message }; }
}

module.exports = {
  CFG,
  isConfigured,
  schemaProbe,
  rawProbe,
  lookupStay,
  buildStay,
  getBookingByReference,
  probeAction,
  mock: { verify: mockVerify, stay: mockStay },
  _get: get,
};
