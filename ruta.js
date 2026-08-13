// functions/api/[[ruta]].js
// Un solo archivo para toda la API: /api/estado y /api/copias
//
// La identidad la pone Cloudflare Access, que inyecta la cabecera
// Cf-Access-Authenticated-User-Email. Sin esa cabecera no se hace nada.

const LIMITE = 512 * 1024;   // tope de tamaño del estado
const COPIAS_MAX = 30;
const HORAS_ENTRE_COPIAS = 24;

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const quienEs = (request, env) => {
  const email = request.headers.get('cf-access-authenticated-user-email');
  if (email) return email.toLowerCase();
  if (env.MODO_DEV === '1') return 'local@dev';   // solo desarrollo local
  return null;
};

export async function onRequest(context) {
  const { request, env, params } = context;
  const ruta = (params.ruta || []).join('/');
  const email = quienEs(request, env);

  if (!email) return json({ error: 'sin_identidad' }, 403);
  if (!env.DB) return json({ error: 'falta_binding_DB' }, 500);

  if (ruta === 'estado' && request.method === 'GET')  return leerEstado(env, email);
  if (ruta === 'estado' && request.method === 'PUT')  return grabarEstado(request, env, email);
  if (ruta === 'copias' && request.method === 'GET')  return leerCopias(request, env, email);

  return json({ error: 'no_existe' }, 404);
}

async function leerEstado(env, email) {
  const f = await env.DB
    .prepare('SELECT json, rev, actualizado FROM estado WHERE email = ?')
    .bind(email).first();

  if (!f) return json({ email, rev: 0, estado: null, actualizado: null });

  let estado = null;
  try { estado = JSON.parse(f.json); } catch {}
  return json({ email, rev: f.rev, estado, actualizado: f.actualizado });
}

async function grabarEstado(request, env, email) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch { return json({ error: 'json_invalido' }, 400); }

  if (!cuerpo || typeof cuerpo.estado !== 'object' || cuerpo.estado === null)
    return json({ error: 'falta_estado' }, 400);

  const texto = JSON.stringify(cuerpo.estado);
  if (texto.length > LIMITE) return json({ error: 'demasiado_grande' }, 413);

  const actual = await env.DB
    .prepare('SELECT json, rev, actualizado FROM estado WHERE email = ?')
    .bind(email).first();

  const revActual = actual ? actual.rev : 0;

  // Otro dispositivo ha escrito por medio: se devuelve lo bueno en vez de pisarlo.
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

  // Copia de seguridad, como mucho una al día. Si falla, no pasa nada.
  try {
    const ult = await env.DB
      .prepare('SELECT creada FROM copias WHERE email = ? ORDER BY id DESC LIMIT 1')
      .bind(email).first();

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

async function leerCopias(request, env, email) {
  const id = new URL(request.url).searchParams.get('id');

  if (id) {
    const f = await env.DB
      .prepare('SELECT json, creada FROM copias WHERE id = ? AND email = ?')
      .bind(Number(id), email).first();
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
