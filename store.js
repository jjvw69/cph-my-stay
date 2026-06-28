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
// Concierge services & experiences (from caribbeanparadisehomes.com/guest-services). No rates shown — handled by the concierge.
const ADDON_CATALOG = [
  // Travel & transfers (in the order they appear on caribbeanparadisehomes.com/guest-services)
  { id: 'privatetravel', category: 'Travel & transfers',    name: 'Luxury private travel',              desc: 'Helicopter, private jet and luxury transfers.' },
  { id: 'transfer',      category: 'Travel & transfers',    name: 'Private airport transfer',           desc: 'Meet & greet at the airport and a private drive to your villa.' },
  { id: 'carrental',     category: 'Travel & transfers',    name: 'Car rental',                         desc: 'A rental car arranged and waiting for you.' },
  { id: 'golfcart',      category: 'Travel & transfers',    name: 'Golf cart',                          desc: 'Your own cart to get around the resort.' },
  { id: 'yacht',         category: 'Travel & transfers',    name: 'Luxury yacht charter',               desc: 'Private yacht and catamaran charters along the coast.' },
  // Provisioning & dining
  { id: 'grocery',       category: 'Provisioning & dining', name: 'Grocery pre-stocking',               desc: 'Your villa stocked with groceries before you arrive.' },
  { id: 'dining',        category: 'Provisioning & dining', name: 'Restaurant & activity reservations', desc: "Bookings at the resort's restaurants and activities." },
  { id: 'catering',      category: 'Provisioning & dining', name: 'Private chef & catering',            desc: 'In-villa dining and catering for any occasion.' },
  // (Experiences moved to the Explore → Experiences directory)
  // In-villa services
  { id: 'babygear',      category: 'In-villa services',     name: 'Baby gear',                          desc: 'Crib, high chair and everything for little ones.' },
  { id: 'staff',         category: 'In-villa services',     name: 'Additional staff',                   desc: 'Extra butlers, housekeepers or a nanny.' },
];

