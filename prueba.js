// Pruebas del proxy con un Apps Script simulado (302 → eco de un solo uso, fallas y lentitud)
'use strict';
const http = require('http');
const { spawn } = require('child_process');
let ok = true; const check = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) ok = false; };

const PUERTO_GAS = 18081, PUERTO_PROXY = 18082, ORIGEN = 'http://localhost:8130';
let modo = {}, ejecuciones = {}, ecos = {}, n = 0;
const gas = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/exec' && req.method === 'GET') { res.writeHead(302, { Location: `http://localhost:${PUERTO_GAS}/echo?k=ping` }); ecos.ping = '{"ok":true,"hora":"ahora"}'; return res.end(); }
  if (u.pathname === '/exec') {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const j = JSON.parse(b), fn = j.fn, m = modo[fn] || '';
      if (m === '503-una-vez' && !ejecuciones['503:' + fn]) { ejecuciones['503:' + fn] = 1; res.writeHead(503); return res.end('Service Unavailable'); }
      if (m === 'cortar-antes' && !ejecuciones['cut:' + fn]) { ejecuciones['cut:' + fn] = 1; return req.socket.destroy(); }   // no ejecutó
      ejecuciones[fn] = (ejecuciones[fn] || 0) + 1;
      if (m === 'cortar-despues') return req.socket.destroy();                                                                 // ejecutó y se cortó
      const k = 'e' + (++n); ecos[k] = JSON.stringify({ ok: true, r: { fn, args: j.args, t: j.t ? 'con token' : 'sin token' } });
      const enviar = () => { res.writeHead(302, { Location: `http://localhost:${PUERTO_GAS}/echo?k=${k}` }); res.end(); };
      if (m === 'lento') setTimeout(enviar, 1500);
      else if (m === 'lento-una-vez' && !ejecuciones['slow:' + fn]) { ejecuciones['slow:' + fn] = 1; setTimeout(enviar, 8000); }
      else enviar();
    });
    return;
  }
  if (u.pathname === '/echo') {
    const k = u.searchParams.get('k'), fn = ecos[k] && JSON.parse(ecos[k]).r && JSON.parse(ecos[k]).r.fn;
    if (fn && modo[fn] === '404-eco-una-vez' && !ecos['404:' + k]) { ecos['404:' + k] = 1; res.writeHead(404); return res.end('Not Found'); }
    if (!ecos[k]) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(ecos[k]);
  }
  res.writeHead(404); res.end();
}).listen(PUERTO_GAS);

