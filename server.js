/**
 * Proxy de "Mi plan" (Registro_Gimnasio) para Render.
 *
 * El celular le habla a este servicio con UNA petición HTTPS que responde directo (con CORS), y el servicio le
 * habla a Apps Script de servidor a servidor, con reintentos. Así el iPhone ya no pasa por la redirección de
 * Apps Script (script.google.com → script.googleusercontent.com), que es lo que produce los "Load failed" y
 * los HTTP 404 en redes lentas.
 *
 * Solo reenvía: no guarda nada y no registra tokens ni contenidos (solo nombre de la función, estado y tiempo).
 * Solo habla con la URL de Apps Script configurada (no es un proxy abierto).
 *
 * Variables de entorno:
 *   APPS_SCRIPT_URL   URL /exec de la implementación de Apps Script (por defecto la de la app)
 *   ALLOWED_ORIGINS   orígenes con permiso CORS, separados por coma (por defecto la app en GitHub Pages)
 *   RATE_LIMIT        peticiones por minuto por IP (por defecto 120)
 *   PORT              lo pone Render
 */
'use strict';
const http = require('http');

const DESTINO = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxpNYt8b4tM8Bzk0I1tC2EoZplQqsqtm0iK2kgqpOO4-hcrTp_tzuGN0nhSKD42o8tD/exec';
const ORIGENES = (process.env.ALLOWED_ORIGINS || 'https://yonathanceravntes.github.io').split(',').map(s => s.trim()).filter(Boolean);
const PUERTO = Number(process.env.PORT) || 10000;
const MAX_CUERPO = 30 * 1024 * 1024;                  // fotos en base64
const POR_MINUTO = Number(process.env.RATE_LIMIT) || 120;
const LENTAS = new Set(['disenarPlanIA', 'coachAnalizar', 'coachPreguntar', 'probarIAApp']);   // la IA piensa 20–90 s
const T_NORMAL = 60000, T_LENTA = 170000, T_ECO = 30000;
const inicio = Date.now();
const cuenta = { atendidas: 0, fallidas: 0, reintentos: 0 };

const esperar = ms => new Promise(ok => setTimeout(ok, ms));
const esLectura = fn => /^get/.test(fn);   // getInicio, getPanel…: repetirlas no cambia nada

/* ---------- CORS y respuestas ---------- */
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGENES.includes('*') || ORIGENES.includes(o))) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function responder(res, status, cuerpo) {
  const txt = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(txt);
}

/* ---------- Límite por IP ---------- */
const visitas = new Map();
function limitar(req) {
  // Render agrega la IP real al final de X-Forwarded-For (lo del principio lo puede inventar quien llama)
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
  const ahora = Date.now(), v = visitas.get(ip);
  if (!v || ahora - v.desde > 60000) { visitas.set(ip, { desde: ahora, n: 1 }); return false; }
  v.n++;
  return v.n > POR_MINUTO;
}
setInterval(() => { const ahora = Date.now(); for (const [ip, v] of visitas) if (ahora - v.desde > 120000) visitas.delete(ip); }, 60000).unref();

function leerCuerpo(req) {
  return new Promise((ok, ko) => {
    const partes = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > MAX_CUERPO) { ko(Object.assign(new Error('Petición demasiado grande'), { status: 413 })); req.destroy(); } else partes.push(d); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', ko);
  });
}

/* ---------- Apps Script ---------- */
/** La conexión ni siquiera se abrió: repetir es seguro aunque la función escriba. */
function sinConectar(e) {
  const c = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/.test(c);
}
function motivo(e) { return String((e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.name === 'TimeoutError' ? 'tiempo agotado' : e.message)) || e); }

/** La respuesta de Apps Script vive en la URL de la redirección (script.googleusercontent.com). Pedirla se puede repetir. */
async function leerEco(url) {
  let ultimo;
  for (let k = 0; k < 3; k++) {
    if (k) { cuenta.reintentos++; await esperar(400 * k); }
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(T_ECO) });
      const txt = await r.text();
      if (r.ok) return txt;
      ultimo = new Error('eco HTTP ' + r.status);
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}

/**
 * Envía la llamada a Apps Script. Lecturas: hasta 3 intentos. Escrituras: se repiten solo si la conexión no llegó a
 * abrirse o si Google respondió 429/503 (no ejecutó). Llamadas de IA: nunca se repiten (cada intento cuesta).
 */