const CONCIERGES = [
  { id: 'maria-fernanda', name: 'María Fernanda', phone: '+1 (829) 763-8801', avatarInitials: 'MF' },
  { id: 'ivonna',         name: 'Ivonna',         phone: '+1 (829) 763-8801', avatarInitials: 'Iv' },
  { id: 'jan',            name: 'Jan',            phone: '+1 (829) 763-8801', avatarInitials: 'Jn' },
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
  { id:'lago',          cat:'Dining', name:'Lago',                        meta:'Teeth of the Dog',  desc:'Buffet breakfast and à la carte overlooking the 18th fairway, by the pro shop.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Lago-Restaurant-3-min-800x600-1.webp' },
  // ---- Golf ----
  { id:'teeth-of-the-dog', cat:'Golf', name:'Teeth of the Dog',          meta:'Pete Dye · 18 holes', desc:"Pete Dye's #1-ranked Caribbean course — seven oceanfront holes 'created by God.'", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic45.webp', more:'https://caribbeanparadisehomes.com/teeth-of-the-dog-golf-course-the-complete-visitor-guide/' },
  { id:'dye-fore',      cat:'Golf', name:'Dye Fore',                      meta:'Pete Dye · 27 holes', desc:'A clifftop 27 holes above the Chavón River — three nines up to 7,667 yards.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic19-small.webp', more:'https://caribbeanparadisehomes.com/casa-de-campo-golf-guide-three-courses/' },
  { id:'the-links',     cat:'Golf', name:'The Links',                     meta:'Pete Dye · 18 holes', desc:"Pete Dye's inland Scottish-style links — strategic, playable, built for repeat rounds.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/02/hole16_2.jpg.jpeg', more:'https://caribbeanparadisehomes.com/casa-de-campo-golf-guide-three-courses/' },
  // ---- Amenities (informational) ----
  { id:'marina',        cat:'Amenities', name:'Casa de Campo Marina',    meta:'Waterfront village',  desc:'A Mediterranean-style yacht harbour — a walkable waterfront of dining, boutiques and nightlife.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/05/A745160.jpg', info:true, more:'https://caribbeanparadisehomes.com/casa-de-campo-marina-guide/' },
  { id:'altos',         cat:'Amenities', name:'Altos de Chavón',         meta:'Cultural village',    desc:'A re-created 16th-century Mediterranean clifftop village — amphitheatre, museum, galleries and dining.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/altos-de-chavon-web.jpg', info:true, more:'https://caribbeanparadisehomes.com/altos-de-chavon-complete-guide/' },
  { id:'minitas-beach', cat:'Amenities', name:'Minitas Beach',           meta:'Private · on resort', desc:"Casa de Campo's only private beach — calm, swimmable Caribbean water and full beach-club facilities.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic34.webp', info:true, more:'https://caribbeanparadisehomes.com/minitas-beach-guide/' },
  // ---- Activities & wellness (bookable) ----
  { id:'spa',           cat:'Activities', name:'The Spa',                meta:'Wellness',            desc:'Massage, facials, body treatments and hydrotherapy — plus in-villa spa services.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Reception.webp', more:'https://www.casadecampo.com.do/experiences/spa/' },
  { id:'tennis',        cat:'Activities', name:'Racquet Center',          meta:'13 clay courts',     desc:"The Caribbean's largest racquet facility — Har-Tru clay courts plus padel and pickleball.", img:'https://www.casadecampo.com.do/wp-content/uploads/2025/09/639a04b1e1fb9ae75d22be67bf00d0ec00fbad8b.jpg', more:'https://www.casadecampo.com.do/experiences/racquet-center/' },
  { id:'equestrian',    cat:'Activities', name:'Equestrian Center',      meta:'Polo & riding',       desc:"Horseback riding, polo, jumping and children's programs across countryside trails and arenas.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/polo_Casa_de_Campo_Nacho_Figueras-1.webp', more:'https://www.casadecampo.com.do/experiences/equestrian/' },
  { id:'shooting',      cat:'Activities', name:'Shooting Center',        meta:'245 acres',           desc:"The DR's largest range — 200+ stations of sporting clays, trap, skeet and five-stand.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic39.webp', more:'https://www.casadecampo.com.do/experiences/shooting-center/' },
  // ---- Experiences: tours & adventures (bookable) ----
  { id:'horseback-tour', cat:'Activities', name:'Horseback Riding Tour', meta:'Ranch trail · 2h', desc:'A guided trail ride to a working ranch — cowboys, cane fields, pastures and lagoons (Thu/Fri/Sat).', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/polo_Casa_de_Campo_Nacho_Figueras-1.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'pottery', cat:'Activities', name:'Pottery at Emilio Robba', meta:'Altos de Chavón · 1h', desc:'Discover your inner artist in a hands-on ceramics class at the Emilio Robba workshop in Altos de Chavón.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/12/altos-de-chavon-web.jpg', more:'https://www.casadecampo.com.do/experiences/altos-de-chavon/' },
  { id:'kayak', cat:'Activities', name:'Chavón River Kayak', meta:'Chavón River', desc:'Paddle the tranquil Chavón River past lush tropical vegetation — single or double kayaks.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-kayak.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'watersports', cat:'Activities', name:'Minitas Water Sports', meta:'Minitas Beach', desc:"Snorkelling, kayaks, banana boat, Hobie Wave and sailing from the resort's private beach.", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/Casa_de_Campo_Dominica_Republic34.webp', more:'https://www.casadecampo.com.do/experiences/beaches/' },
  { id:'zipline', cat:'Outside', name:'Cumayasa Zip Line', meta:'Adventure', desc:'Fly over the lush flora of the eastern region with certified guides on this thrilling zip-line course.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-zipline.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'buggies', cat:'Outside', name:'Cumayasa Buggies', meta:'Off-road · ages 5+', desc:'Take the wheel and race through the Dominican countryside in your own off-road buggy.', img:'https://www.casadecampo.com.do/wp-content/uploads/2025/09/Buggies.jpg', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'catalina', cat:'Activities', name:'Catalina Island', meta:'Catamaran · beach day', desc:'A catamaran day trip to Catalina Island — white-sand beaches, snorkelling and crystal-clear water.', img:'https://www.casadecampo.com.do/wp-content/uploads/2019/08/catalina-island-excusion-2.jpg', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'cave', cat:'Outside', name:'Las Maravillas Cave', meta:'La Romana · half day', desc:'Explore a 100,000-year-old cave of Taíno rock art — the first natural museum of its kind in the West Indies.', img:'https://www.casadecampo.com.do/wp-content/uploads/2025/09/Maravillas-Cave.jpg', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'santo-domingo', cat:'Outside', name:'Santo Domingo City Tour', meta:'Capital · full day', desc:'Discover the oldest city in the New World — museums, cathedrals and historic landmarks of the capital.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-santo-domingo-fixed.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'cigar', cat:'Outside', name:'Cigar Factory Tour', meta:'Tabacalera de García', desc:"Tour the world's largest hand-rolled cigar factory — home of Montecristo, Romeo y Julieta and more.", img:'https://www.casadecampo.com.do/wp-content/smush-webp/2025/09/manos-1024x949.jpg.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  { id:'rum', cat:'Activities', name:'Rum Factory · Ron Barceló', meta:'Distillery tour', desc:"Tour one of the country's most prestigious rum distilleries, founded in 1930 (adults only).", img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/06/cph-rum-fixed.webp', more:'https://www.casadecampo.com.do/experiences/excursions/' },
  // ---- Family programs & childcare ----
  { id:'family-programs', cat:'Activities', name:'Family Programs', meta:"Supervised kids' camps · 1–17", desc:'Award-winning supervised programs by age group — Toddlers (1–3), Kidz (4–6), Casa Tweens (7–12) and Bonche 4 Teens (13–17): playground, arts & crafts, beach Olympics, sports, kayaking, horseback riding and more.', img:'https://www.casadecampo.com.do/wp-content/uploads/2024/01/EJ4B91245.jpg', more:'https://www.casadecampo.com.do/experiences/for-families/' },
  { id:'family-nannies', cat:'Activities', name:'Nannies & Babysitting', meta:'Childcare · day or night', desc:'Professionally trained nannies (First Aid & CPR, English/Spanish) for daytime supervision or evening babysitting.', img:'https://www.casadecampo.com.do/wp-content/uploads/2025/09/Nanny-Services-2025.jpeg', more:'https://www.casadecampo.com.do/experiences/for-families/' },
  // ---- In-villa experiences (arranged by your concierge) ----
  { id:'entertainment', cat:'Activities', name:'Live Entertainment', meta:'In-villa · events', desc:'Musicians, DJs and performers to set the mood for a dinner, celebration or party at your villa.', img:'https://www.casadecampo.com.do/wp-content/uploads/2019/03/nightlife-cocktail-bar.jpg', more:'https://www.casadecampo.com.do/experiences/nightlife/' },
  { id:'rumcigar', cat:'Activities', name:'Rum & Cigar Tasting', meta:'In-villa · curated', desc:'A curated Dominican rum and hand-rolled cigar tasting, hosted in the comfort of your villa.', img:'https://www.casadecampo.com.do/wp-content/smush-webp/2025/09/manos-1024x949.jpg.webp', more:'https://www.casadecampo.com.do/experiences/' },
  { id:'yoga', cat:'Activities', name:'Private Yoga', meta:'In-villa · wellness', desc:'A private sunrise yoga session on your terrace or the beach with a certified instructor.', img:'https://www.casadecampo.com.do/wp-content/smush-webp/2025/09/Minitas_-Beach-scaled.jpg.webp', more:'https://www.casadecampo.com.do/rejuvenate/' },
  { id:'yacht-charter', cat:'Activities', name:'Yacht Charters', meta:'Marina · private charter', desc:'Private motor yachts, sailing yachts and catamarans with crew from Casa de Campo Marina — half-day, full-day, sunset cruises and island trips.', img:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2026/05/A745160.jpg', more:'https://www.casadecampo.com.do/experiences/marina/' },
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
    leadName: '', lastName: '', email: '', phone: '', source: 'Direct Booking',
    adults: 0, children: 0,
    villaId: v0.id || '',
    villaName: v0.name || '', villaArea: v0.area || '', villaView: v0.view || '',
    villaSuites: v0.suites || '', villaSleeps: v0.sleeps || '', villaInternal: v0.internalName || '',
    heroPhoto: '',
    checkin: '', checkout: '', checkinTime: '3:00 PM', checkoutTime: '11:00 AM',
    staffIncluded: (v0.staff || 'Chef · Butler · Housekeeper'),
    airport: 'LRM', flight: '', transferArranged: false,
    offeredAddOnIds: [],
    conciergeId: 'maria-fernanda', wifiHandover: 'Wi-Fi & keys handed over in person at the villa.',
    welcomeMessage: '',
    requests: [],
    messages: [],
    guestList: [],
    guestCheckin: null,
    followUpDate: '', followUpNote: '',
    wifiName: '', wifiPassword: '', villaNumber: '', registrationNumber: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function listStays() {
  return stays.slice().sort((a, b) => (a.checkin || '').localeCompare(b.checkin || '')).map(summaryStay);
}
function summaryStay(s) {
  const v = getVilla(s.villaId);
  return { id: s.id, reference: s.reference, status: s.status, guest: s.leadName || s.lastName || '(no name)',
    villa: s.villaName || (v ? v.name : ''), checkin: s.checkin, checkout: s.checkout, guests: (s.adults || 0) + (s.children || 0),
    source: s.source || '', followUpDate: s.followUpDate || '', followUpNote: s.followUpNote || '', requests: (s.requests || []).length };
}
function getStay(id) { return stays.find(s => s.id === id) || null; }
function createStay() { const s = blankStay(); stays.push(s); persistStays(); return s; }
function saveStay(id, patch) {
  const s = getStay(id); if (!s) return null;
  const allowed = ['leadName','lastName','email','phone','source','adults','children','villaId','villaName','villaArea','villaView','villaSuites','villaSleeps','villaInternal','heroPhoto','checkin','checkout','checkinTime','checkoutTime','staffIncluded','airport','flight','transferArranged','offeredAddOnIds','conciergeId','wifiHandover','welcomeMessage','status','wifiName','wifiPassword','villaNumber','registrationNumber','followUpDate','followUpNote'];
  allowed.forEach(k => { if (k in patch) s[k] = patch[k]; });
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
    status: 'pending',
    price: '',
    createdAt: Date.now(),
  };
  s.requests.push(req); s.updatedAt = Date.now(); persistStays(); return req;
}
/** Guest cancels one of their own requests. We DON'T delete it — we mark it
 *  cancelled so the concierge keeps a record (log) of it in the Console. */
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
  s.requests.splice(i, 1); s.updatedAt = Date.now(); persistStays(); return true;
}
/** Guest submits the pre-arrival guest list (names + passport numbers) for resort registration. */
function setGuestList(reference, guests) {
  const s = findPublishedStayByRef(reference); if (!s) return null;
  if (!Array.isArray(guests)) return null;
  s.guestList = guests.slice(0, 40)
    .map(g => ({ name: norm(g && g.name).slice(0, 80), passport: norm(g && g.passport).slice(0, 40) }))
    .filter(g => g.name || g.passport);
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
    flight: norm(data.flight).slice(0, 120),
    occasion: norm(data.occasion).slice(0, 60),
    dietary: norm(data.dietary).slice(0, 600),
    submittedAt: Date.now(),
  };
  // Keep the staff-facing arrival fields in sync with what the guest actually submitted,
  // so the console's "Arrival airport / Flight" always reflect the guest's real arrival.
  if (s.guestCheckin.airport) s.airport = s.guestCheckin.airport;
  if (s.guestCheckin.flight) s.flight = s.guestCheckin.flight;
  s.updatedAt = Date.now(); persistStays(); return s.guestCheckin;
}
/** Concierge confirms a request from the Console and sets the final price. */
function confirmRequest(stayId, requestId, price) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return null;
  const r = s.requests.find(x => x.id === requestId); if (!r) return null;
  r.status = 'confirmed'; r.price = norm(price).slice(0, 30);
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
  return (s.requests || []).map(r => ({ id: r.id, type: r.type, refId: r.refId, title: r.title, date: r.date, endDate: r.endDate || '', cartType: r.cartType || '', serviceLevel: r.serviceLevel || '', time: r.time, guests: r.guests, note: r.note, status: r.status, price: r.price || '', createdAt: r.createdAt }));
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
    guest: { firstName: (s.leadName || '').split(' ')[0] || '', lastName: s.lastName || '', family: s.lastName || s.leadName || 'Guest', email: s.email || '', phone: s.phone || '' },
    booking: {
      reference: s.reference, status: s.status,
      arrive: s.checkin, depart: s.checkout, nights: nightsBetween(s.checkin, s.checkout),
      arriveTime: '15:00', checkInTime: s.checkinTime || '3:00 PM', checkOutTime: s.checkoutTime || '11:00 AM',
      adults: Number(s.adults) || null, children: Number(s.children) || 0,
      airport: s.airport || 'LRM', flight: s.flight || '', transferArranged: !!s.transferArranged,
    },
    villa: { id: villa.id, name: villa.name, area: villa.area, view: villa.view, suites: villa.suites, sleeps: villa.sleeps, internalName: villa.internalName, hero: villa.hero, gallery: [], amenities: [], staffIncluded: String(s.staffIncluded || v.staff || 'Chef · Butler · Housekeeper').split(/\s*·\s*|\s*,\s*/).filter(Boolean), description: '' },
    concierge: c,
    welcomeMessage: s.welcomeMessage || '',
    wifiName: s.wifiName || '', wifiPassword: s.wifiPassword || '', villaNumber: s.villaNumber || '', registrationNumber: s.registrationNumber || '',
    guestList: (s.guestList || []).map(g => ({ name: g.name, passport: g.passport })),
    addOns: ADDON_CATALOG.map(a => ({ id: a.id, category: a.category, name: a.name, desc: a.desc, recommended: offered.has(a.id) })),
    explore: EXPLORE_SCENES,
    requests: (s.requests || []).map(r => ({ id: r.id, type: r.type, refId: r.refId, title: r.title, date: r.date, endDate: r.endDate || '', cartType: r.cartType || '', serviceLevel: r.serviceLevel || '', time: r.time, guests: r.guests, note: r.note, status: r.status, price: r.price || '', createdAt: r.createdAt })),
    messages: (s.messages || []).map(m => ({ id: m.id, from: m.from, text: m.text, at: m.at })),
    guestCheckin: s.guestCheckin || null,
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
  addRequest, removeGuestRequest, removeStaffRequest, setGuestList, saveCheckin, confirmRequest, addGuestMessage, addStaffMessage, getMessagesByRef, getRequestsByRef,
  toGuestStay, findPublishedForLogin, getPublishedByRefForSession,
  _counts: () => ({ stays: stays.length, staff: staff.length }),
};