const pedir = (metodo, ruta, cuerpo, origen) => new Promise(ok => {
  const req = http.request({ host: 'localhost', port: PUERTO_PROXY, path: ruta, method: metodo, headers: origen ? { Origin: origen } : {} }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', e => ok({ status: 0, body: String(e) }));
  if (cuerpo) req.write(cuerpo); req.end();
});
const post = (fn, extra) => pedir('POST', '/api', JSON.stringify(Object.assign({ fn, args: [1], t: 'TOKEN-SECRETO' }, extra || {})), ORIGEN);

const proxy = spawn(process.execPath, [__dirname + '/server.js'], { env: Object.assign({}, process.env, { PORT: PUERTO_PROXY, APPS_SCRIPT_URL: `http://localhost:${PUERTO_GAS}/exec`, ALLOWED_ORIGINS: ORIGEN, RATE_LIMIT: 60 }) });
let logs = ''; proxy.stdout.on('data', d => logs += d); proxy.stderr.on('data', d => logs += d);

(async () => {
  await new Promise(r => setTimeout(r, 600));
  let r = await pedir('GET', '/salud');
  check(r.status === 200 && /proxy Mi plan/.test(r.body), 'salud responde');
  r = await post('getInicio');
  check(r.status === 200 && JSON.parse(r.body).r.fn === 'getInicio' && r.headers['access-control-allow-origin'] === ORIGEN, 'getInicio pasa por la redirección y vuelve con CORS');
  r = await pedir('POST', '/api', JSON.stringify({ fn: 'getInicio', args: [] }), 'https://otro.sitio');
  check(r.status === 200 && !r.headers['access-control-allow-origin'], 'otro origen: responde pero sin permiso CORS');
  modo.getPanel = '404-eco-una-vez';
  r = await post('getPanel');
  check(r.status === 200 && ejecuciones.getPanel === 1, 'eco 404 una vez → reintenta solo la lectura del eco (1 ejecución)');
  modo.guardarSeries = '503-una-vez';
  r = await post('guardarSeries');
  check(r.status === 200 && ejecuciones.guardarSeries === 1, 'escritura con 503 → se repite (no se había ejecutado) → 1 ejecución');
  modo.guardarDiario = 'cortar-despues';
  r = await post('guardarDiario');
  check(r.status === 502 && ejecuciones.guardarDiario === 1 && JSON.parse(r.body).codigo === 'proxy', 'escritura cortada después de ejecutar → NO se repite (502, 1 ejecución)');
  modo.getHistorial = 'cortar-antes';
  r = await post('getHistorial');
  check(r.status === 200 && ejecuciones.getHistorial === 1, 'lectura cortada → se repite y responde');
  modo.getSemana = 'lento-una-vez';
  let t0 = Date.now(); r = await post('getSemana'); const dur = Date.now() - t0;
  check(r.status === 200 && ejecuciones.getSemana === 2 && dur < 7000, 'lectura pegada 8 s → sale otra a los 4,5 s y gana (' + dur + ' ms, 2 ejecuciones)');
  modo.guardarCardio = 'lento-una-vez';
  t0 = Date.now(); r = await post('guardarCardio');
  check(r.status === 200 && ejecuciones.guardarCardio === 1 && Date.now() - t0 >= 7900, 'escritura lenta → espera, sin duplicar (1 ejecución)');
  modo.disenarPlanIA = '503-una-vez';
  r = await post('disenarPlanIA');
  check(r.status === 502 && !ejecuciones.disenarPlanIA, 'IA con 503 → no se repite (cada intento cuesta)');
  modo.coachPreguntar = 'lento';
  r = await post('coachPreguntar');
  check(r.status === 200 && ejecuciones.coachPreguntar === 1, 'llamada lenta (1,5 s) → espera y responde');
  r = await pedir('POST', '/api', 'esto no es json', ORIGEN);
  check(r.status === 400, 'cuerpo inválido → 400');
  r = await pedir('POST', '/api', JSON.stringify({ fn: 'x; rm -rf', args: [] }), ORIGEN);
  check(r.status === 400, 'nombre de función inválido → 400');
  r = await pedir('POST', '/api', 'x'.repeat(31 * 1024 * 1024), ORIGEN);
  check(r.status === 413 || r.status === 0, 'petición gigante → rechazada (' + r.status + ')');
  r = await pedir('GET', '/api?api=ping');
  check(r.status === 200 && JSON.parse(r.body).ok, 'GET ping atraviesa hasta Apps Script');
  r = await pedir('OPTIONS', '/api', null, ORIGEN);
  check(r.status === 204 && r.headers['access-control-allow-methods'], 'OPTIONS (preflight) → 204');
  r = await pedir('GET', '/otra');
  check(r.status === 404, 'rutas desconocidas → 404 (no es proxy abierto)');
  let limite = 0; for (let i = 0; i < 70; i++) { const x = await pedir('GET', '/api?api=ping'); if (x.status === 429) limite++; }
  check(limite > 0, 'límite por minuto → 429 (' + limite + ' rechazadas de 70)');
  check(!/TOKEN-SECRETO/.test(logs) && /getInicio 200/.test(logs), 'los registros no muestran el token (solo función, estado y tiempo)');
  console.log('--- registro del proxy ---\n' + logs.trim().split('\n').slice(0, 12).join('\n'));
  proxy.kill(); gas.close();
  console.log(ok ? 'TODO OK' : 'HAY FALLOS'); process.exit(ok ? 0 : 1);
})();