async function llamarAppsScript(cuerpo, fn) {
  const lectura = esLectura(fn), lenta = LENTAS.has(fn);
  const intentos = lectura ? 3 : lenta ? 1 : 2;
  let ultimo = null;
  for (let i = 0; i < intentos; i++) {
    if (i) { cuenta.reintentos++; await esperar(500 * i); }
    let r;
    try {
      r = await fetch(DESTINO, { method: 'POST', body: cuerpo, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'manual',
                                 signal: AbortSignal.timeout(lenta ? T_LENTA : T_NORMAL) });
    } catch (e) {
      ultimo = e;
      if (lectura || sinConectar(e)) continue;
      break;
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      try { await r.arrayBuffer(); } catch (e) {}
      return await leerEco(r.headers.get('location'));   // ya se ejecutó: solo falta leer la respuesta
    }
    const txt = await r.text().catch(() => '');
    if (r.ok) return txt;                                     // (Apps Script a veces responde directo)
    ultimo = new Error('Apps Script HTTP ' + r.status);
    if (!lectura && r.status !== 429 && r.status !== 503) break;
  }
  throw ultimo || new Error('sin respuesta');
}

/* ---------- Servidor ---------- */
const servidor = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && (url.pathname === '/salud' || url.pathname === '/')) {
    return responder(res, 200, { ok: true, servicio: 'proxy Mi plan', desde: new Date(inicio).toISOString(), ...cuenta });
  }
  if (url.pathname !== '/api') return responder(res, 404, { ok: false, error: 'No encontrado' });
  if (limitar(req)) return responder(res, 429, { ok: false, error: 'Demasiadas peticiones; espera un minuto.' });

  if (req.method === 'GET') {   // diagnóstico de la cadena completa: ?api=ping
    if (url.searchParams.get('api') !== 'ping') return responder(res, 400, { ok: false, error: 'Usa POST' });
    const t0 = Date.now();
    try {
      const r = await fetch(DESTINO + '?api=ping', { redirect: 'follow', signal: AbortSignal.timeout(T_NORMAL) });
      const txt = await r.text();
      console.log(`ping ${r.status} ${Date.now() - t0}ms`);
      return responder(res, r.ok ? 200 : 502, r.ok ? txt : { ok: false, error: 'Apps Script HTTP ' + r.status });
    } catch (e) { console.log(`ping ERROR ${motivo(e)} ${Date.now() - t0}ms`); return responder(res, 502, { ok: false, error: 'No pude llegar a Apps Script: ' + motivo(e) }); }
  }
  if (req.method !== 'POST') return responder(res, 405, { ok: false, error: 'Método no permitido' });

  let cuerpo, fn = '?';
  try {
    cuerpo = await leerCuerpo(req);
    const j = JSON.parse(cuerpo);
    fn = String(j && j.fn || '');
    if (!/^[A-Za-z_]\w{0,60}$/.test(fn)) throw Object.assign(new Error('Falta la función'), { status: 400 });
  } catch (e) {
    return responder(res, e.status || 400, { ok: false, error: e.status === 413 ? 'La petición es demasiado grande.' : 'Petición no válida.' });
  }
  const t0 = Date.now();
  try {
    const txt = await llamarAppsScript(cuerpo, fn);
    cuenta.atendidas++;
    console.log(`${fn} 200 ${Date.now() - t0}ms`);
    return responder(res, 200, txt);
  } catch (e) {
    cuenta.fallidas++;
    console.log(`${fn} ERROR ${motivo(e)} ${Date.now() - t0}ms`);
    return responder(res, 502, { ok: false, error: 'El servidor de la app no respondió (' + motivo(e) + ').', codigo: 'proxy' });
  }
});
servidor.requestTimeout = 0;          // las llamadas de IA tardan; Apps Script pone su propio límite
servidor.headersTimeout = 65000;
servidor.keepAliveTimeout = 65000;
servidor.listen(PUERTO, () => console.log(`Proxy Mi plan escuchando en ${PUERTO} → ${DESTINO.replace(/macros\/s\/[^/]+/, 'macros/s/…')} · CORS: ${ORIGENES.join(', ')}`));
module.exports = servidor;
