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
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');

// ---------------------------------------------------------------- seed catalogs
// Concierge services & experiences (from caribbeanparadisehomes.com/guest-services). No rates shown — handled by the concierge.
const ADDON_CATALOG = [
  // Travel & transfers (in the order they appear on caribbeanparadisehomes.com/guest-services)
  { id: 'privatetravel', category: 'Travel & transfers',    name: 'Luxury private travel',              desc: 'Private jet charters, group flights and air ambulance.' },
  { id: 'transfer',      category: 'Travel & transfers',    name: 'Private airport transfer',           desc: 'Meet & greet at the airport and a private drive to your villa.' },
  { id: 'carrental',     category: 'Travel & transfers',    name: 'Car rental',                         desc: 'A rental car arranged and waiting for you.' },
  { id: 'golfcart',      category: 'Travel & transfers',    name: 'Golf cart',                          desc: 'Your own cart to get around the resort.' },
  { id: 'bicycle',       category: 'Travel & transfers',    name: 'Bicycle rental',                     desc: 'Bicycles delivered to your villa for getting around the resort.' },
  { id: 'yacht',         category: 'Travel & transfers',    name: 'Luxury yacht charter',               desc: 'Private yacht and catamaran charters along the coast.' },
  // Provisioning
  { id: 'grocery',       category: 'Provisioning',          name: 'Grocery pre-stocking',               desc: 'Your villa stocked with groceries before you arrive.' },
  { id: 'arrivalmeals',  category: 'Provisioning',          name: 'Arrival meals',                      desc: 'Meals ready when you arrive — breakfast, lunch or dinner. A private chef can be arranged.' },
  // (Experiences moved to the Explore → Experiences directory)
  // Spa & wellness
  { id: 'yoga',          category: 'Spa & wellness',        name: 'Private Yoga',                       desc: 'A private sunrise yoga session on your terrace or the beach with a certified instructor.' },
  { id: 'massage',       category: 'Spa & wellness',        name: 'In-Villa Massage',                   desc: 'A private massage in your villa or on the terrace with a certified therapist — single, couples or group.' },
  // Kids & childcare
  { id: 'babygear',      category: 'Kids & childcare',      name: 'Baby gear',                          desc: 'Crib, high chair and everything for little ones.' },
  { id: 'nannies',       category: 'Kids & childcare',      name: 'Nannies & Babysitting',              desc: 'Trained nannies (First Aid & CPR, EN/ES) for daytime supervision or evening babysitting.' },
  // Additional services
  { id: 'staff',         category: 'Additional services',     name: 'Additional staff',                   desc: 'Extra villa staff — private chef, waiters, driver, butler, housekeeper or nanny.' },
  { id: 'entertainment', category: 'Additional services',     name: 'Live Entertainment',                 desc: 'Musicians, DJs and performers to set the mood for a dinner, celebration or evening at your villa.' },
  { id: 'rumcigar',      category: 'Additional services',     name: 'Rum & Cigar Tasting',                desc: 'A curated Dominican rum and hand-rolled cigar tasting, hosted in the comfort of your villa (adults only).' },
];

// Single source of truth for per-service options + rates. Keyed by ADDON_CATALOG id.
// Served to BOTH the console (invoice + send-service pickers) and the guest app so the
// options/rates offered stay identical. Same [label, rate] shape on both sides. Edit here only.
const SERVICE_OPTIONS = {
  golfcart:[['4-seater · year-round','$80 / day'],['4-seater · Easter & holidays','$120 / day'],['6-seater · year-round','$105 / day'],['6-seater · Easter & holidays','$150 / day']],
  bicycle:[['Adult · per day','$70 / day'],['Child · per day','$50 / day'],['Custom rate — enter amount below','']],
  carrental:[['Small SUV','$85 / day'],['Luxury SUV','$120 / day'],['Mid-size SUV (3 rows)','$140 / day'],['Minivan (Hyundai H-1)','$125 / day'],['Minivan Full','$160 / day'],['Minibus (up to 15)','$160 / day'],['Chevrolet Tahoe','$320 / day'],['Chevrolet Suburban','$360 / day']],
  transfer:[
    ['LRM → Casa de Campo · Standard · One-way','$50'],['LRM → Casa de Campo · Standard · Round-trip','$90'],
    ['LRM → Casa de Campo · Comfort · One-way','$80'],['LRM → Casa de Campo · Comfort · Round-trip','$150'],
    ['LRM → Casa de Campo · VIP Black · One-way','$150'],['LRM → Casa de Campo · VIP Black · Round-trip','$280'],
    ['PUJ → Casa de Campo · Standard · One-way','$125'],['PUJ → Casa de Campo · Standard · Round-trip','$240'],
    ['PUJ → Casa de Campo · Comfort · One-way','$160'],['PUJ → Casa de Campo · Comfort · Round-trip','$300'],
    ['PUJ → Casa de Campo · VIP Black · One-way','$290'],['PUJ → Casa de Campo · VIP Black · Round-trip','$560'],
    ['SDQ → Casa de Campo · Standard · One-way','$140'],['SDQ → Casa de Campo · Standard · Round-trip','$270'],
    ['SDQ → Casa de Campo · Comfort · One-way','$190'],['SDQ → Casa de Campo · Comfort · Round-trip','$360'],
    ['SDQ → Casa de Campo · VIP Black · One-way','$320'],['SDQ → Casa de Campo · VIP Black · Round-trip','$620'],
    ['Casa de Campo → LRM (La Romana) · Standard · One-way','$50'],['Casa de Campo → LRM (La Romana) · Comfort · One-way','$80'],['Casa de Campo → LRM (La Romana) · VIP Black · One-way','$150'],
    ['Casa de Campo → PUJ (Punta Cana) · Standard · One-way','$125'],['Casa de Campo → PUJ (Punta Cana) · Comfort · One-way','$160'],['Casa de Campo → PUJ (Punta Cana) · VIP Black · One-way','$290'],
    ['Casa de Campo → SDQ (Santo Domingo) · Standard · One-way','$140'],['Casa de Campo → SDQ (Santo Domingo) · Comfort · One-way','$190'],['Casa de Campo → SDQ (Santo Domingo) · VIP Black · One-way','$320']],
  nannies:[['Daytime nanny','$26 / hour'],['Evening babysitting','$20 / hour']],
  staff:[['Private chef','$150 / day · rate may vary with skills & experience'],['Waiter','$50 / day · rate may vary with skills & experience']],
  massage:[['60 minutes','$120'],['90 minutes','$140'],['120 minutes','$160']],
  yoga:[['1 person · 60 min','$120 / hour'],['2 people · 60 min','$95 / hour per person'],['3–6 people · 60 min','$240 / hour'],['7–10 people · 60 min','$60 / hour per person']],
  babygear:[['Crib','$45 / day'],['High chair','$20 / day'],['Playpen / Pack’n’Play','$30 / day']],
  // Luxury private travel is quote-based (pricing varies by aircraft/vehicle & route) — options with NO set rate; the concierge types the amount.
  privatetravel:[['Private jet charter',''],['Group charter flight',''],['Air ambulance / medical',''],['Luxury SUV transfer',''],['Luxury van / minibus',''],['VIP airport fast-track & greeter',''],['Other','']],
};

// Single source of truth for the grocery "Provisioning (Super)" dropdown in the console editor.
// Served to the console via /api/staff/bootstrap (BOOT.provisioningOptions). To add/remove a
// coordinator or helper, edit THIS list only — the console picks it up on next load. Names in CAPS.
// The console still allows a free-typed value ("Type a new value…") for anything not listed here.
const PROVISIONING_OPTIONS = [
  'MF: ALAIN','MF: ANY','MF: BELKIS','MF: CHEF','MF: IN PREP!','MF: IRIS','MF: JOAQUIN',
  'MF: MARGOT','MF: MAYRA','MF: NICO','MF: YESENIA','MF: YOHA','MF: YULI',
  'NARCISSA','YOLLMARY','IVO',
];

// Single source of truth for booking channels. Used TWICE: the stay-level "Booking source"
// select (where the villa booking came from) and the per-service "Booked via" field on invoice
// lines + service requests (which channel booked THIS golf cart / transfer / etc.). Served to the
// console via /api/staff/bootstrap. Add a partner agency here only — both pickers pick it up.
// "Booked via" is STAFF-ONLY: it is never sent to the guest (toGuestStay whitelists fields).
const BOOKING_SOURCE_PARTNERS = [
  'AMA Selections','Bonvido','Dream Exotic Villas','Dream Exotics Rentals','Duffy Destinations',
  'Exceptional Villas','Gathering Vacations','Haute Retreats','Heaven Villas',
  'Home & Villas by Marriott Bonvoy','Hosted Villas','In Veritas','Jetset World Travel','LaCure',
  'One Fine Stay','Personal Villas','Rental Escapes','Top Villas','TravelLustre','Villaway',
];
const BOOKING_SOURCES = ['Direct Booking'].concat(BOOKING_SOURCE_PARTNERS);
// Extra channels that only make sense per-service (a cart can come from the villa owner or be
// booked by the guest on the spot, even when the stay itself came through an agency).
const SERVICE_BOOKED_VIA = ['Guest direct','Villa owner','CPH concierge'].concat(BOOKING_SOURCES);

