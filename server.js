'use strict';

/**
 * CPH "My Stay" server — zero external dependencies (Node >=18 stdlib only).
 * Flat layout: server.js + villas365.js + index.html all live in the repo root.
 * Serves the guest app (index.html) and a small JSON API that talks to 365Villas.
 * For safety the server ONLY ever returns index.html for non-API routes — it never
 * serves server.js / villas365.js / .env to the public.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const v365 = require('./villas365');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE = 'cph_stay';
const SECURE_COOKIES = process.env.NODE_ENV !== 'development';
const LOGIN_MAX = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

if (!SESSION_SECRET) console.warn('[WARN] SESSION_SECRET is not set — set a long random value in production.');

// ---- tiny signed token (JWT-style) via HMAC-SHA256, no deps ----
const enc = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function mac(body){ return crypto.createHmac('sha256', SESSION_SECRET || 'insecure-dev-secret').update(body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function sign(payload){ const body = enc(JSON.stringify(Object.assign({}, payload, { exp: Date.now()+SESSION_HOURS*3600*1000 }))); return body + '.' + mac(body); }
function verify(token){
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.'); const expect = mac(body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { const o = JSON.parse(Buffer.from(body.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString()); return (o.exp && o.exp > Date.now()) ? o : null; } catch { return null; }
}
function parseCookies(req){ const out={}; const h=req.headers.cookie; if(!h) return out; h.split(';').forEach(p=>{const i=p.indexOf('='); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}); return out; }
function setCookie(res, token){ const a=[`${COOKIE}=${encodeURIComponent(token)}`,'HttpOnly','Path=/','SameSite=Lax',`Max-Age=${SESSION_HOURS*3600}`]; if(SECURE_COOKIES)a.push('Secure'); res.setHeader('Set-Cookie', a.join('; ')); }
function clearCookie(res){ res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`+(SECURE_COOKIES?'; Secure':'')); }
function session(req){
  // Prefer a Bearer token (works in cross-site iframes where 3rd-party cookies are blocked); fall back to cookie.
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) { const v = verify(m[1].trim()); if (v) return v; }
  return verify(parseCookies(req)[COOKIE]);
}

function readBody(req){ return new Promise(resolve=>{ let d=''; let big=false; req.on('data',c=>{d+=c; if(d.length>1e6){big=true;req.destroy();}}); req.on('end',()=>{ if(big)return resolve({}); try{resolve(d?JSON.parse(d):{});}catch{resolve({});} }); req.on('error',()=>resolve({})); }); }
function sendJSON(res, code, obj){ const s=JSON.stringify(obj); res.writeHead(code,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}); res.end(s); }

// ---- in-memory login throttle (per IP, 15-min window) ----
const attempts = new Map();
const clientIp = req => (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
function throttled(ip){ const now=Date.now(); const r=attempts.get(ip)||{n:0,t:now}; if(now-r.t>15*60*1000){r.n=0;r.t=now;} r.n++; attempts.set(ip,r); return r.n>LOGIN_MAX; }

async function handleLogin(req,res){
  const ip=clientIp(req);
  if(throttled(ip)) return sendJSON(res,429,{ok:false,error:'Too many attempts. Please wait a few minutes, or call your concierge.'});
  const b=await readBody(req); const reference=String(b.reference||'').trim(); const lastName=String(b.lastName||'').trim();
  if(!reference||!lastName) return sendJSON(res,400,{ok:false,error:'Enter your booking reference and lead guest last name.'});
  try{
    let stay;
    if(v365.CFG.mock){
      const r=v365.mock.verify(reference,lastName);
      if(r===null) return sendJSON(res,404,{ok:false,error:'We could not find that booking. Check the reference and try again.'});
      if(r===false) return sendJSON(res,401,{ok:false,error:'That last name does not match this booking.'});
      stay=r;
    } else {
      if(!v365.isConfigured()) return sendJSON(res,503,{ok:false,error:'Booking system is not configured yet.'});
      stay=await v365.lookupStay(reference);
      if(!stay) return sendJSON(res,404,{ok:false,error:'We could not find that booking. Check the reference and try again.'});
      if((stay.guest.lastName||'').trim().toLowerCase()!==lastName.toLowerCase()) return sendJSON(res,401,{ok:false,error:'That last name does not match this booking.'});
      if(stay.booking.status && /draft|needs.?info/i.test(String(stay.booking.status))) return sendJSON(res,403,{ok:false,error:'Your stay is being finalized. Please check back shortly or contact your concierge.'});
    }
    const token = sign({ref:reference,last:lastName});
    setCookie(res, token); attempts.delete(ip);
    return sendJSON(res,200,{ok:true,stay,token});
  }catch(err){ console.error('[login]',err.message); return sendJSON(res,502,{ok:false,error:'We had trouble reaching the booking system. Please try again, or call your concierge.'}); }
}
async function handleStay(req,res){
  const s=session(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'});
  try{ const stay=v365.CFG.mock?v365.mock.verify(s.ref,s.last):await v365.lookupStay(s.ref); if(!stay) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); return sendJSON(res,200,{ok:true,stay}); }
  catch(err){ console.error('[stay]',err.message); return sendJSON(res,502,{ok:false,error:'Could not load your stay right now.'}); }
}
async function handleSubmit(kind,req,res){
  const s=session(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'});
  await readBody(req); console.log('[%s] booking %s',kind,s.ref);
  if(kind==='message') return sendJSON(res,200,{ok:true,received:true,autoReply:'Thanks! Your concierge will reply shortly.'});
  return sendJSON(res,200,{ok:true,received:true});
}

const server = http.createServer(async (req,res)=>{
  const url=req.url.split('?')[0];
  try{
    if(url==='/healthz') return sendJSON(res,200,{ok:true,mode:v365.CFG.mock?'mock':'live',configured:v365.isConfigured(),time:new Date().toISOString()});
    if(req.method==='POST'&&url==='/api/login') return handleLogin(req,res);
    if(req.method==='POST'&&url==='/api/logout'){ clearCookie(res); return sendJSON(res,200,{ok:true}); }
    if(req.method==='GET' &&url==='/api/stay') return handleStay(req,res);
    if(req.method==='POST'&&url==='/api/checkin') return handleSubmit('checkin',req,res);
    if(req.method==='POST'&&url==='/api/addons') return handleSubmit('addons',req,res);
    if(req.method==='POST'&&url==='/api/message') return handleSubmit('message',req,res);
    if(req.method==='GET'){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache, must-revalidate'}); return res.end(INDEX_HTML); }
    res.writeHead(405); res.end('Method not allowed');
  }catch(err){ console.error('[server]',err); sendJSON(res,500,{ok:false,error:'Server error'}); }
});
server.listen(PORT, ()=>console.log(`CPH My Stay on :${PORT} (mode=${v365.CFG.mock?'MOCK':'LIVE'})`));
