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
  { id: "bahia-azul", name: "Casa Bahia Azul", area: "Bahía Minitas", view: "Beachfront", suites: 5, sleeps: 10, hero: "https://secure.365villas.com/getimage/uploads/config/jvanwelie/property/gallery/123/20260114_123614_7813jpg.jpg" },
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
    checkin: '', checkout: '', checkinTime: '3:00 PM', checkoutTime: '11:00 AM',
    airport: 'LRM', flight: '', transferArranged: false,
    offeredAddOnIds: [],
    conciergeId: 'maria-fernanda', wifiHandover: 'Wi-Fi & keys handed over in person at the villa.',
    welcomeMessage: '',
    requests: [],
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
    requests: (s.requests || []).length };
}
function getStay(id) { return stays.find(s => s.id === id) || null; }
function createStay() { const s = blankStay(); stays.push(s); persistStays(); return s; }
function saveStay(id, patch) {
  const s = getStay(id); if (!s) return null;
  const allowed = ['leadName','lastName','email','phone','adults','children','villaId','villaName','villaArea','villaView','villaSuites','villaSleeps','heroPhoto','checkin','checkout','checkinTime','checkoutTime','airport','flight','transferArranged','offeredAddOnIds','conciergeId','wifiHandover','welcomeMessage','status'];
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
    time: norm(body.time).slice(0, 20),
    guests: Math.max(0, Math.min(99, Number(body.guests) || 0)),
    note: norm(body.note).slice(0, 300),
    status: 'pending',
    createdAt: Date.now(),
  };
  s.requests.push(req); s.updatedAt = Date.now(); persistStays(); return req;
}
/** Guest removes one of their own pending requests. */
function removeGuestRequest(reference, requestId) {
  const s = findPublishedStayByRef(reference); if (!s || !Array.isArray(s.requests)) return false;
  const i = s.requests.findIndex(r => r.id === requestId); if (i < 0) return false;
  s.requests.splice(i, 1); s.updatedAt = Date.now(); persistStays(); return true;
}
/** Staff dismisses a request (e.g. once actioned) from the Console. */
function removeStaffRequest(stayId, requestId) {
  const s = getStay(stayId); if (!s || !Array.isArray(s.requests)) return false;
  const i = s.requests.findIndex(r => r.id === requestId); if (i < 0) return false;
  s.requests.splice(i, 1); s.updatedAt = Date.now(); persistStays(); return true;
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
    villa: { id: villa.id, name: villa.name, area: villa.area, view: villa.view, suites: villa.suites, sleeps: villa.sleeps, hero: villa.hero, gallery: [], amenities: [], staffIncluded: ['Chef','Butler','Housekeeping'], description: '' },
    concierge: c,
    welcomeMessage: s.welcomeMessage || '',
    addOns: ADDON_CATALOG.filter(a => offered.has(a.id)),
    explore: EXPLORE_SCENES,
    requests: (s.requests || []).map(r => ({ id: r.id, type: r.type, refId: r.refId, title: r.title, date: r.date, time: r.time, guests: r.guests, note: r.note, status: r.status, createdAt: r.createdAt })),
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
  addRequest, removeGuestRequest, removeStaffRequest,
  toGuestStay, findPublishedForLogin, getPublishedByRefForSession,
  _counts: () => ({ stays: stays.length, staff: staff.length }),
};
