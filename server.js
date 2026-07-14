'use strict';

/**
 * CPH "My Stay" server — zero external dependencies (Node >=18 stdlib only).
 * Serves: the guest app (index.html), the Concierge Console (console.html),
 * a guest API (login/stay) and a staff API (manage + publish stays).
 * Data lives in a disk-backed store (store.js); the PMS API is NOT in the path.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const v365 = require('./villas365'); // PMS adapter — used ONLY by /healthz + /api/_probe diagnostics, never in the guest path.

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const GUEST_HOURS = Number(process.env.SESSION_HOURS || 168);
const STAFF_HOURS = Number(process.env.STAFF_SESSION_HOURS || 12); // idle timeout — sliding, so it only counts once the console stops being used
const STAFF_COOKIE = 'cph_staff';
const SECURE = process.env.NODE_ENV !== 'development';
const LOGIN_MAX = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
// Concierge notifications (all optional). Set the relevant env vars to enable a channel.
// WhatsApp via Twilio:
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ''; // production WhatsApp Business sender, e.g. whatsapp:+18095551234
const CONCIERGE_WHATSAPP = process.env.CONCIERGE_WHATSAPP || '';     // e.g. whatsapp:+18297638801
// Approved WhatsApp template (Content SID, HX...) used to alert the concierge OUTSIDE the 24h session window.
// Once set, concierge WhatsApp alerts are sent as this template (delivers reliably from a production sender).
const TWILIO_CONCIERGE_TEMPLATE_SID = process.env.TWILIO_CONCIERGE_TEMPLATE_SID || '';
// ---- Meta WhatsApp Cloud API (preferred, permanent fix) ----
// When these are set, concierge alerts go straight through Meta's Graph API using an approved template,
// bypassing Twilio entirely. Get PHONE_NUMBER_ID + a permanent access token from Meta (WhatsApp → API setup).
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';                        // permanent access token (System User)
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';   // the sending number's Phone Number ID
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'guest_alert';
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';      // must match the approved template's language
// SMS has NO 24h/72h window — set TWILIO_SMS_FROM to a Twilio SMS-capable number to alert the concierge with no restrictions.
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || ''; // e.g. +13055551234
const CONCIERGE_SMS = process.env.CONCIERGE_SMS || CONCIERGE_WHATSAPP.replace(/^whatsapp:/,''); // María's plain number for SMS
// Email via Resend:
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'concierge@caribbeanparadisehomes.com';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'My Stay <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://cph-my-stay.onrender.com';
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'console.html'));
// Advisor headshots (real-estate tab) + hosted villa hero images, served as static assets.
const STATIC_IMAGES = {};
['jan.jpg','ivonna.jpg','azimut.jpg','casa-del-mar.jpg','villa-serenity.jpg','barranca-29.webp'].forEach(f=>{ try{ STATIC_IMAGES['/'+f]=fs.readFileSync(path.join(__dirname,f)); }catch(e){} });
// Content hash of the app files — changes only when a new build is deployed (stable across
// restarts/cold-starts). The guest app and console poll this and refresh when it changes.
// Includes store.js + server.js so a data-layer/server-only deploy also bumps the version.
const _verSrc = [INDEX_HTML, CONSOLE_HTML];
['store.js','server.js'].forEach(f=>{ try{ _verSrc.push(fs.readFileSync(path.join(__dirname,f))); }catch(e){} });
const APP_VER = crypto.createHash('md5').update(Buffer.concat(_verSrc)).digest('hex').slice(0, 10);

// ---- PWA: installable Concierge Console (manifest + minimal service worker) ----
const MANIFEST_JSON = JSON.stringify({
  name:'CPH Concierge Console', short_name:'CPH Console', description:'Caribbean Paradise Homes — staff console for guest stays.',
  start_url:'/console', scope:'/console', display:'standalone', orientation:'any',
  background_color:'#16241E', theme_color:'#16241E',
  icons:[{ src:'https://caribbeanparadisehomes.com/wp-content/uploads/sites/58/2024/11/cropped-CPH-Logo-Only-FB-270x270.jpg', sizes:'270x270', type:'image/jpeg', purpose:'any maskable' }]
});
const SW_JS = "self.addEventListener('install',function(e){self.skipWaiting();});\n"
  + "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});\n"
  + "self.addEventListener('fetch',function(e){/* network passthrough — installability shell only */});\n";

// ---- Apple Calendar / iCal subscription feed (read-only) ----
// Staff subscribe once to  {APP_URL}/calendar/<token>.ics  in Apple Calendar (or Google/Outlook).
// PUBLISHED stays only. Per stay we emit: one all-day block (arrival→departure) plus a timed
// ARRIVAL and DEPARTURE event. Notes carry a deep link back to the booking in the console.
// The token is derived from SESSION_SECRET (stable across deploys) unless CALENDAR_TOKEN is set.
const CALENDAR_TOKEN = process.env.CALENDAR_TOKEN
  || crypto.createHmac('sha256', SESSION_SECRET || 'insecure-dev').update('calendar-feed-v1').digest('hex').slice(0, 32);
const CAL_TZ_OFFSET = 4; // America/Santo_Domingo is a fixed UTC-4 (no DST) — local + 4h = UTC.

