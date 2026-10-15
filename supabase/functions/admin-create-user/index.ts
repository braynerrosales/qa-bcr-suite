// QA BCR Suite — crea un usuario desde Administración → Usuarios.
// Solo un ADMIN activo puede llamarla. La clave secreta la pone Supabase
// en el entorno de la función: nunca llega al navegador.
// Publicar con "Verify JWT" desactivado: la función valida la sesión ella misma
// (las sesiones de los proyectos nuevos no usan el secreto JWT legacy).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const ALLOWED_ORIGINS = ['https://braynerrosales.github.io'];
const ROLES = ['ADMIN', 'QA_LEAD', 'QA'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

// Proyectos nuevos: SUPABASE_SECRET_KEYS (JSON por nombre). Antiguos: SUPABASE_SERVICE_ROLE_KEY.
function secretKey(): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch { /* se usa la clave legacy */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, { error: 'Método no permitido.' });

  const url = Deno.env.get('SUPABASE_URL');
  const secret = secretKey();
  if (!url || !secret) return reply(500, { error: 'La función no tiene la configuración de Supabase.' });
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1. Quién llama: sesión válida de un ADMIN activo.
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return reply(401, { error: 'Falta la sesión.' });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return reply(401, { error: 'La sesión no es válida. Iniciá sesión de nuevo.' });
  const { data: me, error: meError } = await admin.from('profiles').select('role, active').eq('id', auth.user.id).maybeSingle();
  if (meError) return reply(500, { error: 'No se pudo comprobar tu perfil.' });
  if (!me || !me.active || me.role !== 'ADMIN') return reply(403, { error: 'Solo un ADMIN puede crear usuarios.' });

  // 2. Datos del usuario nuevo.
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Datos inválidos.' }); }
  const email = String(body.email ?? '').trim().toLowerCase();
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? 'QA');
  const password = String(body.password ?? '');
  if (!EMAIL_RE.test(email) || email.length > 254) return reply(400, { error: 'El correo no es válido.' });
  if (!fullName || fullName.length > 120) return reply(400, { error: 'Falta el nombre completo (máximo 120 caracteres).' });
  if (!ROLES.includes(role)) return reply(400, { error: 'Rol inválido.' });
  if (password.length < 10 || password.length > 72) return reply(400, { error: 'La contraseña temporal debe tener entre 10 y 72 caracteres.' });

  // 3. Crear en Auth (confirmado: no depende del correo). El trigger crea el perfil como QA.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) {
    const exists = createError?.code === 'email_exists' || /already/i.test(createError?.message ?? '');
    return reply(exists ? 409 : 400, { error: exists ? 'Ya existe un usuario con ese correo.' : 'No se pudo crear el usuario: ' + createError?.message });
  }
  const id = created.user.id;
  if (role !== 'QA') {
    const { error: roleError } = await admin.from('profiles').update({ role }).eq('id', id);
    if (roleError) return reply(500, { error: 'Usuario creado como QA, pero no se pudo asignar el rol. Cambialo en la lista.', id });
  }
  return reply(200, { id, email, full_name: fullName, role });
});
