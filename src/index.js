// Reglas — Worker único: sirve la app y la API.
//
// Los archivos de ./public se sirven antes de llegar aquí. Este código solo
// entra cuando la ruta no corresponde a ningún archivo, que es el caso de /api/*.
//
// La identidad la pone Cloudflare Access. Sin identidad, la API no hace nada.

const LIMITE = 512 * 1024;
const COPIAS_MAX = 30;
const HORAS_ENTRE_COPIAS = 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/estado' || url.pathname === '/api/copias') {
      return api(request, env, url);
    }

    // Cualquier otra cosa: los archivos estáticos.
    return env.ASSETS.fetch(request);
  },
};

/* ---------------------------------------------------------------- API --- */

async function api(request, env, url) {
  const email = quienEs(request, env);
  if (!email) return json({ error: 'sin_identidad' }, 403);
  if (!env.DB) return json({ error: 'falta_binding_DB' }, 500);

  if (url.pathname === '/api/estado') {
    if (request.method === 'GET') return leerEstado(env, email);
    if (request.method === 'PUT') return grabarEstado(request, env, email);
  }
  if (url.pathname === '/api/copias' && request.method === 'GET') {
    return leerCopias(url, env, email);
  }
  return json({ error: 'metodo_no_permitido' }, 405);
}

/* --------------------------------------------------------- identidad --- */

function quienEs(request, env) {
  // Camino normal: Access inyecta el correo del usuario autenticado.
  const cabecera = request.headers.get('cf-access-authenticated-user-email');
  if (cabecera) return cabecera.toLowerCase();

  // Respaldo: algunos montajes solo traen el token. La petición ya ha pasado
  // por Access para llegar hasta aquí, así que basta con leer el correo.
  const jwt =
    request.headers.get('cf-access-jwt-assertion') || galleta(request, 'CF_Authorization');
  if (jwt) return correoDeJwt(jwt) || 'usuario';

  // Solo desarrollo local.
  if (env.MODO_DEV === '1') return 'local@dev';

  return null;
}

function galleta(request, nombre) {
  const c = request.headers.get('cookie');
  if (!c) return null;
  const m = c.match(new RegExp('(?:^|;\\s*)' + nombre + '=([^;]+)'));
  return m ? m[1] : null;
}

function correoDeJwt(jwt) {
  try {
    const p = jwt.split('.')[1];
    const s = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
    const d = JSON.parse(decodeURIComponent(escape(s)));
    return (d.email || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ estado --- */

async function leerEstado(env, email) {
  const f = await env.DB.prepare('SELECT json, rev, actualizado FROM estado WHERE email = ?')
    .bind(email)
    .first();

  if (!f) return json({ email, rev: 0, estado: null, actualizado: null });

  let estado = null;
  try { estado = JSON.parse(f.json); } catch {}
  return json({ email, rev: f.rev, estado, actualizado: f.actualizado });
}

async function grabarEstado(request, env, email) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch { return json({ error: 'json_invalido' }, 400); }

  if (!cuerpo || typeof cuerpo.estado !== 'object' || cuerpo.estado === null) {
    return json({ error: 'falta_estado' }, 400);
  }

  const texto = JSON.stringify(cuerpo.estado);
  if (texto.length > LIMITE) return json({ error: 'demasiado_grande' }, 413);

  const actual = await env.DB
    .prepare('SELECT json, rev, actualizado FROM estado WHERE email = ?')
    .bind(email)
    .first();

  const revActual = actual ? actual.rev : 0;

  // Otro dispositivo escribió por medio: se devuelve lo bueno en vez de pisarlo.
  if (actual && Number(cuerpo.rev ?? 0) !== revActual && !cuerpo.forzar) {
    let estado = null;
    try { estado = JSON.parse(actual.json); } catch {}
    return json({ error: 'conflicto', rev: revActual, estado, actualizado: actual.actualizado }, 409);
  }

  const rev = revActual + 1;
  const t = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO estado (email, json, rev, actualizado) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET json = excluded.json,
                                      rev = excluded.rev,
                                      actualizado = excluded.actualizado`
  ).bind(email, texto, rev, t).run();

  // Copia de seguridad, como mucho una al día. Si falla, no tumba el guardado.
  try {
    const ult = await env.DB
      .prepare('SELECT creada FROM copias WHERE email = ? ORDER BY id DESC LIMIT 1')
      .bind(email)
      .first();

    if (!ult || (Date.now() - Date.parse(ult.creada)) / 3600000 >= HORAS_ENTRE_COPIAS) {
      await env.DB.prepare('INSERT INTO copias (email, json, creada) VALUES (?, ?, ?)')
        .bind(email, texto, t).run();
      await env.DB.prepare(
        `DELETE FROM copias WHERE email = ? AND id NOT IN
           (SELECT id FROM copias WHERE email = ? ORDER BY id DESC LIMIT ?)`
      ).bind(email, email, COPIAS_MAX).run();
    }
  } catch {}

  return json({ ok: true, rev, actualizado: t });
}

/* ------------------------------------------------------------ copias --- */

async function leerCopias(url, env, email) {
  const id = url.searchParams.get('id');

  if (id) {
    const f = await env.DB
      .prepare('SELECT json, creada FROM copias WHERE id = ? AND email = ?')
      .bind(Number(id), email)
      .first();
    if (!f) return json({ error: 'no_existe' }, 404);
    let estado = null;
    try { estado = JSON.parse(f.json); } catch {}
    return json({ id: Number(id), creada: f.creada, estado });
  }

  const { results } = await env.DB.prepare(
    'SELECT id, creada, LENGTH(json) AS bytes FROM copias WHERE email = ? ORDER BY id DESC'
  ).bind(email).all();

  return json({ copias: results || [] });
}

/* ------------------------------------------------------------ comunes --- */

function json(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