function icsEsc(t){ return String(t == null ? '' : t).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n'); }
// RFC 5545: fold content lines at 75 octets, continuation lines start with a single space.
function icsFold(line){ if(Buffer.byteLength(line)<=74) return line; const out=[]; let cur=''; for(const ch of line){ if(Buffer.byteLength(cur+ch)>73){ out.push(cur); cur=' '; } cur+=ch; } out.push(cur); return out.join('\r\n'); }
function icsDate(d){ return String(d||'').replace(/-/g,''); }            // 2026-07-13 -> 20260713
function icsDatePlus(d,days){ const t=Date.parse(String(d)+'T00:00:00Z'); if(!isFinite(t)) return ''; return new Date(t+days*86400000).toISOString().slice(0,10).replace(/-/g,''); }
// "3:00 PM" / "15:00" (local DR time) -> UTC stamp on the given date, e.g. 20260713T190000Z
function icsStampLocal(date,timeStr,fallbackHour){
  const t=Date.parse(String(date)+'T00:00:00Z'); if(!isFinite(t)) return '';
  let h=fallbackHour, mi=0;
  const m=String(timeStr||'').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if(m){ h=parseInt(m[1],10); mi=parseInt(m[2]||'0',10); const ap=(m[3]||'').toUpperCase();
    if(ap==='PM'&&h<12) h+=12; if(ap==='AM'&&h===12) h=0; }
  return new Date(t+(h+CAL_TZ_OFFSET)*3600000+mi*60000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
}
function icsPlusHour(stamp){ const iso=stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'); return new Date(Date.parse(iso)+3600000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''); }

// Villa short code, Jan's arrivals-sheet shorthand: first 3 letters of the internal property name +
// its number  →  "Bahia Minitas 3" = BAH3, "Barranca Este 71" = BAR71, "Punta Aguila 22" = PUN22.
// Only one pair collides under that rule (Los Almendros 4 / Los Lagos 4) — hard-mapped below.
const VILLA_CODE_OVERRIDES = { 'Los Almendros 4':'ALM4', 'Los Lagos 4':'LAG4' };
function villaCode(internal, fallbackName){
  const n=String(internal||'').trim();
  if(!n) return String(fallbackName||'').replace(/[^A-Za-z0-9]/g,'').slice(0,6).toUpperCase();
  if(VILLA_CODE_OVERRIDES[n]) return VILLA_CODE_OVERRIDES[n];
  const toks=n.replace(/[()]/g,' ').split(/\s+/).filter(Boolean);
  const word=toks.find(t=>/^[A-Za-z]/.test(t))||'';
  const numTok=toks.find(t=>/^\d/.test(t))||'';          // first number wins: "34 (8br)" → 34
  const br=(n.match(/(\d+)\s*br/i)||[])[1]||'';          // bedroom variant suffix, e.g. "- 6br"
  let code=word.slice(0,3).toUpperCase()+numTok.toUpperCase();
  if(br && br!==numTok.replace(/\D/g,'')) code+='-'+br+'BR';
  return code;
}
// The four greeter feeds. Apple colours per CALENDAR, not per event — so each greeter gets its own
// feed, and the feed carries its own colour via X-APPLE-CALENDAR-COLOR (the exact hex the console
// uses for that greeter's chip), so Apple Calendar picks it up on subscribe with no manual step.
const CAL_FEEDS = { maria:'Maria', ivonna:'Ivonna', jan:'Jan', none:'Unassigned' };
// Must stay in lockstep with console.html .greet-sel.g-* rules (and CAL_FEED_COLORS there).
const CAL_COLORS = { maria:'#12794D', ivonna:'#5A3A88', jan:'#D7E600', none:'#B4B2A9' };
// RFC 7986 COLOR takes a CSS3 name (used by Google/Outlook); Apple uses the hex above.
const CAL_CSSCOLOR = { maria:'seagreen', ivonna:'darkslateblue', jan:'yellow', none:'darkgray' };
const AGENT_LETTER = { jan:'J', ivonna:'I', maria:'M' };

/* Pull the guest's real flight times off the airport transfer. The transfer can live in either place:
   a guest REQUEST (they asked for it) or a concierge-SENT service (staff arranged it) — both carry the
   same flight fields. Cancelled ones are ignored.

   CRITICAL: the flight fields are DIRECTION-DEPENDENT (see index.html rqRouteChange).
     · Round-trip        → arrivalTime = landing,  returnTime = departure flight.
     · One-way ARRIVAL   → arrivalTime = landing.
     · One-way DEPARTURE → arrivalTime is RELABELLED "flight departure time", and flightOrigin is
                           relabelled "flight destination". There is NO returnTime on a one-way.
   So a one-way departure transfer must be read out of the *arrival* fields, or its time is lost and the
   event silently falls back to the 11:00 AM check-out default. Direction comes from the route text
   ("Route: Casa de Campo → LRM", stored in the note) and, failing that, from the leg's date. */
function transferLegs(s){
  const out={arrTime:'',arrAirline:'',arrFlightNo:'',arrFrom:'',depTime:'',depAirline:'',depFlightNo:'',depTo:''};
  const isTransfer=x=>x && (x.refId==='transfer' || x.serviceId==='transfer' || /transfer/i.test(String(x.name||x.title||'')));
  const live=x=>x && x.status!=='cancelled' && x.status!=='declined';
  const setArr=(t,al,fn,pl)=>{ if(out.arrTime)return; out.arrTime=t||''; out.arrAirline=al||''; out.arrFlightNo=fn||''; out.arrFrom=pl||''; };
  const setDep=(t,al,fn,pl)=>{ if(out.depTime)return; out.depTime=t||''; out.depAirline=al||''; out.depFlightNo=fn||''; out.depTo=pl||''; };
  [].concat(s.requests||[], s.sentServices||[]).filter(x=>isTransfer(x)&&live(x)).forEach(r=>{
    const txt=[r.note,r.title,r.option,r.serviceLevel,r.trip,r.name].filter(Boolean).join(' ');
    const roundTrip=/round[- ]?trip/i.test(txt) || !!r.returnTime;
    if(roundTrip){                                   // one request carries BOTH legs
      setArr(r.arrivalTime, r.airline, r.flightNo, r.flightOrigin);
      setDep(r.returnTime, r.returnAirline, r.returnFlightNo, r.returnDest);
      return;
    }
    // One-way. Which leg is it? Route text wins; otherwise fall back to matching the date.
    const routeSaysDeparture=/casa de campo\s*(?:→|->|to\b)/i.test(txt);
    const dateSaysDeparture=!!(r.date && s.checkout && r.date===s.checkout && r.date!==s.checkin);
    if(routeSaysDeparture || dateSaysDeparture) setDep(r.arrivalTime, r.airline, r.flightNo, r.flightOrigin);
    else setArr(r.arrivalTime, r.airline, r.flightNo, r.flightOrigin);
  });
  return out;
}

/** Build the .ics for one greeter feed. `who` is a key of CAL_FEEDS; 'none' = no greeter assigned. */
function calendarICS(who){
  const now=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const label=CAL_FEEDS[who]||'Arrivals';
  const hex=CAL_COLORS[who]||'#B4B2A9';
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Caribbean Paradise Homes//My Stay Console//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'X-WR-CALNAME:'+icsEsc('CPH · '+label),
    'X-WR-CALDESC:'+icsEsc('Caribbean Paradise Homes — arrivals & departures'+(who==='none'?' with no greeter assigned':' met by '+label)),
    'X-APPLE-CALENDAR-COLOR:'+hex+'FF',      // Apple Calendar: exact greeter colour, applied on subscribe
    'COLOR:'+(CAL_CSSCOLOR[who]||'darkgray'), // RFC 7986: Google / Outlook honour a CSS3 colour name
    'X-WR-TIMEZONE:America/Santo_Domingo','REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H'];
  store.exportAll()
    .filter(s=>s.status==='published'&&s.checkin&&s.checkout)
    .filter(s=>{ const g=String(s.assigneeId||'').trim(); return who==='none' ? !CAL_FEEDS[g] : g===who; })
    .forEach(s=>{
      const v=store.getVilla(s.villaId)||{};
      const villaFull=s.villaInternal||v.internalName||s.villaName||v.name||'';
      const code=villaCode(s.villaInternal||v.internalName||'', s.villaName||v.name||'');
      const name=(s.lastName||s.leadName||'Guest').trim();
      const agent=AGENT_LETTER[String(s.bookingAgent||'').toLowerCase()]||'';
      const prefix=agent?('('+agent+') '):'';                       // no agent set → no empty "( )"
      const link=APP_URL+'/console?stay='+s.id;
      const stamp=new Date(s.updatedAt||s.createdAt||Date.now()).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
      const guests=(Number(s.adults)||0)+(Number(s.children)||0);
      // Apple subscriptions are READ-ONLY — the time can't be edited in Calendar, so it has to be right
      // at the source. Prefer the guest's real FLIGHT time from the airport transfer (request or
      // concierge-sent service); fall back to the villa's check-in / check-out time.
      const tf=transferLegs(s);
      const arrTime=tf.arrTime||s.checkinTime;    // flight lands → else 3:00 PM
      const depTime=tf.depTime||s.checkoutTime;   // return flight → else 11:00 AM
      const flightLine=(t,f)=>{ const bits=[f.airline,f.flightNo].filter(Boolean).join(' ');
        return (bits||f.time)?(t+': '+[bits,f.place,f.time].filter(Boolean).join(' · ')):''; };
      const baseNotes=['Booking '+(s.reference||''), villaFull?('Villa: '+villaFull+(s.villaName?(' · '+s.villaName):'')):'',
        guests?(guests+' guests'):'', label&&who!=='none'?('Greeter: '+label):''].filter(Boolean);
      // Link is NOT repeated in the notes — the URL property below already gives Apple a tappable row.
      const notesFor=(extra)=>[...(extra?[extra]:[]), ...baseNotes].filter(Boolean).join('\n');
      // TIMED events (1h). Apple draws a timed event as a colour bar + text, not a filled block —
      // that's Apple's rendering rule for timed events and is not configurable here.
      const ev=(uid,summary,start,notes)=>{ L.push('BEGIN:VEVENT','UID:'+uid,'DTSTAMP:'+now,'LAST-MODIFIED:'+stamp,
        'SUMMARY:'+icsEsc(summary),'DTSTART:'+start,'DTEND:'+icsPlusHour(start));
        if(villaFull) L.push('LOCATION:'+icsEsc(villaFull));
        L.push('DESCRIPTION:'+icsEsc(notes),'URL:'+link,'TRANSP:TRANSPARENT','END:VEVENT'); };
      // (J) ARR | BAH3 | Hartley   —  at the arrival flight time, else the villa's check-in time
      const a=icsStampLocal(s.checkin,arrTime,15);
      if(a) ev('arr-'+s.id+'@cph-my-stay', prefix+'ARR | '+code+' | '+name, a,
        notesFor(flightLine('Arrival flight',{airline:tf.arrAirline,flightNo:tf.arrFlightNo,place:tf.arrFrom&&('from '+tf.arrFrom),time:tf.arrTime})));
      // (J) DEP | BAH3 | Hartley   —  at the return flight time, else the villa's check-out time
      const d=icsStampLocal(s.checkout,depTime,11);
      if(d) ev('dep-'+s.id+'@cph-my-stay', prefix+'DEP | '+code+' | '+name, d,
        notesFor(flightLine('Return flight',{airline:tf.depAirline,flightNo:tf.depFlightNo,place:tf.depTo&&('to '+tf.depTo),time:tf.depTime})));
    });
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n')+'\r\n';
}

// ---- Server-Sent Events: push instant console updates (no more 18s lag) ----
const sseClients = new Set();
function broadcastStaff(obj){ const s='data: '+JSON.stringify(obj||{type:'changed'})+'\n\n'; for(const r of sseClients){ try{ r.write(s); }catch(e){} } }
function sseHandler(req,res){
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write('retry: 4000\n\n'); res.write('data: {"type":"hello"}\n\n');
  sseClients.add(res);
  const ka=setInterval(()=>{ try{ res.write(': ka\n\n'); }catch(e){ } }, 25000);
  req.on('close',()=>{ clearInterval(ka); sseClients.delete(res); });
}

if (!SESSION_SECRET) console.warn('[WARN] SESSION_SECRET is not set — set a long random value in production.');

// ---- signed tokens (HMAC-SHA256) ----
const b64 = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function mac(body){ return crypto.createHmac('sha256', SESSION_SECRET || 'insecure-dev').update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function sign(payload, hours){ const body=b64(JSON.stringify(Object.assign({},payload,{exp:Date.now()+hours*3600*1000}))); return body+'.'+mac(body); }
function verify(token){ if(!token||token.indexOf('.')<0) return null; const [body,sig]=token.split('.'); const exp=mac(body); if(sig.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp))) return null; try{ const o=JSON.parse(Buffer.from(body.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString()); return (o.exp&&o.exp>Date.now())?o:null; }catch{ return null; } }

function parseCookies(req){ const out={}; const h=req.headers.cookie; if(!h) return out; h.split(';').forEach(p=>{const i=p.indexOf('='); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}); return out; }
function setCookie(res,name,token,hours){ const a=[`${name}=${encodeURIComponent(token)}`,'HttpOnly','Path=/','SameSite=Lax',`Max-Age=${hours*3600}`]; if(SECURE)a.push('Secure'); res.setHeader('Set-Cookie',a.join('; ')); }
function clearCookie(res,name){ res.setHeader('Set-Cookie',`${name}=; HttpOnly; Path=/; Max-Age=0`+(SECURE?'; Secure':'')); }

function readBody(req){ return new Promise(resolve=>{ let d=''; let big=false; req.on('data',c=>{d+=c; if(d.length>2e6){big=true;req.destroy();}}); req.on('end',()=>{ if(big)return resolve({}); try{resolve(d?JSON.parse(d):{});}catch{resolve({});} }); req.on('error',()=>resolve({})); }); }
function readForm(req){ return new Promise(resolve=>{ let d=''; let big=false; req.on('data',c=>{d+=c; if(d.length>2e5){big=true;req.destroy();}}); req.on('end',()=>{ if(big)return resolve({}); const o={}; d.split('&').forEach(p=>{ if(!p)return; const i=p.indexOf('='); const k=i<0?p:p.slice(0,i); const v=i<0?'':p.slice(i+1); try{ o[decodeURIComponent(k.replace(/\+/g,' '))]=decodeURIComponent(v.replace(/\+/g,' ')); }catch(e){} }); resolve(o); }); req.on('error',()=>resolve({})); }); }
function sendJSON(res,code,obj){ const s=JSON.stringify(obj); res.writeHead(code,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}); res.end(s); }
function sendHTML(res,buf){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache','Expires':'0'}); res.end(buf); }

// ---- guest session: bearer token (works inside cross-site iframe) or cookie ----
function guestSession(req){ const h=req.headers['authorization']||''; const m=h.match(/^Bearer\s+(.+)$/i); if(m){ const v=verify(m[1].trim()); if(v&&v.t==='g') return v; } const v=verify(parseCookies(req)['cph_stay']); return (v&&v.t==='g')?v:null; }
// ---- staff session: cookie (console is top-level same-origin) ----
function staffSession(req){ const v=verify(parseCookies(req)[STAFF_COOKIE]); return (v&&v.t==='s')?v:null; }

// ---- login throttle ----
const attempts=new Map();
const ip=req=>(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'?';
function throttled(k){ const now=Date.now(); const r=attempts.get(k)||{n:0,t:now}; if(now-r.t>15*60*1000){r.n=0;r.t=now;} r.n++; attempts.set(k,r); return r.n>LOGIN_MAX; }

// ============================ GUEST API ============================
async function guestLogin(req,res){
  if(throttled('g:'+ip(req))) return sendJSON(res,429,{ok:false,error:'Too many attempts. Please wait a few minutes, or call your concierge.'});
  const b=await readBody(req); const reference=String(b.reference||'').trim(); const lastName=String(b.lastName||'').trim();
  if(!reference||!lastName) return sendJSON(res,400,{ok:false,error:'Enter your booking reference and lead guest last name.'});
  const r=store.findPublishedForLogin(reference,lastName);
  // Same error for both cases — a distinct "reference exists" reply lets outsiders enumerate bookings.
  if(r.notFound||r.mismatch) return sendJSON(res,401,{ok:false,error:'We could not find a booking with that reference and last name. Check both and try again.'});
  const token=sign({t:'g',ref:reference},GUEST_HOURS); attempts.delete('g:'+ip(req));
  return sendJSON(res,200,{ok:true,stay:r.stay,token});
}
function guestStay(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const stay=store.getPublishedByRefForSession(s.ref); if(!stay) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); store.touchGuestSeen(s.ref); const token=sign({t:'g',ref:s.ref},GUEST_HOURS); return sendJSON(res,200,{ok:true,stay,token}); }
async function guestMessage(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const m=store.addGuestMessage(s.ref,String(b.text||'')); if(!m) return sendJSON(res,400,{ok:false,error:'Empty message.'}); console.log('[message] %s "%s"',s.ref,String(m.text).slice(0,40)); notifyMessage(store.getPublishedByRefForSession(s.ref),m.text); broadcastStaff({type:'message'}); return sendJSON(res,200,{ok:true,message:m}); }
function guestMessages(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const msgs=store.getMessagesByRef(s.ref); if(!msgs) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); store.touchGuestSeen(s.ref); return sendJSON(res,200,{ok:true,messages:msgs}); }
function guestRequests(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const reqs=store.getRequestsByRef(s.ref); if(!reqs) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); store.touchGuestSeen(s.ref); return sendJSON(res,200,{ok:true,requests:reqs}); }
async function guestAddRequest(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const r=store.addRequest(s.ref,b); if(!r) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); console.log('[request] %s %s "%s"',s.ref,r.type,r.title); notifyConcierge(store.getPublishedByRefForSession(s.ref),r); broadcastStaff({type:'request'}); return sendJSON(res,200,{ok:true,request:r}); }

