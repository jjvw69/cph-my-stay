'use strict';

/**
 * Disk-backed data store for the My Stay system.
 * - Persists `stays.json` and `staff.json` in DATA_DIR (a Render disk in prod).
 * - Holds seed catalogs: villas, add-ons, concierges.
 * - Staff passwords are hashed with scrypt (never stored in plaintext).
 * Zero external dependencies (Node stdlib only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STAYS_FILE = path.join(DATA_DIR, 'stays.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');

// ---------------------------------------------------------------- seed catalogs
const ADDON_CATALOG = [
  { id: 'transfer',   category: 'Arrival & transfers', name: 'Private airport transfer', desc: 'Meet & greet, airport → villa', price: '$85' },
  { id: 'golfcart',   category: 'Arrival & transfers', name: 'Extra golf cart',          desc: 'Per day',                       price: '$60' },
  { id: 'grocery',    category: 'Provisioning',         name: 'Grocery pre-stocking',     desc: 'Villa stocked before arrival',  price: 'On request' },
  { id: 'rumcigar',   category: 'Experiences',          name: 'Rum & cigar tasting',      desc: 'Curated local selection',       price: '$140' },
  { id: 'spa',        category: 'Experiences',          name: 'In-villa spa',             desc: 'Massage for two',               price: '$260' },
  { id: 'yoga',       category: 'Experiences',          name: 'Private yoga',             desc: 'Sunrise session, per class',    price: '$90'  },
  { id: 'yacht',      category: 'Experiences',          name: 'Yacht charter',            desc: 'Half or full day',              price: 'On request' },
  { id: 'saona',      category: 'Excursions',           name: 'Saona Island day trip',    desc: 'Catamaran, lunch, pickup',      price: '$160' },
  { id: 'babygear',   category: 'In-villa services',    name: 'Baby gear',                desc: 'Crib, high chair, more',        price: 'On request' },
];

const CONCIERGES = [
  { id: 'ivonna', name: 'Ivonna', phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
  { id: 'jan',    name: 'Jan',    phone: '+1 (829) 763-8801', avatarInitials: 'Jn' },
  { id: 'maria',  name: 'María',  phone: '+1 (829) 763-8801', avatarInitials: 'Mn' },
];

// Starter villa list — staff can extend/edit. (Future: sync from 365Villas listings.)
let VILLAS = [
  { id: 'bahia-azul',   name: 'Casa Bahía Azul', area: 'Punta Minitas',  view: 'Oceanfront',  suites: 5, sleeps: 10, hero: '' },
  { id: 'vista-mar',    name: 'Casa Vista Mar',  area: 'Vistamar',       view: 'Ocean view',  suites: 4, sleeps: 8,  hero: '' },
  { id: 'las-colinas',  name: 'Casa Las Colinas',area: 'Las Colinas',    view: 'Golf view',   suites: 6, sleeps: 12, hero: '' },
  { id: 'cajuiles',     name: 'Casa Cajuiles',   area: 'Cajuiles',       view: 'Garden view', suites: 4, sleeps: 8,  hero: '' },
  { id: 'marina',       name: 'Casa Marina',     area: 'Marina',         view: 'Marina view', suites: 3, sleeps: 6,  hero: '' },
];

// ----------------------------------------------------------------- persistence
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function readJSON(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function writeJSON(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic-ish
}

let stays = readJSON(STAYS_FILE, []);
let staff = readJSON(STAFF_FILE, []);
function persistStays() { writeJSON(STAYS_FILE, stays); }
function persistStaff() { writeJSON(STAFF_FILE, staff); }

// --------------------------------------------------------------------- helpers
const norm = s => String(s == null ? '' : s).trim();
function genId() { return crypto.randomBytes(8).toString('hex'); }
function nextReference() {
  const yr = new Date().getFullYear();
  const n = stays.filter(s => (s.reference || '').includes('-' + yr + '-')).length + 1;
  return `CDC-${yr}-${String(n).padStart(4, '0')}`;
}

// ------------------------------------------------------------------ staff auth
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (e) { return false; }
}
function getStaffByEmail(email) { const e = norm(email).toLowerCase(); return staff.find(s => s.email === e) || null; }
function staffPublic(s) { return s ? { id: s.id, name: s.name, email: s.email, role: s.role } : null; }
function listStaffPublic() { return staff.map(staffPublic); }

/** Seed staff accounts from env on first boot (STAFF_ACCOUNTS="Name|email|password;..."). */
function seedStaffFromEnv() {
  const raw = process.env.STAFF_ACCOUNTS || '';
  if (!raw) return;
  let changed = false;
  raw.split(';').map(s => s.trim()).filter(Boolean).forEach(entry => {
    const [name, email, password, role] = entry.split('|').map(x => (x || '').trim());
    if (!email || !password) return;
    const e = email.toLowerCase();
    if (staff.find(s => s.email === e)) return; // don't overwrite existing
    staff.push({ id: genId(), name: name || email, email: e, role: role || 'concierge', pw: hashPassword(password), createdAt: Date.now() });
    changed = true;
  });
  if (changed) persistStaff();
}