const CONCIERGES = [
  { id: 'maria-fernanda', name: 'María Fernanda', phone: '+1 (829) 763-8801', avatarInitials: 'MF' },
  { id: 'ivonna',         name: 'Ivonna',         phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
  { id: 'jan',            name: 'Jan',            phone: '+1 (829) 763-8801', avatarInitials: 'Jn' },
];

// Single source of truth for the yacht fleet — served to BOTH the console (proposal picker) and the guest app
// (preferred-yacht select) so they always stay in sync. Edit here only.
const YACHT_CATALOG = [
  { name:'Azimut 86 · Andrea', detail:'Up to 16 guests · 86ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Azimut 60', detail:'Up to 18 guests · 60ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Prestige 50', detail:'Up to 14 guests · 50ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Majesty 56 · Georyana 3', detail:'Up to 16 guests · 56ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Take It Easy 5', detail:'Up to 35 guests · 64ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Pacific 72 · Summer Wind', detail:'Up to 18 guests · 72ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Princess 60', detail:'Up to 12 guests · 60ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Azimut 55 · Ancoral', detail:'Up to 15 guests · 55ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Aicon 60 · Libra', detail:'Up to 15 guests · 60ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Prestige 42', detail:'Up to 14 guests · 42ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Alena 56 · Die Alto Dime', detail:'Up to 16 guests · 56ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Sea Ray 53', detail:'Up to 12 guests · 53ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Powerplay 54 · Liquid', detail:'Up to 22 guests · 55ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Tiara 48', detail:'Up to 14 guests · 48ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Sea Ray 540 · High Adventure', detail:'Up to 12 guests · 54ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Hatteras 53 · sport-fishing', detail:'Up to 16 guests · 53ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'No Worries', detail:'Up to 22 guests · 50ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Regal 38', detail:'Up to 10 guests · 38ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Fairline 50', detail:'Up to 12 guests · 50ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Enjoy', detail:'Up to 35 guests · 48ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Rohans 42', detail:'Up to 12 guests · 42ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Happy Hours', detail:'Up to 20 guests · 44ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Lose', detail:'Up to 20 guests · 50ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Marisabel', detail:'Up to 10 guests · 43ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Chris-Craft 43', detail:'Up to 12 guests · 43ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Meridian 42', detail:'Up to 14 guests · 42ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Sea Ray 42', detail:'Up to 12 guests · 40ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Princess 40', detail:'Up to 10 guests · 40ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Tiara 38', detail:'Up to 10 guests · 38ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Volare', detail:'Up to 10 guests · 43ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Lady V', detail:'Up to 12 guests · 43ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Fairline 43 · Aria 1', detail:'Up to 10 guests · 43ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Champagne Girl', detail:'Up to 10 guests · 40ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Intrepid 37', detail:'Up to 9 guests · 37ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Intrepid 36', detail:'Up to 9 guests · 36ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Happy Wind · sailing', detail:'Up to 14 guests · 38ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Velero 42 · sailing', detail:'Up to 9 guests · 42ft · crew of 2 · full day (8h)', rate:'Rates by request' },
  { name:'Pearson 40 · Mar del Sur · fishing', detail:'Up to 8 guests · 40ft · crew of 2 · full day (8h)', rate:'Rates by request' },
];

// Starter villa list — staff can extend/edit. hero = default photo (staff can override per stay).
const IMG = 'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/';
// Full Casa de Campo catalog (80 villas), generated from caribbeanparadisehomes.com listings.
// Each hero is the villa's real first gallery image (365villas). Staff can still override per stay.
let VILLAS = [
  { id: "casa-caleton", name: "Casa Caleton", area: "Caleton", view: "Beachfront", suites: 12, sleeps: 24, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/9/20241111_145842_4937jpg.jpg" },
  { id: "casa-minitas", name: "Casa Minitas", area: "Punta Minitas", view: "Beachfront", suites: 12, sleeps: 24, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/6/20241111_132408_9506jpg.jpg" },
  { id: "el-cocotal", name: "El Cocotal", area: "Vista Chavón", view: "Ocean view", suites: 10, sleeps: 20, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/10/20241111_150235_6747jpg.jpg" },
  { id: "villa-farallon", name: "Villa Farallon", area: "Punta Águila", view: "Oceanfront", suites: 10, sleeps: 24, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/5/20241111_131014_4929jpg.jpg" },
  { id: "la-plage", name: "La Plage", area: "Bahía Minitas", view: "Beachfront", suites: 9, sleeps: 20, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/8/20260110_082720_398jpg.jpg" },
  { id: "casa-cana", name: "Casa Cana", area: "Punta Águila", view: "Golf view", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/13/20260123_132031_9544jpg.jpg" },
  { id: "casa-del-sol", name: "Casa del Sol", area: "Las Palmas", view: "Golf view", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/79/20241205_072630_9273png.png" },
  { id: "casa-minitas-8br", name: "Casa Minitas 8br", area: "Punta Minitas", view: "Beachfront", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/80/20241206_054339_8054jpg.jpg" },
  { id: "villa-mar-azul", name: "Villa Mar Azul", area: "Punta Minitas", view: "Beachfront", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/97/20250320_121135_872jpg.jpg" },
  { id: "villa-oasis", name: "Villa Oasis", area: "Punta Minitas", view: "Oceanfront", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/14/20241113_123158_1613jpeg.jpeg" },
  { id: "villa-palmeras", name: "Villa Palmeras", area: "Vista Chavón", view: "Ocean view", suites: 8, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/18/20241113_130343_7319jpg.jpg" },
  { id: "casa-aguila", name: "Casa Aguila", area: "Punta Águila", view: "Oceanfront", suites: 7, sleeps: 14, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/126/20260303_075054_54jpg.jpg" },
  { id: "los-mangos", name: "Los Mangos", area: "Mangos", view: "Golf view", suites: 7, sleeps: 16, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/25/20241113_143043_3337jpeg.jpeg" },
  { id: "villa-esperanza", name: "Villa Esperanza", area: "Vistamar", view: "Ocean view", suites: 7, sleeps: 14, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/85/20250114_051010_7763jpg.jpg" },
  { id: "villa-palms", name: "Villa Palms", area: "Las Palmas", view: "Golf view", suites: 7, sleeps: 14, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/19/20250604_075932_8529jpg.jpg" },
  { id: "aqua-vista", name: "Aqua Vista", area: "Lagos", view: "Garden view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/86/20250114_114642_6009jpeg.jpeg" },
  { id: "casa-al-mare", name: "Casa Al Mare", area: "Punta Minitas", view: "Oceanfront", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/3/20241111_081612_9317jpg.jpg" },
  { id: "casa-aurea", name: "Casa Aurea", area: "Riomar", view: "Garden view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/124/20260206_050241_4169jpeg.jpeg" },
  { id: "casa-calm", name: "Casa Calm", area: "Costa Verde", view: "Oceanfront", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/12/20260226_065333_7459jpg.jpg" },
  { id: "casa-roble", name: "Casa Roble", area: "Barranca Este", view: "Garden view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/15/20241113_125336_2610jpg.jpg" },
  { id: "casa-sam", name: "Casa Sam", area: "Batey", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/26/20241115_113108_3679jpg.jpg" },
  { id: "casa-zens", name: "Casa Zens", area: "Barranca", view: "Ocean view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/84/20250110_113530_9481jpg.jpg" },
  { id: "la-brisa", name: "La Brisa", area: "Vistamar", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/41/20250214_070017_8608jpg.jpg" },
  { id: "la-florentina", name: "La Florentina", area: "Río Arriba", view: "Ocean view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/24/20241113_142752_3106jpg.jpg" },
  { id: "la-menina", name: "La Menina", area: "Costamar", view: "Oceanfront", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/11/20241112_131123_2907jpg.jpg" },
  { id: "las-ramas", name: "Las Ramas", area: "Batey", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/46/20241118_083429_1298jpg.jpg" },
  { id: "ocean-bliss", name: "Ocean Bliss", area: "Punta Minitas", view: "Oceanfront", suites: 6, sleeps: 14, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/4/20241111_085130_1689jpeg.jpeg" },
  { id: "villa-alfa", name: "Villa Alfa", area: "Ingenio", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/119/20251229_112716_8220jpeg.jpeg" },
  { id: "villa-farallon-6br", name: "Villa Farallon 6br", area: "Punta Águila", view: "Oceanfront", suites: 6, sleeps: 15, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/98/20250320_142940_8381jpg.jpg" },
  { id: "villa-isabel", name: "Villa Isabel", area: "Colinas", view: "Garden view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/44/20241118_082856_8940jpg.jpg" },
  { id: "villa-le-blanc", name: "Villa Le Blanc", area: "Las Palmas", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/32/20241115_115415_217jpg.jpg" },
  { id: "villa-marfil", name: "Villa Marfil", area: "Vistamar", view: "Garden view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/129/20260617_074807_642jpeg.jpeg" },
  { id: "villa-royale", name: "Villa Royale", area: "Cerezas", view: "Golf view", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/107/20250703_123755_2565jpg.jpg" },
  { id: "villa-serenita", name: "Villa Serenita", area: "Boca Chavón", view: "Oceanfront", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/109/20250801_033057_4740jpg.jpg" },
  { id: "villa-sueno", name: "Villa Sueño", area: "Vistamar", view: "Oceanfront", suites: 6, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/130/20260619_022358_1040jpg.jpg" },
  { id: "bahia-azul", name: "Casa Bahia Azul", area: "Bahía Minitas", view: "Beachfront", suites: 5, sleeps: 10, staff: "Housekeeper · Cook · Butler", hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/123/20260114_123614_7813jpg.jpg" },
  { id: "casa-batey", name: "Casa Batey", area: "Batey", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/106/20250630_134644_3227jpeg.jpeg" },
  { id: "casa-bo", name: "Casa BO", area: "Ingenio", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/23/20241113_142518_3190jpg.jpg" },
  { id: "casa-bosque", name: "Casa Bosque", area: "El Bosque", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/121/20260110_110019_882jpg.jpg" },
  { id: "cerezas-modern", name: "Cerezas Modern", area: "Cerezas", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/47/20241118_083547_7085jpg.jpg" },
  { id: "golf-villa-v", name: "Golf Villa V", area: "Golf", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/57/20260331_112117_7218jpg.jpg" },
  { id: "la-madera", name: "La Madera", area: "Punta Águila", view: "Oceanfront", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/120/20260120_065823_8648jpg.jpg" },
  { id: "la-sultana", name: "La Sultana", area: "Bahía Chavón", view: "Marina view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/35/20250919_165717_226jpg.jpg" },
  { id: "minitas-garden", name: "Minitas Garden", area: "Jardín Minitas", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/82/20241216_103302_9659jpg.jpg" },
  { id: "palm-west", name: "Palm West", area: "Las Palmas", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/91/20250203_061333_5086jpeg.jpeg" },
  { id: "punta-arrecife", name: "Punta Arrecife", area: "Punta Minitas", view: "Oceanfront", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/17/20241113_130111_4207jpg.jpg" },
  { id: "river-house", name: "River House", area: "Vista Chavón", view: "Ocean view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/20/20241113_140026_5334jpg.jpg" },
  { id: "tropical-modern", name: "Tropical Modern", area: "Naranjos", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/30/20241115_114752_7415jpg.jpg" },
  { id: "villa-agua", name: "Villa Agua", area: "Barranca", view: "Ocean view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/127/20260303_121608_3030jpg.jpg" },
  { id: "villa-coral", name: "Villa Coral", area: "Barranca Oeste", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/112/20251105_070201_2311jpg.jpg" },
  { id: "villa-esfera", name: "Villa Esfera", area: "Catalina", view: "Ocean view", suites: 5, sleeps: 12, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/108/20250714_074358_8462jpg.jpg" },
  { id: "villa-kari", name: "Villa Kari", area: "Cañas", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/111/20250917_121651_2728jpeg.jpeg" },
  { id: "villa-kiki", name: "Villa Kiki", area: "Riomar", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/16/20241113_125822_9457jpg.jpg" },
  { id: "villa-miramar", name: "Villa Miramar", area: "Punta Águila", view: "Beachfront", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/7/20241111_134945_7642jpg.jpg" },
  { id: "villa-palma-real", name: "Villa Palma Real", area: "Las Palmas", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/110/20250905_132850_8310jpg.jpg" },
  { id: "villa-santorini", name: "Villa Santorini", area: "Punta Minitas", view: "Beachfront", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/100/20250327_144426_3176jpg.jpg" },
  { id: "villa-sky", name: "Villa Sky", area: "Lagos", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/87/20250114_121941_1084jpeg.jpeg" },
  { id: "villa-solara", name: "Villa Solara", area: "Tennis Villas", view: "Garden view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/93/20250213_112436_7001jpg.jpg" },
  { id: "villa-tranquila", name: "Villa Tranquila", area: "Punta Águila", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/94/20250218_111820_3550jpeg.jpeg" },
  { id: "villa-volcan", name: "Villa Volcan", area: "Ingenio", view: "Golf view", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/118/20251222_131753_2052jpg.jpg" },
  { id: "casa-adri", name: "Casa Adri", area: "Cañas", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/51/20241118_113715_2320jpeg.jpeg" },
  { id: "casa-bliss", name: "Casa Bliss", area: "Ingenio", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/95/20250308_091504_5072jpg.jpg" },
  { id: "casa-blue", name: "Casa Blue", area: "Limones", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/48/20241118_084039_1043jpg.jpg" },
  { id: "casa-bonita", name: "Casa Bonita", area: "Golf", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/113/20251106_145414_1422jpg.jpg" },
  { id: "casa-ceiba", name: "Casa Ceiba", area: "Barranca Este", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/36/20241115_120819_8543jpeg.jpeg" },
  { id: "casa-del-lago", name: "Casa del Lago", area: "Lagos", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/38/20241115_121309_3688jpg.jpg" },
  { id: "casa-mota", name: "Casa Mota", area: "Vistamar", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/131/20260626_064950_6144jpg.jpg" },
  { id: "golf-villa-ix", name: "Golf Villa IX", area: "Golf", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/58/20241118_125013_6573jpg.jpg" },
  { id: "hacienda-mallet", name: "Hacienda Mallet", area: "Vistamar", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/65/20250207_061954_6755jpg.jpg" },
  { id: "la-fabulosa", name: "La Fabulosa", area: "Costa Verde", view: "Oceanfront", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/28/20241115_114223_5973jpg.jpg" },
  { id: "la-serenite", name: "La Serenite", area: "Lagos", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/61/20250326_160530_5378jpg.jpg" },
  { id: "le-cheval", name: "Le Cheval", area: "Polo", view: "Polo view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/67/20241119_114424_1976jpeg.jpeg" },
  { id: "porta-azul", name: "Porta Azul", area: "Limones", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/54/20241118_115546_7444jpg.jpg" },
  { id: "villa-cielo", name: "Villa Cielo", area: "Almendros", view: "Golf view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/104/20250625_093633_5627jpg.jpg" },
  { id: "villa-porton", name: "Villa Portón", area: "Barranca Este", view: "Garden view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/27/20241115_113431_9365jpeg.jpeg" },
  { id: "vista-del-polo", name: "Vista del Polo", area: "Polo", view: "Polo view", suites: 4, sleeps: 8, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/125/20260217_131109_6539jpg.jpg" },
  { id: "bella-vista", name: "Bella Vista", area: "Golf", view: "Golf view", suites: 3, sleeps: 6, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/128/20260305_143135_3432jpeg.jpeg" },
  { id: "golf-villa-8", name: "Golf Villa 8", area: "Casa de Campo", view: "Ocean view", suites: 3, sleeps: 6, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/55/20260105_112259_8450jpeg.jpeg" },
  { id: "villa-uchi", name: "Villa Uchi", area: "Golf", view: "Golf view", suites: 3, sleeps: 6, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/56/20241118_122037_2871jpeg.jpeg" },
  { id: "la-darsena", name: "La Darsena", area: "Darsena", view: "Marina view", suites: 2, sleeps: 4, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/122/20260112_123809_3725jpeg.jpeg" },
];

// 365villas internal property name per property ID (read from the GuestWisely Property Status table).
const INTERNAL = {
  '3':'Punta Minitas 18','4':'Punta Minitas 19','5':'Punta Aguila 22','6':'Punta Minitas 34','7':'Punta Aguila 26',
  '8':'Bahia Minitas 6','9':'Caleton 24','10':'Vista Chavon 7','11':'Costamar 10','12':'Costa Verde 1',
  '13':'Punta Aguila 57','14':'Punta Minitas 5','15':'Barranca Este 71','16':'Riomar 29','17':'Punta Minitas 32',
  '18':'Vista Chavon 13','19':'Palmas 11','20':'Vista Chavon 17','23':'Ingenio 12','24':'Rio Arriba 8',
  '25':'Mangos 28','26':'Batey 10','27':'Barranca Este 72','28':'Costa Verde 5','30':'Naranjos 11',
  '32':'Palmas 36','35':'Bahia Chavon 7','36':'Barranca Este 72a','38':'Los Lagos 4','41':'Vistamar 30',
  '44':'Colinas 20','46':'Batey 20','47':'Cerezas 34','48':'Limones 39','51':'Canas 45',
  '54':'Limones 25','55':'Golf Villa 8','56':'Golf Villa 120','57':'Golf Villa 255','58':'Golf Villa 267',
  '61':'Los Lagos 55','65':'Vistamar 22','67':'Polo 35','79':'Palmas 22','80':'Punta Minitas 34 (8br)',
  '82':'Jardin Minitas 6','84':'Barranca 14a','85':'Vistamar 8','86':'Los Lagos 31','87':'Los Lagos 49',
  '91':'Palmas 13','93':'Tennis Villa 34a','94':'Punta Aguila 58','95':'Ingenio 3','97':'Punta Minitas 14',
  '98':'Punta Aguila 22 - 6br','100':'Punta Minitas 12','104':'Los Almendros 4','106':'Batey 6','107':'Cerezas 71',
  '108':'La Catalina 10','109':'Bahia Chavon 2','110':'Palmas 27','111':'Canas II 9','112':'Barranca Oeste 7',
  '113':'Golf Villa 142','118':'Ingenio 16','119':'Ingenio 1a','120':'Punta Aguila 12a','121':'El Bosque 8',
  '122':'Darsena 5','123':'Bahia Minitas 3','124':'Riomar 35','125':'Polo 16','126':'Punta Aguila 25',
  '127':'Barranca 17','128':'Golf Villa 18','129':'Los Lagos 65','130':'Punta Aguila 10','131':'Toronjas 1',
};
VILLAS.forEach(v => { const m = String(v.hero || '').match(/\/gallery\/(\d+)\//); v.internalName = (m && INTERNAL[m[1]]) ? INTERNAL[m[1]] : ''; });

// Resort / explore scenes shown to guests (Discover + Explore). Photos from the CPH media library.
// Explore scenes shown to guests (Discover + Explore). info:true = informational (no request buttons).
const EXPLORE_SCENES = [
  // ---- Dining (image-rich first so the Home "Discover" strip leads with photos) ----
  { id:'minitas-club',  cat:'Dining', name:'Minitas Beach Club',          meta:'Beachfront',        desc:'Mediterranean, seafood, pizza and pasta on the sand — sea-view lunches and sunset dinners.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Minitas_-Restaurant-3-min-800x600-1.webp', menu:'https://qrcodes.pro/ViS8IV?_ga-ft=aNiRlw.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#MENU' },
  { id:'la-casita',     cat:'Dining', name:'La Casita',                   meta:'Marina',            desc:'Spanish & Mediterranean seafood on an elevated Marina terrace — a sunset-reservation favourite.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/La-Casita7-800x600-1.webp', menu:'https://qrcodes.pro/HHlSZF?_ga-ft=aNhWyg.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#MENU' },
  { id:'causa',         cat:'Dining', name:'Causa',                       meta:'Marina',            desc:'Peruvian — Creole, Nikkei and Chifa — with exceptional ceviche and tiradito.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Causa-Restaurant.webp', menu:'https://qrcodes.pro/lHLn7D?_ga-ft=aNidXg.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#MENU' },
  { id:'sbg',           cat:'Dining', name:'SBG · Blue Grill',            meta:'Marina',            desc:'Mediterranean-international fusion — grilled fish, steaks, DJ nights and Sunday brunch.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/SBG_Marina_084-800x600-1.jpg', menu:'https://qrcodes.pro/SMcOSr?_ga-ft=aNh9nw.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#MENU' },
  { id:'la-piazzetta',  cat:'Dining', name:'La Piazzetta',                meta:'Altos de Chavón',   desc:'Fine Italian in the clifftop village — housemade pasta and a serious wine list, candlelit.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/la-piazzetta-casa-de-campo-min-1-800x600-1.jpg', menu:'https://qrcodes.pro/OnHtz9?_ga-ft=aNigtA.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#DINNER' },
  { id:'limoncello',    cat:'Dining', name:'Limoncello',                  meta:'Marina',            desc:'Casual Italian — thin-crust pizza and pasta in a relaxed waterfront setting.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Limoncello_1-1024x681-1.webp' },
  { id:'shibuya',       cat:'Dining', name:'Shibuya',                     meta:'Marina',            desc:'Asian fusion and sushi on the Marina waterfront.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/DJI_0725_HDR.webp' },
  { id:'la-cana',       cat:'Dining', name:'La Caña Restaurant',          meta:'Resort centre',     desc:"French-Mediterranean fine dining — the resort's social hub, with rum, cigars and live music.", img:'https://www.casadecampo.com.do/wp-content/smush-webp/2025/07/La-Cana-1024x514.jpg.webp', menu:'https://qrcodes.pro/ZQSU4L?_ga-ft=aNiJBg.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#DINNER' },
  { id:'peperoni',      cat:'Dining', name:'Peperoni',                    meta:'Marina',            desc:'Steaks, sushi, pasta and international fare under an outdoor canopy terrace.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/peperoni.jpg' },
  { id:'onnos',         cat:'Dining', name:"Onno's",                      meta:'Altos de Chavón',   desc:'Tapas and international casual by the amphitheatre — 100+ cocktails, an all-day social hub.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/onnosres.jpg' },
  { id:'la-cantina',    cat:'Dining', name:'La Cantina',                  meta:'Altos de Chavón',   desc:'Caribbean-Latin dishes and sushi on the plaza — reliable mofongo (closed Sundays).', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/lacantina.jpg' },
  { id:'chilango',      cat:'Dining', name:'Chilango Taquería',           meta:'Altos de Chavón',   desc:'Mexican street food above Plaza Chavón — tacos, guacamole and plaza views.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/CHILANGO-ATQUERIA-18-800x600-1.jpg', menu:'https://qrcodes.pro/a5eEIc?_ga-ft=aNiFQQ.AA.AA.AA.AA.0QUj-OuXS8GQZdXUPkuVJg..0#MENU' },
  { id:'cafe-marietta', cat:'Dining', name:'Café Marietta',               meta:'Altos de Chavón',   desc:'Café fare and light meals on the village steps, with Chavón River and Dye Fore views.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/cafemarietta.jpg' },
  { id:'lago',          cat:'Dining', name:'Lago', noBook:true,            meta:'Teeth of the Dog',  desc:'Buffet breakfast and à la carte overlooking the 18th fairway, by the pro shop.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Lago-Restaurant-3-min-800x600-1.webp' },
  { id:'alegria',       cat:'Dining', name:'Alegría',                     meta:'Altos de Chavón',   desc:'Mediterranean cooking with a Dominican soul on the Callejón de la Alegría — Chavón River views, Chef Javier Cabrera.', img:'https://i0.wp.com/casadecampoliving.com/wp-content/uploads/2023/06/Alegria-Restaurant-1.jpg?w=1000&ssl=1' },
  { id:'dolce-italia',  cat:'Dining', name:'Dolce Italia',                meta:'Marina',            desc:'Authentic Italian in the Marina — wood-fired pizza, artisanal pastries and the only Marina breakfast (from 7:45am).', img:'https://i0.wp.com/casadecampoliving.com/wp-content/uploads/2024/02/IMG_3738.jpg?w=1000&ssl=1' },
  // ---- Cafés ----
  { id:'azimut',        cat:'Cafe', name:'Café Azimut', noBook:true,        meta:'Marina · Paseo del Mar',          desc:'The corner café at the start of the Paseo del Mar — Nespresso coffee, juices and snacks with Marina-deck views (8am–8pm).', img:'https://cph-my-stay.onrender.com/azimut.jpg' },
  { id:'voala',         cat:'Cafe', name:'Voalá Café Marché', noBook:true,   meta:'Altos de Chavón · Calle Las Piedras', desc:'A cosy brunch-and-coffee spot, gourmet deli and wine shop on the cobbled lanes of Altos de Chavón — pet-friendly.', img:'https://i0.wp.com/casadecampoliving.com/wp-content/uploads/2023/08/EJ4B4678.jpg?w=1000&ssl=1' },
  // ---- Golf ----
  { id:'teeth-of-the-dog', cat:'Golf', name:'Teeth of the Dog',          meta:'Pete Dye · 18 holes', desc:"Pete Dye's #1-ranked Caribbean course — seven oceanfront holes 'created by God.'", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic45.webp', more:'https://caribbeanparadisehomes.com/teeth-of-the-dog-golf-course-the-complete-visitor-guide/' },
  { id:'dye-fore',      cat:'Golf', name:'Dye Fore',                      meta:'Pete Dye · 27 holes', desc:'A clifftop 27 holes above the Chavón River — three nines up to 7,667 yards.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic19-small.webp', more:'https://caribbeanparadisehomes.com/casa-de-campo-golf-guide-three-courses/' },
  { id:'the-links',     cat:'Golf', name:'The Links',                     meta:'Pete Dye · 18 holes', desc:"Pete Dye's inland Scottish-style links — strategic, playable, built for repeat rounds.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/02/hole16_2.jpg.jpeg', more:'https://caribbeanparadisehomes.com/casa-de-campo-golf-guide-three-courses/' },
  // ---- Amenities (informational) ----
  { id:'marina',        cat:'Amenities', name:'Casa de Campo Marina',    meta:'Waterfront village',  desc:'A Mediterranean-style yacht harbour — a walkable waterfront of dining, boutiques and nightlife.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/05/A745160-1024x683.jpg', info:true, more:'https://caribbeanparadisehomes.com/casa-de-campo-marina-guide/' },
  { id:'altos',         cat:'Amenities', name:'Altos de Chavón',         meta:'Cultural village',    desc:'A re-created 16th-century Mediterranean clifftop village — amphitheatre, museum, galleries and dining.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/altos-de-chavon-web.jpg', info:true, more:'https://caribbeanparadisehomes.com/altos-de-chavon-complete-guide/' },
  { id:'minitas-beach', cat:'Amenities', name:'Minitas Beach',           meta:'Private · on resort', desc:"Casa de Campo's only private beach — calm, swimmable Caribbean water and full beach-club facilities.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic34.webp', info:true, more:'https://caribbeanparadisehomes.com/minitas-beach-guide/' },
  { id:'eco-trail',     cat:'Amenities', name:'Eco Trail & Bike Path', meta:'Recreational park · near Altos', desc:'A 65-acre nature park by the Dye Fore Lakes — two walking loops (2.5km & 1.5km), bike paths and a pedestrian walkway to Altos de Chavón.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic19-small.webp', info:true },
  { id:'kids-park',     cat:'Amenities', name:'Kids Park',               meta:'Recreational park · near Altos', desc:"A children's playground and open meadows inside the resort's recreational park — picnics, lawn games and family afternoons.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/kids-in-Casa-scaled-1-768x511.webp', info:true },
  // ---- Activities & wellness (bookable) ----
  { id:'spa',           cat:'Activities', name:'The Spa',                meta:'Wellness',            desc:'Massage, facials, body treatments and hydrotherapy — plus in-villa spa services.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Reception.webp', more:'https://www.casadecampo.com.do/experiences/spa/' },
  { id:'tennis',        cat:'Activities', name:'Racquet Center',          meta:'13 clay courts',     desc:"The Caribbean's largest racquet facility — Har-Tru clay courts plus padel and pickleball.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/tennis2-768x512.webp', more:'https://www.casadecampo.com.do/experiences/racquet-center/' },
  { id:'equestrian',    cat:'Activities', name:'Equestrian Center',      meta:'Riding & lessons',       desc:"Horseback riding, lessons, jumping and children's programs across countryside trails and arenas.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Polo-Challenge-800x600-1.webp', more:'https://www.casadecampo.com.do/experiences/equestrian/' },
  { id:'shooting',      cat:'Activities', name:'Shooting Center',        meta:'245 acres',           desc:"The DR's largest range — 200+ stations of sporting clays, trap, skeet and five-stand.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic39.webp', more:'https://www.casadecampo.com.do/experiences/shooting-center/' },
  // ---- Experiences: tours & adventures (bookable) ----
  { id:'horseback-tour', cat:'Activities', name:'Horseback Riding Tour', meta:'Ranch trail · 2h', desc:'A guided trail ride to a working ranch — cowboys, cane fields, pastures and lagoons (Thu/Fri/Sat).', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/02/33441417-H1-Horse_Back-web-768x512.jpg', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'pottery', cat:'Activities', name:'Pottery at Emilio Robba', meta:'Altos de Chavón · 1h', desc:'Discover your inner artist in a hands-on ceramics class at the Emilio Robba workshop in Altos de Chavón.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/altos-de-chavon-web.jpg', more:'https://www.casadecampo.com.do/experiences/altos-de-chavon/' },
  { id:'kayak', cat:'Activities', name:'Chavón River Kayak', meta:'Chavón River', desc:'Paddle the tranquil Chavón River past lush tropical vegetation — single or double kayaks.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-kayak.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'watersports', cat:'Activities', name:'Minitas Water Sports', meta:'Minitas Beach', desc:"Snorkelling, kayaks, banana boat, Hobie Wave and sailing from the resort's private beach.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic34.webp', more:'https://www.casadecampo.com.do/experiences/beaches/' },
  { id:'zipline', cat:'Outside', name:'Cumayasa Zip Line', meta:'Adventure', desc:'Fly over the lush flora of the eastern region with certified guides on this thrilling zip-line course.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-zipline.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'buggies', cat:'Outside', name:'Cumayasa Buggies', meta:'Off-road · ages 5+', desc:'Take the wheel and race through the Dominican countryside in your own off-road buggy.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/11/buggy-tour-550x366-1.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'catalina', cat:'Activities', name:'Catalina Island', meta:'Catamaran · beach day', desc:'A catamaran day trip to Catalina Island — white-sand beaches, snorkelling and crystal-clear water.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/catalina-768x512.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'cave', cat:'Outside', name:'Las Maravillas Cave', meta:'La Romana · half day', desc:'Explore a 100,000-year-old cave of Taíno rock art — the first natural museum of its kind in the West Indies.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/cueva-de-las-maravillas1-1-768x576.jpg', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'santo-domingo', cat:'Outside', name:'Santo Domingo City Tour', meta:'Capital · full day', desc:'Discover the oldest city in the New World — museums, cathedrals and historic landmarks of the capital.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-santo-domingo-fixed.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'cigar', cat:'Outside', name:'Cigar Factory Tour', meta:'Tabacalera de García', desc:"Tour the world's largest hand-rolled cigar factory — home of Montecristo, Romeo y Julieta and more.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cigarrolling-768x434.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'rum', cat:'Outside', name:'Rum Factory · Ron Barceló', meta:'Distillery tour', desc:"Tour one of the country's most prestigious rum distilleries, founded in 1930 (adults only).", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-rum-fixed.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  // ---- Family programs & childcare ----
  { id:'family-programs', cat:'Activities', name:'Family Programs', meta:"Supervised kids' camps · 1–17", desc:'Award-winning supervised programs by age group — Toddlers (1–3), Kidz (4–6), Casa Tweens (7–12) and Bonche 4 Teens (13–17): playground, arts & crafts, beach Olympics, sports, kayaking, horseback riding and more.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/familytravelling-768x384.webp', more:'https://www.casadecampo.com.do/experiences/for-families/' },
  // ---- In-villa experiences moved to Villa Add-ons > Additional services (entertainment, rumcigar) ----
  { id:'yacht-charter', cat:'Activities', name:'Yacht Charters', meta:'Marina · private charter', desc:'Private motor yachts, sailing yachts and catamarans with crew from Casa de Campo Marina — half-day, full-day, sunset cruises and island trips.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/05/A745160-1024x683.jpg', more:'https://www.casadecampo.com.do/experiences/marina/' },
  // ---- Nightlife ----
  { id:'genesis', cat:'Nightlife', info:true, name:'Genesis Nightclub', meta:'Altos de Chavón · late night', desc:'The resort’s nightclub in the clifftop village — DJs, dancing and bottle service into the early hours.', img:'https://www.casadecampo.com.do/wp-content/uploads/2019/03/nightlife-cocktail-bar.jpg', more:'https://www.casadecampo.com.do/experiences/nightlife/' },
  { id:'la-cana-night', cat:'Nightlife', info:true, name:'La Caña', meta:'Resort centre · live music', desc:'The hotel’s poolside restaurant turns evening social hub — live music, rum and cigars after dinner.', img:'https://www.casadecampo.com.do/wp-content/smush-webp/2025/07/La-Cana-1024x514.jpg.webp', more:'https://www.casadecampo.com.do/experiences/nightlife/' },
  { id:'sbg-night', cat:'Nightlife', info:true, name:'SBG', meta:'Marina · DJ nights', desc:'The Marina grill becomes a waterfront nightspot — DJ sets, cocktails and yacht-side energy.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/SBG_Marina_084-800x600-1.jpg', more:'https://www.casadecampo.com.do/experiences/nightlife/' },
  { id:'onnos-night', cat:'Nightlife', info:true, name:'Onno’s', meta:'Altos de Chavón · late bar', desc:'All-day tapas spot by day, one of the liveliest late bars after dark — 100+ cocktails before Genesis.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/onnosres.jpg', more:'https://www.casadecampo.com.do/experiences/nightlife/' },
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

// ----- custom services + per-service suppliers (concierge-managed, persisted) -----
// services = { customAddOns:[{id,category,name,price,desc,supplier,rates}], suppliers:{ [builtinId]:'Vendor' }, rates:{ [builtinId]:'guest-facing rate text' } }
let services = readJSON(SERVICES_FILE, { customAddOns: [], suppliers: {}, rates: {} });
if (!services.customAddOns) services.customAddOns = [];
if (!services.suppliers) services.suppliers = {};
if (!services.rates) services.rates = {};
function persistServices() { writeJSON(SERVICES_FILE, services); }

// ----- supplier payables settlement (Jan only, persisted) -----
// payablesSettled = { [key]: { settled:true, amount, at } } where key = `${invoiceId}:${category}`.
// A payable is "settled" once Jan has actually paid that supplier; we keep the amount at the
// moment of settling so we can flag a mismatch if the invoice is edited afterwards.
const PAYABLES_FILE = path.join(DATA_DIR, 'payables.json');
let payablesSettled = readJSON(PAYABLES_FILE, {});
if (!payablesSettled || typeof payablesSettled !== 'object') payablesSettled = {};
function persistPayables() { writeJSON(PAYABLES_FILE, payablesSettled); }

// ----- global invoice numbering ------------------------------------------------
// ONE running sequence across ALL bookings — every invoice gets its own unique
// number, starting at 001. Never per-stay (two bookings must never share a no).
if (typeof services.invoiceSeq !== 'number') services.invoiceSeq = 0;
function invNoFmt(n) { return String(n).padStart(3, '0'); } // 1 -> "001", 42 -> "042", 1000 -> "1000"
function nextInvoiceNo() { services.invoiceSeq = (services.invoiceSeq || 0) + 1; persistServices(); return invNoFmt(services.invoiceSeq); }
// One-time migration: renumber every existing invoice into a single global
// sequence (ordered by when it was created) so historical duplicates are removed.
(function migrateInvoiceSequence() {
  if (services.invoiceSeqMigrated) return;
  const all = [];
  stays.forEach(s => (s.invoices || []).forEach(iv => all.push(iv)));
  all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id || '').localeCompare(String(b.id || '')));
  let n = 0; all.forEach(iv => { n += 1; iv.no = invNoFmt(n); });
  services.invoiceSeq = n; services.invoiceSeqMigrated = true;
  if (all.length) persistStays();
  persistServices();
})();
// Self-heal on every boot: an invoice must ALWAYS carry a number. Anything missing one (legacy row,
// interrupted write) gets the next number in the global sequence, so no console row can render blank.
(function backfillInvoiceNos() {
  let fixed = 0;
  stays.forEach(s => (s.invoices || []).forEach(iv => { if (!iv.no || !String(iv.no).trim()) { iv.no = nextInvoiceNo(); fixed++; } }));
  if (fixed) { console.log('[invoices] backfilled %d invoice number(s)', fixed); persistStays(); }
})();

/** Built-in catalog (with any supplier override) + custom services. supplier is INTERNAL — never sent to guests. */
function allAddOns() {
  const builtins = ADDON_CATALOG.map(a => ({ id: a.id, category: a.category, name: a.name, desc: a.desc, price: '', rates: services.rates[a.id] || '', supplier: services.suppliers[a.id] || '', custom: false }));
  const customs = (services.customAddOns || []).map(a => ({ id: a.id, category: a.category || 'Bespoke services', name: a.name, desc: a.desc || '', price: a.price || '', rates: a.rates || '', supplier: a.supplier || '', custom: true }));
  return builtins.concat(customs);
}
/** What the console needs (includes supplier + price + custom flag). */
function listServicesForStaff() { return allAddOns(); }
function addCustomService(b) {
  const name = String((b && b.name) || '').trim();
  if (!name) return null;
  const item = {
    id: 'svc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    category: String((b && b.category) || 'Bespoke services').trim() || 'Bespoke services',
    name, price: String((b && b.price) || '').trim(),
    desc: String((b && b.desc) || '').trim(), supplier: String((b && b.supplier) || '').trim(),
    rates: String((b && b.rates) || '').replace(/\s+$/, ''),
  };
  services.customAddOns.push(item); persistServices(); return item;
}
function updateService(id, b) {
  id = String(id || '');
  const custom = services.customAddOns.find(a => a.id === id);
  if (custom) {
    if (b.name != null) custom.name = String(b.name).trim() || custom.name;
    if (b.price != null) custom.price = String(b.price).trim();
    if (b.desc != null) custom.desc = String(b.desc).trim();
    if (b.category != null) custom.category = String(b.category).trim() || custom.category;
    if (b.supplier != null) custom.supplier = String(b.supplier).trim();
    if (b.rates != null) custom.rates = String(b.rates).replace(/\s+$/, '');
    persistServices(); return custom;
  }
  // built-in: supplier and guest-facing rates are editable (name/desc come from the catalog)
  if (ADDON_CATALOG.some(a => a.id === id)) {
    if (b.supplier != null) { const v = String(b.supplier).trim(); if (v) services.suppliers[id] = v; else delete services.suppliers[id]; }
    if (b.rates != null) { const v = String(b.rates).replace(/\s+$/, ''); if (v.trim()) services.rates[id] = v; else delete services.rates[id]; }
    persistServices();
    return { id, supplier: services.suppliers[id] || '', rates: services.rates[id] || '', custom: false };
  }
  return null;
}
function deleteCustomService(id) {
  id = String(id || '');
  const n = services.customAddOns.length;
  services.customAddOns = services.customAddOns.filter(a => a.id !== id);
  if (services.customAddOns.length === n) return false;
  persistServices(); return true;
}

// --------------------------------------------------------------------- helpers
const norm = s => String(s == null ? '' : s).trim();
function genId() { return crypto.randomBytes(8).toString('hex'); }
function nextReference() {
  // max existing number + 1 (NOT count+1): deleting a stay must never recycle its reference —
  // guest tokens are bound to the reference, so a recycled one would open the new guest's stay.
  const yr = new Date().getFullYear();
  const maxN = stays.reduce((m, s) => { const mm = String(s.reference || '').match(new RegExp('-' + yr + '-(\\d+)$')); return mm ? Math.max(m, Number(mm[1])) : m; }, 0);
  return `CDC-${yr}-${String(maxN + 1).padStart(4, '0')}`;
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
// Per-villa nightly rate (US$), source: CPH public listings "From $X/night" (caribbeanparadisehomes.com),
// keyed to the villa's 365villas property number. Drives the security-deposit preset (= one night) on
// NON-direct bookings. Villas not listed on CPH (e.g. Casa del Mar, Villa Serenity) are intentionally
// omitted → no preset, staff fill the deposit manually. Add/refresh rates here as they change.
const NIGHTLY_RATES = {
  'casa-caleton': 9800, 'casa-minitas': 13800, 'el-cocotal': 6350, 'villa-farallon': 12300,
  'la-plage': 9200, 'casa-del-sol': 2700, 'casa-minitas-8br': 9200, 'villa-mar-azul': 6900,
  'villa-oasis': 4350, 'casa-aguila': 10350, 'villa-esperanza': 2900, 'villa-palms': 4050,
  'casa-al-mare': 9200, 'casa-roble': 5200, 'casa-sam': 3400, 'casa-zens': 2900,
  'la-brisa': 2300, 'la-florentina': 5200, 'la-menina': 7050, 'ocean-bliss': 9200,
  'villa-farallon-6br': 10250, 'villa-isabel': 1800, 'villa-le-blanc': 4050, 'villa-royale': 3450,
  'villa-serenita': 5200, 'villa-sueno': 9750, 'bahia-azul': 8650, 'casa-batey': 3200,
  'casa-bo': 2600, 'casa-bosque': 2600, 'cerezas-modern': 1700, 'golf-villa-v': 1050,
  'la-madera': 3650, 'minitas-garden': 3150, 'punta-arrecife': 5200, 'river-house': 4600,
  'villa-agua': 3450, 'casa-calm': 5750, 'casa-del-lago': 2300, 'villa-solara': 1750,
  'villa-miramar': 13800, 'villa-cielo': 1050, 'porta-azul': 1450, 'villa-coral': 2500,
  'villa-esfera': 3450, 'villa-palma-real': 4050, 'villa-sky': 2600, 'villa-tranquila': 3450,
  'casa-adri': 1350, 'casa-blue': 1600, 'casa-bonita': 1350, 'casa-ceiba': 2880,
  'casa-mota': 1250, 'golf-villa-ix': 850, 'hacienda-mallet': 2100, 'la-serenite': 1050,
  'vista-del-polo': 1600, 'bella-vista': 600, 'golf-villa-8': 600, 'villa-uchi': 900,
  'villa-marfil': 1500, 'palm-west': 3650, 'villa-santorini': 5200, 'casa-cana': 4700,
  // Still to add (pull from individual /property/N-... pages when needed): villa-palmeras, los-mangos,
  // aqua-vista, casa-aurea, las-ramas, villa-alfa, la-sultana, tropical-modern, villa-kari,
  // villa-kiki, villa-volcan, casa-bliss, la-fabulosa, le-cheval, villa-porton.
};
function listVillas() { return VILLAS.map(v => ({ ...v, nightlyRate: NIGHTLY_RATES[v.id] || 0 })); }
function getVilla(id) { return VILLAS.find(v => v.id === id) || null; }

// -------------------------------------------------------------------- stays
function blankStay() {
  const v0 = VILLAS[0] || {};
  return {
    id: genId(), reference: nextReference(), status: 'draft',
    leadName: '', lastName: '', email: '', phone: '', source: 'Direct Booking',
    adults: 0, children: 0,
    villaId: v0.id || '',
    villaName: v0.name || '', villaArea: v0.area || '', villaView: v0.view || '',
    villaSuites: v0.suites || '', villaSleeps: v0.sleeps || '', villaInternal: v0.internalName || '',
    heroPhoto: '',
    checkin: '', checkout: '', checkinTime: '3:00 PM', checkoutTime: '11:00 AM',
    staffIncluded: (v0.staff || 'Chef · Butler · Housekeeper'),
    staffHours: '8:00 AM – 5:00 PM',
    staffReadAt: 0,
    airport: 'LRM', flight: '', transferArranged: false,
    offeredAddOnIds: ['transfer', 'golfcart', 'yacht'],
    conciergeId: 'maria-fernanda', assigneeId: '', internalNotes: '', wifiHandover: 'Wi-Fi & keys handed over in person at the villa.',
    // Arrivals-board ops fields (STAFF ONLY — never sent to the guest app). Mirror the Excel arrivals sheet.
    agent: '', cartConfig: '', staffCount: '', accessCodes: '', transferNote: '', provisioning: '', extras: '',
    bookingAgent: '', // CPH booking agent (ivonna | jan) — internal owner of the booking, staff-only
    rowColor: '', // arrivals-board row highlight colour (staff-only): ''|green|yellow|orange|red|blue|purple|gray
    grocerySuper: '', // grocery-section provisioning pick (staff-only) — SAME VALUE as `provisioning` (board Super column); always kept mirrored, see syncProvisioning()
    groceryDeposit: 0, groceryDepositPaid: false, // grocery deposit (staff-only, US$): amount (0=none) + paid flag; shown on the arrivals board
    welcomeMessage: "Welcome to {villa name} — we're so happy to have you. I'm {concierge name}, here to help with transfers, groceries, dinners, or anything else. Tap Pre check-in when you have a moment, and message me anytime.",
    requests: [],
    messages: [],
    guestList: [],
    guestCheckin: null,
    followUpDate: '', followUpNote: '', followUps: [], depositReminderAdded: false,
    wifiName: '', wifiPassword: '', villaNumber: '', registrationNumber: '',
    paymentStatus: '', balanceDue: '', securityDeposit: '', totalCharge: '', amountPaid: '', balanceDueBy: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function listStays() {
  return stays.slice().sort((a, b) => (a.checkin || '').localeCompare(b.checkin || '')).map(summaryStay);
}
function nextFollowUp(s){ const a=(s.followUps&&s.followUps.length)?s.followUps.slice():(s.followUpDate?[{date:s.followUpDate,note:s.followUpNote||''}]:[]); const b=a.filter(x=>x&&x.date); if(!b.length)return null; b.sort((x,y)=>String(x.date).localeCompare(String(y.date))); return b[0]; }
/** Single source of truth for pre-arrival readiness. Three things must be in place before a
 *  guest arrives: pre check-in, guest passport numbers, and the airport transfer. Used by BOTH
 *  the guest app banner and the console pre-arrival alert so the two can never drift.
 *  Transfer has two thresholds: the guest's part is done once they've ANSWERED the transport
 *  question (organize OR self) or a transfer is booked; the console (operational) gate is
 *  stricter — a transfer must actually be arranged OR the guest self-declared. */
function stayReadiness(s) {
  const gc = s.guestCheckin || null;
  const preCheckin = !!gc;
  const passports = (s.guestList || []).some(g => g && String(g.passport || '').trim());
  const transferArranged = !!s.transferArranged;
  const transferSelf = !!(gc && gc.transportMode === 'self');
  const transferAnswered = transferArranged || !!(gc && (gc.transportMode === 'self' || gc.transportMode === 'organize'));
  const transferReady = transferArranged || transferSelf;      // console / operational
  const transferGuestDone = transferArranged || transferAnswered; // guest side
  const missing = [];
  // Human labels for the console tooltip/pill. All three are STEPS OF THE PRE CHECK-IN — don't call
  // any single one "pre check-in" again (that naming confused the console).
  if (!preCheckin) missing.push('guest details');
  if (!passports) missing.push('passports');
  if (!transferReady) missing.push('transportation');
  const guestMissing = [];
  if (!preCheckin) guestMissing.push('precheckin');
  if (!passports) guestMissing.push('passports');
  if (!transferGuestDone) guestMissing.push('transfer');
  return {
    preCheckin, passports,
    transferArranged, transferSelf, transferAnswered, transferReady, transferGuestDone,
    ready: missing.length === 0, missing,
    guestReady: guestMissing.length === 0, guestMissing,
    done: 3 - missing.length, total: 3,
  };
}
/** Normalized golf-cart display for the arrivals board — DERIVED from the booking file:
 *  billable carts come from the golf-cart invoice (source of truth, edited there), villa &
 *  pending come from the cart status. Format: "2× 6-seater", "1× 4-seater villa", "Pending". */
/** Read one piece of cart text — an invoice line label, a request cartType, or a staff Cart-cell
 *  segment — into {qty, seats, villa}. Understands every shape we actually use:
 *    "1× 6-seater" · "2x 6 seater" · "Villa Golf cart 6p" · "2 de 6p" · "Golf cart — 4-seater" */
function parseCartText(t) {
  const s = String(t || '').trim();
  if (!s || /^none$/i.test(s)) return null;
  const seatM = s.match(/(\d)\s*-?\s*seater/i) || s.match(/(\d)\s*p\b/i);
  if (!seatM) return null;
  const qtyM = s.match(/(\d+)\s*(?:[×x*]|de)\s*\d/i);
  return { qty: qtyM ? Number(qtyM[1]) : 1, seats: Number(seatM[1]), villa: /villa|owner/i.test(s) };
}
const RE_CART_ANY = /golf\s*cart|golfcart|seater|\d\s*p\b/i;
/** SINGLE SOURCE OF TRUTH for a stay's golf-cart status. Priority:
 *    1. golf-cart INVOICE lines (incl. a US$0 villa/owner cart — that still counts as settled)
 *    2. a CONFIRMED golf-cart request
 *    3. the staff Cart cell (cartConfig) — now only a manual override / fallback
 *  Returns { lines, note }. `note` is the beige console banner; it is empty once the cart is
 *  resolved by ANY of the three. Issuing the invoice is what clears it — no double entry.
 *  (Before 2026-07-14 the banner + board read cartConfig ONLY, so an invoiced cart still said
 *   "pending" until someone retyped it into the Cart cell by hand.) */
function cartInfo(s) {
  const lines = [];
  let anyBillable = false, anyVilla = false;
  const push = (p, tag) => {
    if (!p) return;
    lines.push(p.qty + '× ' + p.seats + '-seater' + (p.villa ? ' villa' : '') + (tag || ''));
    if (p.villa) anyVilla = true; else anyBillable = true;
  };

  // 1 — invoice lines
  (s.invoices || []).forEach(inv => {
    if (!RE_CART_ANY.test(String(inv.title || ''))) return;
    (inv.items || []).forEach(it => {
      const sup = String(it.supplier || '').trim();     // per-line supplier
      const via = String(it.bookedVia || '').trim();    // per-line booking channel
      const tag = (sup ? (' · ' + sup) : '') + (via ? (' · via ' + via) : '');
      const amt = Number(it.amount) || 0;
      const p = parseCartText(it.label);
      // A US$0 line on a golf-cart invoice = the villa/owner is providing it, not billed.
      if (p) { if (!amt) p.villa = true; return push(p, tag); }
      // Fallback for old lines with no seat count in the label: infer from rate × days.
      const rate = parseFloat(String(it.rate || '').replace(/[^0-9.]/g, '')) || 0;
      const days = parseFloat(String(it.days || '').replace(/[^0-9.]/g, '')) || 0;
      const seats = (rate === 105 || rate === 150) ? 6 : (rate === 80 || rate === 120) ? 4 : 0;
      const qty = (rate && days) ? Math.round(amt / (rate * days)) : 0;
      if (seats && qty) push({ qty, seats, villa: false }, tag);
    });
  });

  // 2 — confirmed golf-cart request (only if no invoice line spoke first)
  if (!lines.length) {
    (s.requests || []).forEach(r => {
      if (r.status !== 'confirmed') return;
      if (!RE_CART_ANY.test(String(r.refId || '') + ' ' + String(r.title || ''))) return;
      const sup = String(r.supplier || '').trim();
      const via = String(r.bookedVia || '').trim();
      const tag = (sup ? (' · ' + sup) : '') + (via ? (' · via ' + via) : '');
      push(parseCartText(r.cartType || r.title), tag);
    });
  }

  // 3 — staff Cart cell. Villa carts typed there are always shown (they're never invoiced);
  //     billable ones only when nothing above resolved the cart.
  const raw = String(s.cartConfig || '').trim();
  const segs = raw.split(/\n|&|\+|\s+y\s+/i).map(x => x.trim()).filter(Boolean);
  segs.forEach(seg => {
    if (/^none$/i.test(seg)) return;
    const isVilla = /villa|owner/i.test(seg);
    if (!isVilla && lines.length) return;          // already resolved by invoice/request
    if (isVilla && anyVilla) return;               // don't double-list the same villa cart
    const p = parseCartText(seg);
    if (p) push(p, '');
    else if (isVilla) { lines.push('villa'); anyVilla = true; }
  });

  // Two identical invoice lines = two identical carts. Show them as one row ("2× 4-seater"),
  // the way the arrivals sheet has always been written — not as a repeated line.
  const merged = [];
  lines.forEach(l => {
    const m = l.match(/^(\d+)× (.+)$/);
    if (!m) { merged.push(l); return; }
    const same = merged.find(x => x.rest === m[2]);
    if (same) same.qty += Number(m[1]); else merged.push({ qty: Number(m[1]), rest: m[2] });
  });
  const outLines = merged.map(x => (typeof x === 'string') ? x : (x.qty + '× ' + x.rest));

  const resolved = outLines.length > 0;
  let note = '';
  if (!resolved && /^none$/i.test(raw)) note = 'Golf cart — pending (to confirm).';
  else if (resolved && anyVilla && !anyBillable) note = 'Golf cart — provided by villa/owner, not billed.';
  return { lines: outLines, note, resolved };
}
/** Board Cart cell: one cart per line ("2× 6-seater · Julio · via Top Villas"), or "Pending". */
function golfCartDisplay(s) {
  const info = cartInfo(s);
  if (!info.lines.length) return /^none$/i.test(String(s.cartConfig || '').trim()) ? 'Pending' : '';
  return info.lines.join('\n'); // .ab-cart is white-space:pre-line
}
/** First non-empty supplier found on an invoice line whose label matches `re`.
 *  Staff-only — surfaced onto the arrivals board (Transfer / Cart columns) + Excel export. */
function invoiceItemSupplier(s, re) {
  for (const inv of (s.invoices || [])) {
    for (const it of (inv.items || [])) {
      const sup = String((it && it.supplier) || '').trim();
      if (sup && re.test(String((it && it.label) || ''))) return sup;
    }
  }
  return '';
}
const RE_TRANSFER_LINE = /private airport transfer|airport transfer|\btransfer\b|\b(?:LRM|PUJ|SDQ)\b/i;
const RE_CART_LINE = /golf\s*cart|golfcart|seater/i;
/** Supplier set on a matching guest request (staff-only). Takes precedence over the invoice
 *  supplier for the arrivals board, since the request is the primary booking record. */
function requestSupplier(s, re) {
  for (const r of (s.requests || [])) {
    if (r.status === 'cancelled') continue;
    const sup = String((r && r.supplier) || '').trim();
    if (sup && (re.test(String((r && r.refId) || '')) || re.test(String((r && r.title) || '')))) return sup;
  }
  return '';
}
/** Board supplier for a column: request supplier first, else invoice-line supplier. */
function boardSupplier(s, re) { return requestSupplier(s, re) || invoiceItemSupplier(s, re); }
/** Same two lookups for bookedVia — the booking channel that booked this service (staff-only).
 *  Request first (primary booking record), then the invoice line. */
function invoiceItemBookedVia(s, re) {
  for (const inv of (s.invoices || [])) {
    for (const it of (inv.items || [])) {
      const via = String((it && it.bookedVia) || '').trim();
      if (via && re.test(String((it && it.label) || ''))) return via;
    }
  }
  return '';
}
function requestBookedVia(s, re) {
  for (const r of (s.requests || [])) {
    if (r.status === 'cancelled') continue;
    const via = String((r && r.bookedVia) || '').trim();
    if (via && (re.test(String((r && r.refId) || '')) || re.test(String((r && r.title) || '')))) return via;
  }
  return '';
}
function boardBookedVia(s, re) { return requestBookedVia(s, re) || invoiceItemBookedVia(s, re); }
function summaryStay(s) {
  const v = getVilla(s.villaId); const fu = nextFollowUp(s);
  // Cart column: each golf cart on its own line. If the invoice lines already carry per-line
  // suppliers (contain " · "), use them as-is; otherwise append one shared supplier line.
  const gcDisp = golfCartDisplay(s);
  const cartVia = boardBookedVia(s, RE_CART_LINE);
  const gcCart = (gcDisp.indexOf(' · ') >= 0) ? gcDisp
    : [gcDisp, [boardSupplier(s, RE_CART_LINE), cartVia ? 'via ' + cartVia : ''].filter(Boolean).join(' · ')].map(x => String(x || '').trim()).filter(Boolean).join('\n');
  return { id: s.id, reference: s.reference, status: s.status, guest: s.leadName || s.lastName || '(no name)',
    villa: s.villaName || (v ? v.name : ''), villaInternal: s.villaInternal || (v ? v.internalName : '') || '', checkin: s.checkin, checkout: s.checkout, guests: (s.adults || 0) + (s.children || 0),
    source: s.source || '', followUpDate: (fu&&fu.date)||'', followUpNote: (fu&&fu.note)||'', followUps: (s.followUps||[]).slice(), requests: (s.requests || []).length,
    pending: (s.requests || []).filter(r => r.status !== 'confirmed' && r.status !== 'cancelled' && r.status !== 'done').length,
    guestMsgs: (s.messages || []).filter(m => m.from === 'guest').length, guestLastSeen: s.guestLastSeen || 0,
    lastMsgAt: ((s.messages || [])[(s.messages || []).length - 1] || {}).at || 0,
    lastMsgText: String(((s.messages || [])[(s.messages || []).length - 1] || {}).text || '').slice(0, 90),
    lastMsgFrom: ((s.messages || [])[(s.messages || []).length - 1] || {}).from || '',
    revenue: stayRevenue(s), confirmed: (s.requests || []).filter(r => r.status === 'confirmed').length,
    unpaid: (s.invoices || []).filter(i => i.status === 'sent').length,
    unpaidTotal: (s.invoices || []).filter(i => i.status === 'sent').reduce((a, i) => a + invoiceTotal(i), 0),
    unpaidInvoices: (s.invoices || []).filter(i => i.status === 'sent').map(i => ({ no: i.no || '', title: i.title || 'Invoice', kind: i.kind || '', total: invoiceTotal(i), dueBy: i.dueBy || '' })),
    transferArranged: !!s.transferArranged, preCheckinDone: !!s.guestCheckin, hasReg: !!String(s.registrationNumber || '').trim(),
    readiness: stayReadiness(s),
    transfers: (s.requests || []).filter(r => r.type === 'addon' && r.refId === 'transfer' && r.status !== 'cancelled').map(r => ({ date: r.date || '', endDate: r.endDate || '' })),
    assigneeId: s.assigneeId || '', paymentStatus: s.paymentStatus || '',
    ppl: ((Number(s.adults) || 0) + (Number(s.children) || 0)) || '',
    agent: s.agent || '', cartConfig: s.cartConfig || '', staffCount: s.staffCount || '', accessCodes: s.accessCodes || '',
    registrationNumber: s.registrationNumber || '', // board Access column now edits the same field as Stay details Registration #
    transferNote: [boardSupplier(s, RE_TRANSFER_LINE), (function(){ const v = boardBookedVia(s, RE_TRANSFER_LINE); return v ? 'via ' + v : ''; })(), s.transferNote].map(x => String(x || '').trim()).filter(Boolean).join(' · '), provisioning: s.provisioning || '', extras: s.extras || '', internalNotes: s.internalNotes || '',
    bookingAgent: s.bookingAgent || '', golfCart: gcCart, rowColor: s.rowColor || '', grocerySuper: s.grocerySuper || '',
    groceryDeposit: parseFloat(s.groceryDeposit) || 0, groceryDepositPaid: !!s.groceryDepositPaid };
}
function getStay(id) { return stays.find(s => s.id === id) || null; }
function exportAll() { return stays; }

// ------------------------------------------------------- upsell / revenue metrics
function parsePrice(p) { const n = Number(String(p == null ? '' : p).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
function stayRevenue(s) { return (s.requests || []).filter(r => r.status === 'confirmed').reduce((a, r) => a + parsePrice(r.price), 0); }
/** Aggregate add-on/experience conversion + revenue across all stays, for the console Upsell panel. */
/** Match a piece of invoice text to a catalog service. Titles in the wild are messy
 *  ("golf cart", "Golf cart rental", "Golf cart — 6-seater · year-round"), so match on the
 *  service's distinctive phrase rather than its exact name. */
const SERVICE_ALIASES = {
  golfcart:     ['golf cart', 'golfcart', 'seater'],
  transfer:     ['airport transfer', 'transfer', 'lrm', 'puj', 'sdq'],
  carrental:    ['car rental', 'carrental'],
  yacht:        ['yacht', 'catamaran'],
  grocery:      ['grocery', 'groceries', 'pre-stocking', 'pre stock', 'prestock', 'stocking', 'supermarket'],
  arrivalmeals: ['arrival meal', 'meal plan', 'chef'],
  privatetravel:['private jet', 'air ambulance', 'private travel'],
  yoga:         ['yoga'],
  massage:      ['massage'],
  babygear:     ['baby gear', 'crib', 'high chair'],
  nannies:      ['nanny', 'nannies', 'babysit'],
  staff:        ['additional staff', 'butler', 'waiter', 'housekeeper'],
  entertainment:['entertainment', 'musician', 'dj '],
  rumcigar:     ['rum', 'cigar'],
};
function serviceKeyFor(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  for (const id of Object.keys(SERVICE_ALIASES)) {
    if (SERVICE_ALIASES[id].some(a => t.indexOf(a) >= 0)) return id;
  }
  return '';
}
function serviceNameFor(id) { const a = allAddOns().find(x => x.id === id); return a ? a.name : ''; }
/** Upsell panel. Rebuilt 2026-07-14 to measure MONEY, not clicks.
 *  It used to count only guest requests that staff had explicitly hit "Confirm" on, and summed the
 *  request's free-text price field — so it read US$0 for golf carts while thousands of dollars of
 *  golf-cart invoices existed. Now: revenue = ISSUED INVOICES (the same source as Total Stay
 *  Charge), and a service counts as booked when it's invoiced. Requests are still reported, but
 *  only as demand (asked / still awaiting) — never as revenue. */
function upsellMetrics() {
  let totalRevenue = 0, paidRevenue = 0, booked = 0, pending = 0, totalReq = 0, staysWithBooking = 0, published = 0;
  const svc = {};
  const bucket = (id, title) => {
    const key = id || 'other';
    return svc[key] || (svc[key] = { id: key, title: (id && serviceNameFor(id)) || title || 'Other', booked: 0, revenue: 0, paid: 0, due: 0, requested: 0, awaiting: 0, items: [] });
  };
  /* Groceries are a pass-through, not a CPH add-on — the guest's supermarket bill flows straight to
     the store, we don't earn on the face value. So they're excluded from the whole Revenue view
     (Invoiced add-ons / Paid / Still to collect / by-service / by-month / cash flow). Unpaid grocery
     invoices still show for chasing in the concierge Today view, which reads a different source. */
  const isGroceryInv = inv => inv.kind === 'grocery' || /grocer|pre[\s-]?stock|provision|supermarket|stocking/i.test(inv.title || '');
  stays.forEach(s => {
    if (s.status === 'published') published++;
    let stayBooked = 0;
    // MONEY — every issued (non-draft) invoice
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      if (isGroceryInv(inv)) return;               // groceries are a pass-through, not an add-on
      const amt = invoiceTotal(inv);
      const isPaid = inv.status === 'paid';
      const id = serviceKeyFor(inv.title) || serviceKeyFor(((inv.items || [])[0] || {}).label);
      const e = bucket(id, inv.title);
      e.booked++; e.revenue += amt;
      if (isPaid) e.paid += amt; else e.due += amt;
      // Per-invoice detail for the collapsible breakdown in the console panel.
      e.items.push({
        stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        no: inv.no || '', title: inv.title || '', total: amt, paid: isPaid,
        checkin: s.checkin || '', dueBy: inv.dueBy || '',
      });
      booked++; stayBooked++; totalRevenue += amt;
      if (isPaid) paidRevenue += amt;
    });
    // DEMAND — guest requests. Counted, never turned into revenue.
    (s.requests || []).forEach(r => {
      if (r.status === 'cancelled') return;
      totalReq++;
      const id = serviceKeyFor((r.refId || '') + ' ' + (r.title || ''));
      const e = bucket(id, r.title);
      e.requested++;
      if (r.status !== 'confirmed' && r.status !== 'done') { e.awaiting++; pending++; }
    });
    if (stayBooked > 0) staysWithBooking++;
  });
  const byService = Object.values(svc).sort((a, b) => (b.revenue - a.revenue) || (b.booked - a.booked) || (b.requested - a.requested));
  byService.forEach(e => e.items.sort((a, b) => (a.paid === b.paid) ? (b.total - a.total) : (a.paid ? 1 : -1))); // unpaid first, then biggest

  // ---- owner dashboard cuts (Revenue view — Jan & Ivonna only) -------------------------------
  const _n = new Date();
  const today = _n.getFullYear() + '-' + String(_n.getMonth() + 1).padStart(2, '0') + '-' + String(_n.getDate()).padStart(2, '0');
  const M = {}, SRC = {}, VIL = {}, CH = {}, PAYEE = { jan: 0, ivonna: 0 }, VILITEMS = {};
  const overdue = [];
  const bump = (map, key, amt, paid) => {
    if (!key) return;
    const e = map[key] || (map[key] = { key, revenue: 0, paid: 0, due: 0, booked: 0 });
    e.revenue += amt; e.booked++; if (paid) e.paid += amt; else e.due += amt;
  };
  stays.forEach(s => {
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      if (isGroceryInv(inv)) return;               // groceries excluded from every owner cut too
      const amt = invoiceTotal(inv);
      const isPaid = inv.status === 'paid';
      // Revenue is attributed to the ARRIVAL month — that's the month the money is earned.
      bump(M, String(s.checkin || '').slice(0, 7), amt, isPaid);
      bump(SRC, (s.source || 'Unknown').trim(), amt, isPaid);
      bump(VIL, (s.villaName || '—').trim(), amt, isPaid);
      // Keep the invoices behind each villa so the console's Top-villas bars can expand to show them.
      { const vk = (s.villaName || '—').trim();
        (VILITEMS[vk] || (VILITEMS[vk] = [])).push({ stayId: s.id, guest: s.leadName || s.lastName || '(no name)', no: inv.no || '', title: inv.title || '', total: amt, paid: isPaid, dueBy: inv.dueBy || '', checkin: s.checkin || '' }); }
      // Which channel booked the SERVICE (per-line bookedVia), falling back to the stay's source.
      const via = ((inv.items || []).map(i => String(i.bookedVia || '').trim()).find(Boolean)) || (s.source || 'Unknown').trim();
      bump(CH, via, amt, isPaid);
      PAYEE[inv.payTo === 'ivonna' ? 'ivonna' : 'jan'] += amt;
      if (!isPaid) {
        const d = String(inv.dueBy || '').trim();
        const days = (d && d < today) ? Math.round((new Date(today) - new Date(d)) / 864e5) : 0;
        overdue.push({ stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
          no: inv.no || '', title: inv.title || '', total: amt, dueBy: d, daysOverdue: days, checkin: s.checkin || '' });
      }
    });
  });
  // ---- GOLF CART EARNINGS (Julio) ------------------------------------------------------------
  // From Jan's "Arrivals Concierge.xlsx" → Golf Carts tab. The rate tier moves with the season
  // (4p: 80/120 · 6p: 105/150/170) but the spread to Julio is ALWAYS the same:
  //     charge − Julio's cost = US$20 per cart, per night.
  // So CPH's cut = 20 × carts × nights, whatever the season. Cost = charge − margin.
  // Only carts supplied by JULIO count — villa/owner carts are not ours to earn on.
  const CART_MARGIN_PER_NIGHT = 20;
  const cartRows = [];
  stays.forEach(s => {
    let charged = 0, margin = 0, cartNights = 0, carts = 0, nights = 0, via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      if (!RE_CART_ANY.test(String(inv.title || ''))) return;
      (inv.items || []).forEach(it => {
        if (!/julio/i.test(String(it.supplier || ''))) return;   // Julio only
        const p = parseCartText(it.label);
        const qty = (p && p.qty) || 1;
        const days = parseFloat(String(it.days || '').replace(/[^0-9.]/g, '')) || nightsBetween(s.checkin, s.checkout) || 0;
        const amt = Number(it.amount) || 0;
        if (!days) return;
        if (!via && it.bookedVia) via = String(it.bookedVia).trim();   // which channel booked THIS cart
        charged += amt; cartNights += qty * days; carts += qty; nights = Math.max(nights, days);
        margin += CART_MARGIN_PER_NIGHT * qty * days;
        if (inv.status === 'paid') paidAmt += amt; else dueAmt += amt;  // has the guest actually paid?
      });
    });
    if (cartNights) cartRows.push({
      stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
      checkin: s.checkin || '', nights, carts, cartNights,
      // Source of the cart = the channel that booked it ("Booked via"), else the stay's own source.
      source: via || (s.source || 'Unknown').trim(),
      charged, cost: charged - margin, margin,
      paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
      upcoming: !!(s.checkout && s.checkout >= today),
    });
  });
  // Which source actually brings the cart money in.
  const cartBySrc = {};
  cartRows.forEach(r => {
    const e = cartBySrc[r.source] || (cartBySrc[r.source] = { key: r.source, bookings: 0, cartNights: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.cartNights += r.cartNights; e.charged += r.charged; e.cost += r.cost; e.margin += r.margin;
  });
  const cartSources = Object.values(cartBySrc).sort((a, b) => b.margin - a.margin);
  cartRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const cartSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + r.cost, margin: a.margin + r.margin,
    cartNights: a.cartNights + r.cartNights,
  }), { charged: 0, cost: 0, margin: 0, cartNights: 0 });
  const cartEarnings = {
    perNight: CART_MARGIN_PER_NIGHT,
    all: cartSum(cartRows),
    upcoming: cartSum(cartRows.filter(r => r.upcoming)),
    rows: cartRows,
    bySource: cartSources,
  };

  // ---- AIRPORT TRANSFER EARNINGS -------------------------------------------------------------
  // Unlike the golf carts (a flat US$20/cart/night spread), transfers earn CPH a straight
  // PERCENTAGE of what the guest is charged: 13%. The supplier keeps the other 87%.
  const TRANSFER_MARGIN_PCT = 0.13;
  const xferRows = [];
  stays.forEach(s => {
    let charged = 0, trips = 0, sup = '', via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      (inv.items || []).forEach(it => {
        const label = String(it.label || '');
        if (!RE_TRANSFER_LINE.test(label) && !RE_TRANSFER_LINE.test(String(inv.title || ''))) return;
        const amt = Number(it.amount) || 0;
        if (!amt) return;
        charged += amt; trips++;
        if (!sup && it.supplier) sup = String(it.supplier).trim();
        if (!via && it.bookedVia) via = String(it.bookedVia).trim();
        if (inv.status === 'paid') paidAmt += amt; else dueAmt += amt;
      });
    });
    if (charged) {
      const margin = Math.round(charged * TRANSFER_MARGIN_PCT * 100) / 100;
      xferRows.push({
        stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        checkin: s.checkin || '', trips, supplier: sup,
        source: via || (s.source || 'Unknown').trim(),
        charged, cost: Math.round((charged - margin) * 100) / 100, margin,
        paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
        upcoming: !!(s.checkout && s.checkout >= today),
      });
    }
  });
  const xferBySrc = {};
  xferRows.forEach(r => {
    const e = xferBySrc[r.source] || (xferBySrc[r.source] = { key: r.source, bookings: 0, trips: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.trips += r.trips; e.charged += r.charged; e.cost += r.cost; e.margin += r.margin;
  });
  const xferSources = Object.values(xferBySrc).sort((a, b) => b.margin - a.margin);
  xferRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const xferSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + r.cost, margin: a.margin + r.margin, trips: a.trips + r.trips,
  }), { charged: 0, cost: 0, margin: 0, trips: 0 });
  const transferEarnings = {
    pct: Math.round(TRANSFER_MARGIN_PCT * 100),
    all: xferSum(xferRows),
    upcoming: xferSum(xferRows.filter(r => r.upcoming)),
    rows: xferRows,
    bySource: xferSources,
  };

  // ---- YACHT CHARTER EARNINGS ----------------------------------------------------------------
  // CPH adds a 28% MARKUP on the boat's price before invoicing the guest. So the guest pays
  // cost × 1.28, and CPH's profit is that 28% (= 28/128 of what the guest is charged).
  const YACHT_MARKUP = 0.28;
  const RE_YACHT_LINE = /yacht|catamaran|charter|boat/i;
  const yachtRows = [];
  stays.forEach(s => {
    let charged = 0, count = 0, sup = '', via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      const yachtInv = inv.kind === 'yacht' || RE_YACHT_LINE.test(String(inv.title || ''));
      (inv.items || []).forEach(it => {
        if (!yachtInv && !RE_YACHT_LINE.test(String(it.label || ''))) return;
        const amt = Number(it.amount) || 0;
        if (!amt) return;
        charged += amt; count++;
        if (!sup && it.supplier) sup = String(it.supplier).trim();
        if (!via && it.bookedVia) via = String(it.bookedVia).trim();
        if (inv.status === 'paid') paidAmt += amt; else dueAmt += amt;
      });
    });
    if (charged) {
      // The yacht LINE amount is the BOAT'S PRICE (cost). CPH adds YACHT_MARKUP on top, and that
      // grossed-up figure is what the guest is invoiced. (The old code treated the line as the guest
      // charge and divided it back down — under-counting the margin. Correct: guest charge = boat
      // price × (1 + markup); e.g. a 2,975 boat line invoices the guest 3,808 at 28%, margin 833.)
      const boatCost = charged;
      const margin = Math.round(boatCost * YACHT_MARKUP * 100) / 100;         // the 28% CPH adds
      const guestCharged = Math.round((boatCost + margin) * 100) / 100;       // what the guest pays
      yachtRows.push({
        stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        checkin: s.checkin || '', count, supplier: sup,
        source: via || (s.source || 'Unknown').trim(),
        charged: guestCharged, cost: boatCost, margin,
        paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
        upcoming: !!(s.checkout && s.checkout >= today),
      });
    }
  });
  yachtRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const yachtSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + r.cost, margin: a.margin + r.margin, count: a.count + r.count,
  }), { charged: 0, cost: 0, margin: 0, count: 0 });
  const yachtBySrc = {};
  yachtRows.forEach(r => {
    const e = yachtBySrc[r.source] || (yachtBySrc[r.source] = { key: r.source, bookings: 0, count: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.count += r.count; e.charged += r.charged; e.cost += r.cost; e.margin += r.margin;
  });
  const yachtEarnings = {
    pct: Math.round(YACHT_MARKUP * 100),
    all: yachtSum(yachtRows),
    upcoming: yachtSum(yachtRows.filter(r => r.upcoming)),
    rows: yachtRows,
    bySource: Object.values(yachtBySrc).sort((a, b) => b.margin - a.margin),
  };

  // ---- CAR RENTAL EARNINGS -------------------------------------------------------------------
  // Like airport transfers, car rentals earn CPH a straight PERCENTAGE of what the guest is
  // charged: 10%. The rental supplier keeps the other 90%. (Golf carts are a separate line — this
  // matches "car rental", never "golf cart".)
  const CARRENTAL_MARGIN_PCT = 0.10;
  const RE_CARRENTAL_LINE = /car\s*rental|rental\s*car|car\s*hire|hertz|avis|europcar|budget\s*rent/i;
  const carRows = [];
  stays.forEach(s => {
    let charged = 0, count = 0, sup = '', via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      (inv.items || []).forEach(it => {
        const label = String(it.label || '');
        if (!RE_CARRENTAL_LINE.test(label) && !RE_CARRENTAL_LINE.test(String(inv.title || ''))) return;
        const amt = Number(it.amount) || 0;
        if (!amt) return;
        charged += amt; count++;
        if (!sup && it.supplier) sup = String(it.supplier).trim();
        if (!via && it.bookedVia) via = String(it.bookedVia).trim();
        if (inv.status === 'paid') paidAmt += amt; else dueAmt += amt;
      });
    });
    if (charged) {
      const margin = Math.round(charged * CARRENTAL_MARGIN_PCT * 100) / 100;
      carRows.push({
        stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        checkin: s.checkin || '', count, supplier: sup,
        source: via || (s.source || 'Unknown').trim(),
        charged, cost: Math.round((charged - margin) * 100) / 100, margin,
        paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
        upcoming: !!(s.checkout && s.checkout >= today),
      });
    }
  });
  const carBySrc = {};
  carRows.forEach(r => {
    const e = carBySrc[r.source] || (carBySrc[r.source] = { key: r.source, bookings: 0, count: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.count += r.count; e.charged += r.charged; e.cost += r.cost; e.margin += r.margin;
  });
  carRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const carSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + r.cost, margin: a.margin + r.margin, count: a.count + r.count,
  }), { charged: 0, cost: 0, margin: 0, count: 0 });
  const carEarnings = {
    pct: Math.round(CARRENTAL_MARGIN_PCT * 100),
    all: carSum(carRows),
    upcoming: carSum(carRows.filter(r => r.upcoming)),
    rows: carRows,
    bySource: Object.values(carBySrc).sort((a, b) => b.margin - a.margin),
  };

  // ---- IN-VILLA SERVICES EARNINGS (chef · massage · nannies · staff · entertainment) ----------
  // Grouped "people we send to the villa" services. CPH earns 18% of what the guest is charged.
  // (If the number is ever unset again — INVILLA_MARGIN_PCT=null — the section reports charged only
  // and marks profit PENDING, and nothing flows into the CPH-earnings roll-up.)
  const INVILLA_MARGIN_PCT = 0.18; // 18% of what the guest is charged
  const RE_INVILLA_LINE = /chef|arrival meal|meal plan|\bcake\b|\bbike\b|bicycle|massage|\bspa\b|nann|babysit|butler|waiter|housekeep|additional staff|entertainment|musician|\bdj\b/i;
  const invillaRows = [];
  stays.forEach(s => {
    let charged = 0, count = 0, sup = '', via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      (inv.items || []).forEach(it => {
        const label = String(it.label || '');
        if (!RE_INVILLA_LINE.test(label) && !RE_INVILLA_LINE.test(String(inv.title || ''))) return;
        const amt = Number(it.amount) || 0;
        if (!amt) return;
        charged += amt; count++;
        if (!sup && it.supplier) sup = String(it.supplier).trim();
        if (!via && it.bookedVia) via = String(it.bookedVia).trim();
        if (inv.status === 'paid') paidAmt += amt; else dueAmt += amt;
      });
    });
    if (charged) {
      const margin = INVILLA_MARGIN_PCT == null ? null : Math.round(charged * INVILLA_MARGIN_PCT * 100) / 100;
      invillaRows.push({
        stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        checkin: s.checkin || '', count, supplier: sup,
        source: via || (s.source || 'Unknown').trim(),
        charged, cost: margin == null ? null : Math.round((charged - margin) * 100) / 100, margin,
        paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
        upcoming: !!(s.checkout && s.checkout >= today),
      });
    }
  });
  const invillaBySrc = {};
  invillaRows.forEach(r => {
    const e = invillaBySrc[r.source] || (invillaBySrc[r.source] = { key: r.source, bookings: 0, count: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.count += r.count; e.charged += r.charged; e.cost += (r.cost || 0); e.margin += (r.margin || 0);
  });
  invillaRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const invillaSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + (r.cost || 0), margin: a.margin + (r.margin || 0), count: a.count + r.count,
  }), { charged: 0, cost: 0, margin: 0, count: 0 });
  const invillaEarnings = {
    pct: INVILLA_MARGIN_PCT == null ? null : Math.round(INVILLA_MARGIN_PCT * 100),
    pending: INVILLA_MARGIN_PCT == null,
    all: invillaSum(invillaRows),
    upcoming: invillaSum(invillaRows.filter(r => r.upcoming)),
    rows: invillaRows,
    bySource: Object.values(invillaBySrc).sort((a, b) => b.margin - a.margin),
  };

  // ---- GROCERIES — movements only (NOT revenue) ----------------------------------------------
  // Groceries are a pass-through; excluded from every revenue number above. This block just
  // surfaces the money MOVING through — charged, collected, still owed — so the volume is visible
  // in the left column without ever being counted as CPH revenue.
  const grocRows = []; let grocCharged = 0, grocPaid = 0, grocDue = 0, grocCount = 0;
  stays.forEach(s => {
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      if (!isGroceryInv(inv)) return;
      const amt = invoiceTotal(inv);
      if (!amt) return;
      const isPaid = inv.status === 'paid';
      grocCharged += amt; grocCount++;
      if (isPaid) grocPaid += amt; else grocDue += amt;
      grocRows.push({ stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
        no: inv.no || '', total: amt, paid: isPaid, dueBy: inv.dueBy || '', checkin: s.checkin || '' });
    });
  });
  grocRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const groceryMovements = { charged: grocCharged, paid: grocPaid, due: grocDue, count: grocCount, rows: grocRows };

  // ---- GROCERY EARNINGS (pick-up & delivery fee) ---------------------------------------------
  // Groceries are mostly a pass-through — the supermarket bill and the service fee flow straight
  // out — but CPH keeps the PICK-UP & DELIVERY fee on each grocery invoice. That fee is CPH's
  // earning; everything else on the invoice is the guest's grocery bill. Reported here in the
  // same shape as the other earnings sections so it slots into the CPH earnings roll-up.
  //   charged = full grocery invoice value (sub-total + service fee + pick-up)
  //   margin  = pick-up & delivery fee (what CPH keeps)   ·   cost = charged − margin
  const grocEarnRows = [];
  stays.forEach(s => {
    let charged = 0, margin = 0, count = 0, via = '', paidAmt = 0, dueAmt = 0;
    (s.invoices || []).forEach(inv => {
      if (inv.status === 'draft') return;
      if (!isGroceryInv(inv)) return;
      const g = groceryBreakdown(inv);
      const pickup = Number(g.pickup) || 0;
      const chg = Number(g.totalUSD) || 0;            // full invoice value (sub + service fee + pick-up)
      if (!chg && !pickup) return;
      charged += chg; margin += pickup; count++;
      if (!via) { const v = (inv.items || []).map(it => String(it.bookedVia || '').trim()).find(Boolean); if (v) via = v; }
      if (inv.status === 'paid') paidAmt += chg; else dueAmt += chg;
    });
    if (count) grocEarnRows.push({
      stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
      checkin: s.checkin || '', count,
      source: via || (s.source || 'Unknown').trim(),
      charged: Math.round(charged * 100) / 100, margin: Math.round(margin * 100) / 100,
      cost: Math.round((charged - margin) * 100) / 100,
      paidAmt, dueAmt, paid: dueAmt === 0, partly: paidAmt > 0 && dueAmt > 0,
      upcoming: !!(s.checkout && s.checkout >= today),
    });
  });
  const grocEarnBySrc = {};
  grocEarnRows.forEach(r => {
    const e = grocEarnBySrc[r.source] || (grocEarnBySrc[r.source] = { key: r.source, bookings: 0, count: 0, charged: 0, cost: 0, margin: 0 });
    e.bookings++; e.count += r.count; e.charged += r.charged; e.cost += r.cost; e.margin += r.margin;
  });
  grocEarnRows.sort((a, b) => String(a.checkin).localeCompare(String(b.checkin)));
  const grocEarnSum = list => list.reduce((a, r) => ({
    charged: a.charged + r.charged, cost: a.cost + r.cost, margin: a.margin + r.margin, count: a.count + r.count,
  }), { charged: 0, cost: 0, margin: 0, count: 0 });
  const groceryEarnings = {
    all: grocEarnSum(grocEarnRows),
    upcoming: grocEarnSum(grocEarnRows.filter(r => r.upcoming)),
    rows: grocEarnRows,
    bySource: Object.values(grocEarnBySrc).sort((a, b) => b.margin - a.margin),
  };

  // ---- TOTAL CPH EARNINGS --------------------------------------------------------------------
  // What WE actually made, across the services where we take a margin — NOT what was invoiced.
  // (Groceries deliberately excluded: they're a pass-through, not a CPH margin line.)
  // ---- SERVICE FEES (kept by CPH in full) ----------------------------------------------------
  // Most invoices add a service/legal fee % on top of the base service lines (e.g. golf-cart 10%,
  // in-villa 18%). That fee is money the guest pays and CPH keeps entirely, so it's pure margin.
  // Summed here as its own income line so the earnings roll-up reconciles with Invoiced add-ons.
  // Excluded: yacht invoices (their markup is already inside the yacht section's charged) and flat
  // extras like pick-up & delivery (a pass-through, not CPH income).
  let serviceFeeIncome = 0;
  stays.forEach(s => (s.invoices || []).forEach(inv => {
    if (inv.status === 'draft' || isGroceryInv(inv)) return;
    if (inv.kind === 'yacht' || /yacht|catamaran|charter|boat/i.test(inv.title || '')) return;
    const total = invoiceTotal(inv);
    const lines = (inv.items || []).reduce((a, it) => a + (Number(it.amount) || 0), 0);
    const extras = (inv.extras || []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const fee = Math.round((total - lines - extras) * 100) / 100;
    if (fee > 0.005) serviceFeeIncome += fee;
  }));
  serviceFeeIncome = Math.round(serviceFeeIncome * 100) / 100;

  const earnParts = [
    { key: 'Golf carts', margin: cartEarnings.all.margin, charged: cartEarnings.all.charged },
    { key: 'Car rentals', margin: carEarnings.all.margin, charged: carEarnings.all.charged },
    { key: 'Airport transfers', margin: transferEarnings.all.margin, charged: transferEarnings.all.charged },
    { key: 'Yacht charters', margin: yachtEarnings.all.margin, charged: yachtEarnings.all.charged },
    { key: 'In-villa services', margin: invillaEarnings.all.margin, charged: invillaEarnings.all.charged },
    { key: 'Groceries', margin: groceryEarnings.all.margin, charged: groceryEarnings.all.charged },
    { key: 'Service fees', margin: serviceFeeIncome, charged: serviceFeeIncome },
  ].filter(p => p.margin > 0).sort((a, b) => b.margin - a.margin);
  const totalEarnings = {
    margin: earnParts.reduce((a, p) => a + p.margin, 0),
    charged: earnParts.reduce((a, p) => a + p.charged, 0),
    upcomingMargin: cartEarnings.upcoming.margin + carEarnings.upcoming.margin + transferEarnings.upcoming.margin + yachtEarnings.upcoming.margin + invillaEarnings.upcoming.margin + groceryEarnings.upcoming.margin,
    parts: earnParts,
  };

  // ---- CASH FLOW — when the outstanding money is due -------------------------------------------
  const cashByMonth = {};
  overdue.forEach(o => {
    const key = o.dueBy ? String(o.dueBy).slice(0, 7) : 'nodate';
    const e = cashByMonth[key] || (cashByMonth[key] = { key, total: 0, count: 0, overdue: 0, items: [] });
    e.total += o.total; e.count++;
    e.items.push(o);                       // the actual invoices behind the bar — the console expands these
    if (o.daysOverdue > 0) e.overdue += o.total;
  });
  Object.values(cashByMonth).forEach(e => e.items.sort((a, b) => String(a.dueBy).localeCompare(String(b.dueBy)) || (b.total - a.total)));
  const cashFlow = Object.values(cashByMonth)
    .sort((a, b) => (a.key === 'nodate' ? 1 : b.key === 'nodate' ? -1 : a.key.localeCompare(b.key)));

  const sortRev = o => Object.values(o).sort((a, b) => b.revenue - a.revenue);
  const byMonth = Object.values(M).sort((a, b) => a.key.localeCompare(b.key)); // chronological — it's a trend
  // Unpaid invoices are ordered BY DUE DATE — soonest first, so anything already past its date sits
  // at the very top and the next thing to chase is right under it. Invoices with no due date at all
  // fall to the bottom (nothing to chase them against), biggest first.
  overdue.sort((a, b) => {
    if (a.dueBy && b.dueBy) return a.dueBy.localeCompare(b.dueBy) || (b.total - a.total);
    if (a.dueBy) return -1;
    if (b.dueBy) return 1;
    return b.total - a.total;
  });

  return {
    totalRevenue, paidRevenue, dueRevenue: totalRevenue - paidRevenue, booked, pending, totalReq, published,
    staysWithBooking, staysWithConfirmed: staysWithBooking, // legacy key
    attachRate: published ? Math.round(staysWithBooking / published * 100) : 0,
    avgPerBooking: booked ? totalRevenue / booked : 0,
    avgPerStay: staysWithBooking ? totalRevenue / staysWithBooking : 0,
    byService, byMonth, bySource: sortRev(SRC),
    byVilla: sortRev(VIL).slice(0, 10).map(v => ({ ...v, items: (VILITEMS[v.key] || []).sort((a, b) => (a.paid === b.paid) ? (b.total - a.total) : (a.paid ? 1 : -1)) })),
    byChannel: sortRev(CH),
    byPayee: PAYEE, overdue, overdueTotal: overdue.filter(o => o.daysOverdue > 0).reduce((a, o) => a + o.total, 0),
    cartEarnings, carEarnings, transferEarnings, yachtEarnings, invillaEarnings, totalEarnings, cashFlow,
    groceryMovements, groceryEarnings,
  };
}

// ---------------------------------------------- supplier payables (Jan only)
// "What CPH still owes suppliers." Only PAID invoices count — you owe the supplier once the
// guest's money is actually in. Covers golf carts (Julio: cost = charge − US$20/cart/night) and
// airport transfers (the supplier keeps 87%, CPH keeps 13%). Each payable can be ticked off as
// settled once Jan has paid that supplier; the settled state persists in payables.json.
const PAY_CART_MARGIN_PER_NIGHT = 20;
const PAY_TRANSFER_MARGIN_PCT = 0.13;
function payables() {
  const _n = new Date();
  const today = _n.getFullYear() + '-' + String(_n.getMonth() + 1).padStart(2, '0') + '-' + String(_n.getDate()).padStart(2, '0');
  const round = v => Math.round((Number(v) || 0) * 100) / 100;
  const rows = [];
  const attach = base => {
    base.margin = round(base.charged - base.cost);         // CPH profit = what's charged − supplier cost
    const st = payablesSettled[base.key] || null;
    // Only a guest-PAID invoice can be "settled with the supplier"; unpaid ones are never owed yet.
    base.settled = !!(base.guestPaid && st && st.settled);
    base.settledAmount = st ? Number(st.amount) || 0 : 0;
    base.settledAt = st ? st.at || 0 : 0;
    // invoice edited after Jan settled it → the amount owed no longer matches what he paid
    base.changed = base.settled && Math.round(base.settledAmount) !== Math.round(base.cost);
    return base;
  };
  stays.forEach(s => {
    const meta = {
      stayId: s.id, guest: s.leadName || s.lastName || '(no name)', villa: s.villaName || '',
      villaInternal: (s.villaInternal || '').trim(),   // internal property name (e.g. "Bahia Minitas 3")
      checkin: s.checkin || '', checkout: s.checkout || '',   // arrival + departure
      upcoming: !!(s.checkout && s.checkout >= today),
      // CPH booking agent = the internal owner of the reservation (ivonna | jan), staff-only field.
      cphAgent: (s.bookingAgent || '').trim(),
      // Booking source = the channel/OTA the villa was booked through (Direct, Rental Escapes, …).
      bookingSource: (s.source || '').trim(),
    };
    (s.invoices || []).forEach(inv => {
      if (inv.status !== 'paid' && inv.status !== 'sent') return;   // skip drafts; include sent (unpaid) + paid
      const guestPaid = inv.status === 'paid';           // has the guest actually paid this invoice?
      const invNo = inv.no || '', paidAt = inv.paidAt || 0;
      // --- golf carts (Julio only) ---
      let cAmt = 0, cCost = 0, carts = 0, cartNights = 0, nights = 0, cSup = '', cVia = '';
      (inv.items || []).forEach(it => {
        if (!/julio/i.test(String(it.supplier || ''))) return;
        if (!RE_CART_ANY.test(String(it.label || '')) && !RE_CART_ANY.test(String(inv.title || ''))) return;
        const p = parseCartText(it.label); const qty = (p && p.qty) || 1;
        const days = parseFloat(String(it.days || '').replace(/[^0-9.]/g, '')) || nightsBetween(s.checkin, s.checkout) || 0;
        const amt = Number(it.amount) || 0; if (!days || !amt) return;
        cAmt += amt; carts += qty; cartNights += qty * days; nights = Math.max(nights, days);
        cCost += amt - (PAY_CART_MARGIN_PER_NIGHT * qty * days);
        if (!cSup) cSup = String(it.supplier).trim(); if (!cVia && it.bookedVia) cVia = String(it.bookedVia).trim();
      });
      if (cartNights) rows.push(attach(Object.assign({}, meta, {
        key: inv.id + ':cart', invoiceId: inv.id, invoiceNo: invNo, paidAt,
        category: 'cart', supplier: cSup || 'Julio', via: cVia, guestPaid,
        // booking agent: the channel that booked THIS cart, else the stay's own source
        source: cVia || (s.source || 'Unknown').trim(),
        detail: carts + '× cart · ' + nights + 'n',
        charged: round(cAmt), cost: round(cCost),
      })));
      // --- airport transfers ---
      let tAmt = 0, tCost = 0, trips = 0, tSup = '', tVia = '';
      (inv.items || []).forEach(it => {
        const label = String(it.label || '');
        if (!RE_TRANSFER_LINE.test(label) && !RE_TRANSFER_LINE.test(String(inv.title || ''))) return;
        const amt = Number(it.amount) || 0; if (!amt) return;
        tAmt += amt; trips++; tCost += amt * (1 - PAY_TRANSFER_MARGIN_PCT);
        if (!tSup && it.supplier) tSup = String(it.supplier).trim(); if (!tVia && it.bookedVia) tVia = String(it.bookedVia).trim();
      });
      if (tAmt) rows.push(attach(Object.assign({}, meta, {
        key: inv.id + ':transfer', invoiceId: inv.id, invoiceNo: invNo, paidAt,
        category: 'transfer', supplier: tSup || '(supplier not set)', via: tVia, guestPaid,
        // booking agent: the channel that booked THIS transfer, else the stay's own source
        source: tVia || (s.source || 'Unknown').trim(),
        detail: trips + ' leg' + (trips === 1 ? '' : 's'),
        charged: round(tAmt), cost: round(tCost),
      })));
    });
  });
  // Unpaid (awaiting the guest) first so Jan sees what's coming, then paid, each block by check-in.
  rows.sort((a, b) => (a.guestPaid === b.guestPaid ? String(a.checkin).localeCompare(String(b.checkin)) : (a.guestPaid ? 1 : -1)));
  // group by supplier — the actionable unit is "pay this vendor US$X"
  const bySupMap = {};
  rows.forEach(r => {
    const e = bySupMap[r.supplier] || (bySupMap[r.supplier] = { supplier: r.supplier, category: r.category, count: 0, cost: 0, outstanding: 0, settled: 0, pending: 0, profit: 0, rows: [] });
    e.count++; e.cost += r.cost; e.profit += r.margin;
    if (!r.guestPaid) e.pending += r.cost;               // guest hasn't paid → not owed yet
    else if (r.settled) e.settled += r.cost;             // paid to the supplier already
    else e.outstanding += r.cost;                        // paid by guest, still to pay the supplier
    if (e.category !== r.category) e.category = 'mixed';
    e.rows.push(r);
  });
  const bySupplier = Object.values(bySupMap)
    .map(e => Object.assign(e, { cost: round(e.cost), outstanding: round(e.outstanding), settled: round(e.settled), pending: round(e.pending), profit: round(e.profit) }))
    .sort((a, b) => b.outstanding - a.outstanding || b.pending - a.pending || b.cost - a.cost);
  const paid = rows.filter(r => r.guestPaid), unpaid = rows.filter(r => !r.guestPaid);
  const sum = (list, f) => round(list.reduce((a, r) => a + f(r), 0));
  const byCat = cat => { const rs = rows.filter(r => r.category === cat); const rp = rs.filter(r => r.guestPaid); return { count: rs.length, cost: sum(rs, r => r.cost), outstanding: sum(rp.filter(r => !r.settled), r => r.cost), pending: sum(rs.filter(r => !r.guestPaid), r => r.cost), profit: sum(rs, r => r.margin) }; };
  return {
    // supplier side — what Jan owes vendors
    toPay: sum(paid.filter(r => !r.settled), r => r.cost),   // guest paid, supplier not yet paid → pay now
    settled: sum(paid.filter(r => r.settled), r => r.cost),  // already paid to the supplier
    pending: sum(unpaid, r => r.cost),                       // supplier cost that becomes due once the guest pays
    // profit side — what Jan books as CPH earnings
    profit: sum(paid, r => r.margin),                        // realised profit (guest has paid)
    profitPending: sum(unpaid, r => r.margin),               // profit still to come (guest hasn't paid)
    totalCharged: sum(rows, r => r.charged),
    count: rows.length, paidCount: paid.length, unpaidCount: unpaid.length,
    cart: byCat('cart'), transfer: byCat('transfer'),
    bySupplier, rows,
  };
}
/** Mark a supplier payable settled (Jan paid the supplier) or clear it. amount = cost at settle time. */
function setPayableSettled(key, settled, amount) {
  key = String(key || ''); if (!key) return false;
  if (settled) payablesSettled[key] = { settled: true, amount: Number(amount) || 0, at: Date.now() };
  else delete payablesSettled[key];
  persistPayables(); return true;
}

// ---------------------------------------------- scheduled guest message automations
function daysFromToday(iso) { const d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return null; const t = new Date(new Date().toDateString()); return Math.round((d - t) / 864e5); }
function pushAutoMsg(s, text) { if (!Array.isArray(s.messages)) s.messages = []; s.messages.push({ id: genId(), from: 'concierge', text: norm(text).slice(0, 1000), at: Date.now(), auto: true }); s.updatedAt = Date.now(); }
/** Runs the pre-arrival / arrival / post-stay message sequence. Each message sends once per stay
 *  (tracked in s.autoSent). Returns the sent items so the server can also email/WhatsApp the guest. */
function runAutomations() {
  const sent = [];
  stays.forEach(s => {
    if (s.status !== 'published' || !s.checkin) return;
    s.autoSent = s.autoSent || {};
    const dIn = daysFromToday(s.checkin);
    const dOut = s.checkout ? daysFromToday(s.checkout) : null;
    const name = (s.leadName || '').split(' ')[0] || 'there';
    const conc = ((CONCIERGES.find(c => c.id === s.conciergeId) || CONCIERGES[0] || {}).name) || 'your concierge';
    // 1) Pre check-in reminder — 1–7 days before arrival, only if not yet submitted
    if (dIn != null && dIn >= 1 && dIn <= 7 && !s.guestCheckin && !s.autoSent.precheckin) {
      const text = `Hi ${name}, your arrival on ${s.checkin} is coming up. Please complete your pre check-in in the app so we can arrange your airport transfer and have your villa ready.`;
      pushAutoMsg(s, text); s.autoSent.precheckin = true;
      sent.push({ stayId: s.id, ref: s.reference, email: s.email || '', phone: s.phone || '', subject: 'Complete your pre check-in', text });
    }
    // 2) Arrival-day welcome
    if (dIn === 0 && !s.autoSent.arrival) {
      const wifi = s.wifiName ? ` Wi-Fi: ${s.wifiName}${s.wifiPassword ? ' / ' + s.wifiPassword : ''}.` : '';
      const text = `Welcome to Casa de Campo, ${name}! Your villa is ready.${wifi} ${conc} is on hand for anything you need — just message here.`;
      pushAutoMsg(s, text); s.autoSent.arrival = true;
      sent.push({ stayId: s.id, ref: s.reference, email: s.email || '', phone: s.phone || '', subject: 'Welcome — your villa is ready', text });
    }
    // 3) Post-stay thank-you — the day after checkout (or later)
    if (dOut != null && dOut <= -1 && !s.autoSent.poststay) {
      const text = `Thank you for staying with us, ${name}. It was a pleasure hosting you at Casa de Campo. If you have a moment we'd love your feedback, and we hope to welcome you back soon.`;
      pushAutoMsg(s, text); s.autoSent.poststay = true;
      sent.push({ stayId: s.id, ref: s.reference, email: s.email || '', phone: s.phone || '', subject: 'Thank you for your stay', text });
    }
  });
  if (sent.length) persistStays();
  return sent;
}
function createStay() { const s = blankStay(); stays.push(s); persistStays(); return s; }
// The arrivals-board "Super" column (`provisioning`, imported from the old Excel sheet) and the
// Grocery pre-stocking "Provisioning (Super)" picker (`grocerySuper`) are ONE value shown in two
// places. Whichever side writes, both fields are set — never let them drift apart.
function syncProvisioning(s, patch) {
  const hasG = patch && 'grocerySuper' in patch, hasP = patch && 'provisioning' in patch;
  if (hasG && !hasP) s.provisioning = s.grocerySuper || '';
  else if (hasP && !hasG) s.grocerySuper = s.provisioning || '';
  else if (hasG && hasP) { const v = s.grocerySuper || s.provisioning || ''; s.grocerySuper = v; s.provisioning = v; }
  return s;
}
// One-time backfill: legacy bookings only carry the imported `provisioning` value, so the console
// picker showed "— none —" while the board showed e.g. NARCISSA. Copy it across on boot.
(function backfillProvisioning() {
  let fixed = 0;
  stays.forEach(s => {
    const g = String(s.grocerySuper || '').trim(), p = String(s.provisioning || '').trim();
    if (!g && p) { s.grocerySuper = p; fixed++; }
    else if (g && !p) { s.provisioning = g; fixed++; }
  });
  if (fixed) { console.log('[provisioning] synced Super/grocerySuper on %d stay(s)', fixed); persistStays(); }
})();

function saveStay(id, patch) {
  const s = getStay(id); if (!s) return null;
  const allowed = ['leadName','lastName','email','phone','source','adults','children','villaId','villaName','villaArea','villaView','villaSuites','villaSleeps','villaInternal','heroPhoto','checkin','checkout','checkinTime','checkoutTime','staffIncluded','staffHours','airport','flight','transferArranged','offeredAddOnIds','conciergeId','assigneeId','internalNotes','wifiHandover','welcomeMessage','status','wifiName','wifiPassword','villaNumber','registrationNumber','followUpDate','followUpNote','followUps','depositReminderAdded','paymentStatus','balanceDue','securityDeposit','totalCharge','amountPaid','balanceDueBy','agent','cartConfig','staffCount','accessCodes','transferNote','provisioning','extras','bookingAgent','rowColor','grocerySuper','groceryDeposit','groceryDepositPaid','grocery','mealPlan','guestList'];
  allowed.forEach(k => { if (k in patch) s[k] = patch[k]; });
  // Staff may edit the registration list from the console — sanitise exactly like the guest-submitted path.
  if ('guestList' in patch) s.guestList = sanitizeGuestList(patch.guestList);
  syncProvisioning(s, patch); // board Super ↔ grocery Provisioning (Super) are one field

  s.updatedAt = Date.now();
  persistStays(); return s;
}
function publishStay(id) { return saveStay(id, { status: 'published' }); }
function deleteStay(id) { const i = stays.findIndex(s => s.id === id); if (i < 0) return false; stays.splice(i, 1); persistStays(); return true; }

// ----------------------------------------------------- guest interest requests
function findPublishedStayByRef(reference) {
  const ref = norm(reference).toLowerCase();
  return stays.find(x => x.status === 'published' && norm(x.reference).toLowerCase() === ref) || null;
}
/** A guest taps "Add to itinerary" or requests an add-on; capture date/time/party size. */
function addRequest(reference, body) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  if (!Array.isArray(s.requests)) s.requests = [];
  const req = {
    id: genId(),
    type: body.type === 'addon' ? 'addon' : 'explore',
    refId: norm(body.refId).slice(0, 60),
    title: norm(body.title).slice(0, 120),
    date: norm(body.date).slice(0, 20),
    endDate: norm(body.endDate).slice(0, 20),
    cartType: norm(body.cartType).slice(0, 30),
    serviceLevel: norm(body.serviceLevel).slice(0, 30),
    time: norm(body.time).slice(0, 20),
    guests: Math.max(0, Math.min(99, Number(body.guests) || 0)),
    note: norm(body.note).slice(0, 300),
    familyName: norm(body.familyName).slice(0, 60), // head-of-family / group label to tell multiple same-type bookings apart (e.g. two airport transfers)
    airline: norm(body.airline).slice(0, 40),         // arrival flight details captured on the private airport transfer
    flightNo: norm(body.flightNo).slice(0, 24),
    flightOrigin: norm(body.flightOrigin).slice(0, 60),
    arrivalTime: norm(body.arrivalTime).slice(0, 40),
    returnAirline: norm(body.returnAirline).slice(0, 40),   // return/departure flight details (round-trip transfer)
    returnFlightNo: norm(body.returnFlightNo).slice(0, 24),
    returnDest: norm(body.returnDest).slice(0, 60),
    returnTime: norm(body.returnTime).slice(0, 40),
    status: 'pending',
    price: '',
    suggestedPrice: norm(body.suggestedPrice).slice(0, 30),
    createdAt: Date.now(),
  };
  s.requests.push(req); s.updatedAt = Date.now(); persistStays(); return req;
}
/** Guest cancels one of their own requests. We DON'T delete it — we mark it
 *  cancelled so the concierge keeps a record (log) of it in the Console. */
/** Guest edits one of their own requests. Changing details sends it back to 'pending' so the
 *  concierge re-confirms (and clears any prior price). */
function updateGuestRequest(reference, requestId, body) {
  const s = findPublishedStayByRef(reference); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  // Guests may not edit a request the concierge already arranged (done) or one that was cancelled —
  // an edit would silently un-arrange it / resurrect it. They can message the concierge instead.
  if (r.status === 'done' || r.status === 'cancelled') return null;
  if (body.date != null) r.date = norm(body.date).slice(0, 20);
  if (body.endDate != null) r.endDate = norm(body.endDate).slice(0, 20);
  if (body.cartType != null) r.cartType = norm(body.cartType).slice(0, 30);
  if (body.serviceLevel != null) r.serviceLevel = norm(body.serviceLevel).slice(0, 40);
  if (body.time != null) r.time = norm(body.time).slice(0, 20);
  if (body.guests != null) r.guests = Math.max(0, Math.min(99, Number(body.guests) || 0));
  if (body.note != null) r.note = norm(body.note).slice(0, 300);
  if (body.familyName != null) r.familyName = norm(body.familyName).slice(0, 60);
  if (body.airline != null) r.airline = norm(body.airline).slice(0, 40);
  if (body.flightNo != null) r.flightNo = norm(body.flightNo).slice(0, 24);
  if (body.flightOrigin != null) r.flightOrigin = norm(body.flightOrigin).slice(0, 60);
  if (body.arrivalTime != null) r.arrivalTime = norm(body.arrivalTime).slice(0, 40);
  if (body.returnAirline != null) r.returnAirline = norm(body.returnAirline).slice(0, 40);
  if (body.returnFlightNo != null) r.returnFlightNo = norm(body.returnFlightNo).slice(0, 24);
  if (body.returnDest != null) r.returnDest = norm(body.returnDest).slice(0, 60);
  if (body.returnTime != null) r.returnTime = norm(body.returnTime).slice(0, 40);
  r.status = 'pending'; r.price = ''; r.confirmedAt = ''; r.doneAt = ''; r.updatedAt = Date.now();
  s.updatedAt = Date.now(); persistStays(); return r;
}
function removeGuestRequest(reference, requestId) {
  const s = findPublishedStayByRef(reference); if (!s || !Array.isArray(s.requests)) return false;
  const r = s.requests.find(r => r.id === requestId); if (!r) return false;
  r.status = 'cancelled'; r.cancelledAt = Date.now();
  s.updatedAt = Date.now(); persistStays(); return true;
}
/** Staff dismisses a request (e.g. once actioned) from the Console. */
function removeStaffRequest(stayId, requestId) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return false;
  const i = s.requests.findIndex(r => r.id === requestId); if (i < 0) return false;
  // Don't hard-delete a request that an invoice is linked to — that would dangle the
  // invoice's requestId and drop the "linked / cancelled" review flag. Soft-cancel instead.
  if (Array.isArray(s.invoices) && s.invoices.some(iv => iv.requestId === requestId)) {
    const r = s.requests[i];
    if (r.status !== 'cancelled') { r.status = 'cancelled'; r.cancelledAt = Date.now(); }
    s.updatedAt = Date.now(); persistStays(); return true;
  }
  s.requests.splice(i, 1); s.updatedAt = Date.now(); persistStays(); return true;
}
/** Staff marks a request done (arranged). We KEEP it as a record (status='done') so it stays
 *  visible/greyed and logged in the activity timeline, instead of vanishing. */
function markRequestDone(stayId, requestId) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  if (r.status === 'cancelled') return null;
  r.status = 'done'; r.doneAt = Date.now(); s.updatedAt = Date.now(); persistStays(); return r;
}
/** Staff reopens a previously done (or cancelled) request so it can be edited / re-arranged.
 *  Returns it to the active queue: clears the done/cancelled status and timestamp. */
function reopenRequest(stayId, requestId) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  r.status = ''; r.doneAt = ''; r.cancelledAt = ''; r.reopenedAt = Date.now(); s.updatedAt = Date.now(); persistStays(); return r;
}
/** Staff sets/updates the head-of-family / group label on a request (to tell multiple same-type bookings apart). */
function setRequestFamily(stayId, requestId, name) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  r.familyName = norm(name).slice(0, 60); s.updatedAt = Date.now(); persistStays(); return r;
}
/** Staff edit-all: the console can edit every field of a request. Only fields present in body
 *  are touched. Status/price are preserved unless price is explicitly provided. Two-way sync:
 *  the same request object feeds toGuestStay, so edits land in the guest's My Plan on next poll. */
function staffUpdateRequest(stayId, requestId, body) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  body = body || {};
  if (body.title != null) r.title = norm(body.title).slice(0, 80);
  if (body.date != null) r.date = norm(body.date).slice(0, 20);
  if (body.endDate != null) r.endDate = norm(body.endDate).slice(0, 20);
  if (body.cartType != null) r.cartType = norm(body.cartType).slice(0, 30);
  if (body.serviceLevel != null) r.serviceLevel = norm(body.serviceLevel).slice(0, 40);
  if (body.time != null) r.time = norm(body.time).slice(0, 20);
  if (body.guests != null) r.guests = (('' + body.guests).trim() === '') ? '' : Math.max(0, Math.min(99, Number(body.guests) || 0));
  if (body.note != null) r.note = norm(body.note).slice(0, 300);
  if (body.familyName != null) r.familyName = norm(body.familyName).slice(0, 60);
  if (body.airline != null) r.airline = norm(body.airline).slice(0, 40);
  if (body.flightNo != null) r.flightNo = norm(body.flightNo).slice(0, 24);
  if (body.flightOrigin != null) r.flightOrigin = norm(body.flightOrigin).slice(0, 60);
  if (body.arrivalTime != null) r.arrivalTime = norm(body.arrivalTime).slice(0, 40);
  if (body.returnAirline != null) r.returnAirline = norm(body.returnAirline).slice(0, 40);
  if (body.returnFlightNo != null) r.returnFlightNo = norm(body.returnFlightNo).slice(0, 24);
  if (body.returnDest != null) r.returnDest = norm(body.returnDest).slice(0, 60);
  if (body.returnTime != null) r.returnTime = norm(body.returnTime).slice(0, 40);
  if (body.price != null) r.price = norm(body.price).slice(0, 24);
  if (body.supplier != null) r.supplier = norm(body.supplier).slice(0, 80); // internal supplier (staff-only; stripped from toGuestStay, exported to arrivals board)
  if (body.bookedVia != null) r.bookedVia = norm(body.bookedVia).slice(0, 80); // booking channel for THIS service (staff-only; stripped from toGuestStay, exported to arrivals board)
  r.updatedAt = Date.now(); s.updatedAt = Date.now(); persistStays(); return r;
}
/** Guest submits/updates their grocery pre-stocking list. Persisted on the stay so it survives
 *  reloads and shows in the Concierge Console. */
function saveGrocery(reference, data) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  data = data || {};
  const items = Array.isArray(data.items) ? data.items.slice(0, 500).map(it => ({
    category: norm(it && it.category).slice(0, 60),
    name: norm(it && it.name).slice(0, 80),
    qty: Math.max(1, Math.min(99, parseInt(it && it.qty, 10) || 1)),
  })).filter(it => it.name) : [];
  const other = {};
  if (data.other && typeof data.other === 'object') {
    Object.keys(data.other).slice(0, 60).forEach(k => { const v = norm(data.other[k]).slice(0, 300); if (v) other[norm(k).slice(0, 60)] = v; });
  }
  s.grocery = { items, other, note: norm(data.note).slice(0, 600), updatedAt: Date.now() };
  s.updatedAt = Date.now(); persistStays(); return s.grocery;
}
/** Guest submits/updates their arrival-meals plan (breakfast / lunch / dinner each with date,
 *  time, guests and dishes). Persisted on the stay; shows in the Concierge Console. */
function saveMealPlan(reference, data) {
  const s = findPublishedStayByRef(reference); if (!s) return null; data = data || {};
  const out = { updatedAt: Date.now(), note: norm(data.note).slice(0, 600) };
  ['snacks', 'breakfast', 'lunch', 'dinner'].forEach(k => {
    const m = data[k] || {};
    out[k] = { date: norm(m.date).slice(0, 20), time: norm(m.time).slice(0, 20), guests: norm(m.guests).slice(0, 10), desc: norm(m.desc).slice(0, 500) };
  });
  // extra meals the guest added beyond the standard slots (any number of days/meals)
  out.extra = (Array.isArray(data.extra) ? data.extra : []).slice(0, 16).map(m => ({
    type: norm(m && m.type).slice(0, 40), date: norm(m && m.date).slice(0, 20), time: norm(m && m.time).slice(0, 20),
    guests: norm(m && m.guests).slice(0, 10), desc: norm(m && m.desc).slice(0, 500)
  })).filter(m => m.type || m.date || m.time || m.guests || m.desc);
  s.mealPlan = out; s.updatedAt = Date.now(); persistStays(); return out;
}
/** Shared shape guard for the registration list — used by both the guest submit and the console editor. */
function sanitizeGuestList(guests) {
  if (!Array.isArray(guests)) return [];
  const seen = new Set();
  return guests.slice(0, 40)
    .map(g => ({ name: norm(g && g.name).slice(0, 80), passport: norm(g && g.passport).slice(0, 40) }))
    .filter(g => g.name || g.passport)
    // Drop exact repeats (same name + same passport) — a guest submitting while staff had the list open
    // used to produce doubled rows. Same name with a DIFFERENT passport is kept: they're two people.
    .filter(g => { const k = g.name.toLowerCase() + '|' + g.passport.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Guest submits the pre-arrival guest list (names + passport numbers) for resort registration. */
function setGuestList(reference, guests) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  if (!Array.isArray(guests)) return null;
  s.guestList = sanitizeGuestList(guests);
  s.updatedAt = Date.now(); persistStays(); return s.guestList;
}
/** Guest submits pre check-in (airport, transfer, party, flight, occasion, dietary) — persist
 *  it on the stay so the concierge sees it in the Console. Does NOT overwrite staff fields. */
function saveCheckin(reference, data) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  data = data || {};
  const tt = data.transferType === 'oneway' ? 'oneway' : data.transferType === 'roundtrip' ? 'roundtrip' : '';
  s.guestCheckin = {
    airport: norm(data.airport).slice(0, 8),
    transferType: tt,
    adults: Math.max(0, Math.min(40, parseInt(data.adults, 10) || 0)),
    children: Math.max(0, Math.min(40, parseInt(data.children, 10) || 0)),
    childAges: Array.isArray(data.childAges) ? data.childAges.slice(0, 40).map(a => { const n = parseInt(a, 10); return (Number.isFinite(n) && n >= 0 && n <= 17) ? n : ''; }) : [],
    flight: norm(data.flight).slice(0, 120),
    occasion: norm(data.occasion).slice(0, 60),
    dietary: norm(data.dietary).slice(0, 600),
    transportMode: (data.transportMode === 'organize' || data.transportMode === 'self') ? data.transportMode : '',
    transportCompany: norm(data.transportCompany).slice(0, 120),
    transportArrival: norm(data.transportArrival).slice(0, 160),
    transportDeparture: norm(data.transportDeparture).slice(0, 160),
    submittedAt: Date.now(),
  };
  // Keep the staff-facing arrival fields in sync with what the guest actually submitted,
  // so the console's "Arrival airport / Flight" always reflect the guest's real arrival.
  if (s.guestCheckin.airport) s.airport = s.guestCheckin.airport;
  if (s.guestCheckin.flight) s.flight = s.guestCheckin.flight;
  s.updatedAt = Date.now(); persistStays(); return s.guestCheckin;
}
/** Staff resets a single pre-arrival SECTION so the guest re-does just that part (not a blanket wipe).
 *  part: 'party' (adults/children/ages) | 'documents'|'passports' (guest list + passport numbers) |
 *  'transportation' (transport answer + airport/flight) | 'preferences' (occasion/dietary) |
 *  'all' (everything — clears the whole pre check-in + guest list, re-arms the auto-reminder). */
function resetCheckin(stayId, part) {
  const s = getStay(stayId); if (!s) return null;
  part = String(part || 'all');
  const gc = s.guestCheckin;
  if (part === 'all') { s.guestCheckin = null; s.guestList = []; if (s.autoSent) s.autoSent.precheckin = false; }
  else if (part === 'documents' || part === 'passports') { s.guestList = []; }
  else if (gc) {
    if (part === 'party') { gc.adults = 0; gc.children = 0; gc.childAges = []; }
    else if (part === 'transportation') { gc.transportMode = ''; gc.transportCompany = ''; gc.transportArrival = ''; gc.transportDeparture = ''; gc.airport = ''; gc.flight = ''; gc.transferType = ''; }
    else if (part === 'preferences') { gc.occasion = ''; gc.dietary = ''; }
  }
  s.updatedAt = Date.now(); persistStays(); return s;
}
// ----- concierge-pushed services (console sends → guest confirms/declines). Two-way sync. -----
/** Console pushes a service to the guest's plan. */
function sendService(stayId, b) {
  const s = getStay(stayId); if (!s) return null;
  if (!Array.isArray(s.sentServices)) s.sentServices = [];
  const name = norm(b && b.name).slice(0, 80); if (!name) return null;
  const item = {
    id: 'snt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    serviceId: norm(b && b.serviceId).slice(0, 60),
    name,
    option: norm(b && b.option).slice(0, 120),
    rate: norm(b && b.rate).slice(0, 40),
    note: norm(b && b.note).slice(0, 300),
    // Per-service booking details (mirror the guest request form) so a pushed service carries the
    // same context and can prefill an invoice. All optional.
    date: norm(b && b.date).slice(0, 20),
    endDate: norm(b && b.endDate).slice(0, 20),
    time: norm(b && b.time).slice(0, 20),
    guests: Math.max(0, Math.min(99, Number(b && b.guests) || 0)) || '',
    qty: Math.max(0, Math.min(99, Number(b && b.qty) || 0)) || '',
    trip: norm(b && b.trip).slice(0, 20),
    airline: norm(b && b.airline).slice(0, 40),
    flightNo: norm(b && b.flightNo).slice(0, 24),
    flightOrigin: norm(b && b.flightOrigin).slice(0, 60),
    arrivalTime: norm(b && b.arrivalTime).slice(0, 40),
    returnAirline: norm(b && b.returnAirline).slice(0, 40),
    returnFlightNo: norm(b && b.returnFlightNo).slice(0, 24),
    returnDest: norm(b && b.returnDest).slice(0, 60),
    returnTime: norm(b && b.returnTime).slice(0, 40),
    status: 'sent', sentAt: Date.now(), respondedAt: 0,
  };
  s.sentServices.push(item); s.updatedAt = Date.now(); persistStays(); return item;
}
/** Console edits a sent service (option / rate / note). Resets status to 'sent' so the guest re-confirms. */
function updateSentService(stayId, sid, b) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.sentServices)) return null;
  const it = s.sentServices.find(x => x.id === sid); if (!it) return null;
  if (b.option != null) it.option = norm(b.option).slice(0, 120);
  if (b.rate != null) it.rate = norm(b.rate).slice(0, 40);
  if (b.note != null) it.note = norm(b.note).slice(0, 300);
  if (b.name != null) { const n = norm(b.name).slice(0, 80); if (n) it.name = n; }
  if (b.date != null) it.date = norm(b.date).slice(0, 20);
  if (b.endDate != null) it.endDate = norm(b.endDate).slice(0, 20);
  if (b.time != null) it.time = norm(b.time).slice(0, 20);
  if (b.guests != null) it.guests = Math.max(0, Math.min(99, Number(b.guests) || 0)) || '';
  if (b.qty != null) it.qty = Math.max(0, Math.min(99, Number(b.qty) || 0)) || '';
  if (b.trip != null) it.trip = norm(b.trip).slice(0, 20);
  if (b.airline != null) it.airline = norm(b.airline).slice(0, 40);
  if (b.flightNo != null) it.flightNo = norm(b.flightNo).slice(0, 24);
  if (b.flightOrigin != null) it.flightOrigin = norm(b.flightOrigin).slice(0, 60);
  if (b.arrivalTime != null) it.arrivalTime = norm(b.arrivalTime).slice(0, 40);
  if (b.returnAirline != null) it.returnAirline = norm(b.returnAirline).slice(0, 40);
  if (b.returnFlightNo != null) it.returnFlightNo = norm(b.returnFlightNo).slice(0, 24);
  if (b.returnDest != null) it.returnDest = norm(b.returnDest).slice(0, 60);
  if (b.returnTime != null) it.returnTime = norm(b.returnTime).slice(0, 40);
  it.status = 'sent'; it.respondedAt = 0; s.updatedAt = Date.now(); persistStays(); return it;
}
/** Console cancels (removes) a sent service. */
function cancelSentService(stayId, sid) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.sentServices)) return false;
  const n = s.sentServices.length;
  s.sentServices = s.sentServices.filter(x => x.id !== sid);
  if (s.sentServices.length === n) return false;
  s.updatedAt = Date.now(); persistStays(); return true;
}
/** Guest confirms or declines a sent service. */
function respondSentService(reference, sid, response) {
  const s = findPublishedStayByRef(reference); if (!s || !Array.isArray(s.sentServices)) return null;
  const it = s.sentServices.find(x => x.id === sid); if (!it) return null;
  it.status = response === 'confirmed' ? 'confirmed' : response === 'declined' ? 'declined' : it.status;
  it.respondedAt = Date.now(); s.updatedAt = Date.now(); persistStays(); return it;
}
// ----- invoices (concierge creates → reviews → sends → guest sees + pays by Zelle → mark paid) -----
function clampPct(v, def) { if (v === undefined || v === null || v === '') return def; const n = Number(v); return (isFinite(n) && n >= 0 && n <= 100) ? n : def; }
function invoiceSubtotal(inv) { return (inv && Array.isArray(inv.items) ? inv.items : []).reduce((a, x) => a + (Number(x && x.amount) || 0), 0); }
/** Full money breakdown: subtotal → 18% legal fee (ITBIS) + 10% service fee (each optional) → total. */
/** Flat extra charges on a service invoice (e.g. "Pick up & delivery" US$50). Any label, any
 *  amount — added AFTER the % fees, so they are never marked up. */
function cleanExtras(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 10).map(x => ({
    label: norm(x && x.label).slice(0, 120),
    amount: Math.max(0, Math.round((parseFloat(String(x && x.amount).replace(/[^0-9.]/g, '')) || 0) * 100) / 100),
  })).filter(x => x.label || x.amount);
}
function invoiceBreakdown(inv) {
  const subtotal = invoiceSubtotal(inv);
  const legalPct = Number(inv && inv.legalPct) || 0, servicePct = Number(inv && inv.servicePct) || 0;
  const legal = Math.round(subtotal * legalPct) / 100;     // subtotal * legalPct/100, to cents
  const service = Math.round(subtotal * servicePct) / 100;
  const extras = cleanExtras(inv && inv.extras);
  const extrasTotal = Math.round(extras.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  return { subtotal, legalPct, servicePct, legal, service, extras, extrasTotal, total: Math.round((subtotal + legal + service + extrasTotal) * 100) / 100 };
}
function cleanGroceryItems(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 60).map(it => ({
    label: norm(it && it.label).slice(0, 120),
    amountRD: Math.max(0, Math.round((parseFloat(String(it && it.amountRD).replace(/[^0-9.]/g, '')) || 0) * 100) / 100),
  })).filter(it => it.label || it.amountRD);
}
/** Grocery/pre-stocking invoice — every value is entered manually by staff (no calculations):
 *  RD line items, the Total in RD, the US$ sub-total, the US$ service fee, and the US$ total. */
function groceryBreakdown(inv) {
  const totalUSD = Number(inv && inv.totalUSD) || 0;
  // Deposit / funds the guest already handed over for the shopping — subtracted from the invoice total.
  const deposit = Number(inv && inv.depositUSD) || 0;
  const finalUSD = Math.round((totalUSD - deposit) * 100) / 100; // may be negative = we owe the guest a refund
  return {
    totalRD: Number(inv && inv.totalRD) || 0,
    subUSD: Number(inv && inv.subUSD) || 0,
    svc: Number(inv && inv.serviceFeeUSD) || 0,
    pickup: Number(inv && inv.pickupUSD) || 0,
    totalUSD,
    deposit,
    finalUSD,
    dueUSD: Math.max(0, finalUSD),   // what's still collectable — a credit never offsets other invoices
    refundUSD: Math.max(0, -finalUSD),
  };
}
function invoiceTotal(inv) { return (inv && inv.kind === 'grocery') ? groceryBreakdown(inv).dueUSD : invoiceBreakdown(inv).total; }
function cleanItems(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 40).map(it => {
    const o = {
      label: norm(it && it.label).slice(0, 120),
      amount: Math.max(0, Math.round((parseFloat(String(it && it.amount).replace(/[^0-9.]/g, '')) || 0) * 100) / 100),
    };
    const rate = String((it && it.rate) || '').replace(/[^0-9.]/g, '');   // optional per-day rate (calculator aid, kept so edits reload)
    const days = String((it && it.days) || '').replace(/[^0-9.]/g, '');
    const supplier = norm(it && it.supplier).slice(0, 80);               // optional internal supplier (staff-only; stripped from toGuestStay)
    const bookedVia = norm(it && it.bookedVia).slice(0, 80);             // booking channel that booked THIS line (staff-only; see BOOKING_SOURCES)
    if (rate) o.rate = rate; if (days) o.days = days; if (supplier) o.supplier = supplier; if (bookedVia) o.bookedVia = bookedVia;
    return o;
  }).filter(it => it.label || it.amount);
}
// Who the guest pays for this invoice — one of a small fixed set. Defaults to Jan.
function cleanPayTo(v) { return String(v || '').trim().toLowerCase() === 'ivonna' ? 'ivonna' : 'jan'; }
function createInvoice(stayId, b) {
  const s = getStay(stayId); if (!s) return null;
  if (!Array.isArray(s.invoices)) s.invoices = [];
  const invNo = nextInvoiceNo(); // global running sequence — unique across all bookings
  const iid = 'inv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const money = v => Math.max(0, Math.round((parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0) * 100) / 100);
  const inv = (b && b.kind === 'grocery') ? {
    id: iid, no: invNo, kind: 'grocery',
    title: norm(b && b.title).slice(0, 120) || 'Grocery pre-stocking',
    items: cleanGroceryItems(b && b.items),
    totalRD: money(b && b.totalRD),
    subUSD: money(b && b.subUSD),
    serviceFeeUSD: money(b && b.serviceFeeUSD),
    pickupUSD: money(b && b.pickupUSD),
    totalUSD: money(b && b.totalUSD),
    depositUSD: money(b && b.depositUSD),   // funds already received from the guest — deducted from the total
    legalPct: 0, servicePct: 0,
    dueBy: norm(b && b.dueBy).slice(0, 40),
    note: norm(b && b.note).slice(0, 400),
    payTo: cleanPayTo(b && b.payTo),
    status: 'draft', createdAt: Date.now(), sentAt: 0, paidAt: 0,
  } : {
    id: iid,
    no: invNo,
    title: norm(b && b.title).slice(0, 120) || 'Invoice',
    items: cleanItems(b && b.items),
    requestId: norm(b && b.requestId).slice(0, 40), // optional link to the guest request this invoice bills — lets the console flag it if the request is later cancelled
    yachtId: norm(b && b.yachtId).slice(0, 40),     // optional link to the yacht proposal — locks the guest's boat choice once invoiced
    legalPct: clampPct(b && b.legalPct, 18),     // 18% ITBIS / legal fee by default
    servicePct: clampPct(b && b.servicePct, 10), // 10% service fee by default
    extras: cleanExtras(b && b.extras),          // flat extra charges (e.g. Pick up & delivery US$50) — any label, any amount
    dueBy: norm(b && b.dueBy).slice(0, 40),
    note: norm(b && b.note).slice(0, 400),
    payTo: cleanPayTo(b && b.payTo),
    status: 'draft', createdAt: Date.now(), sentAt: 0, paidAt: 0,
  };
  if (inv.kind === 'grocery') {
    // Totals must add up (server-side guard — a console typo must never reach the guest):
    // total = sub-total + service fee + pick-up. Blank total auto-fills; a wrong total is rejected.
    const expected = Math.round((inv.subUSD + inv.serviceFeeUSD + inv.pickupUSD) * 100) / 100;
    if (!inv.totalUSD && expected) inv.totalUSD = expected;
    else if (expected && Math.abs(inv.totalUSD - expected) > 0.05) return { error: `Total US$${inv.totalUSD.toFixed(2)} doesn't add up — Sub-total + Service fee + Pick-up = US$${expected.toFixed(2)}. Fix the amounts, or clear the Total to auto-fill it.` };
  }
  s.invoices.push(inv); s.updatedAt = Date.now(); persistStays(); return inv;
}
function updateInvoice(stayId, iid, b) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.invoices)) return null;
  const inv = s.invoices.find(x => x.id === iid); if (!inv) return null;
  if (inv.kind === 'grocery') {
    const money = v => Math.max(0, Math.round((parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0) * 100) / 100);
    // Validate totals BEFORE mutating the stored invoice (reject = no partial write).
    const cand = {
      subUSD: b.subUSD != null ? money(b.subUSD) : inv.subUSD,
      serviceFeeUSD: b.serviceFeeUSD != null ? money(b.serviceFeeUSD) : inv.serviceFeeUSD,
      pickupUSD: b.pickupUSD != null ? money(b.pickupUSD) : inv.pickupUSD,
      totalUSD: b.totalUSD != null ? money(b.totalUSD) : inv.totalUSD,
    };
    const expected = Math.round((cand.subUSD + cand.serviceFeeUSD + cand.pickupUSD) * 100) / 100;
    let autoTotal = 0;
    if (!cand.totalUSD && expected) autoTotal = expected;
    else if (expected && Math.abs(cand.totalUSD - expected) > 0.05) return { error: `Total US$${cand.totalUSD.toFixed(2)} doesn't add up — Sub-total + Service fee + Pick-up = US$${expected.toFixed(2)}. Fix the amounts, or clear the Total to auto-fill it.` };
    if (b.title != null) inv.title = norm(b.title).slice(0, 120) || inv.title;
    if (b.items != null) inv.items = cleanGroceryItems(b.items);
    if (b.totalRD != null) inv.totalRD = money(b.totalRD);
    if (b.subUSD != null) inv.subUSD = money(b.subUSD);
    if (b.serviceFeeUSD != null) inv.serviceFeeUSD = money(b.serviceFeeUSD);
    if (b.pickupUSD != null) inv.pickupUSD = money(b.pickupUSD);
    if (b.totalUSD != null) inv.totalUSD = money(b.totalUSD);
    if (b.depositUSD != null) inv.depositUSD = money(b.depositUSD);
    if (autoTotal) inv.totalUSD = autoTotal;
    if (b.dueBy != null) inv.dueBy = norm(b.dueBy).slice(0, 40);
    if (b.note != null) inv.note = norm(b.note).slice(0, 400);
    if (b.payTo != null) inv.payTo = cleanPayTo(b.payTo);
    s.updatedAt = Date.now(); persistStays(); return inv;
  }
  if (b.title != null) inv.title = norm(b.title).slice(0, 120) || inv.title;
  if (b.items != null) inv.items = cleanItems(b.items);
  if (b.requestId != null) inv.requestId = norm(b.requestId).slice(0, 40);
  if (b.yachtId != null) inv.yachtId = norm(b.yachtId).slice(0, 40);
  if (b.legalPct != null) inv.legalPct = clampPct(b.legalPct, 18);
  if (b.servicePct != null) inv.servicePct = clampPct(b.servicePct, 10);
  if (b.extras != null) inv.extras = cleanExtras(b.extras);
  if (b.dueBy != null) inv.dueBy = norm(b.dueBy).slice(0, 40);
  if (b.note != null) inv.note = norm(b.note).slice(0, 400);
  if (b.payTo != null) inv.payTo = cleanPayTo(b.payTo);
  s.updatedAt = Date.now(); persistStays(); return inv;
}
function setInvoiceStatus(stayId, iid, status) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.invoices)) return null;
  const inv = s.invoices.find(x => x.id === iid); if (!inv) return null;
  if (status === 'sent') { inv.status = 'sent'; inv.sentAt = Date.now(); }
  else if (status === 'paid') { if (inv.status !== 'sent') return null; inv.status = 'paid'; inv.paidAt = Date.now(); }
  else if (status === 'draft') { inv.status = 'draft'; inv.sentAt = 0; inv.paidAt = 0; }
  s.updatedAt = Date.now(); persistStays(); return inv;
}
function deleteInvoice(stayId, iid) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.invoices)) return false;
  const n = s.invoices.length; s.invoices = s.invoices.filter(x => x.id !== iid);
  if (s.invoices.length === n) return false;
  s.updatedAt = Date.now(); persistStays(); return true;
}
// ----- yacht charter proposal (concierge sends 2-3 options → guest picks one → concierge arranges + invoices) -----
function cleanYachtOptions(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 5).map((o, i) => ({
    id: norm(o && o.id).slice(0, 24) || ('opt' + (i + 1)),
    name: norm(o && o.name).slice(0, 100),
    detail: norm(o && o.detail).slice(0, 400),
    rate: norm(o && o.rate).slice(0, 60),
  })).filter(o => o.name || o.detail || o.rate);
}
/** Console creates/updates the yacht proposal for a stay (one active proposal). Resets the guest's choice. */
function setYachtProposal(stayId, b) {
  const s = getStay(stayId); if (!s) return null;
  const options = cleanYachtOptions(b && b.options);
  if (!options.length) return null;
  s.yachtProposal = {
    id: (s.yachtProposal && s.yachtProposal.id) || ('yp' + Date.now().toString(36)),
    title: norm(b && b.title).slice(0, 120) || 'Yacht charter options',
    intro: norm(b && b.intro).slice(0, 400),
    options,
    status: 'sent', chosenId: '', sentAt: Date.now(), respondedAt: 0,
  };
  s.updatedAt = Date.now(); persistStays(); return s.yachtProposal;
}
/** Console withdraws the yacht proposal. */
function cancelYachtProposal(stayId) {
  const s = getStay(stayId); if (!s || !s.yachtProposal) return false;
  s.yachtProposal = null; s.updatedAt = Date.now(); persistStays(); return true;
}
/** Guest picks one of the yacht options. */
function chooseYacht(reference, optionId) {
  const s = findPublishedStayByRef(reference); if (!s || !s.yachtProposal) return null;
  const yp = s.yachtProposal;
  // Once the chosen boat has been invoiced, the choice is LOCKED — changing boats goes through the concierge.
  if ((s.invoices || []).some(iv => iv.yachtId && iv.yachtId === yp.id)) return null;
  const opt = (yp.options || []).find(o => o.id === optionId); if (!opt) return null;
  yp.chosenId = opt.id; yp.status = 'chosen'; yp.respondedAt = Date.now();
  s.updatedAt = Date.now(); persistStays(); return yp;
}
/** Concierge confirms a request from the Console and sets the final price. */
function confirmRequest(stayId, requestId, price) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  if (r.status === 'cancelled') return null;
  r.status = 'confirmed'; r.price = norm(price).slice(0, 30); r.confirmedAt = Date.now();
  s.updatedAt = Date.now(); persistStays(); return r;
}
/** Guest sends a concierge chat message — persisted on the stay so the conversation survives reloads/logout. */
function addGuestMessage(reference, text) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  if (!Array.isArray(s.messages)) s.messages = [];
  const t = norm(text).slice(0, 1000); if (!t) return null;
  const m = { id: genId(), from: 'guest', text: t, at: Date.now() };
  s.messages.push(m); s.updatedAt = Date.now(); persistStays(); return m;
}
/** Match an inbound phone number (e.g. from a WhatsApp webhook) to a published stay by the guest's phone. */
function digitsOf(p) { return String(p == null ? '' : p).replace(/\D/g, ''); }
function findStayByGuestPhone(phone) { const a = digitsOf(phone).slice(-10); if (a.length < 8) return null; return stays.find(s => s.status === 'published' && digitsOf(s.phone).slice(-10) === a) || null; }
/** Append a guest message that arrived over an external channel (WhatsApp/SMS) to the right stay's chat. */
function addGuestMessageByPhone(phone, text, via) {
  const s = findStayByGuestPhone(phone); if (!s) return null;
  if (!Array.isArray(s.messages)) s.messages = [];
  const t = norm(text).slice(0, 1000); if (!t) return null;
  const m = { id: genId(), from: 'guest', text: t, at: Date.now(), via: via || 'whatsapp' };
  s.messages.push(m); s.updatedAt = Date.now(); s.guestLastSeen = Date.now(); persistStays();
  return { stay: s, message: m };
}
/** Concierge replies from the Console (keyed by stay id). */
function addStaffMessage(stayId, text) {
  const s = getStay(stayId); if (!s) return null;
  if (!Array.isArray(s.messages)) s.messages = [];
  const t = norm(text).slice(0, 1000); if (!t) return null;
  const m = { id: genId(), from: 'concierge', text: t, at: Date.now() };
  s.messages.push(m); s.updatedAt = Date.now(); persistStays(); return m;
}
/** Lightweight fetch of just the conversation, for guest polling. */
function getMessagesByRef(reference) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  return (s.messages || []).map(m => ({ id: m.id, from: m.from, text: m.text, at: m.at }));
}
/** Lightweight fetch of just the requests, for guest polling (live status/price updates). Same shape as toGuestStay.requests. */
function getRequestsByRef(reference) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  return (s.requests || []).map(r => ({ id: r.id, type: r.type, refId: r.refId, title: r.title, date: r.date, endDate: r.endDate || '', cartType: r.cartType || '', serviceLevel: r.serviceLevel || '', time: r.time, guests: r.guests, note: r.note, familyName: r.familyName || '', airline: r.airline || '', flightNo: r.flightNo || '', flightOrigin: r.flightOrigin || '', arrivalTime: r.arrivalTime || '', returnAirline: r.returnAirline || '', returnFlightNo: r.returnFlightNo || '', returnDest: r.returnDest || '', returnTime: r.returnTime || '', status: r.status, price: r.price || '', createdAt: r.createdAt, updatedAt: r.updatedAt || 0 }));
}

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
    internalName: s.villaInternal || v.internalName || '',
    hero: s.heroPhoto || v.hero || '',
  };
  const c = CONCIERGES.find(x => x.id === s.conciergeId) || CONCIERGES[0];
  const offered = new Set(s.offeredAddOnIds || []);
  return {
    source: 'console',
    stayId: s.id,
    bookingSource: s.source || '',
    guest: { firstName: (s.leadName || '').split(' ')[0] || '', lastName: s.lastName || '', family: s.lastName || s.leadName || 'Guest', email: s.email || '', phone: s.phone || '' },
    booking: {
      reference: s.reference, status: s.status,
      arrive: s.checkin, depart: s.checkout, nights: nightsBetween(s.checkin, s.checkout),
      arriveTime: '15:00', checkInTime: s.checkinTime || '3:00 PM', checkOutTime: s.checkoutTime || '11:00 AM',
      adults: Number(s.adults) || null, children: Number(s.children) || 0,
      airport: s.airport || 'LRM', flight: s.flight || '', transferArranged: !!s.transferArranged,
    },
    villa: { id: villa.id, name: villa.name, area: villa.area, view: villa.view, suites: villa.suites, sleeps: villa.sleeps, internalName: villa.internalName, hero: s.heroPhoto || villa.hero, gallery: [], amenities: [], staffIncluded: String(s.staffIncluded || v.staff || 'Chef · Butler · Housekeeper').split(/\s*·\s*|\s*,\s*/).filter(Boolean), description: '' },
    staffHours: s.staffHours || '8:00 AM – 5:00 PM',
    staffReadAt: s.staffReadAt || 0,
    concierge: c,
    welcomeMessage: s.welcomeMessage || '',
    wifiName: s.wifiName || '', wifiPassword: s.wifiPassword || '', villaNumber: s.villaNumber || '',
    wifiHandover: s.wifiHandover || '', // console-editable handover line — shown to the guest when no Wi-Fi name/password is set yet
    // Registration # is shown to the guest ONLY once the stay is ready AND a number is entered — hidden while pre-arrival info is pending/missing.
    registrationNumber: (stayReadiness(s).ready && String(s.registrationNumber || '').trim()) ? s.registrationNumber : '',
    guestList: (s.guestList || []).map(g => ({ name: g.name, passport: g.passport })),
    addOns: allAddOns().map(a => ({ id: a.id, category: a.category, name: a.name, desc: a.desc, price: a.price || '', rates: a.rates || '', custom: !!a.custom, recommended: offered.has(a.id) })),
    yachtFleet: YACHT_CATALOG.map(y => y.name),   // single source (store.js) — keeps guest + console in sync
    serviceOptions: SERVICE_OPTIONS,              // single source — same service options/rates on guest + console

    explore: EXPLORE_SCENES,
    requests: (s.requests || []).map(r => ({ id: r.id, type: r.type, refId: r.refId, title: r.title, date: r.date, endDate: r.endDate || '', cartType: r.cartType || '', serviceLevel: r.serviceLevel || '', time: r.time, guests: r.guests, note: r.note, familyName: r.familyName || '', airline: r.airline || '', flightNo: r.flightNo || '', flightOrigin: r.flightOrigin || '', arrivalTime: r.arrivalTime || '', returnAirline: r.returnAirline || '', returnFlightNo: r.returnFlightNo || '', returnDest: r.returnDest || '', returnTime: r.returnTime || '', status: r.status, price: r.price || '', createdAt: r.createdAt, updatedAt: r.updatedAt || 0 })),
    sentServices: (s.sentServices || []).map(x => ({ id: x.id, serviceId: x.serviceId, name: x.name, option: x.option || '', rate: x.rate || '', note: x.note || '', date: x.date || '', endDate: x.endDate || '', time: x.time || '', guests: x.guests || '', qty: x.qty || '', trip: x.trip || '', airline: x.airline || '', flightNo: x.flightNo || '', flightOrigin: x.flightOrigin || '', arrivalTime: x.arrivalTime || '', returnAirline: x.returnAirline || '', returnFlightNo: x.returnFlightNo || '', returnDest: x.returnDest || '', returnTime: x.returnTime || '', status: x.status, sentAt: x.sentAt, respondedAt: x.respondedAt || 0 })),
    yachtProposal: s.yachtProposal ? { id: s.yachtProposal.id, title: s.yachtProposal.title, intro: s.yachtProposal.intro || '', options: (s.yachtProposal.options || []).map(o => ({ id: o.id, name: o.name, detail: o.detail || '', rate: o.rate || '' })), status: s.yachtProposal.status, chosenId: s.yachtProposal.chosenId || '', invoiced: (s.invoices || []).some(iv => iv.yachtId && iv.yachtId === s.yachtProposal.id), sentAt: s.yachtProposal.sentAt, respondedAt: s.yachtProposal.respondedAt || 0 } : null,
    invoices: (s.invoices || []).filter(x => x.status !== 'draft').map(x => { if (x.kind === 'grocery') { const g = groceryBreakdown(x); return ({ id: x.id, no: x.no, title: x.title, kind: 'grocery', items: (x.items || []).map(it => ({ label: it.label, amountRD: it.amountRD })), totalRD: g.totalRD, subUSD: g.subUSD, serviceFeeUSD: g.svc, pickupUSD: g.pickup, invoiceUSD: g.totalUSD, depositUSD: g.deposit, finalUSD: g.finalUSD, refundUSD: g.refundUSD, total: g.dueUSD, dueBy: x.dueBy || '', note: x.note || '', payTo: x.payTo || 'jan', status: x.status, sentAt: x.sentAt || 0, paidAt: x.paidAt || 0 }); } const bd = invoiceBreakdown(x); return ({ id: x.id, no: x.no, title: x.title, items: (x.items || []).map(it => ({ label: it.label, amount: it.amount })), subtotal: bd.subtotal, legalPct: bd.legalPct, servicePct: bd.servicePct, legalFee: bd.legal, serviceFee: bd.service, extras: bd.extras, extrasTotal: bd.extrasTotal, total: bd.total, dueBy: x.dueBy || '', note: x.note || '', payTo: x.payTo || 'jan', status: x.status, sentAt: x.sentAt || 0, paidAt: x.paidAt || 0 }); }),
    messages: (s.messages || []).map(m => ({ id: m.id, from: m.from, text: m.text, at: m.at })),
    guestCheckin: s.guestCheckin || null,
    readiness: stayReadiness(s),
    grocery: s.grocery || null,
    mealPlan: s.mealPlan || null,
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
/** Record that the guest app polled/opened this booking — ephemeral (not persisted), powers the console "guest active" pulse. */
function touchGuestSeen(reference) {
  const s = findPublishedStayByRef(reference);
  if (s) s.guestLastSeen = Date.now();
}
/** Mark that a staffer has opened/read this stay's conversation — powers the guest chat's read receipts. */
function markStaffRead(stayId) {
  const s = getStay(stayId);
  if (s) { s.staffReadAt = Date.now(); persistStays(); }
  return s;
}

// init
ensureDir();
seedStaffFromEnv();

module.exports = {
  DATA_DIR, ADDON_CATALOG, CONCIERGES, YACHT_CATALOG, SERVICE_OPTIONS, PROVISIONING_OPTIONS,
  BOOKING_SOURCES, BOOKING_SOURCE_PARTNERS, SERVICE_BOOKED_VIA,
  allAddOns, listServicesForStaff, addCustomService, updateService, deleteCustomService,
  sendService, updateSentService, cancelSentService, respondSentService,
  createInvoice, updateInvoice, setInvoiceStatus, deleteInvoice, invoiceTotal,
  setYachtProposal, cancelYachtProposal, chooseYacht,
  hashPassword, verifyPassword, getStaffByEmail, staffPublic, listStaffPublic, seedStaffFromEnv,
  listVillas, getVilla,
  cartInfo,
  listStays, getStay, exportAll, runAutomations, upsellMetrics, payables, setPayableSettled, createStay, saveStay, publishStay, deleteStay,
  addRequest, updateGuestRequest, removeGuestRequest, removeStaffRequest, markRequestDone, reopenRequest, setRequestFamily, staffUpdateRequest, setGuestList, saveGrocery, saveMealPlan, saveCheckin, resetCheckin, confirmRequest, addGuestMessage, addGuestMessageByPhone, addStaffMessage, getMessagesByRef, getRequestsByRef,
  toGuestStay, findPublishedForLogin, getPublishedByRefForSession, touchGuestSeen, markStaffRead,
  _counts: () => ({ stays: stays.length, staff: staff.length }),
};