// Notify the concierge when a guest submits a request — WhatsApp (Twilio) and/or email (Resend).
// No-op (logs only) until at least one channel's env vars are set.
function notifyConcierge(stay,r){
  const ref=stay&&stay.booking?stay.booking.reference:''; const guest=stay&&stay.guest?(stay.guest.family||stay.guest.firstName||'Guest'):'Guest'; const villa=stay&&stay.villa?stay.villa.name:'';
  const text=[
    `New My Stay request`,
    `${guest} (booking ${ref})`,'',
    `${r.type==='addon'?'Add-on':'Itinerary'}: ${r.title}`,
    `When: ${r.date||'—'}   Time: ${r.time||'—'}   Guests: ${r.guests||'—'}`,
    r.note?`Note: ${r.note}`:'', villa?`Villa: ${villa}`:'','',
    `Open this stay: ${APP_URL}/console${stay&&stay.stayId?('?stay='+stay.stayId):''}`,
  ].filter(Boolean).join('\n');
  let sent=false;
  if(notifyConciergeAllChannels(text,ref)) sent=true;
  if(RESEND_API_KEY){ sendEmail(`New guest request — ${r.title} (${ref})`,text,ref); sent=true; }
  if(!sent) console.log('[notify] disabled — %s requested "%s" (%s)',guest,r.title,ref);
}
// Notify the concierge of a new guest CHAT message.
function notifyMessage(stay,msgText){
  const ref=stay&&stay.booking?stay.booking.reference:''; const guest=stay&&stay.guest?(stay.guest.family||stay.guest.firstName||'Guest'):'Guest'; const villa=stay&&stay.villa?stay.villa.name:'';
  const text=[`New guest message`,`${guest} (booking ${ref})`,'',`"${msgText}"`,villa?`Villa: ${villa}`:'','',`Reply: ${APP_URL}/console${stay&&stay.stayId?('?stay='+stay.stayId):''}`].filter(Boolean).join('\n');
  let sent=false;
  if(notifyConciergeAllChannels(text,ref)) sent=true;
  if(RESEND_API_KEY){ sendEmail(`New guest message (${ref})`,text,ref); sent=true; }
  if(!sent) console.log('[notify] disabled — %s messaged (%s)',guest,ref);
}
// Notify the GUEST (e.g. request confirmed, or stay published) — email and/or WhatsApp to the guest's own contact.
function toWhatsAppNum(p){ const d=String(p||'').replace(/[^\d]/g,''); return d.length>=8?('whatsapp:+'+d):''; }
function notifyGuest(stay,subject,text){
  if(!stay) return; const email=String(stay.email||'').trim(); const phone=toWhatsAppNum(stay.phone); const ref=stay.reference||'';
  let sent=false;
  if(RESEND_API_KEY && email){ sendEmailTo(email,subject,text,ref); sent=true; }
  if(TWILIO_SID&&TWILIO_TOKEN&&TWILIO_WHATSAPP_FROM && phone){ sendWhatsAppTo(phone,text,ref); sent=true; }
  if(!sent) console.log('[notify-guest] skipped (no channel or no guest contact) — %s',ref);
}
function withWa(n){ return n.indexOf('whatsapp:')===0?n:('whatsapp:'+n); }
// Plain SMS (no WhatsApp window restriction) — used to alert the concierge reliably.
function sendSmsTo(to,text,ref){
  try{
    const form='From='+encodeURIComponent(TWILIO_SMS_FROM)+'&To='+encodeURIComponent(to)+'&Body='+encodeURIComponent(text)+'&StatusCallback='+encodeURIComponent(APP_URL+'/api/twilio/status');
    const auth='Basic '+Buffer.from(TWILIO_SID+':'+TWILIO_TOKEN).toString('base64');
    const https=require('https');
    const rq=https.request('https://api.twilio.com/2010-04-01/Accounts/'+TWILIO_SID+'/Messages.json',{method:'POST',headers:{'Authorization':auth,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(form)}},resp=>{ let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ resp.statusCode>=300?console.error('[notify] sms REJECTED',resp.statusCode,d):console.log('[notify] sms queued re %s to=%s',ref,to); }); });
    rq.on('error',e=>console.error('[notify] sms error',e.message)); rq.write(form); rq.end();
  }catch(e){ console.error('[notify] sms threw',e.message); }
}
function waDigits(n){ return String(n||'').replace(/[^\d]/g,''); }
// Meta WhatsApp Cloud API — send the concierge alert as an approved template (delivers with no 24h window / no sandbox).
function sendWhatsAppCloud(toDigits,text,ref){
  try{
    const body=JSON.stringify({ messaging_product:'whatsapp', to:toDigits, type:'template',
      template:{ name:WHATSAPP_TEMPLATE_NAME, language:{ code:WHATSAPP_TEMPLATE_LANG },
        components:[ { type:'body', parameters:[ { type:'text', text:waSanitize(text) } ] } ] } });
    const https=require('https');
    const rq=https.request('https://graph.facebook.com/v21.0/'+WHATSAPP_PHONE_NUMBER_ID+'/messages',
      { method:'POST', headers:{ 'Authorization':'Bearer '+WHATSAPP_TOKEN, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } },
      resp=>{ let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ resp.statusCode>=300 ? console.error('[notify] whatsapp-cloud REJECTED',resp.statusCode,d) : console.log('[notify] whatsapp-cloud sent re %s to=%s',ref,toDigits); }); });
    rq.on('error',e=>console.error('[notify] whatsapp-cloud error',e.message)); rq.write(body); rq.end();
  }catch(e){ console.error('[notify] whatsapp-cloud threw',e.message); }
}
function notifyConciergeAllChannels(text,ref){
  let sent=false;
  // Preferred: Meta WhatsApp Cloud API. When configured, it's the only channel used for the concierge (no Twilio, no SMS).
  if(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID && CONCIERGE_WHATSAPP){ sendWhatsAppCloud(waDigits(CONCIERGE_WHATSAPP),text,ref); return true; }
  // Fallback (legacy Twilio) — only if Cloud API isn't set up.
  if(TWILIO_SID&&TWILIO_TOKEN&&TWILIO_SMS_FROM&&CONCIERGE_SMS){ sendSmsTo(CONCIERGE_SMS,text,ref); sent=true; }
  if(TWILIO_SID&&TWILIO_TOKEN&&TWILIO_WHATSAPP_FROM&&CONCIERGE_WHATSAPP){ sendWhatsApp(text,ref); sent=true; }
  return sent;
}
// Flatten a multi-line alert into one WhatsApp-template-safe line (no newlines/tabs, no long runs of spaces).
function waSanitize(text){ return String(text||'').replace(/\r/g,'').replace(/\n+/g,' · ').replace(/\s{2,}/g,' ').trim().slice(0,600); }
// Concierge alert: uses the approved template (Content SID) when configured so it delivers outside the 24h window.
function sendWhatsApp(text,ref){ sendWhatsAppTo(CONCIERGE_WHATSAPP,text,ref,TWILIO_CONCIERGE_TEMPLATE_SID); }
function sendWhatsAppTo(to,text,ref,templateSid){
  try{
    let form='From='+encodeURIComponent(withWa(TWILIO_WHATSAPP_FROM))+'&To='+encodeURIComponent(withWa(to));
    if(templateSid){ form+='&ContentSid='+encodeURIComponent(templateSid)+'&ContentVariables='+encodeURIComponent(JSON.stringify({1:waSanitize(text)})); }
    else { form+='&Body='+encodeURIComponent(text); }
    form+='&StatusCallback='+encodeURIComponent(APP_URL+'/api/twilio/status');
    const auth='Basic '+Buffer.from(TWILIO_SID+':'+TWILIO_TOKEN).toString('base64');
    const https=require('https');
    const rq=https.request('https://api.twilio.com/2010-04-01/Accounts/'+TWILIO_SID+'/Messages.json',{method:'POST',headers:{'Authorization':auth,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(form)}},resp=>{ let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ if(resp.statusCode>=300){ console.error('[notify] whatsapp REJECTED',resp.statusCode,d); } else { let sid=''; try{ sid=JSON.parse(d).sid; }catch(_){ } console.log('[notify] whatsapp queued re %s sid=%s to=%s',ref,sid||'?',to); } }); });
    rq.on('error',e=>console.error('[notify] whatsapp error',e.message)); rq.write(form); rq.end();
  }catch(e){ console.error('[notify] whatsapp threw',e.message); }
}
function sendEmail(subject,text,ref){ sendEmailTo(NOTIFY_EMAIL,subject,text,ref); }
function sendEmailTo(to,subject,text,ref){
  try{
    const body=JSON.stringify({from:NOTIFY_FROM,to:[to],subject,text});
    const https=require('https');
    const rq=https.request('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+RESEND_API_KEY,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},resp=>{ let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{ resp.statusCode>=300?console.error('[notify] email failed',resp.statusCode,d):console.log('[notify] emailed %s re %s',to,ref); }); });
    rq.on('error',e=>console.error('[notify] email error',e.message)); rq.write(body); rq.end();
  }catch(e){ console.error('[notify] email threw',e.message); }
}
async function guestRemoveRequest(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const okr=store.removeGuestRequest(s.ref,String(b.id||'')); if(okr) broadcastStaff({type:'update'}); return okr?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
async function guestUpdateRequest(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const r=store.updateGuestRequest(s.ref,String(b.id||''),b); if(!r) return sendJSON(res,404,{ok:false,error:'Request not found.'}); console.log('[request] %s edited "%s"',s.ref,r.title); notifyConcierge(store.getPublishedByRefForSession(s.ref),r); broadcastStaff({type:'request'}); return sendJSON(res,200,{ok:true,request:r}); }
async function guestGuestList(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const list=store.setGuestList(s.ref, Array.isArray(b.guests)?b.guests:[]); if(list===null) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); console.log('[guestlist] %s (%d guests)',s.ref,list.length); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,guestList:list}); }
async function guestCheckinSave(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const c=store.saveCheckin(s.ref,b); if(!c) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); console.log('[checkin] %s airport=%s transfer=%s party=%d+%d',s.ref,c.airport||'-',c.transferType||'-',c.adults,c.children); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,received:true}); }
async function guestSaveGrocery(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const g=store.saveGrocery(s.ref, b||{}); if(g===null) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); console.log('[grocery] %s (%d items)',s.ref,(g.items||[]).length); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,grocery:g}); }
async function guestSaveMealPlan(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const mp=store.saveMealPlan(s.ref, b||{}); if(mp===null) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); console.log('[mealplan] %s',s.ref); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,mealPlan:mp}); }
async function guestRespondSentService(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const it=store.respondSentService(s.ref,String(b.id||''),String(b.response||'')); if(!it) return sendJSON(res,404,{ok:false,error:'Not found'}); console.log('[sent-service] %s %s %s',s.ref,it.name,it.status); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,service:it}); }
async function guestChooseYacht(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const b=await readBody(req); const yp=store.chooseYacht(s.ref,String(b.optionId||'')); if(!yp) return sendJSON(res,404,{ok:false,error:'Not found'}); const chosen=(yp.options||[]).find(o=>o.id===yp.chosenId)||{}; console.log('[yacht] %s chose %s',s.ref,chosen.name||yp.chosenId); const st=store.getPublishedByRefForSession(s.ref); notifyConcierge(st,{type:'yacht',title:'Yacht charter chosen: '+(chosen.name||''),date:'',time:''}); broadcastStaff({type:'update'}); return sendJSON(res,200,{ok:true,yachtProposal:yp}); }
function guestTyping(req,res){ const s=guestSession(req); if(s) broadcastStaff({type:'typing',ref:s.ref}); return sendJSON(res,200,{ok:true}); }

