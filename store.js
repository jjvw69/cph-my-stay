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
  { id: 'golfcart',   category: 'Arrival & transfers', name: 'Golf cart',                desc: 'Per day',                       price: '$60' },
  { id: 'grocery',    category: 'Provisioning',         name: 'Grocery pre-stocking',     desc: 'Villa stocked before arrival',  price: 'On request' },
  { id: 'rumcigar',   category: 'Experiences',          name: 'Rum & cigar tasting',      desc: 'Curated local selection',       price: '$140' },
  { id: 'spa',        category: 'Experiences',          name: 'In-villa spa',             desc: 'Massage for two',               price: '$260' },
  { id: 'yoga',       category: 'Experiences',          name: 'Private yoga',             desc: 'Sunrise session, per class',    price: '$90'  },
  { id: 'yacht',      category: 'Experiences',          name: 'Yacht charter',            desc: 'Half or full day',              price: 'On request' },
  { id: 'saona',      category: 'Excursions',           name: 'Saona Island day trip',    desc: 'Catamaran, lunch, pickup',      price: '$160' },
  { id: 'babygear',   category: 'In-villa services',    name: 'Baby gear',                desc: 'Crib, high chair, more',        price: 'On request' },
];

const CONCIERGES = [
  { id: 'maria-fernanda', name: 'María Fernanda', phone: '+1 (829) 763-8801', avatarInitials: 'MF' },
  { id: 'ivonna',         name: 'Ivonna',         phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
  { id: 'jan',            name: 'Jan',            phone: '+1 (829) 763-8801', avatarInitials: 'Jn' },
];

// Starter villa list — staff can extend/edit. hero = default photo (staff can override per stay).
const IMG = 'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/';
let VILLAS = [
  { id: 'bahia-azul',   name: 'Casa Bahía Azul', area: 'Punta Minitas',  view: 'Oceanfront',  suites: 5, sleeps: 10, hero: 'https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/123/20260114_123614_7813jpg.jpg' },
  { id: 'vista-mar',    name: 'Casa Vista Mar',  area: 'Vistamar',       view: 'Ocean view',  suites: 4, sleeps: 8,  hero: IMG+'Punta_Minitas_18_Casa_de_Campo_Caribbean_Paradise_Homes_28.webp' },
  { id: 'las-colinas',  name: 'Casa Las Colinas',area: 'Las Colinas',    view: 'Golf view',   suites: 6, sleeps: 12, hero: IMG+'Golf_Villa_142_Casa_de_Campo_Caribbean_Paradise_Homes_21.webp' },
  { id: 'cajuiles',     name: 'Casa Cajuiles',   area: 'Cajuiles',       view: 'Garden view', suites: 4, sleeps: 8,  hero: IMG+'Bahia_Chavon_7_Casa_de_Campo_Caribbean_Paradise_Homes_4.webp' },
  { id: 'marina',       name: 'Casa Marina',     area: 'Marina',         view: 'Marina view', suites: 3, sleeps: 6,  hero: IMG+'Dye-Fore-Golf-View-To-Marina-Caribbean-Paradise-Homes_3.webp' },
];

// Resort / explore scenes shown to guests (Discover + Explore). Photos from the CPH media library.
const EXPLORE_SCENES = [
  { id:'minitas-beach', cat:'Beaches',    name:'Minitas Beach',           meta:'On resort · 6 min',          desc:"The resort's sheltered white-sand cove, loungers and water sports.", img: IMG+'minitas-beach.webp' },
  { id:'teeth-dog',     cat:'Activities', name:'Teeth of the Dog Golf',   meta:'World top-100 · 7 min',      desc:"Pete Dye's iconic oceanfront course — seven holes hug the Caribbean.", img: IMG+'Dye-fore-Golf-Caribbean-Paradise-Homes_2.webp' },
  { id:'saona',         cat:'Excursions', name:'Saona Island Catamaran',  meta:'Full day · pickup included', desc:'Sail to palm-fringed Saona, with natural pools and a beach lunch.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2025/01/saona.jpeg' },
  { id:'minitas-club',  cat:'Dining',     name:'Minitas Beach Club',      meta:'On resort · 5 min',          desc:'Beachfront dining with Mediterranean-Caribbean menus, toes in the sand.', img: IMG+'Minitas_-Restaurant-3-min-800x600-1.webp' },
  { id:'la-cana',       cat:'Dining',     name:'La Caña by Il Circo',     meta:'On resort · 5 min',          desc:'Signature Italian at the heart of the resort, poolside and elegant.', img: IMG+'Causa-Restaurant.webp' },
  { id:'altos',         cat:'Activities', name:'Altos de Chavón',         meta:'Cultural village · 10 min',  desc:'A re-created 16th-century Mediterranean village and amphitheatre.', img: IMG+'Golf-Villas-Aerial-Caribbean-Paradise-Homes_1.webp' },
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
  const v0 = VILLAS[0] || {};
  return {
    id: genId(), reference: nextReference(), status: 'draft',
    leadName: '', lastName: '', email: '', phone: '',
    adults: 2, children: 0,
    villaId: v0.id || '',
    villaName: v0.name || '', villaArea: v0.area || '', villaView: v0.view || '',
    villaSuites: v0.suites || '', villaSleeps: v0.sleeps || '',
    heroPhoto: '',
    checkin: '', checkout: '', checkinTime: '3:00 PM',
    airport: 'LRM', flight: '', transferArranged: false,
    offeredAddOnIds: [],
    conciergeId: 'maria-fernanda', wifiHandover: 'Wi-Fi & keys handed over in person at the villa.',
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
  const allowed = ['leadName','lastName','email','phone','adults','children','villaId','villaName','villaArea','villaView','villaSuites','villaSleeps','heroPhoto','checkin','checkout','checkinTime','airport','flight','transferArranged','offeredAddOnIds','conciergeId','wifiHandover','welcomeMessage','status'];
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
  const v = getVilla(s.villaId) || {};
  const villa = {
    id: s.villaId || v.id || '',
    name: s.villaName || v.name || 'Your villa',
    area: s.villaArea || v.area || 'Casa de Campo',
    view: s.villaView || v.view || '',
    suites: s.villaSuites || v.suites || null,
    sleeps: s.villaSleeps || v.sleeps || null,
    hero: s.heroPhoto || v.hero || '',
  };
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
    villa: { id: villa.id, name: villa.name, area: villa.area, view: villa.view, suites: villa.suites, sleeps: villa.sleeps, hero: villa.hero, gallery: [], amenities: [], staffIncluded: ['Chef','Butler','Housekeeping'], description: '' },
    concierge: c,
    welcomeMessage: s.welcomeMessage || '',
    addOns: ADDON_CATALOG.filter(a => offered.has(a.id)),
    explore: EXPLORE_SCENES,
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
