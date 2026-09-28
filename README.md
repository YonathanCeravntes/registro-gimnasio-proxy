# registro-gimnasio-proxy

Servidor intermedio de la app **Mi plan** (Registro_Gimnasio) para Render.

El celular le habla a este servicio con una sola petición HTTPS que responde directo (con CORS), y el servicio
le habla a Apps Script de servidor a servidor, con reintentos. Así el iPhone no pasa por la redirección de
Apps Script (`script.google.com` → `script.googleusercontent.com`), que en redes lentas produce "Load failed" y HTTP 404.

- Solo reenvía a la URL de Apps Script configurada (no es un proxy abierto) y no guarda datos.
- Los registros muestran solo la función, el estado y el tiempo; nunca tokens ni contenidos.
- Lecturas (`get…`): si Apps Script tarda más de 4,5 s, sale otra igual en paralelo y gana la primera (Apps Script a veces
  se queda pegado 20–30 s). Escrituras: se repiten solo si Google no llegó a ejecutarlas. La IA nunca se repite sola.
- Si el proxy no responde, la app sigue funcionando directo contra Apps Script.

## Render

- Tipo: Web Service · Node · `npm install` / `node server.js` · health check `/salud`
- Variables (opcionales): `APPS_SCRIPT_URL`, `ALLOWED_ORIGINS`, `RATE_LIMIT`, `COBERTURA_MS`

## Rutas

- `GET /salud` → estado del proxy
- `GET /api?api=ping` → prueba la cadena completa hasta Apps Script
- `POST /api` → `{ fn, args, t }` (lo mismo que acepta Apps Script)

Pruebas locales: `npm test`