// ---- Inbound WhatsApp/SMS (Twilio webhook). Lands the guest's reply in the right stay's chat. ----
// Configure Twilio: the WhatsApp number's "When a message comes in" → POST {APP_URL}/api/twilio/inbound
async function twilioInbound(req,res){
  const b=await readForm(req);
  const from=b.From||b.from||''; const body=b.Body||b.body||'';
  // Guard: only lands if the sender's number matches a published stay's guest phone.
  const r=store.addGuestMessageByPhone(from,body,/whatsapp/i.test(from)?'whatsapp':'sms');
  if(r){ console.log('[wa-in] %s → stay %s "%s"',from,r.stay.id,String(body).slice(0,40)); broadcastStaff({type:'message'}); }
  else console.log('[wa-in] no matching published stay for %s',from);
  res.writeHead(200,{'Content-Type':'text/xml'}); res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ============================ STAFF API ============================
async function staffLogin(req,res){
  if(throttled('s:'+ip(req))) return sendJSON(res,429,{ok:false,error:'Too many attempts. Please wait a few minutes.'});
  const b=await readBody(req); const email=String(b.email||'').trim(); const password=String(b.password||'');
  const st=store.getStaffByEmail(email);
  if(!st||!store.verifyPassword(password,st.pw)) return sendJSON(res,401,{ok:false,error:'Wrong email or password.'});
  setCookie(res,STAFF_COOKIE,sign({t:'s',sid:st.id,email:st.email,role:st.role},STAFF_HOURS),STAFF_HOURS); attempts.delete('s:'+ip(req));
  return sendJSON(res,200,{ok:true,staff:Object.assign({},store.staffPublic(st),{canRevenue:canSeeRevenue(st)})});
}
/* Staff auth guard with a SLIDING session. The cookie used to be a hard 8h from login: after 8h
   the console kept rendering (it had already loaded) but every API call 401'd, so it looked frozen
   — nothing clickable worked and only a re-sign-in fixed it. Now every authenticated staff request
   re-issues the cookie, so a console in active use never expires; the 8h idle timeout only starts
   counting once you stop using it. The client also hard-fails to the sign-in gate on any 401. */
/* REVENUE ACCESS — the upsell / revenue numbers are owner-level, not concierge-level. Only Jan and
   Ivonna see them; María Fernanda (and any future concierge) does not. Gated on the SERVER, not just
   hidden in the UI, so the numbers can't be fetched by anyone else either.
   Override the list any time with the REVENUE_EMAILS env var (comma-separated). */
const REVENUE_EMAILS = String(process.env.REVENUE_EMAILS || 'jan@caribbeanparadisehomes.com,ivonna@caribbeanparadisehomes.com')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const REVENUE_ROLES = ['owner','admin','manager'];
function canSeeRevenue(s){
  if(!s) return false;
  const email=String(s.email||'').toLowerCase();
  if(REVENUE_EMAILS.includes(email)) return true;
  if(REVENUE_ROLES.includes(String(s.role||'').toLowerCase())) return true;
  return /^(jan|ivonna)@/.test(email); // fallback if the account was seeded on another domain
}
function requireStaff(req,res){
  const s=staffSession(req);
  if(!s){ sendJSON(res,401,{ok:false,error:'Session expired. Please sign in again.'}); return null; }
  setCookie(res,STAFF_COOKIE,sign({t:'s',sid:s.sid,email:s.email,role:s.role},STAFF_HOURS),STAFF_HOURS);
  return s;
}

// Run scheduled guest-message automations, throttled to once every 15 min (covers Render spin-downs:
// fires whenever any request comes in). Also posts the message in-app and emails/WhatsApps the guest if configured.
let _lastAuto=0;
function maybeRunAutomations(){
  const now=Date.now(); if(now-_lastAuto < 15*60*1000) return; _lastAuto=now;
  try{ const sent=store.runAutomations(); sent.forEach(it=>notifyGuest(it,it.subject,it.text)); if(sent.length) console.log('[auto] sent %d scheduled message(s)',sent.length); }
  catch(e){ console.error('[auto] error',e.message); }
}

async function route(req,res){
  maybeRunAutomations();
  const url=req.url.split('?')[0];
  const m=req.method;

  // health — includes PMS mode so the scheduled monitor can distinguish live/mock/unconfigured.
  // no-store: health responses must never be cached (a stale timestamp defeats the monitor).
  if(url==='/healthz'){
    const configured = !!(v365.CFG.key && v365.CFG.pass);
    const mode = v365.CFG.mock ? 'mock' : (configured ? 'live' : 'unconfigured');
    const s = JSON.stringify({ok:true,configured,mode,store:store._counts(),time:new Date().toISOString()});
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','Content-Length':Buffer.byteLength(s)});
    return res.end(s);
  }
  // PMS reachability probe — returns response STRUCTURE only (status/message), never guest data.
  if(m==='GET' && url==='/api/_probe'){
    const configured = !!(v365.CFG.key && v365.CFG.pass);
    const mode = v365.CFG.mock ? 'mock' : (configured ? 'live' : 'unconfigured');
    let probes = [];
    if(mode === 'live'){
      try{ probes = [await v365.probeAction('getreservations')]; }
      catch(e){ probes = [{action:'getreservations', err: e.message}]; }
    }
    const ok = mode === 'live' && probes.length > 0 && probes.every(p => !p.err);
    const s = JSON.stringify({ok,mode,configured,probes,note:'structure only — never returns guest data',time:new Date().toISOString()});
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','Content-Length':Buffer.byteLength(s)});
    return res.end(s);
  }

  // guest api
  if(m==='GET' &&url==='/api/version') return sendJSON(res,200,{ok:true,ver:APP_VER});
  if(m==='POST'&&url==='/api/login') return guestLogin(req,res);
  if(m==='POST'&&url==='/api/logout'){ clearCookie(res,'cph_stay'); return sendJSON(res,200,{ok:true}); }
  if(m==='GET' &&url==='/api/stay') return guestStay(req,res);
  if(m==='POST'&&url==='/api/checkin') return guestCheckinSave(req,res);
  if(m==='POST'&&url==='/api/message') return guestMessage(req,res);
  if(m==='GET' &&url==='/api/messages') return guestMessages(req,res);
  if(m==='GET' &&url==='/api/requests') return guestRequests(req,res);
  if(m==='POST'&&url==='/api/request') return guestAddRequest(req,res);
  if(m==='POST'&&url==='/api/request/remove') return guestRemoveRequest(req,res);
  if(m==='POST'&&url==='/api/request/update') return guestUpdateRequest(req,res);
  if(m==='POST'&&url==='/api/guestlist') return guestGuestList(req,res);
  if(m==='POST'&&url==='/api/grocery') return guestSaveGrocery(req,res);
  if(m==='POST'&&url==='/api/mealplan') return guestSaveMealPlan(req,res);
  if(m==='POST'&&url==='/api/sent-service/respond') return guestRespondSentService(req,res);
  if(m==='POST'&&url==='/api/yacht/choose') return guestChooseYacht(req,res);
  if(m==='POST'&&url==='/api/typing') return guestTyping(req,res);
  if(m==='POST'&&url==='/api/twilio/inbound') return twilioInbound(req,res);
  if(m==='POST'&&url==='/api/twilio/status'){ try{ const b=await readForm(req); const st=b.MessageStatus||b.SmsStatus||''; const err=b.ErrorCode||''; if(st==='undelivered'||st==='failed'){ console.error('[notify] whatsapp DELIVERY FAILED status=%s errorCode=%s to=%s sid=%s',st,err,b.To||'',b.MessageSid||''); } else { console.log('[notify] whatsapp status=%s to=%s',st,b.To||''); } }catch(e){} res.writeHead(204); return res.end(); }

  // staff api
  if(m==='POST'&&url==='/api/staff/login') return staffLogin(req,res);
  if(m==='POST'&&url==='/api/staff/logout'){ clearCookie(res,STAFF_COOKIE); return sendJSON(res,200,{ok:true}); }
  if(m==='GET' &&url==='/api/staff/me'){ const s=staffSession(req); return sendJSON(res,200,{ok:!!s,staff:s?{name:s.email,email:s.email,role:s.role,canRevenue:canSeeRevenue(s)}:null}); }
  if(url.startsWith('/api/staff/')){
    const s=requireStaff(req,res); if(!s) return;
    if(m==='GET'&&url==='/api/staff/events') return sseHandler(req,res);
    if(m==='GET' &&url==='/api/staff/bootstrap') return sendJSON(res,200,{ok:true,villas:store.listVillas(),addons:store.listServicesForStaff(),concierges:store.CONCIERGES,yachtCatalog:store.YACHT_CATALOG,serviceOptions:store.SERVICE_OPTIONS,provisioningOptions:store.PROVISIONING_OPTIONS,bookingSources:store.BOOKING_SOURCES,bookingSourcePartners:store.BOOKING_SOURCE_PARTNERS,serviceBookedVia:store.SERVICE_BOOKED_VIA,calendarFeeds:Object.keys(CAL_FEEDS).map(k=>({id:k,label:CAL_FEEDS[k],url:APP_URL+'/calendar/'+CALENDAR_TOKEN+'/'+k+'.ics'}))});
    if(m==='POST'&&url==='/api/staff/services'){ const b=await readBody(req); const it=store.addCustomService(b); if(it) broadcastStaff({type:'services'}); return it?sendJSON(res,200,{ok:true,service:it}):sendJSON(res,400,{ok:false,error:'A service name is required.'}); }
    const svU=url.match(/^\/api\/staff\/services\/([A-Za-z0-9]+)$/);
    if(svU&&m==='PUT'){ const b=await readBody(req); const it=store.updateService(svU[1],b); if(it) broadcastStaff({type:'services'}); return it?sendJSON(res,200,{ok:true,service:it}):sendJSON(res,404,{ok:false,error:'Service not found'}); }
    if(svU&&m==='DELETE'){ const okd=store.deleteCustomService(svU[1]); if(okd) broadcastStaff({type:'services'}); return okd?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Only custom services can be deleted'}); }
    if(m==='GET' &&url==='/api/staff/stays') return sendJSON(res,200,{ok:true,stays:store.listStays()});
    if(m==='GET' &&url==='/api/staff/metrics'){ if(!canSeeRevenue(s)) return sendJSON(res,403,{ok:false,error:'Revenue is restricted.'}); return sendJSON(res,200,{ok:true,metrics:store.upsellMetrics()}); }
    if(m==='GET' &&url==='/api/staff/export'){ const data=JSON.stringify({exportedAt:new Date().toISOString(),stays:store.exportAll()},null,2); res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="my-stay-backup-'+new Date().toISOString().slice(0,10)+'.json"'}); return res.end(data); }
    if(m==='POST'&&url==='/api/staff/stays') return sendJSON(res,200,{ok:true,stay:store.createStay()});
    const cm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/requests\/([A-Za-z0-9]+)\/confirm$/);
    if(cm&&m==='POST'){ const b=await readBody(req); const r=store.confirmRequest(cm[1],cm[2],String(b.price||'')); if(r){ const st=store.getStay(cm[1]); notifyGuest(st,`Your request is confirmed — ${r.title}`,['Good news — your concierge has confirmed your request.','',`${r.title}${r.price?' · '+r.price:''}`,r.date?`When: ${r.date}${r.time?' '+r.time:''}`:'','','See the details in your My Stay app.'].filter(Boolean).join('\n')); } return r?sendJSON(res,200,{ok:true,request:r}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const dm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/requests\/([A-Za-z0-9]+)\/done$/);
    if(dm&&m==='POST'){ const r=store.markRequestDone(dm[1],dm[2]); if(r) broadcastStaff({type:'update'}); return r?sendJSON(res,200,{ok:true,request:r}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ro=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/requests\/([A-Za-z0-9]+)\/reopen$/);
    if(ro&&m==='POST'){ const r=store.reopenRequest(ro[1],ro[2]); if(r) broadcastStaff({type:'update'}); return r?sendJSON(res,200,{ok:true,request:r}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const fm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/requests\/([A-Za-z0-9]+)\/family$/);
    if(fm&&m==='PUT'){ const b=await readBody(req); const r=store.setRequestFamily(fm[1],fm[2],String(b.familyName||'')); if(r) broadcastStaff({type:'update'}); return r?sendJSON(res,200,{ok:true,request:r}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const rm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/requests\/([A-Za-z0-9]+)$/);
    if(rm&&m==='DELETE'){ return store.removeStaffRequest(rm[1],rm[2])?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    if(rm&&m==='PUT'){ const b=await readBody(req); const r=store.staffUpdateRequest(rm[1],rm[2],b); if(r) broadcastStaff({type:'update'}); return r?sendJSON(res,200,{ok:true,request:r}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const rcM=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/reset-checkin$/);
    if(rcM&&m==='POST'){ const b=await readBody(req); const s=store.resetCheckin(rcM[1],String(b.part||'precheckin')); if(s) broadcastStaff({type:'update'}); return s?sendJSON(res,200,{ok:true,stay:store.toGuestStay(s)}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ssA=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/sent-services$/);
    if(ssA&&m==='POST'){ const b=await readBody(req); const it=store.sendService(ssA[1],b); if(it){ const st=store.getStay(ssA[1]); if(st&&st.status==='published') notifyGuest(st,'A service has been arranged for you',['Your concierge has set up a service for your stay — please open My Stay to review and confirm.','',`${it.name}${it.option?' · '+it.option:''}${it.rate?' · '+it.rate:''}`].join('\n')); broadcastStaff({type:'update'}); } return it?sendJSON(res,200,{ok:true,service:it}):sendJSON(res,400,{ok:false,error:'A service name is required.'}); }
    const ssB=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/sent-services\/([A-Za-z0-9]+)$/);
    if(ssB&&m==='PUT'){ const b=await readBody(req); const it=store.updateSentService(ssB[1],ssB[2],b); if(it) broadcastStaff({type:'update'}); return it?sendJSON(res,200,{ok:true,service:it}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    if(ssB&&m==='DELETE'){ const okd=store.cancelSentService(ssB[1],ssB[2]); if(okd) broadcastStaff({type:'update'}); return okd?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ivA=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/invoices$/);
    if(ivA&&m==='POST'){ const b=await readBody(req); const it=store.createInvoice(ivA[1],b); if(it&&it.error) return sendJSON(res,400,{ok:false,error:it.error}); if(it) broadcastStaff({type:'update'}); return it?sendJSON(res,200,{ok:true,invoice:it}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ivB=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/invoices\/([A-Za-z0-9]+)$/);
    if(ivB&&m==='PUT'){ const b=await readBody(req); const it=store.updateInvoice(ivB[1],ivB[2],b); if(it&&it.error) return sendJSON(res,400,{ok:false,error:it.error}); if(it) broadcastStaff({type:'update'}); return it?sendJSON(res,200,{ok:true,invoice:it}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    if(ivB&&m==='DELETE'){ const okd=store.deleteInvoice(ivB[1],ivB[2]); if(okd) broadcastStaff({type:'update'}); return okd?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ivS=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/invoices\/([A-Za-z0-9]+)\/(send|paid|draft)$/);
    if(ivS&&m==='POST'){ const action=ivS[3]; const status=action==='send'?'sent':action; const it=store.setInvoiceStatus(ivS[1],ivS[2],status); if(it){ if(action==='send'){ const st=store.getStay(ivS[1]); if(st&&st.status==='published'){ const tot=store.invoiceTotal(it); notifyGuest(st,'Your invoice is ready',['Your concierge has sent you an invoice — open My Stay to review and settle it.','',`${it.title}: $${tot.toLocaleString('en-US')}${it.dueBy?' · due '+it.dueBy:''}`].join('\n')); } } broadcastStaff({type:'update'}); } return it?sendJSON(res,200,{ok:true,invoice:it}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const ypA=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/yacht$/);
    if(ypA&&m==='POST'){ const b=await readBody(req); const yp=store.setYachtProposal(ypA[1],b); if(yp){ const st=store.getStay(ypA[1]); if(st&&st.status==='published') notifyGuest(st,'Yacht charter options for your stay',['Your concierge has sent you a few yacht charter options to choose from — open My Stay to review and pick your favourite.','',(yp.options||[]).map(o=>`• ${o.name}${o.rate?' · '+o.rate:''}`).join('\n')].join('\n')); broadcastStaff({type:'update'}); } return yp?sendJSON(res,200,{ok:true,yachtProposal:yp}):sendJSON(res,400,{ok:false,error:'Add at least one option.'}); }
    if(ypA&&m==='DELETE'){ const okd=store.cancelYachtProposal(ypA[1]); if(okd) broadcastStaff({type:'update'}); return okd?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    const sm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)\/messages$/);
    if(sm&&m==='POST'){ const b=await readBody(req); store.markStaffRead(sm[1]); const msg=store.addStaffMessage(sm[1],String(b.text||'')); if(msg){ const st=store.getStay(sm[1]); const ph=st?toWhatsAppNum(st.phone):''; if(ph&&TWILIO_SID&&TWILIO_TOKEN&&TWILIO_WHATSAPP_FROM){ sendWhatsAppTo(ph,msg.text,(st.reference||'')); } } return msg?sendJSON(res,200,{ok:true,message:msg}):sendJSON(res,400,{ok:false,error:'Empty or not found'}); }
    const mm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)(\/publish)?$/);
    if(mm){
      const id=mm[1];
      // The console gets the stay PLUS derived read-only fields (cartNote) so the editor banner and
      // the arrivals board can never disagree — both come from store.cartInfo(). cartNote is not in
      // the saveStay whitelist, so it is never persisted back.
      if(m==='GET'){ store.markStaffRead(id); const st=store.getStay(id); return st?sendJSON(res,200,{ok:true,stay:Object.assign({},st,{cartNote:store.cartInfo(st).note})}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='POST'&&mm[2]==='/publish'){ const wasPublished=(store.getStay(id)||{}).status==='published'; const st=store.publishStay(id); if(st&&!wasPublished){ notifyGuest(st,'Your My Stay is ready',['Your villa concierge has prepared your personalised My Stay.','',`Booking ${st.reference} — open it any time at:`,`${APP_URL}/my-stay?b=${st.reference}`,'','Sign in with your booking reference and lead-guest last name.'].join('\n')); } return st?sendJSON(res,200,{ok:true,stay:st}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='PUT'){ const patch=await readBody(req); const st=store.saveStay(id,patch); return st?sendJSON(res,200,{ok:true,stay:st}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='DELETE'){ return store.deleteStay(id)?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    }
    return sendJSON(res,404,{ok:false,error:'Unknown staff route'});
  }

  // ---- iCal subscription feeds (Apple Calendar / Google / Outlook). Secret token in the path. ----
  // One feed per greeter: /calendar/<token>/{maria|ivonna|jan|none}.ics — Apple colours per CALENDAR,
  // not per event, so a separate feed per greeter is the only way to colour by who's meeting the guest.
  const calM=url.match(/^\/calendar\/([A-Za-z0-9_-]+)\/([a-z]+)\.ics$/);
  if(calM&&(m==='GET'||m==='HEAD')){
    const got=Buffer.from(calM[1]), want=Buffer.from(CALENDAR_TOKEN);
    const okTok = got.length===want.length && crypto.timingSafeEqual(got,want);
    if(!okTok || !CAL_FEEDS[calM[2]]){ res.writeHead(404,{'Content-Type':'text/plain'}); return res.end('Not found'); }
    const body=calendarICS(calM[2]);
    res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'inline; filename="cph-'+calM[2]+'.ics"','Cache-Control':'no-cache, must-revalidate','Content-Length':Buffer.byteLength(body)});
    return m==='HEAD'?res.end():res.end(body);
  }

  // pages
  if(m==='GET'&&STATIC_IMAGES[url]){ const _ct=/\.webp$/i.test(url)?'image/webp':/\.png$/i.test(url)?'image/png':'image/jpeg'; res.writeHead(200,{'Content-Type':_ct,'Cache-Control':'public, max-age=86400'}); return res.end(STATIC_IMAGES[url]); }
  if(m==='GET'&&url==='/sw.js'){ res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-cache','Service-Worker-Allowed':'/'}); return res.end(SW_JS); }
  if(m==='GET'&&url==='/manifest.webmanifest'){ res.writeHead(200,{'Content-Type':'application/manifest+json; charset=utf-8','Cache-Control':'no-cache'}); return res.end(MANIFEST_JSON); }
  if(m==='GET'&&(url==='/console'||url.startsWith('/console'))) return sendHTML(res,CONSOLE_HTML);
  if(m==='GET') return sendHTML(res,INDEX_HTML);
  res.writeHead(405); res.end('Method not allowed');
}

const server=http.createServer((req,res)=>{ route(req,res).catch(err=>{ console.error('[server]',err); try{sendJSON(res,500,{ok:false,error:'Server error'});}catch(e){} }); });
server.listen(PORT,()=>console.log(`CPH My Stay on :${PORT} | data=${store.DATA_DIR} | ${JSON.stringify(store._counts())}`));
setTimeout(()=>{ _lastAuto=0; maybeRunAutomations(); }, 8000);
setInterval(()=>{ _lastAuto=0; maybeRunAutomations(); }, 60*60*1000);