// ------------------------------------------------------------------- villas
function listVillas() { return VILLAS; }
function getVilla(id) { return VILLAS.find(v => v.id === id) || null; }

// -------------------------------------------------------------------- stays
function blankStay() {
  return {
    id: genId(), reference: nextReference(), status: 'draft',
    leadName: '', lastName: '', email: '', phone: '',
    adults: 2, children: 0,
    villaId: VILLAS[0] ? VILLAS[0].id : '',
    checkin: '', checkout: '', checkinTime: '3:00 PM',
    airport: 'LRM', flight: '', transferArranged: false,
    offeredAddOnIds: [],
    conciergeId: 'ivonna', wifiHandover: 'Wi-Fi & keys handed over in person at the villa.',
    welcomeMessage: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function listStays() {
  return stays.slice().sort((a, b) => (a.checkin || '').localeCompare(b.checkin || '')).map(summaryStay);
}
function summaryStay(s) {
  const v = getVilla(s.villaId);
  return { id: s.id, reference: s.reference, status: s.status, guest: s.leadName || s.lastName || '(no name)',
    villa: v ? v.name : '', checkin: s.checkin, checkout: s.checkout, guests: (s.adults || 0) + (s.children || 0) };
}
function getStay(id) { return stays.find(s => s.id === id) || null; }
function createStay() { const s = blankStay(); stays.push(s); persistStays(); return s; }
function saveStay(id, patch) {
  const s = getStay(id); if (!s) return null;
  const allowed = ['leadName','lastName','email','phone','adults','children','villaId','checkin','checkout','checkinTime','airport','flight','transferArranged','offeredAddOnIds','conciergeId','wifiHandover','welcomeMessage','status'];
  allowed.forEach(k => { if (k in patch) s[k] = patch[k]; });
  s.updatedAt = Date.now();
  persistStays(); return s;
}
function publishStay(id) { return saveStay(id, { status: 'published' }); }
function deleteStay(id) { const i = stays.findIndex(s => s.id === id); if (i < 0) return false; stays.splice(i, 1); persistStays(); return true; }

// ------------------------------------------------------- guest-facing mapping
function nightsBetween(a, b) { const d1 = new Date(a), d2 = new Date(b); if (isNaN(d1) || isNaN(d2)) return null; return Math.max(0, Math.round((d2 - d1) / 86400000)); }

/** Map a stored stay → the shape the guest app renders. */
function toGuestStay(s) {
  const v = getVilla(s.villaId) || { name: 'Your villa', area: 'Casa de Campo', view: '', suites: null, sleeps: null, hero: '' };
  const c = CONCIERGES.find(x => x.id === s.conciergeId) || CONCIERGES[0];
  const offered = new Set(s.offeredAddOnIds || []);
  return {
    source: 'console',
    guest: { firstName: (s.leadName || '').split(' ')[0] || '', lastName: s.lastName || '', family: s.lastName || s.leadName || 'Guest', email: s.email || '', phone: s.phone || '' },
    booking: {
      reference: s.reference, status: s.status,
      arrive: s.checkin, depart: s.checkout, nights: nightsBetween(s.checkin, s.checkout),
      arriveTime: '15:00', checkInTime: s.checkinTime || '3:00 PM', checkOutTime: '11:00 AM',
      adults: Number(s.adults) || null, children: Number(s.children) || 0,
      airport: s.airport || 'LRM', flight: s.flight || '', transferArranged: !!s.transferArranged,
    },
    villa: { id: v.id, name: v.name, area: v.area, view: v.view, suites: v.suites, sleeps: v.sleeps, hero: v.hero || '', gallery: [], amenities: [], staffIncluded: ['Chef','Butler','Housekeeping'], description: '' },
    concierge: c,
    welcomeMessage: s.welcomeMessage || '',
    addOns: ADDON_CATALOG.filter(a => offered.has(a.id)),
  };
}

/** Guest login: find a PUBLISHED stay matching reference + lead-guest surname. */
function findPublishedForLogin(reference, lastName) {
  const ref = norm(reference).toLowerCase();
  const last = norm(lastName).toLowerCase();
  const s = stays.find(x => x.status === 'published' && norm(x.reference).toLowerCase() === ref);
  if (!s) return { notFound: true };
  if (norm(s.lastName).toLowerCase() !== last) return { mismatch: true };
  return { stay: toGuestStay(s) };
}
function getPublishedByRefForSession(reference) {
  const ref = norm(reference).toLowerCase();
  const s = stays.find(x => x.status === 'published' && norm(x.reference).toLowerCase() === ref);
  return s ? toGuestStay(s) : null;
}

// init
ensureDir();
seedStaffFromEnv();

module.exports = {
  DATA_DIR, ADDON_CATALOG, CONCIERGES,
  hashPassword, verifyPassword, getStaffByEmail, staffPublic, listStaffPublic, seedStaffFromEnv,
  listVillas, getVilla,
  listStays, getStay, createStay, saveStay, publishStay, deleteStay,
  toGuestStay, findPublishedForLogin, getPublishedByRefForSession,
  _counts: () => ({ stays: stays.length, staff: staff.length }),
};
