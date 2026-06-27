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

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const GUEST_HOURS = Number(process.env.SESSION_HOURS || 12);
const STAFF_HOURS = Number(process.env.STAFF_SESSION_HOURS || 8);
const STAFF_COOKIE = 'cph_staff';
const SECURE = process.env.NODE_ENV !== 'development';
const LOGIN_MAX = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'console.html'));

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
function sendJSON(res,code,obj){ const s=JSON.stringify(obj); res.writeHead(code,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}); res.end(s); }
function sendHTML(res,buf){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache, must-revalidate'}); res.end(buf); }

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
  if(r.notFound) return sendJSON(res,404,{ok:false,error:'We could not find that booking. Check the reference and try again.'});
  if(r.mismatch) return sendJSON(res,401,{ok:false,error:'That last name does not match this booking.'});
  const token=sign({t:'g',ref:reference},GUEST_HOURS); attempts.delete('g:'+ip(req));
  return sendJSON(res,200,{ok:true,stay:r.stay,token});
}
function guestStay(req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); const stay=store.getPublishedByRefForSession(s.ref); if(!stay) return sendJSON(res,404,{ok:false,error:'Booking not found.'}); return sendJSON(res,200,{ok:true,stay}); }
async function guestSubmit(kind,req,res){ const s=guestSession(req); if(!s) return sendJSON(res,401,{ok:false,error:'Not signed in.'}); await readBody(req); console.log('[%s] %s',kind,s.ref); if(kind==='message') return sendJSON(res,200,{ok:true,received:true,autoReply:'Thanks! Your concierge will reply shortly.'}); return sendJSON(res,200,{ok:true,received:true}); }

// ============================ STAFF API ============================
async function staffLogin(req,res){
  if(throttled('s:'+ip(req))) return sendJSON(res,429,{ok:false,error:'Too many attempts. Please wait a few minutes.'});
  const b=await readBody(req); const email=String(b.email||'').trim(); const password=String(b.password||'');
  const st=store.getStaffByEmail(email);
  if(!st||!store.verifyPassword(password,st.pw)) return sendJSON(res,401,{ok:false,error:'Wrong email or password.'});
  setCookie(res,STAFF_COOKIE,sign({t:'s',sid:st.id,email:st.email,role:st.role},STAFF_HOURS),STAFF_HOURS); attempts.delete('s:'+ip(req));
  return sendJSON(res,200,{ok:true,staff:store.staffPublic(st)});
}
function requireStaff(req,res){ const s=staffSession(req); if(!s){ sendJSON(res,401,{ok:false,error:'Not signed in.'}); return null; } return s; }

async function route(req,res){
  const url=req.url.split('?')[0];
  const m=req.method;

  // health
  if(url==='/healthz') return sendJSON(res,200,{ok:true,store:store._counts(),time:new Date().toISOString()});

  // guest api
  if(m==='POST'&&url==='/api/login') return guestLogin(req,res);
  if(m==='POST'&&url==='/api/logout'){ clearCookie(res,'cph_stay'); return sendJSON(res,200,{ok:true}); }
  if(m==='GET' &&url==='/api/stay') return guestStay(req,res);
  if(m==='POST'&&url==='/api/checkin') return guestSubmit('checkin',req,res);
  if(m==='POST'&&url==='/api/addons') return guestSubmit('addons',req,res);
  if(m==='POST'&&url==='/api/message') return guestSubmit('message',req,res);

  // staff api
  if(m==='POST'&&url==='/api/staff/login') return staffLogin(req,res);
  if(m==='POST'&&url==='/api/staff/logout'){ clearCookie(res,STAFF_COOKIE); return sendJSON(res,200,{ok:true}); }
  if(m==='GET' &&url==='/api/staff/me'){ const s=staffSession(req); return sendJSON(res,200,{ok:!!s,staff:s?{name:s.email,email:s.email,role:s.role}:null}); }
  if(url.startsWith('/api/staff/')){
    const s=requireStaff(req,res); if(!s) return;
    if(m==='GET' &&url==='/api/staff/bootstrap') return sendJSON(res,200,{ok:true,villas:store.listVillas(),addons:store.ADDON_CATALOG,concierges:store.CONCIERGES});
    if(m==='GET' &&url==='/api/staff/stays') return sendJSON(res,200,{ok:true,stays:store.listStays()});
    if(m==='POST'&&url==='/api/staff/stays') return sendJSON(res,200,{ok:true,stay:store.createStay()});
    const mm=url.match(/^\/api\/staff\/stays\/([A-Za-z0-9]+)(\/publish)?$/);
    if(mm){
      const id=mm[1];
      if(m==='GET'){ const st=store.getStay(id); return st?sendJSON(res,200,{ok:true,stay:st}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='POST'&&mm[2]==='/publish'){ const st=store.publishStay(id); return st?sendJSON(res,200,{ok:true,stay:st}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='PUT'){ const patch=await readBody(req); const st=store.saveStay(id,patch); return st?sendJSON(res,200,{ok:true,stay:st}):sendJSON(res,404,{ok:false,error:'Not found'}); }
      if(m==='DELETE'){ return store.deleteStay(id)?sendJSON(res,200,{ok:true}):sendJSON(res,404,{ok:false,error:'Not found'}); }
    }
    return sendJSON(res,404,{ok:false,error:'Unknown staff route'});
  }

  // pages
  if(m==='GET'&&(url==='/console'||url.startsWith('/console'))) return sendHTML(res,CONSOLE_HTML);
  if(m==='GET') return sendHTML(res,INDEX_HTML);
  res.writeHead(405); res.end('Method not allowed');
}

const server=http.createServer((req,res)=>{ route(req,res).catch(err=>{ console.error('[server]',err); try{sendJSON(res,500,{ok:false,error:'Server error'});}catch(e){} }); });
server.listen(PORT,()=>console.log(`CPH My Stay on :${PORT} | data=${store.DATA_DIR} | ${JSON.stringify(store._counts())}`));
