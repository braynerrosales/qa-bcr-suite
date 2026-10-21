// QA BCR Suite — crea un usuario desde Administración → Usuarios, le pone
// una contraseña temporal nueva (action: 'reset_password') a quien olvidó la suya
// o elimina un usuario (action: 'delete_user').
// Solo un ADMIN activo puede llamarla. La clave secreta la pone Supabase
// en el entorno de la función: nunca llega al navegador.
// Publicar con "Verify JWT" desactivado: la función valida la sesión ella misma
// (las sesiones de los proyectos nuevos no usan el secreto JWT legacy).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const ALLOWED_ORIGINS = ['https://braynerrosales.github.io'];
const ROLES = ['ADMIN', 'QA_LEAD', 'QA', 'BETA'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Un ADMIN no le cambia la contraseña ni elimina a otro ADMIN: así nadie entra con la cuenta de otro.
// Para hacerlo, primero se le quita el rol (queda a la vista en la lista).
const ADMIN_TARGET = 'Es ADMIN: primero cambiale el rol en la lista.';

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
  const { data: me, error: meError } = await admin.from('profiles').select('role, active, must_change_password').eq('id', auth.user.id).maybeSingle();
  if (meError) return reply(500, { error: 'No se pudo comprobar tu perfil.' });
  if (!me || !me.active || me.role !== 'ADMIN') return reply(403, { error: 'Solo un ADMIN puede crear usuarios.' });
  // Igual que en la base: con la contraseña temporal no hay permisos.
  if (me.must_change_password) return reply(403, { error: 'Cambiá tu contraseña temporal antes de administrar usuarios.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Datos inválidos.' }); }

  // Eliminar un usuario: se borra de Auth y, en cascada, su perfil y su historial del QA Generator.
  // Quien tiene horas no se elimina (la base también lo impide): cambiarían los informes ya enviados.
  if (body.action === 'delete_user') {
    const id = String(body.id ?? '');
    if (!UUID_RE.test(id)) return reply(400, { error: 'Usuario inválido.' });
    if (id === auth.user.id) return reply(400, { error: 'No podés eliminar tu propio usuario.' });
    const { data: target, error: targetError } = await admin.from('profiles').select('id, role').eq('id', id).maybeSingle();
    if (targetError) return reply(500, { error: 'No se pudo buscar el usuario.' });
    if (!target) return reply(404, { error: 'El usuario no existe.' });
    if (target.role === 'ADMIN') return reply(403, { error: ADMIN_TARGET });
    const [horas, ajustes] = await Promise.all([
      admin.from('horas').select('id', { count: 'exact', head: true }).eq('user_id', id),
      admin.from('horas_ajustes').select('id', { count: 'exact', head: true }).eq('user_id', id),
    ]);
    if (horas.error || ajustes.error) return reply(500, { error: 'No se pudo revisar si el usuario tiene horas.' });
    if ((horas.count ?? 0) + (ajustes.count ?? 0) > 0) {
      return reply(409, { error: 'Tiene horas registradas: no se elimina para no cambiar los informes. Para que no entre más, desmarcá "Activo".' });
    }
    const { error: delError } = await admin.auth.admin.deleteUser(id);
    if (delError) return reply(400, { error: 'No se pudo eliminar el usuario: ' + delError.message });
    return reply(200, { id });
  }

  const password = String(body.password ?? '');
  if (password.length < 10 || password.length > 72) return reply(400, { error: 'La contraseña temporal debe tener entre 10 y 72 caracteres.' });

  // Contraseña temporal nueva para un usuario que ya existe.
  if (body.action === 'reset_password') {
    const id = String(body.id ?? '');
    if (!UUID_RE.test(id)) return reply(400, { error: 'Usuario inválido.' });
    if (id === auth.user.id) return reply(400, { error: 'Para tu propia contraseña usá "Clave".' });
    const { data: target, error: targetError } = await admin.from('profiles').select('id, role').eq('id', id).maybeSingle();
    if (targetError) return reply(500, { error: 'No se pudo buscar el usuario.' });
    if (!target) return reply(404, { error: 'El usuario no existe.' });
    if (target.role === 'ADMIN') return reply(403, { error: ADMIN_TARGET });
    const { error: pwError } = await admin.auth.admin.updateUserById(id, { password });
    if (pwError) return reply(400, { error: 'No se pudo cambiar la contraseña: ' + pwError.message });
    // Quien estaba dentro con la contraseña vieja no puede renovar su sesión.
    const { error: sessionsError } = await admin.rpc('admin_cerrar_sesiones', { p_user: id });
    if (sessionsError) return reply(500, { error: 'La contraseña se cambió, pero no se pudieron cerrar sus sesiones abiertas.' });
    // Después del cambio: el trigger on_auth_user_access apaga el aviso al cambiar
    // la contraseña de alguien que ya entró, y acá se vuelve a pedir el cambio.
    const { error: flagError } = await admin.from('profiles')
      .update({ must_change_password: true, password_changed_at: null }).eq('id', id);
    if (flagError) return reply(500, { error: 'La contraseña se cambió, pero no se pudo pedir que la cambie al entrar.' });
    return reply(200, { id });
  }

  // 2. Datos del usuario nuevo.
  const email = String(body.email ?? '').trim().toLowerCase();
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? 'QA');
  if (!EMAIL_RE.test(email) || email.length > 254) return reply(400, { error: 'El correo no es válido.' });
  if (!fullName || fullName.length > 120) return reply(400, { error: 'Falta el nombre completo (máximo 120 caracteres).' });
  if (!ROLES.includes(role)) return reply(400, { error: 'Rol inválido.' });

  // 3. Crear en Auth (confirmado: no depende del correo). El trigger crea el perfil como QA inactivo.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) {
    const exists = createError?.code === 'email_exists' || /already/i.test(createError?.message ?? '');
    return reply(exists ? 409 : 400, { error: exists ? 'Ya existe un usuario con ese correo.' : 'No se pudo crear el usuario: ' + createError?.message });
  }
  const id = created.user.id;
  // Solo lo que crea un ADMIN acá queda activo (alguien registrado por su cuenta no).
  const { error: roleError } = await admin.from('profiles').update({ role, active: true }).eq('id', id);
  if (roleError) return reply(500, { error: 'Usuario creado, pero no se pudo activar ni asignar el rol. Marcá "Activo" y elegí el rol en la lista.', id });
  return reply(200, { id, email, full_name: fullName, role });
});
