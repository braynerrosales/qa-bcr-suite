// Prueba las Fases 2 y 3 con el cliente real de supabase-js y un Supabase simulado en la red.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Requiere: npm i playwright-core y supabase-js descomprimido en ./package (npm pack @supabase/supabase-js@2.117.2).
const DIR = new URL('..', import.meta.url).pathname;
const SUPA = 'https://demo.supabase.co';
const html = readFileSync(DIR + 'index.html', 'utf8');
const configured = html
  .replace(/const SUPABASE_URL='[^']*';/, `const SUPABASE_URL='${SUPA}';`)
  .replace(/const SUPABASE_ANON_KEY='[^']*';/, "const SUPABASE_ANON_KEY='anon-test-key';")
  .replaceAll(/https:\/\/[a-z0-9]+\.supabase\.co(?=[ ;])/g, SUPA)
  .replaceAll(/wss:\/\/[a-z0-9]+\.supabase\.co(?=[ ;])/g, SUPA.replace('https', 'wss'));
// Copia sin configurar: sin URL ni clave.
const unconfigured = html
  .replace(/const SUPABASE_URL='[^']*';/, "const SUPABASE_URL='';")
  .replace(/const SUPABASE_ANON_KEY='[^']*';/, "const SUPABASE_ANON_KEY='';");
const supabaseJs = readFileSync(DIR + 'package/dist/umd/supabase.js', 'utf8');

const users = {
  'admin@bcr.test': { id: 'a0000000-0000-4000-8000-000000000001', password: 'pw', full_name: 'Brayner Rosales', role: 'ADMIN', active: true },
  'lead@bcr.test': { id: 'a0000000-0000-4000-8000-000000000002', password: 'pw', full_name: 'Laura Lead', role: 'QA_LEAD', active: true },
  'qa@bcr.test': { id: 'a0000000-0000-4000-8000-000000000003', password: 'pw', full_name: 'Quique QA <b>', role: 'QA', active: true },
  'off@bcr.test': { id: 'a0000000-0000-4000-8000-000000000004', password: 'pw', full_name: 'Inactivo', role: 'QA', active: false },
};
const byId = (id) => Object.entries(users).find(([, u]) => u.id === id);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (u) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const subOf = (req) => {
  const t = (req.headers()['authorization'] || '').replace('Bearer ', '').split('.')[1];
  try { return JSON.parse(Buffer.from(t, 'base64url').toString()).sub; } catch { return null; }
};
let rejectNextPatch = false;
const patches = [];

// ── Datos simulados (Fase 3): tablas en memoria con la forma de Supabase ──
let functionMissing = false; // la Edge Function no está publicada
let functionUnreachable = false; // respuesta sin CORS: el navegador no la recibe
const created = [];           // cuerpos enviados a admin-create-user
let failConfig = false;      // get_app_config responde 500
let failNextWrite = null;    // código de error para la próxima escritura
let tables;
const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
const solicitudesIniciales = () => [
  { id: 1, nombre: 'Solicitud P3_081 Gobierno <b>Digital</b>', informe_semanal: true, encargados: ['Beto Uno'], horas: null, pend_plan: false, pend_actualizar: false, plan_enviado: true, cierre_enviado: false, cierra: isoDay(5), observaciones: '', cerrada: false },
  { id: 2, nombre: 'Solicitud P3_070 Tucan vencida', informe_semanal: false, encargados: [], horas: 4, pend_plan: false, pend_actualizar: false, plan_enviado: false, cierre_enviado: false, cierra: isoDay(-3), observaciones: 'Entró tarde', cerrada: false },
  { id: 3, nombre: 'QA_OPC_47 Proyecto Digitalizacion', informe_semanal: false, encargados: [], horas: null, pend_plan: true, pend_actualizar: false, plan_enviado: false, cierre_enviado: false, cierra: null, observaciones: '', cerrada: false },
  { id: 4, nombre: 'Solicitud P2_191 TPSISTAR cerrada', informe_semanal: false, encargados: [], horas: null, pend_plan: false, pend_actualizar: false, plan_enviado: false, cierre_enviado: true, cierra: '2026-01-23', observaciones: '', cerrada: true },
];
function resetData(empty = false) {
  tables = empty ? { daily_groups: [], daily_members: [], daily_rules: [], daily_rule_members: [], projects: [], project_variants: [], templates: [], solicitudes: [], horas: [], horas_ajustes: [], feedback: [], daily_runs: [] } : {
    solicitudes: solicitudesIniciales(),
    horas: [],
    horas_ajustes: [],
    feedback: [],
    daily_runs: [],
    daily_groups: [{ id: 1, code: 'daily1', active: true }, { id: 2, code: 'daily2', active: true }],
    daily_members: [
      { id: 1, daily_group_id: 1, name: 'Ana <img src=x onerror=alert(1)>', active: true },
      { id: 2, daily_group_id: 1, name: 'Beto Uno', active: true },
      { id: 3, daily_group_id: 2, name: 'Caro Dos', active: true },
      { id: 4, daily_group_id: 1, name: 'Dani Viejo', active: false },
    ],
    daily_rules: [{ id: 1, daily_group_id: 1, first_range: 1 }, { id: 2, daily_group_id: 2, first_range: 1 }],
    daily_rule_members: [{ id: 1, daily_member_id: 2, rule_type: 'LAST_FIXED' }],
    projects: [
      { id: 1, code: 'DATA', color: '#4f8ef7', active: true },
      { id: 2, code: 'COMERCIAL', color: '#60a5fa', active: true },
    ],
    project_variants: [{ id: 1, project_id: 2, name: 'normal', active: true }, { id: 2, project_id: 2, name: "x'><b>", active: true }],
    templates: [
      { id: 1, project_id: 1, variant_id: null, active: true, tasks: ['QA - {n} - Smoke.'] },
      { id: 2, project_id: 2, variant_id: 1, active: true, tasks: ['QA - {n} - Normal.'] },
    ],
  };
}
resetData();
const nextId = (rows) => Math.max(0, ...rows.map((r) => r.id)) + 1;
// Igual que public.get_app_config() (supabase/migrations/20261015000003_rpc.sql).
function appConfig() {
  const t = tables, people = {}, rules = {}, projects = {};
  for (const g of t.daily_groups.filter((g) => g.active)) {
    const ms = t.daily_members.filter((m) => m.daily_group_id === g.id && m.active).sort((a, b) => a.id - b.id);
    people[g.code] = ms.map((m) => m.name);
    const byRule = (type) => t.daily_rule_members.filter((rm) => rm.rule_type === type).sort((a, b) => a.id - b.id)
      .map((rm) => ms.find((m) => m.id === rm.daily_member_id)).filter(Boolean).map((m) => m.name);
    rules[g.code] = { firstGroup: byRule('FIRST_GROUP'), range: t.daily_rules.find((r) => r.daily_group_id === g.id)?.first_range ?? 1, lastFixed: byRule('LAST_FIXED') };
  }
  for (const p of t.projects.filter((p) => p.active)) {
    const vs = t.project_variants.filter((v) => v.project_id === p.id && v.active).sort((a, b) => a.id - b.id);
    const templates = {};
    for (const tp of t.templates.filter((x) => x.project_id === p.id && x.active)) {
      const v = t.project_variants.find((v) => v.id === tp.variant_id);
      templates[v ? v.name : ''] = tp.tasks;
    }
    projects[p.code] = { color: p.color, variants: vs.map((v) => v.name), templates };
  }
  return { people, rules, projects };
}
const isLead = (me) => !!me && me.active && (me.role === 'ADMIN' || me.role === 'QA_LEAD');
const writes = [];
// Tablas de configuración: GET, POST (insert / upsert), PATCH y DELETE con filtros eq.
function tableRequest(req, url, me, json) {
  const name = url.pathname.replace('/rest/v1/', '');
  const rows = tables[name];
  const filters = [...url.searchParams].filter(([k]) => !['select', 'on_conflict', 'columns', 'order'].includes(k))
    .map(([k, v]) => [k, v.replace(/^eq\./, '')]);
  const match = (r) => filters.every(([k, v]) => String(r[k]) === v);
  const cols = url.searchParams.get('select') || '*';
  const pick = (r) => cols === '*' ? { ...r } : Object.fromEntries(cols.split(',').map((c) => [c, r[c]]));
  const method = req.method();
  // RLS de solicitudes: solo ADMIN y QA_LEAD activos la ven.
  if (method === 'GET') return json(200, name === 'solicitudes' && !isLead(me) ? [] : rows.filter(match).map(pick));
  const body = req.postDataJSON();
  writes.push({ method, name, filters: Object.fromEntries(filters), body });
  if (failNextWrite) { const code = failNextWrite; failNextWrite = null; return json(409, { code, message: 'duplicate key value violates unique constraint' }); }
  const lead = isLead(me);
  if (method === 'POST') {
    if (!lead) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
    const conflict = url.searchParams.get('on_conflict');
    for (const item of [].concat(body)) {
      const existing = conflict && rows.find((r) => r[conflict] === item[conflict]);
      if (existing) Object.assign(existing, item);
      else {
        const dup = name === 'daily_members' && rows.find((r) => r.daily_group_id === item.daily_group_id && r.name === item.name);
        if (dup) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        rows.push({ id: nextId(rows), active: true, ...item, ...(name === 'solicitudes' ? { updated_by: me.id, updated_at: new Date().toISOString() } : {}) });
      }
    }
    return r201(json);
  }
  const target = lead ? rows.filter(match) : [];   // el RLS filtra: 0 filas, sin error
  // Igual que el trigger solicitudes_touch: registra quién y cuándo.
  const stamp = name === 'solicitudes' ? { updated_by: me.id, updated_at: new Date().toISOString() } : {};
  if (method === 'PATCH') target.forEach((r) => Object.assign(r, body, stamp));
  if (method === 'DELETE') {
    tables[name] = rows.filter((r) => !target.includes(r));
    // ON DELETE CASCADE del esquema
    if (name === 'daily_members') tables.daily_rule_members = tables.daily_rule_members.filter((rm) => !target.some((m) => m.id === rm.daily_member_id));
    if (name === 'projects') { tables.project_variants = tables.project_variants.filter((v) => !target.some((p) => p.id === v.project_id)); tables.templates = tables.templates.filter((tp) => !target.some((p) => p.id === tp.project_id)); }
    if (name === 'project_variants') tables.templates = tables.templates.filter((tp) => !target.some((v) => v.id === tp.variant_id));
  }
  return json(200, target.map((r) => ({ id: r.id })));
}
const r201 = (json) => json(201, null);

// Igual que public.horas (supabase/migrations/20261018000001_horas.sql): RLS, checks y trigger.
const ownOrLead = (me, r) => !!me && me.active && (r.user_id === me.id || isLead(me));
function horasRequest(req, url, me, json) {
  const ops = { eq: (a, b) => String(a) === b, gte: (a, b) => String(a) >= b, lte: (a, b) => String(a) <= b };
  const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'columns'].includes(k))
    .map(([k, v]) => { const [op, ...rest] = v.split('.'); return [k, op, rest.join('.')]; });
  const visible = tables.horas.filter((r) => ownOrLead(me, r) && filters.every(([k, op, v]) => ops[op](r[k], v)));
  const method = req.method();
  if (method === 'GET') return json(200, visible.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id).map((r) => ({ ...r })));
  const body = req.postDataJSON();
  writes.push({ method, name: 'horas', body });
  if (failNextWrite) { const code = failNextWrite; failNextWrite = null; return json(403, { code, message: 'denied' }); }
  const checkRow = (r) => {
    const dow = new Date(r.fecha + 'T00:00:00').getDay();
    if (dow === 0 || dow === 6) return 'horas_fecha_check';
    if (!(r.horas > 0 && r.horas <= 24) || r.facturable < 0 || r.facturable > r.horas) return 'horas_check';
    return null;
  };
  const stamp = (r) => Object.assign(r, { updated_by: me.id, updated_at: new Date().toISOString() }, r.tipo !== 'TRABAJO' ? { facturable: 0 } : {});
  if (method === 'POST') {
    const r = stamp({ id: Math.max(0, ...tables.horas.map((x) => x.id)) + 1, user_id: me?.id, tipo: 'TRABAJO', soli: '', tarea: '', facturable: 0, ...body });
    if (!ownOrLead(me, r)) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "horas"' });
    if (checkRow(r)) return json(400, { code: '23514', message: 'violates check constraint ' + checkRow(r) });
    tables.horas.push(r);
    return json(201, [{ ...r }]);
  }
  if (method === 'PATCH') {
    if ('user_id' in body) return json(403, { code: '42501', message: 'permission denied for table horas' });
    for (const r of visible) { const n = stamp({ ...r, ...body }); if (checkRow(n)) return json(400, { code: '23514', message: 'check' }); }
    visible.forEach((r) => stamp(Object.assign(r, body)));
    return json(200, visible.map((r) => ({ ...r })));
  }
  if (method === 'DELETE') { tables.horas = tables.horas.filter((r) => !visible.includes(r)); return json(200, visible.map((r) => ({ id: r.id }))); }
}
// Igual que daily_guardar() / daily_historial() (20261019000002_daily_historial.sql).
function dailyGuardar(me, b) {
  const today = new Date(); const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const min = new Date(today); min.setDate(min.getDate() - 7); const max = new Date(today); max.setDate(max.getDate() + 1);
  if (b.p_fecha < iso(min) || b.p_fecha > iso(max)) return [400, { code: '22023', message: 'Fecha inválida' }];
  if (!tables.daily_groups.some((g) => g.id === b.p_grupo && g.active)) return [400, { code: '22023', message: 'Daily inválido' }];
  if (!Array.isArray(b.p_miembros) || !b.p_miembros.length || b.p_miembros.some((m) => !m.name?.trim() || m.position < 1 || (m.completed && m.absent))) return [400, { code: '22023', message: 'Lista de personas inválida' }];
  const old = tables.daily_runs.find((r) => r.daily_group_id === b.p_grupo && r.run_date === b.p_fecha);
  const run = { id: old?.id ?? tables.daily_runs.length + 1, daily_group_id: b.p_grupo, run_date: b.p_fecha, created_by: me.id, members: b.p_miembros.map((m) => ({ ...m, name: m.name.trim(), completed: !!m.completed, absent: !!m.absent })) };
  tables.daily_runs = tables.daily_runs.filter((r) => r !== old).concat(run);
  return [200, [{ run_id: run.id, reemplazado: !!old }]];
}
function dailyHistorial(b) {
  const nameOf = (id) => Object.values(users).find((u) => u.id === id)?.full_name ?? '';
  return tables.daily_runs.filter((r) => r.daily_group_id === b.p_grupo && r.run_date >= b.desde && r.run_date <= b.hasta)
    .sort((x, y) => y.run_date.localeCompare(x.run_date))
    .flatMap((r) => r.members.map((m) => ({ run_id: r.id, run_date: r.run_date, guardado_por: nameOf(r.created_by), member_name: m.name, position: m.position, completed: m.completed, absent: m.absent })));
}
// Igual que public.feedback (20261019000001): cualquiera activo envía, solo ADMIN lee.
function feedbackRequest(req, url, me, r, json) {
  const admin = !!me?.active && me.role === 'ADMIN';
  const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'columns', 'limit'].includes(k))
    .map(([k, v]) => { const [op, ...rest] = v.split('.'); return [k, rest.join('.')]; });
  const visible = admin ? tables.feedback.filter((f) => filters.every(([k, v]) => String(f[k]) === v)) : [];
  const method = req.method();
  if (method === 'HEAD') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': `0-${Math.max(0, visible.length - 1)}/${visible.length}` } });
  if (method === 'GET') return json(200, [...visible].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((f) => ({ ...f })));
  const body = req.postDataJSON();
  if (method === 'POST') {
    if (!me?.active) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "feedback"' });
    if ('user_id' in body || 'autor' in body) return json(403, { code: '42501', message: 'permission denied for table feedback' });
    if (tables.feedback.filter((f) => f.user_id === me.id).length >= 20) return json(400, { code: '54000', message: 'Llegaste al máximo' });
    tables.feedback.push({ id: Math.max(0, ...tables.feedback.map((x) => x.id)) + 1, user_id: me.id, autor: me.full_name, mensaje: body.mensaje.trim(), leido: false, created_at: new Date(Date.now() + tables.feedback.length).toISOString() });
    return r.fulfill({ status: 201, headers: { 'access-control-allow-origin': '*' }, body: '' });
  }
  if (method === 'PATCH') { visible.forEach((f) => Object.assign(f, { leido: body.leido })); return json(200, visible.map((f) => ({ id: f.id }))); }
  if (method === 'DELETE') { tables.feedback = tables.feedback.filter((f) => !visible.includes(f)); return json(200, visible.map((f) => ({ id: f.id }))); }
}
// Igual que public.horas_ajustes (20261018000003_horas_ajustes.sql): solo QA_LEAD y ADMIN.
function ajustesRequest(req, url, me, json) {
  const ops = { eq: (a, b) => String(a) === b, gte: (a, b) => String(a) >= b, lte: (a, b) => String(a) <= b };
  const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'columns'].includes(k))
    .map(([k, v]) => { const [op, ...rest] = v.split('.'); return [k, op, rest.join('.')]; });
  const lead = !!me?.active && isLead(me);
  const visible = lead ? tables.horas_ajustes.filter((r) => filters.every(([k, op, v]) => ops[op](r[k], v))) : [];
  const method = req.method();
  if (method === 'GET') return json(200, visible.map((r) => ({ ...r })));
  const body = req.postDataJSON();
  writes.push({ method, name: 'horas_ajustes', body });
  if (method === 'POST') {
    if (!lead) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "horas_ajustes"' });
    if (tables.horas_ajustes.some((r) => r.user_id === body.user_id && r.fecha === body.fecha && r.columna === body.columna)) return json(409, { code: '23505', message: 'duplicate key' });
    const r = { id: Math.max(0, ...tables.horas_ajustes.map((x) => x.id)) + 1, ...body, updated_by: me.id, updated_at: new Date().toISOString() };
    tables.horas_ajustes.push(r);
    return json(201, [{ id: r.id }]);
  }
  if (method === 'PATCH') { visible.forEach((r) => Object.assign(r, body, { updated_by: me.id })); return json(200, visible.map((r) => ({ id: r.id }))); }
  if (method === 'DELETE') { tables.horas_ajustes = tables.horas_ajustes.filter((r) => !visible.includes(r)); return json(200, visible.map((r) => ({ id: r.id }))); }
}
// Igual que public.horas_resumen(): totales por persona (con ajustes), para cualquier usuario activo.
function horasResumen(me, { desde, hasta }) {
  const sum = (rows, f) => Math.round(rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
  return Object.values(users).map((u) => {
    const rs = tables.horas.filter((h) => h.user_id === u.id && h.fecha >= desde && h.fecha <= hasta);
    const t = (tipo) => sum(rs.filter((h) => h.tipo === tipo), (h) => h.horas);
    const w = rs.filter((h) => h.tipo === 'TRABAJO');
    const aj = tables.horas_ajustes.filter((x) => x.user_id === u.id && x.fecha >= desde && x.fecha <= hasta);
    const d = (c) => sum(aj.filter((x) => x.columna === c), (x) => x.delta);
    const r = { user_id: u.id, full_name: u.full_name, active: u.active, n: rs.length + aj.length, feriado: t('FERIADO') + d('feriado'), facturable: sum(w, (h) => h.facturable) + d('facturable'), no_facturable: sum(w, (h) => h.horas - h.facturable) + d('no_facturable'), licencia: t('LICENCIA') + d('licencia'), vacaciones: t('VACACIONES') + d('vacaciones') };
    return { ...r, total: Math.round((r.feriado + r.facturable + r.no_facturable + r.licencia + r.vacaciones) * 100) / 100 };
  }).filter((r) => users[Object.keys(users).find((e) => users[e].id === r.user_id)].en_informe !== false && (r.active || r.n)).sort((a, b) => a.full_name.localeCompare(b.full_name))
    .map(({ active, n, ...r }) => r);
}

// Supabase Realtime simulado (protocolo Phoenix 2.0.0: [join_ref, ref, topic, event, payload]).
const rtSockets = [];
function rtPush(type, record, old = {}) {
  for (const s of rtSockets) {
    if (!s.topic) continue;
    s.ws.send(JSON.stringify([null, null, s.topic, 'postgres_changes', { ids: [s.bindingId], data: {
      type, schema: 'public', table: 'solicitudes', commit_timestamp: new Date().toISOString(),
      record: type === 'DELETE' ? undefined : record, old_record: old, columns: [], errors: null } }]));
  }
}
async function setup(context) {
  await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    const s = { ws, topic: null, bindingId: 77 };
    rtSockets.push(s);
    ws.onMessage((m) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(m);
      if (event === 'phx_join') {
        s.topic = topic;
        const pc = (payload.config.postgres_changes || []).map((f) => ({ id: s.bindingId, ...f }));
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } }]));
      } else if (ref) ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
    });
    ws.onClose(() => rtSockets.splice(rtSockets.indexOf(s), 1));
  });
  await context.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
    (r) => r.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: supabaseJs }));
  await context.route('http://app.test/**', (r) => {
    const url = r.request().url();
    if (url.endsWith('/index.html')) return r.fulfill({ contentType: 'text/html', body: configured });
    if (url.endsWith('/sin-config.html')) return r.fulfill({ contentType: 'text/html', body: unconfigured });
    return r.fulfill({ status: 404, body: '' });
  });
  await context.route(`${SUPA}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const json = (status, body) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });

    if (url.pathname === '/auth/v1/token') {
      const { email, password } = req.postDataJSON();
      const u = users[email];
      if (!u || u.password !== password) return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      // Igual que el trigger on_auth_user_access: registra primer y último ingreso.
      u.last_sign_in_at = new Date().toISOString(); u.first_sign_in_at ??= u.last_sign_in_at;
      return json(200, { access_token: tokenFor(u), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email } });
    }
    if (url.pathname === '/auth/v1/user') {
      const e = byId(subOf(req));
      if (!e) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      if (req.method() === 'PUT') {
        const { password } = req.postDataJSON();
        if (password === e[1].password) return json(422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' });
        e[1].password = password;
        if (e[1].last_sign_in_at) { e[1].must_change_password = false; e[1].password_changed_at = new Date().toISOString(); }
      }
      return json(200, { id: e[1].id, aud: 'authenticated', role: 'authenticated', email: e[0] });
    }
    if (url.pathname === '/auth/v1/logout') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });

    if (url.pathname === '/rest/v1/profiles') {
      const me = byId(subOf(req))?.[1];
      const visible = Object.entries(users)
        .filter(([, u]) => u.id === me?.id || me?.active)
        .map(([email, u]) => ({ id: u.id, full_name: u.full_name, email, role: u.role, active: u.active, en_informe: u.en_informe !== false, must_change_password: !!u.must_change_password }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
      const rows = idEq ? visible.filter((p) => p.id === idEq) : visible;
      if (req.method() === 'GET') return json(200, rows);
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON();
        patches.push({ id: idEq, body });
        if (rejectNextPatch || me?.role !== 'ADMIN' || !me.active) { rejectNextPatch = false; return json(200, []); }
        const target = byId(idEq)[1];
        Object.assign(target, body);
        return json(200, [{ id: idEq }]);
      }
    }
    if (url.pathname === '/functions/v1/admin-create-user') {
      if (functionUnreachable) return r.abort('failed');
      // Igual que supabase/functions/admin-create-user: solo ADMIN activo.
      if (functionMissing) return json(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
      const me = byId(subOf(req))?.[1];
      if (!me) return json(401, { error: 'La sesión no es válida. Iniciá sesión de nuevo.' });
      if (me.role !== 'ADMIN' || !me.active) return json(403, { error: 'Solo un ADMIN puede crear usuarios.' });
      const b = req.postDataJSON();
      if (b.action === 'delete_user') {
        const t = byId(b.id);
        if (!t) return json(404, { error: 'El usuario no existe.' });
        if (b.id === me.id) return json(400, { error: 'No podés eliminar tu propio usuario.' });
        delete users[t[0]];
        tables.horas = tables.horas.filter((h) => h.user_id !== b.id);
        tables.feedback.forEach((f) => { if (f.user_id === b.id) f.user_id = null; });
        return json(200, { id: b.id });
      }
      if (b.action === 'reset_password') {
        const t = byId(b.id);
        if (!t) return json(404, { error: 'El usuario no existe.' });
        if (b.id === me.id) return json(400, { error: 'Para tu propia contraseña usá "Clave".' });
        Object.assign(t[1], { password: b.password, must_change_password: true, password_changed_at: null });
        return json(200, { id: b.id });
      }
      created.push(b);
      if (users[b.email]) return json(409, { error: 'Ya existe un usuario con ese correo.' });
      const id = 'a0000000-0000-4000-8000-0000000000' + String(10 + created.length);
      users[b.email] = { id, password: b.password, full_name: b.full_name, role: b.role, active: true, must_change_password: true };
      return json(200, { id, email: b.email, full_name: b.full_name, role: b.role });
    }
    if (url.pathname === '/rest/v1/rpc/admin_user_access') {
      const me = byId(subOf(req))?.[1];
      if (me?.role !== 'ADMIN' || !me.active) return json(403, { code: '42501', message: 'Solo un ADMIN puede ver los ingresos' });
      return json(200, Object.values(users).map((u) => ({ id: u.id, first_sign_in_at: u.first_sign_in_at ?? null, last_sign_in_at: u.last_sign_in_at ?? null, password_changed_at: u.password_changed_at ?? null, must_change_password: !!u.must_change_password })));
    }
    if (url.pathname === '/rest/v1/horas') return horasRequest(req, url, byId(subOf(req))?.[1], json);
    if (url.pathname === '/rest/v1/rpc/daily_guardar' || url.pathname === '/rest/v1/rpc/daily_historial') {
      const me = byId(subOf(req))?.[1];
      if (!me?.active) return json(403, { code: '42501', message: 'Usuario sin acceso' });
      if (url.pathname.endsWith('historial')) return json(200, dailyHistorial(req.postDataJSON()));
      const [st, body] = dailyGuardar(me, req.postDataJSON());
      return json(st, body);
    }
    if (url.pathname === '/rest/v1/feedback') return feedbackRequest(req, url, byId(subOf(req))?.[1], r, json);
    if (url.pathname === '/rest/v1/horas_ajustes') return ajustesRequest(req, url, byId(subOf(req))?.[1], json);
    if (url.pathname === '/rest/v1/rpc/horas_resumen') {
      const me = byId(subOf(req))?.[1];
      if (!me?.active) return json(403, { code: '42501', message: 'Usuario sin acceso' });
      return json(200, horasResumen(me, req.postDataJSON()));
    }
    if (url.pathname === '/rest/v1/rpc/get_app_config') {
      if (failConfig) return json(500, { code: 'XX000', message: 'falla simulada' });
      return json(200, appConfig());
    }
    if (url.pathname === '/rest/v1/rpc/save_template') {
      const me = byId(subOf(req))?.[1], b = req.postDataJSON();
      writes.push({ method: 'RPC', name: 'save_template', body: b });
      if (!isLead(me)) return json(403, { code: '42501', message: 'Solo ADMIN o QA_LEAD pueden modificar plantillas' });
      let tp = tables.templates.find((x) => x.project_id === b.p_project_id && x.variant_id === b.p_variant_id);
      if (!tp) tables.templates.push(tp = { id: nextId(tables.templates), project_id: b.p_project_id, variant_id: b.p_variant_id, active: true });
      tp.active = true; tp.tasks = b.p_tasks.map((x) => x.trim()).filter(Boolean);
      return json(200, tp.id);
    }
    if (url.pathname.startsWith('/rest/v1/') && tables[url.pathname.replace('/rest/v1/', '')]) {
      return tableRequest(req, url, byId(subOf(req))?.[1], json);
    }
    return json(404, { message: 'no simulado: ' + req.method() + ' ' + url.pathname });
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const ok = (m) => console.log('OK  ' + m);
const errors = [];
const dialogs = [];   // mensajes de alert/confirm/prompt
const answers = [];   // respuestas en orden: string para prompt, false para cancelar

async function newPage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  await setup(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); const a = answers.shift(); a === false ? d.dismiss() : d.accept(typeof a === 'string' ? a : undefined); });
  page.on('console', (m) => { if (/Content Security Policy|integrity/i.test(m.text())) errors.push(m.text()); });
  return { context, page };
}
async function login(page, email, password = 'pw') {
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit');
}

// 1. Sin configurar
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/sin-config.html');
  await page.waitForSelector('#auth-blocked:not([hidden])');
  assert.match(await page.textContent('#auth-blocked-text'), /Falta configurar/);
  assert.equal(await page.isVisible('.layout'), false);
  ok('sin configurar: avisa y no muestra la app');
  await context.close();
}

// 2-6. QA: login, credenciales malas, permisos, sesión persistente, logout
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await page.waitForSelector('#auth-form:not([hidden])');
  assert.equal(await page.isVisible('.layout'), false);
  assert.equal(await page.isVisible('.data-banner'), false);
  await page.screenshot({ path: DIR + 'tests/shot-login.png' });
  ok('sin sesión: muestra login y oculta la app');

  await page.fill('#auth-password', 'mala');
  const eye = page.locator('#auth-form .pw-eye');
  assert.equal(await eye.getAttribute('aria-label'), 'Mostrar contraseña');
  await eye.click();
  assert.equal(await page.getAttribute('#auth-password', 'type'), 'text');
  assert.equal(await eye.getAttribute('aria-pressed'), 'true');
  assert.equal(await eye.getAttribute('aria-label'), 'Ocultar contraseña');
  await page.screenshot({ path: DIR + 'tests/shot-login-ojo.png' });
  await eye.click();
  assert.equal(await page.getAttribute('#auth-password', 'type'), 'password');
  await eye.click();
  await login(page, 'qa@bcr.test', 'mala');
  await page.waitForSelector('#auth-error.error');
  assert.equal(await page.getAttribute('#auth-password', 'type'), 'password', 'al ingresar la contraseña vuelve a quedar oculta');
  ok('login: el ojito muestra y oculta la contraseña');
  assert.equal(await page.textContent('#auth-error'), 'Correo o contraseña incorrectos.');
  ok('contraseña incorrecta: mensaje claro');

  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await page.textContent('#sidebar-user-name'), 'Quique QA <b>');
  assert.equal(await page.textContent('#sidebar-user-role'), 'QA');
  assert.equal(await page.isVisible('#nav-admin'), false);
  await page.evaluate(() => showPage('admin'));
  assert.equal(await page.isVisible('#page-home'), true);
  assert.equal(await page.isVisible('#page-admin'), false);
  ok('QA: entra, ve su nombre (escapado) y rol, sin acceso a Administración');

  await page.click('#nav-daily');
  await page.evaluate(() => generateOrder('daily1'));
  ok('la app existente sigue funcionando (Daily)');

  await page.reload();
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await page.textContent('#sidebar-user-role'), 'QA');
  ok('recargar: la sesión se mantiene');

  await page.click('.sidebar-user-actions button:has-text("Cerrar sesión")');
  await page.waitForSelector('#auth-form:not([hidden])');
  assert.equal(await page.isVisible('.layout'), false);
  ok('cerrar sesión: vuelve al login');
  await context.close();
}

// 7. Usuario desactivado
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'off@bcr.test');
  await page.waitForSelector('#auth-blocked:not([hidden])');
  assert.match(await page.textContent('#auth-blocked-text'), /desactivado/);
  assert.equal(await page.isVisible('.layout'), false);
  await page.click('#auth-blocked-logout');
  await page.waitForSelector('#auth-form:not([hidden])');
  ok('desactivado: no entra, ve el aviso y puede cerrar sesión');
  await context.close();
}

// 8. QA_LEAD
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await page.isVisible('#nav-admin'), true);
  await page.click('#nav-admin');
  assert.equal(await page.isVisible('#page-admin'), true);
  assert.equal(await page.isVisible('#atab-users'), false);
  ok('QA_LEAD: entra a Administración, sin pestaña Usuarios');
  await context.close();
}

// 9. ADMIN: pestaña Usuarios
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-admin');
  await page.click('#atab-users');
  await page.waitForSelector('#list-users .user-role-select');
  assert.equal(await page.locator('#list-users .crud-item').count(), 4);
  const selfRow = page.locator('#list-users .crud-item', { hasText: '(vos)' });
  assert.equal(await selfRow.locator('select').isDisabled(), true);
  ok('ADMIN: ve 4 usuarios y no puede cambiarse a sí mismo');

  const qaRow = page.locator('#list-users .crud-item', { hasText: 'qa@bcr.test' });
  await qaRow.locator('select').selectOption('QA_LEAD');
  await page.waitForSelector('#users-status.ok');
  assert.equal(users['qa@bcr.test'].role, 'QA_LEAD');
  ok('ADMIN: cambia el rol y ve "Guardado"');

  rejectNextPatch = true;
  await qaRow.locator('input[type=checkbox]').uncheck();
  await page.waitForSelector('#users-status.error');
  await page.waitForFunction(() => document.querySelector('#list-users .crud-item:nth-child(3) input[type=checkbox]')?.checked !== undefined);
  const checked = await page.locator('#list-users .crud-item', { hasText: 'qa@bcr.test' }).locator('input[type=checkbox]').isChecked();
  assert.equal(checked, true);
  assert.equal(users['qa@bcr.test'].active, true);
  ok('ADMIN: si Supabase rechaza el cambio, avisa y la lista vuelve a lo guardado');
  await page.screenshot({ path: DIR + 'tests/shot-usuarios.png', fullPage: true });
  await context.close();
}

// 10. Sesión con usuario eliminado
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  const saved = users['lead@bcr.test'];
  delete users['lead@bcr.test'];
  await page.reload();
  await page.waitForSelector('#auth-form:not([hidden])');
  assert.match(await page.textContent('#auth-error'), /sesión expiró/);
  users['lead@bcr.test'] = saved;
  ok('usuario eliminado con sesión guardada: vuelve al login');
  await context.close();
}

// 11. Móvil (la prueba 9 ascendió a qa@bcr.test)
users['qa@bcr.test'].role = 'QA';
{
  const { context, page } = await newPage({ width: 375, height: 760 });
  await page.goto('http://app.test/index.html');
  await page.waitForSelector('#auth-form:not([hidden])');
  await page.screenshot({ path: DIR + 'tests/shot-login-movil.png' });
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.mobile-topbar', { state: 'visible' });
  assert.equal(await page.isVisible('#mnav-admin'), false);
  assert.equal(await page.isVisible('#mobile-logout'), true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal: ' + overflow);
  await page.screenshot({ path: DIR + 'tests/shot-movil.png' });
  ok('móvil: botón Salir visible, Admin oculto para QA, sin scroll horizontal');
  await context.close();
}

// ───────────── Fase 3: datos en Supabase ─────────────
const until = (page, fn, arg) => page.waitForFunction(fn, arg);
const lastWrite = () => writes[writes.length - 1];

// 12. QA: carga desde Supabase, genera tareas, nombres escapados, sin permisos de escritura
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await page.isVisible('#data-banner'), false);
  assert.deepEqual(await page.locator('#project-grid .proj-btn').allTextContents(), [' DATA', ' COMERCIAL']);
  assert.equal(await page.textContent('#dtab1 .dt-count'), '2 participantes');
  ok('QA: proyectos y personas vienen de Supabase, sin aviso de archivo');

  await page.click('#nav-qa');
  await page.click('#project-grid .proj-btn[data-type="DATA"]');
  await page.fill('#pbi-input', 'PBI 123 - Algo <b>raro</b>');
  await page.click('#btn-gen');
  await page.waitForSelector('#output-section.visible');
  assert.deepEqual(await page.locator('#table-body td').allTextContents(), ['PBI 123 - Algo <b>raro</b>', 'QA - 123 - Smoke.']);
  ok('QA Generator usa la plantilla de Supabase y muestra el texto sin interpretarlo como HTML');

  assert.equal(await page.locator('#upload-zone, #btn-extract').count(), 0);
  await page.click('#btn-clear-qa');
  assert.equal(await page.inputValue('#pbi-input'), '');
  assert.equal(await page.locator('#output-section.visible').count(), 0);
  assert.equal(await page.locator('#table-body tr').count(), 0);
  assert.equal(await page.isDisabled('#btn-gen'), true);
  assert.equal(await page.locator('#project-grid .proj-btn.active').getAttribute('data-type'), 'DATA');
  ok('Borrar limpia PBIs y tareas y mantiene el proyecto; ya no hay extracción con IA');

  await page.click('#project-grid .proj-btn[data-type="COMERCIAL"]');
  assert.deepEqual(await page.locator('#variant-select option').allTextContents(), ['Seleccionar variante…', 'Normal', "X'><b>"]);
  ok('variantes con caracteres especiales se muestran como texto');

  await page.selectOption('#variant-select', "x'><b>");
  await page.fill('#pbi-input', '77 - Sin plantilla');
  await page.click('#btn-gen');
  await page.waitForSelector('#status-msg.error');
  assert.match(await page.textContent('#status-msg'), /no tiene plantilla de tareas para la variante/);
  assert.equal(await page.locator('#output-section.visible').count(), 0);
  ok('sin plantilla avisa que hay que agregarla, sin llamar a ninguna IA');

  await page.click('#nav-daily');
  await page.click('#rollBtn');
  await page.waitForSelector('#listBody .participant-item');
  const names = await page.locator('#listBody .p-name').allTextContents();
  assert.ok(names.includes('Ana <img'), names.join('|'));
  assert.equal(await page.locator('#listBody img').count(), 0);
  assert.equal(names[names.length - 1], 'Beto Uno');
  await page.locator('#listBody .participant-item').first().click();
  assert.equal(await page.textContent('#doneCount'), '1');
  await page.locator('#listBody .participant-item').first().click();
  assert.equal(await page.textContent('#doneCount'), '0');
  ok('Daily: usa la regla "fijo al final" de Supabase y escapa los nombres');

  const n = writes.length;
  await page.evaluate(() => addPerson('daily1'));
  await page.evaluate(async () => { document.getElementById('newp-daily1').value = 'Intruso'; await addPerson('daily1'); });
  assert.equal(writes.length, n);
  assert.match(dialogs.pop(), /No tenés permiso/);
  ok('QA: la app no intenta escribir (y el RLS lo bloquearía igual)');

  const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('qaBcrSuiteCache_v3')));
  assert.equal(cache.userId, users['qa@bcr.test'].id);
  await page.click('.sidebar-user-actions button:has-text("Cerrar sesión")');
  await page.waitForSelector('#auth-form:not([hidden])');
  assert.equal(await page.evaluate(() => localStorage.getItem('qaBcrSuiteCache_v3')), null);
  ok('la copia local es del usuario y se borra al cerrar sesión');
  await context.close();
}

// 13. QA_LEAD: personas, reglas, plantillas, proyectos y variantes se guardan en Supabase
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-admin');

  await page.fill('#newp-daily1', 'Eva Nueva');
  await page.click('#asec-people .crud-btn-add >> nth=0');
  await page.waitForSelector('#list-people-daily1 .crud-item:has-text("Eva Nueva")');
  assert.ok(tables.daily_members.some((m) => m.name === 'Eva Nueva' && m.daily_group_id === 1));
  assert.equal(await page.inputValue('#newp-daily1'), '');
  ok('agregar persona: se inserta en daily_members');

  await page.fill('#newp-daily1', 'Dani Viejo');
  await page.click('#asec-people .crud-btn-add >> nth=0');
  await page.waitForSelector('#list-people-daily1 .crud-item:has-text("Dani Viejo")');
  assert.equal(tables.daily_members.find((m) => m.id === 4).active, true);
  ok('agregar a alguien que estaba inactivo lo reactiva (no choca con el unique)');

  answers.push('Eva Renombrada');
  await page.locator('#list-people-daily1 .crud-item:has-text("Eva Nueva") button[title="Editar"]').click();
  await page.waitForSelector('#list-people-daily1 .crud-item:has-text("Eva Renombrada")');
  assert.deepEqual(lastWrite().body, { name: 'Eva Renombrada' });
  ok('renombrar persona: actualiza daily_members por id');

  await page.click('#atab-rules');
  const beto = page.locator('#list-rules-daily1 .crud-item:has-text("Beto Uno")');
  assert.equal(await beto.locator('input >> nth=1').isChecked(), true);
  await beto.locator('input >> nth=0').check();
  await until(page, () => !document.body.classList.contains('saving'));
  assert.deepEqual(tables.daily_rule_members.filter((r) => r.daily_member_id === 2).map((r) => r.rule_type), ['FIRST_GROUP']);
  assert.equal(await page.locator('#list-rules-daily1 .crud-item:has-text("Beto Uno") input >> nth=1').isChecked(), false);
  ok('regla: marcar "primeros" reemplaza "fijo al final" con un upsert');

  await page.locator('#list-rules-daily1 .crud-item:has-text("Beto Uno") input >> nth=0').uncheck();
  await until(page, () => !document.body.classList.contains('saving'));
  assert.equal(tables.daily_rule_members.filter((r) => r.daily_member_id === 2).length, 0);
  ok('regla: desmarcar la borra');

  await page.fill('#range-daily1', '3');
  await page.dispatchEvent('#range-daily1', 'change');
  await until(page, () => !document.body.classList.contains('saving'));
  assert.equal(tables.daily_rules.find((r) => r.daily_group_id === 1).first_range, 3);
  ok('rango: se guarda en daily_rules');

  await page.click('#atab-tasks');
  await page.click('#task-project-list .proj-btn[data-code="COMERCIAL"]');
  assert.equal(await page.inputValue('#task-textarea'), 'QA - {n} - Normal.');
  await page.fill('#task-textarea', 'QA - {n} - Uno.\n\n  QA - {n} - Dos.  ');
  await page.click('#asec-tasks button:has-text("Guardar plantilla")');
  await page.waitForSelector('#asec-tasks button:has-text("Guardada")');
  assert.deepEqual(lastWrite().body, { p_project_id: 2, p_variant_id: 1, p_tasks: ['QA - {n} - Uno.', 'QA - {n} - Dos.'] });
  assert.equal(await page.inputValue('#task-textarea'), 'QA - {n} - Uno.\nQA - {n} - Dos.');
  ok('plantilla: se guarda con save_template() (proyecto + variante)');

  await page.fill('#new-variant', 'urgente');
  await page.click('#asec-tasks button:has-text("Agregar variante")');
  await until(page, () => document.getElementById('task-variant-select').value === 'urgente');
  assert.ok(tables.project_variants.some((v) => v.name === 'urgente' && v.project_id === 2));
  assert.equal(await page.inputValue('#task-textarea'), '');
  ok('variante: se crea y queda seleccionada');

  answers.push(true);
  await page.click('#asec-tasks button:has-text("Eliminar variante")');
  await until(page, () => ![...document.querySelectorAll('#task-variant-select option')].some((o) => o.value === 'urgente'));
  assert.ok(!tables.project_variants.some((v) => v.name === 'urgente'));
  ok('variante: se elimina');

  await page.fill('#new-project', 'nuevo');
  await page.click('#asec-tasks button:has-text("Agregar proyecto")');
  await page.waitForSelector('#task-project-list .proj-btn.active[data-code="NUEVO"]');
  await page.waitForSelector('#project-grid .proj-btn[data-type="NUEVO"]', { state: 'attached' });
  ok('proyecto: se crea en mayúsculas, queda seleccionado y aparece en el QA Generator');

  await page.fill('#task-textarea', 'QA - {n} - Única.');
  await page.click('#asec-tasks button:has-text("Guardar plantilla")');
  await page.waitForSelector('#asec-tasks button:has-text("Guardada")');
  assert.equal(lastWrite().body.p_variant_id, null);
  ok('plantilla sin variante: p_variant_id null');

  answers.push(true);
  await page.click('#asec-tasks button:has-text("Eliminar proyecto")');
  await until(page, () => !document.querySelector('#task-project-list [data-code="NUEVO"]'));
  assert.ok(!tables.projects.some((p) => p.code === 'NUEVO'));
  assert.equal(await page.isVisible('#task-editor-wrap'), false);
  ok('proyecto: se elimina');

  await page.click('#atab-people');
  answers.push('Caro Dos');
  failNextWrite = '23505';
  await page.locator('#list-people-daily1 .crud-item:has-text("Eva Renombrada") button[title="Editar"]').click();
  await until(page, () => !document.body.classList.contains('saving'));
  assert.ok(dialogs.some((d) => /Ya existe un registro con ese nombre/.test(d)), dialogs.join(' | '));
  assert.equal(await page.locator('#list-people-daily1 .crud-item:has-text("Eva Renombrada")').count(), 1);
  ok('si Supabase rechaza el cambio, avisa y la lista muestra lo guardado');

  answers.push(true);
  await page.locator('#list-people-daily1 .crud-item:has-text("Eva Renombrada") button[title="Eliminar"]').click();
  await until(page, () => !document.querySelector('#list-people-daily1').textContent.includes('Eva Renombrada'));
  assert.ok(!tables.daily_members.some((m) => m.name === 'Eva Renombrada'));
  ok('quitar persona: se borra de daily_members');

  const otro = await browser.newContext();
  await setup(otro);
  const p2 = await otro.newPage();
  await p2.goto('http://app.test/index.html');
  await login(p2, 'qa@bcr.test');
  await p2.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await p2.textContent('#dtab1 .dt-count'), '3 participantes');
  ok('otro usuario en otro navegador ve los cambios');
  await otro.close();
  await page.screenshot({ path: DIR + 'tests/shot-admin.png', fullPage: true });
  await context.close();
}

// 14. Sin conexión con Supabase: usa la última copia del usuario
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  failConfig = true;
  await page.reload();
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.match(await page.textContent('#data-banner-text'), /Sin conexión con Supabase/);
  assert.equal(await page.textContent('#dtab1 .dt-count'), '3 participantes');
  failConfig = false;
  await page.click('#data-banner-btn');
  await until(page, () => !document.getElementById('data-banner').classList.contains('visible'));
  ok('sin conexión: muestra la copia guardada con aviso y "Reintentar" recupera');
  await context.close();
}
{
  const { context, page } = await newPage();
  failConfig = true;
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('#auth-blocked:not([hidden])');
  assert.match(await page.textContent('#auth-blocked-text'), /No se pudieron cargar los datos.*XX000/);
  failConfig = false;
  ok('sin conexión y sin copia: no muestra la app vacía, explica el error');
  await context.close();
}

// 15. Base vacía: avisa qué falta
resetData(true);
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.match(await page.textContent('#data-banner-text'), /todavía no tiene proyectos ni personas/);
  assert.equal(await page.textContent('#project-grid'), 'No hay proyectos configurados.');
  ok('base vacía: avisa que faltan los datos iniciales');
  await context.close();
}
resetData();

// 16. ADMIN crea usuarios con la Edge Function; el usuario nuevo entra y cambia su contraseña
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-admin');
  await page.click('#atab-users');
  await page.waitForSelector('#list-users .user-role-select');
  const before = await page.locator('#list-users .crud-item').count();

  await page.fill('#nu-name', 'Nora Nueva');
  await page.fill('#nu-email', 'nora@bcr.test');
  await page.selectOption('#nu-role', 'QA_LEAD');
  await page.click('#user-create-form button:has-text("Generar")');
  const temp = await page.inputValue('#nu-password');
  assert.ok(temp.length === 14, temp);
  assert.equal(await page.getAttribute('#nu-password', 'type'), 'password');
  await page.click('#nu-show');
  assert.equal(await page.getAttribute('#nu-password', 'type'), 'text');
  assert.equal(await page.textContent('#nu-show'), 'Ocultar');
  await page.click('#nu-submit');
  await page.waitForSelector('#user-create-status.ok');
  assert.match(await page.textContent('#user-create-status'), /nora@bcr\.test \(QA Lead\)/);
  assert.deepEqual(created.at(-1), { full_name: 'Nora Nueva', email: 'nora@bcr.test', role: 'QA_LEAD', password: temp });
  await until(page, (n) => document.querySelectorAll('#list-users .crud-item').length === n + 1, before);
  assert.equal(await page.inputValue('#nu-password'), '');
  assert.equal(await page.getAttribute('#nu-password', 'type'), 'password');
  ok('ADMIN: crea un usuario con rol y contraseña temporal (oculta salvo con "Ver"); aparece en la lista');

  const shown = await page.textContent('#user-invite-text');
  assert.ok(!shown.includes(temp), 'la contraseña no debe verse en pantalla');
  assert.match(shown, /Hola Nora,[\s\S]*Usuario: nora@bcr\.test[\s\S]*Contraseña temporal: •{10}[\s\S]*Rol: QA Lead/);
  await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); });
  await page.click('#user-invite-copy');
  await page.waitForSelector('#user-invite-copy:has-text("Copiado")');
  const copied = await page.evaluate(() => window.__copied);
  assert.ok(copied.includes('Contraseña temporal: ' + temp), copied);
  assert.ok(copied.includes('Enlace: http'), copied);
  await page.click('#user-invite button:has-text("Listo")');
  assert.equal(await page.isHidden('#user-invite'), true);
  assert.equal(await page.evaluate(() => inviteText), '');
  ok('ADMIN: mensaje para la persona; la contraseña se copia pero no se ve, y "Listo" la borra');

  await page.fill('#nu-name', 'Otra');
  await page.fill('#nu-email', 'nora@bcr.test');
  await page.fill('#nu-password', 'temporal-123');
  await page.click('#nu-submit');
  await page.waitForSelector('#user-create-status.error');
  assert.equal(await page.textContent('#user-create-status'), 'Ya existe un usuario con ese correo.');
  ok('correo repetido: muestra el error de la función');

  functionMissing = true;
  await page.fill('#nu-email', 'otra@bcr.test');
  await page.click('#nu-submit');
  await page.waitForFunction(() => /no está publicada/.test(document.getElementById('user-create-status').textContent));
  functionMissing = false;
  ok('función sin publicar: lo explica');

  functionUnreachable = true;
  await page.click('#nu-submit');
  await page.waitForFunction(() => /No se pudo contactar la función admin-create-user.*Verify JWT/.test(document.getElementById('user-create-status').textContent));
  functionUnreachable = false;
  ok('función inalcanzable (sin CORS o con Verify JWT): dice qué revisar');
  await page.screenshot({ path: DIR + 'tests/shot-crear-usuario.png', fullPage: true });
  await context.close();

  const c2 = await newPage();
  await c2.page.goto('http://app.test/index.html');
  await login(c2.page, 'nora@bcr.test', temp);
  await c2.page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await c2.page.textContent('#sidebar-user-role'), 'QA Lead');
  // Primer ingreso: el diálogo se abre solo, sin "Cancelar", y Escape no lo cierra.
  await c2.page.waitForSelector('#pw-dialog[open]');
  assert.equal(await c2.page.textContent('#pw-title'), 'Cambiá tu contraseña temporal');
  assert.equal(await c2.page.isVisible('#pw-cancel'), false);
  assert.equal(await c2.page.isVisible('#pw-logout'), true);
  await c2.page.keyboard.press('Escape');
  assert.equal(await c2.page.isVisible('#pw-dialog'), true);
  await c2.page.fill('#pw-new', temp);
  await c2.page.fill('#pw-confirm', temp);
  await c2.page.click('#pw-submit');
  await c2.page.waitForSelector('#pw-status.error');
  assert.match(await c2.page.textContent('#pw-status'), /distinta de la actual/);
  await c2.page.fill('#pw-new', 'nueva-clave-segura');
  await c2.page.fill('#pw-confirm', 'otra-cosa-distinta');
  await c2.page.locator('#pw-dialog .pw-eye').nth(1).click();
  assert.deepEqual([await c2.page.getAttribute('#pw-new', 'type'), await c2.page.getAttribute('#pw-confirm', 'type')], ['password', 'text']);
  await c2.page.click('#pw-submit');
  assert.equal(await c2.page.textContent('#pw-status'), 'Las contraseñas no coinciden.');
  await c2.page.fill('#pw-confirm', 'nueva-clave-segura');
  await c2.page.click('#pw-submit');
  await c2.page.waitForSelector('#pw-status.ok');
  assert.equal(users['nora@bcr.test'].password, 'nueva-clave-segura');
  await c2.page.waitForSelector('#pw-dialog', { state: 'hidden' });
  ok('primer ingreso: obliga a cambiar la contraseña temporal (sin Cancelar ni Escape)');
  await c2.context.close();

  // Al volver a entrar ya no lo pide, y el ADMIN ve el estado de cada usuario.
  const c3 = await newPage();
  await c3.page.goto('http://app.test/index.html');
  await login(c3.page, 'nora@bcr.test', 'nueva-clave-segura');
  await c3.page.waitForSelector('.layout', { state: 'visible' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await c3.page.isVisible('#pw-dialog'), false);
  await c3.context.close();
  users['nunca@bcr.test'] = { id: 'a0000000-0000-4000-8000-000000000099', password: 'tmp-nunca-1234', full_name: 'Nadia Nunca', role: 'QA', active: true, must_change_password: true };
  users['temp@bcr.test'] = { id: 'a0000000-0000-4000-8000-000000000098', password: 'tmp-temp-1234', full_name: 'Tomas Temporal', role: 'QA', active: true, must_change_password: true, first_sign_in_at: '2026-10-16T14:00:00Z', last_sign_in_at: '2026-10-16T14:00:00Z' };
  const c4 = await newPage();
  await c4.page.goto('http://app.test/index.html');
  await login(c4.page, 'admin@bcr.test');
  await c4.page.waitForSelector('.layout', { state: 'visible' });
  await c4.page.evaluate(() => { showPage('admin'); selectAdminTab('users'); });
  await c4.page.waitForSelector('#list-users .user-access');
  const badge = (name) => c4.page.locator('#list-users .crud-item', { hasText: name }).locator('.user-access').textContent();
  assert.equal(await badge('Nadia Nunca'), 'Nunca entró');
  assert.equal(await badge('Tomas Temporal'), 'Entró, falta cambiar la contraseña');
  assert.match(await badge('Nora Nueva'), /^Último ingreso: \d{2}\/\d{2}\/\d{4}/);
  assert.match(await c4.page.locator('#list-users .crud-item', { hasText: 'Nora Nueva' }).locator('.user-access').getAttribute('title'), /Contraseña cambiada/);
  await c4.page.screenshot({ path: DIR + 'tests/shot-accesos.png', fullPage: true });
  assert.equal(await c4.page.locator('#list-users .crud-item', { hasText: 'Brayner Rosales' }).locator('.user-reset').count(), 0);
  answers.push(false);
  await c4.page.locator('#list-users .crud-item', { hasText: 'Nora Nueva' }).locator('.user-reset').click();
  assert.equal(users['nora@bcr.test'].password, 'nueva-clave-segura');
  answers.push(true);
  await c4.page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); });
  await c4.page.locator('#list-users .crud-item', { hasText: 'Nora Nueva' }).locator('.user-reset').click();
  await c4.page.waitForSelector('#user-invite:not([hidden])');
  const resetPw = users['nora@bcr.test'].password;
  assert.notEqual(resetPw, 'nueva-clave-segura');
  assert.equal(resetPw.length, 14);
  assert.equal(users['nora@bcr.test'].must_change_password, true);
  assert.match(await c4.page.textContent('#user-invite-text'), /Hola Nora, te generé una contraseña temporal nueva[\s\S]*Contraseña temporal: •{10}/);
  await c4.page.click('#user-invite-copy');
  await c4.page.waitForSelector('#user-invite-copy:has-text("Copiado")');
  assert.ok((await c4.page.evaluate(() => window.__copied)).includes('Contraseña temporal: ' + resetPw));
  await c4.page.waitForFunction(() => /Entró, falta cambiar/.test([...document.querySelectorAll('#list-users .crud-item')].find((e) => e.textContent.includes('Nora Nueva'))?.textContent || ''));
  ok('ADMIN: "Nueva contraseña" pide confirmación, genera una temporal, vuelve a pedir el cambio y arma el mensaje');
  delete users['nunca@bcr.test']; delete users['temp@bcr.test'];

  const noraRow = () => c4.page.locator('#list-users .crud-item').filter({ has: c4.page.locator(`[data-id="${users['nora@bcr.test'].id}"]`) });
  await noraRow().locator('.user-rename').click();
  await c4.page.keyboard.press('Escape');
  await c4.page.waitForSelector('#list-users .crud-item:has-text("Nora Nueva") button.user-rename:has-text("Cambiar nombre")');
  await noraRow().locator('.user-rename').click();
  await noraRow().locator('.user-name-form input').fill('  Nora   Nueva Pérez ');
  await noraRow().locator('.user-name-form input').press('Enter');
  await c4.page.waitForSelector('#list-users .crud-item-name:has-text("Nora Nueva Pérez")');
  assert.equal(users['nora@bcr.test'].full_name, 'Nora Nueva Pérez');
  await c4.page.locator(`#list-users .user-rename[data-id="${users['admin@bcr.test'].id}"]`).click();
  await c4.page.locator('#list-users .user-name-form input').fill('Brayner Rosales M.');
  await c4.page.locator('#list-users .user-name-form button[type=submit]').click();
  await c4.page.waitForSelector('#sidebar-user-name:has-text("Brayner Rosales M.")');
  rejectNextPatch = true;
  await noraRow().locator('.user-rename').click();
  await noraRow().locator('.user-name-form input').fill('Otro nombre');
  await noraRow().locator('.user-name-form input').press('Enter');
  await c4.page.waitForSelector('#users-status.error');
  assert.equal(users['nora@bcr.test'].full_name, 'Nora Nueva Pérez');
  await c4.page.waitForSelector('#list-users .crud-item-name:has-text("Nora Nueva Pérez")');
  users['nora@bcr.test'].full_name = 'Nora Nueva'; users['admin@bcr.test'].full_name = 'Brayner Rosales';
  ok('ADMIN: cambia el nombre de un usuario (y el propio) desde la lista; si no se guarda, avisa');
  await c4.context.close();
  ok('ADMIN ve quién nunca entró, quién sigue con la temporal y el último ingreso');

  const c5 = await newPage();
  await c5.page.goto('http://app.test/index.html');
  await login(c5.page, 'nora@bcr.test', users['nora@bcr.test'].password);
  await c5.page.waitForSelector('#pw-dialog[open]');
  assert.equal(await c5.page.textContent('#pw-title'), 'Cambiá tu contraseña temporal');
  await c5.context.close();
  ok('con la contraseña temporal nueva entra y la app le pide cambiarla');
}

// 17. QA_LEAD no puede crear usuarios (la función lo rechaza aunque se llame a mano)
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  const status = await page.evaluate(async () => {
    const { error } = await supabaseClient.functions.invoke('admin-create-user', { body: { email: 'x@bcr.test', full_name: 'X', role: 'ADMIN', password: 'temporal-123' } });
    return error?.context?.status;
  });
  assert.equal(status, 403);
  assert.ok(!users['x@bcr.test']);
  ok('QA_LEAD: la función responde 403');
  await context.close();
}

// 18. Daily: "No asistió"
{
  const { context, page } = await newPage({ width: 375, height: 760 });
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.mobile-topbar', { state: 'visible' });
  await page.evaluate(() => showPage('daily'));
  await page.click('#rollBtn');
  await page.waitForSelector('#listBody .participant-item');
  const first = page.locator('#listBody .participant-item').first();
  const second = page.locator('#listBody .participant-item').nth(1);
  await second.click();
  assert.equal(await page.textContent('#doneCount'), '1');
  await second.locator('.p-absent-btn').click();
  assert.equal(await page.textContent('#doneCount'), '0');
  assert.equal(await page.textContent('#absentCount'), '1');
  assert.equal(await second.locator('.p-absent-btn').textContent(), 'Asistió');
  await second.click();
  assert.equal(await page.textContent('#doneCount'), '0');
  ok('No asistió: saca a la persona de completados y no se puede marcar como lista');

  await first.locator('.p-absent-btn').click();
  assert.equal(await page.textContent('#absentCount'), '2');
  assert.equal(await page.locator('#absentBody img').count(), 0);
  await page.locator('#absentBody .done-item').first().click();
  assert.equal(await page.textContent('#absentCount'), '1');
  assert.equal(await second.locator('.p-absent-btn').textContent(), 'No asistió');
  await first.locator('.p-absent-btn').click();
  assert.equal(await page.textContent('#absentCount'), '0');
  assert.match(await page.textContent('#absentBody'), /registrar ausencias/);
  await first.locator('.p-absent-btn').click();
  await page.click('#rollBtn');
  assert.equal(await page.textContent('#absentCount'), '0');
  ok('ausencias: se deshacen desde la fila o la lista, y se limpian al generar otro orden');

  // Historial: guardar el daily de hoy (ausente + uno que habló) y verlo abajo.
  assert.match(await page.textContent('#dly-hist-body'), /No hay dailies guardados este mes/);
  const order = await page.locator('#listBody .participant-item').evaluateAll((els) => els.map((e) => e.dataset.name));
  await page.locator('#listBody .participant-item').first().click();
  await page.locator('#listBody .participant-item').nth(1).locator('.p-absent-btn').click();
  await page.click('#dly-save-btn');
  await page.waitForSelector('#dly-save-status.ok');
  assert.match(await page.textContent('#dly-save-status'), new RegExp(`Guardado el Daily 1 de hoy: ${order.length - 1} asisti(ó|eron), 1 no asistió`));
  assert.equal(tables.daily_runs.length, 1);
  const saved = tables.daily_runs[0];
  assert.deepEqual(saved.members.map((m) => m.name), order);
  assert.deepEqual([saved.members[0].completed, saved.members[1].absent, saved.created_by, saved.daily_group_id], [true, true, users['qa@bcr.test'].id, 1]);
  assert.equal(saved.members.find((m) => m.name === 'Beto Uno').daily_member_id, 2);
  await page.waitForSelector('#dly-hist-body .dly-day');
  const dayText = await page.textContent('#dly-hist-body .dly-day-head');
  assert.ok(dayText.includes(`${order.length - 1} de ${order.length} asistieron · empezó ${order[0]} · guardó Quique QA <b>`), dayText);
  assert.equal(await page.textContent('#dly-hist-body .dly-day-absent'), 'No asistieron: ' + order[1]);
  const absRow = page.locator('#dly-hist-body tbody tr', { hasText: order[1] });
  assert.deepEqual(await absRow.locator('td').allTextContents(), [order[1], '0', '1', '0%', '0']);
  assert.equal(await page.locator('#dly-hist-body img').count(), 0, 'los nombres se escapan');
  await page.screenshot({ path: DIR + 'tests/shot-daily-historial.png', fullPage: true });
  let overflowH = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowH <= 0, 'scroll horizontal en historial móvil: ' + overflowH);
  ok('Daily: guarda el daily de hoy (orden, quién habló y quién no asistió) y lo muestra en el historial');

  answers.push(false);
  const nd = dialogs.length;
  await page.click('#dly-save-btn');
  for (let i = 0; i < 50 && dialogs.length === nd; i++) await new Promise((r) => setTimeout(r, 50));
  await page.waitForSelector('#dly-save-btn:not([disabled])');
  assert.match(dialogs.at(-1), /ya lo guardó Quique QA <b>/);
  assert.equal(tables.daily_runs[0].members[1].absent, true, 'si cancela no se reemplaza');
  await page.locator('#listBody .participant-item').nth(1).locator('.p-absent-btn').click();
  answers.push(true);
  await page.click('#dly-save-btn');
  await page.waitForSelector('#dly-save-status.ok:has-text("asisti"):not(:has-text("no asisti"))');
  assert.equal(tables.daily_runs.length, 1, 'un registro por daily por día');
  assert.equal(tables.daily_runs[0].members.some((m) => m.absent), false);
  await page.click('[aria-label="Mes anterior"]');
  await page.waitForSelector('#dly-hist-body .sol-empty');
  await page.click('#dtab2');
  assert.equal(await page.textContent('#dly-hist-title'), 'Historial del Daily 2');
  assert.equal(await page.isVisible('#dly-save'), false);
  ok('Daily: volver a guardar el mismo día pide confirmación y reemplaza; el historial cambia por mes y daily');
  await page.click('#dtab1');
  await page.click('#rollBtn');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal en Daily móvil: ' + overflow);
  await page.locator('#listBody .participant-item').first().locator('.p-absent-btn').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: DIR + 'tests/shot-daily-movil.png' });
  ok('Daily en móvil con el botón No asistió: sin scroll horizontal');
  await context.close();
}

// 19. Solicitudes: solo QA Lead y Admin; lista compartida que se guarda en Supabase
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  for (const sel of ['#nav-solicitudes', '#mnav-solicitudes', '#home-solicitudes']) assert.equal(await page.isVisible(sel), false, sel);
  await page.evaluate(() => showPage('solicitudes'));
  assert.equal(await page.isVisible('#page-solicitudes'), false);
  ok('QA: no ve Solicitudes ni puede abrir la página');
  await context.close();
}
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#home-solicitudes');
  await page.waitForSelector('#sol-body tr');
  const names = () => page.locator('#sol-body .sol-name').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(await names(), ['Solicitud P3_070 Tucan vencida', 'Solicitud P3_081 Gobierno <b>Digital</b>', 'QA_OPC_47 Proyecto Digitalizacion']);
  assert.equal(await page.locator('#sol-body b').count(), 0);
  assert.deepEqual(await page.locator('#sol-stats b').allTextContents(), ['4', '3', '1', '1']);
  assert.equal(await page.locator('#sol-body tr.sol-late').count(), 1);
  assert.equal(await page.locator('#sol-body tr[data-id="2"] .sol-dot.blink').count(), 1);
  assert.equal(await page.locator('#sol-body tr[data-id="3"] .sol-dot-blue').count(), 1);
  ok('Solicitudes: abiertas ordenadas por P y OPC, nombres como texto, vencida resaltada');

  await page.selectOption('#sol-filter', 'all');
  assert.equal(await page.locator('#sol-body tr').count(), 4);
  await page.fill('#sol-search', 'tucan');
  assert.deepEqual(await names(), ['Solicitud P3_070 Tucan vencida']);
  await page.fill('#sol-search', '');
  await page.selectOption('#sol-filter', 'open');
  ok('Solicitudes: buscador y filtro por estado');

  const row = page.locator('#sol-body tr[data-id="1"]');
  await row.locator('.sol-enc select').selectOption('Caro Dos');
  await page.waitForSelector('#sol-body tr[data-id="1"] .sol-chip:has-text("Caro Dos")');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(tables.solicitudes[0].encargados, ['Beto Uno', 'Caro Dos']);
  const opts = await row.locator('.sol-enc select option').allTextContents();
  assert.ok(!opts.includes('Beto Uno') && !opts.includes('Dani Viejo') && opts.includes('Ana <img src=x onerror=alert(1)>'), opts.join('|'));
  await row.locator('button[aria-label="Quitar a Beto Uno"]').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(tables.solicitudes[0].encargados, ['Caro Dos']);
  ok('Solicitudes: encargado se elige de las personas activas del Daily y se puede quitar');
  await row.locator('input[aria-label="Cierre enviado"]').check();
  await page.waitForFunction(() => document.querySelector('#sol-body tr[data-id="1"] .sol-badge').textContent === 'Cerrada');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tables.solicitudes[0].cierre_enviado, true);
  assert.equal(tables.solicitudes[0].cerrada, true);
  assert.deepEqual(tables.solicitudes[0].encargados, []);
  assert.equal(tables.solicitudes[0].informe_semanal, false);
  assert.equal(await row.locator('.sol-chip').count(), 0);
  assert.equal(await row.locator('.sol-enc select').count(), 0);
  assert.equal(await row.locator('input[aria-label="Informe semanal"]').isDisabled(), true);
  await row.locator('textarea[aria-label="Observaciones"]').fill('Pendiente <script>x</script>');
  await row.locator('input[type=number]').fill('6.5');
  await row.locator('input[type=date]').fill('2026-12-01');
  await row.locator('.sol-name').fill('Solicitud P3_081 Renombrada');
  await page.locator('#sol-search').focus();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tables.solicitudes[0].observaciones, 'Pendiente <script>x</script>');
  assert.equal(tables.solicitudes[0].horas, 6.5);
  assert.equal(tables.solicitudes[0].cierra, '2026-12-01');
  assert.equal(tables.solicitudes[0].nombre, 'Solicitud P3_081 Renombrada');
  ok('Solicitudes: casillas, horas, fecha, nombre y notas se guardan; cierre enviado la cierra y quita los encargados');
  assert.equal(await row.locator('.sol-mod').textContent(), 'vos · recién');
  ok('Solicitudes: muestra quién hizo el último cambio');

  await page.waitForSelector('#sol-live', { state: 'visible' });
  const sol2 = { ...tables.solicitudes.find((s) => s.id === 2), observaciones: 'Cambio de otro lead', updated_by: users['admin@bcr.test'].id, updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() };
  rtPush('UPDATE', sol2, { id: 2 });
  await page.waitForFunction(() => document.querySelector('#sol-body tr[data-id="2"] textarea[aria-label="Observaciones"]').value === 'Cambio de otro lead');
  assert.equal(await page.locator('#sol-body tr[data-id="2"] .sol-mod').textContent(), 'Brayner · hace 2 h');
  // La fila que estás editando no se pisa: solo cambia su estado.
  await page.locator('#sol-body tr[data-id="2"] textarea[aria-label="Observaciones"]').focus();
  await page.keyboard.type(' (mío)');
  rtPush('UPDATE', { ...sol2, horas: 9 }, { id: 2 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.locator('#sol-body tr[data-id="2"] textarea[aria-label="Observaciones"]').inputValue(), 'Cambio de otro lead (mío)');
  await page.locator('#sol-search').focus();
  rtPush('INSERT', { id: 50, nombre: 'Solicitud P3_200 En vivo', informe_semanal: false, encargados: [], horas: null, pend_plan: false, pend_actualizar: false, plan_enviado: false, cierre_enviado: false, cierra: null, observaciones: '', cerrada: false, updated_by: users['admin@bcr.test'].id, updated_at: new Date().toISOString() });
  await page.waitForSelector('#sol-body tr[data-id="50"]');
  rtPush('DELETE', null, { id: 50 });
  await page.waitForFunction(() => !document.querySelector('#sol-body tr[data-id="50"]'));
  ok('Solicitudes en vivo: cambios, altas y bajas de otros aparecen solos sin pisar lo que estás escribiendo');


  await page.fill('#sol-new-name', 'Solicitud P3_090 Nueva <i>x</i>');
  await page.click('#sol-new-btn');
  await page.waitForSelector('#sol-status.ok');
  assert.ok(tables.solicitudes.some((s) => s.nombre === 'Solicitud P3_090 Nueva <i>x</i>'));
  assert.equal(await page.locator('#sol-body .sol-name').evaluateAll((els) => els.some((e) => e.value === 'Solicitud P3_090 Nueva <i>x</i>')), true);
  ok('Solicitudes: agregar una nueva');

  tables.solicitudes.find((s) => s.id === 3).nombre = 'QA_OPC_47 Cambiada por otro lead';
  await page.click('#sol-reload');
  await page.waitForSelector('#sol-status.ok:has-text("Lista actualizada")');
  assert.equal(await page.locator('#sol-body tr[data-id="3"] .sol-name').inputValue(), 'QA_OPC_47 Cambiada por otro lead');
  ok('Solicitudes: Recargar trae los cambios de otros');

  answers.push(false);
  await page.locator('#sol-body tr[data-id="3"] .sol-del').click();
  assert.equal(tables.solicitudes.some((s) => s.id === 3), true);
  answers.push(true);
  await page.locator('#sol-body tr[data-id="3"] .sol-del').click();
  await page.waitForFunction(() => !document.querySelector('#sol-body tr[data-id="3"]'));
  assert.equal(tables.solicitudes.some((s) => s.id === 3), false);
  ok('Solicitudes: eliminar pide confirmación');

  failNextWrite = '42501';
  await page.locator('#sol-body tr[data-id="2"] input[aria-label="Plan enviado"]').check();
  await page.waitForFunction(() => !document.querySelector('#sol-body tr[data-id="2"] input[aria-label="Plan enviado"]').checked);
  assert.equal(tables.solicitudes.find((s) => s.id === 2).plan_enviado, false);
  ok('Solicitudes: si Supabase rechaza el cambio, avisa y vuelve a mostrar lo guardado');
  await page.screenshot({ path: DIR + 'tests/shot-solicitudes.png', fullPage: true });
  await context.close();
}
{
  const { context, page } = await newPage({ width: 375, height: 760 });
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.mobile-topbar', { state: 'visible' });
  await page.click('#mnav-solicitudes');
  await page.waitForSelector('#sol-body tr');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal en Solicitudes móvil: ' + overflow);
  await page.screenshot({ path: DIR + 'tests/shot-solicitudes-movil.png' });
  ok('ADMIN en móvil: ve la misma lista, la tabla se desplaza dentro de su recuadro');
  await context.close();
}

// 20. Horas: cada QA carga las suyas; leads corrigen las de todos; consolidado para todos
const ymd = (d) => d.toLocaleDateString('en-CA');
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d; })();
const weekDay = (i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return ymd(d); };
const ids = Object.fromEntries(Object.entries(users).map(([e, u]) => [e.split('@')[0], u.id]));
{
  tables.horas = [
    { id: 1, user_id: ids.lead, fecha: weekDay(0), tipo: 'TRABAJO', soli: 'P3_9', tarea: 'Secreta del lead', horas: 8, facturable: 8, updated_by: ids.lead, updated_at: new Date().toISOString() },
  ];
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-horas');
  await page.waitForSelector('#hrs-days .hrs-day');
  assert.equal(await page.locator('#hrs-days .hrs-day').count(), 5);
  assert.equal(await page.isVisible('#hrs-person-wrap'), false);
  assert.equal(await page.locator('#hrs-days .hrs-line').count(), 0, 'no ve líneas de otros');
  ok('Horas (QA): ve su semana de lunes a viernes, sin selector de persona ni líneas de otros');

  const mon = page.locator(`#hrs-days .hrs-day[data-date="${weekDay(0)}"]`);
  await mon.locator('button:has-text("Agregar línea")').click();
  const l1 = mon.locator('.hrs-line').first();
  await l1.locator('[data-f=soli]').fill('P3_141');
  await l1.locator('[data-f=tarea]').fill('Ejecución 2317552 <b>');
  await l1.locator('[data-f=horas]').fill('8');
  await l1.locator('[data-f=horas]').press('Tab');
  await until(page, () => document.querySelector('#hrs-days .hrs-line [data-f=facturable]').value === '8');
  await new Promise((r) => setTimeout(r, 250));
  let mine = tables.horas.filter((h) => h.user_id === ids.qa);
  assert.equal(mine.length, 1);
  assert.deepEqual({ ...mine[0], id: 0, updated_at: 0 }, { id: 0, user_id: ids.qa, fecha: weekDay(0), tipo: 'TRABAJO', soli: 'P3_141', tarea: 'Ejecución 2317552 <b>', horas: 8, facturable: 8, updated_by: ids.qa, updated_at: 0 });
  await l1.locator('[data-f=facturable]').fill('7');
  await l1.locator('[data-f=facturable]').press('Tab');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(tables.horas.filter((h) => h.user_id === ids.qa).length, 1, 'actualiza, no duplica');
  assert.equal(mine[0].facturable, 7);
  assert.equal(await mon.locator('.hrs-day-tot').textContent(), '8 / 8 h');
  ok('Horas (QA): agrega una línea; facturable arranca igual a las horas y se puede bajar (8 trabajadas, 7 facturables)');

  const tue = page.locator(`#hrs-days .hrs-day[data-date="${weekDay(1)}"]`);
  await tue.locator('button:has-text("Agregar línea")').click();
  const l2 = tue.locator('.hrs-line').first();
  await l2.locator('[data-f=tipo]').selectOption('VACACIONES');
  await l2.locator('[data-f=horas]').fill('4');
  await l2.locator('[data-f=horas]').press('Tab');
  await new Promise((r) => setTimeout(r, 250));
  const vac = tables.horas.find((h) => h.user_id === ids.qa && h.tipo === 'VACACIONES');
  assert.equal(vac.horas, 4); assert.equal(vac.facturable, 0);
  assert.equal(await l2.locator('[data-f=facturable]').isDisabled(), true);
  assert.equal(await tue.locator('.hrs-day-tot').getAttribute('class'), 'hrs-day-tot off');
  assert.deepEqual(await page.locator('#hrs-week-stats b').allTextContents(), ['12 / 40', '7', '1', '4']);
  ok('Horas (QA): vacaciones como línea del día, sin horas facturables; totales de la semana');

  await l1.locator('[data-f=facturable]').fill('9');
  await l1.locator('[data-f=facturable]').press('Tab');
  await page.waitForSelector('#hrs-status.error');
  assert.equal(await l1.locator('[data-f=facturable].bad').count(), 1);
  assert.equal(mine[0].facturable, 7);
  await l1.locator('[data-f=facturable]').fill('7');
  await l1.locator('[data-f=facturable]').press('Tab');
  ok('Horas (QA): no deja facturar más de lo trabajado');

  answers.push(false);
  await l2.locator('.sol-del').click();
  assert.ok(tables.horas.some((h) => h === vac));
  answers.push(true);
  await l2.locator('.sol-del').click();
  await until(page, (d) => !document.querySelector(`#hrs-days .hrs-day[data-date="${d}"] .hrs-line`), weekDay(1));
  assert.ok(!tables.horas.some((h) => h === vac));
  ok('Horas (QA): eliminar una línea pide confirmación');

  await page.click('#hrs-tab-report');
  await page.waitForSelector('#hrs-report-tables table');
  const tableText = await page.locator('#hrs-report-tables').textContent();
  assert.ok(!tableText.includes('Secreta'), 'el consolidado no muestra tareas');
  const rowOf = (name) => page.locator('#hrs-report-tables tbody tr', { hasText: name }).locator('td').allTextContents();
  assert.deepEqual(await rowOf('Laura Lead'), ['Laura Lead', '0', '8', '0', '0', '0', '8', '40']);
  assert.deepEqual(await rowOf('Quique QA'), ['Quique QA <b>', '0', '7', '1', '0', '0', '8', '40']);
  assert.equal(await page.locator('#hrs-report-tables tbody tr', { hasText: 'Inactivo' }).count(), 0);
  assert.equal(await page.locator('#hrs-report-tables .hrs-who').count(), 1, 'un QA solo puede abrir su propia fila');
  const people = await page.locator('#hrs-report-tables tbody tr').count();
  assert.deepEqual(await page.locator('#hrs-report-tables tfoot td').allTextContents(), ['Total horas', '0', '15', '1', '0', '0', '16', String(people * 40)]);
  ok('Horas (QA): ve el consolidado de todos, solo con totales');

  await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); });
  await page.click('#hrs-copy');
  await page.waitForSelector('#hrs-copy:has-text("Copiado")');
  const copied = await page.evaluate(() => window.__copied);
  assert.match(copied, /^Semana .+\nEquipo\tFeriado\tFacturable\tNo facturable\t.+\tTotal\tCapacidad\n/);
  assert.ok(copied.includes('Quique QA <b>\t0\t7\t1\t0\t0\t8\t40'), copied);
  assert.ok(copied.endsWith('Total horas\t0\t15\t1\t0\t0\t16\t' + people * 40), copied);
  ok('Horas: "Copiar para Excel" copia el consolidado separado por tabulaciones');

  // Semana que cruza de mes: dos tablas, como el Excel (29 sep - 2 oct 2026 → 29-30 sep y 1-2 oct).
  await page.evaluate(() => { hrsRef = new Date(2026, 8, 30); return loadHrsReport(); });
  assert.deepEqual(await page.locator('#hrs-report-tables caption').allTextContents(), ['Semana 28 al 30 de septiembre de 2026', 'Semana 1 al 2 de octubre de 2026']);
  assert.equal(await page.locator('#hrs-report-tables table').nth(1).locator('tbody tr').first().locator('td').last().textContent(), '16');
  await page.selectOption('#hrs-mode', 'month');
  await until(page, () => document.querySelector('#hrs-report-tables caption')?.textContent === 'Septiembre 2026');
  assert.equal(await page.locator('#hrs-report-tables tbody tr').first().locator('td').last().textContent(), String(22 * 8));
  ok('Horas: la semana que cruza de mes se parte en dos; vista por mes con su capacidad');
  await context.close();
}
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-horas');
  await page.waitForSelector('#hrs-person-wrap:not([hidden])');
  await until(page, () => document.querySelectorAll('#hrs-days .hrs-line').length === 1);
  assert.equal(await page.inputValue('#hrs-days .hrs-line [data-f=tarea]'), 'Secreta del lead');
  const opts = await page.locator('#hrs-person option').allTextContents();
  assert.ok(opts.includes('Quique QA <b>') && !opts.includes('Inactivo'), opts.join('|'));
  ok('Horas (Lead): elige de quién ver las horas (solo activos)');

  await page.click('#hrs-tab-report');
  await page.waitForSelector('#hrs-report-tables .hrs-who');
  assert.equal(await page.isVisible('#hrs-pick-btn'), false, 'solo un ADMIN elige quién sale en el informe');
  assert.equal(await page.locator('#hrs-report-tables .hrs-who').count(), await page.locator('#hrs-report-tables tbody tr').count());
  await page.locator('#hrs-report-tables .hrs-who', { hasText: 'Quique' }).click();
  await until(page, () => document.querySelectorAll('#hrs-days .hrs-line').length === 1 && document.querySelector('#hrs-days .hrs-line [data-f=soli]').value === 'P3_141');
  assert.equal(await page.inputValue('#hrs-person'), ids.qa);
  const line = page.locator('#hrs-days .hrs-line').first();
  await line.locator('[data-f=facturable]').fill('6.5');
  await line.locator('[data-f=facturable]').press('Tab');
  await page.waitForSelector('#hrs-days .hrs-edited:has-text("Corregido por vos")');
  const q = tables.horas.find((h) => h.user_id === ids.qa);
  assert.equal(q.facturable, 6.5); assert.equal(q.updated_by, ids.lead);
  ok('Horas (Lead): desde el consolidado abre las líneas de un QA, las corrige y queda marcado quién corrigió');

  // Ajuste del consolidado: la línea no cambia, se guarda la diferencia con motivo.
  await page.click('#hrs-tab-report');
  const qRow = () => page.locator('#hrs-report-tables tbody tr', { hasText: 'Quique' });
  const factCell = () => qRow().locator('td').nth(2);
  await page.waitForSelector('#hrs-report-tables .hrs-adj-btn');
  const totalBefore = +(await qRow().locator('td').nth(6).textContent());
  assert.equal(await factCell().textContent(), '6.5');
  await factCell().locator('.hrs-adj-btn').click();
  await page.waitForSelector('#adj-dialog[open]');
  assert.match(await page.textContent('#adj-what'), /Quique QA <b> · Facturable · Semana/);
  assert.match(await page.textContent('#adj-raw'), /Calculado de sus líneas: 6\.5 h/);
  assert.equal(await page.isVisible('#adj-remove'), false);
  await page.fill('#adj-value', '6');
  await page.click('#adj-save');
  assert.equal(await page.isVisible('#adj-dialog'), true, 'sin motivo no guarda');
  await page.fill('#adj-motivo', 'Azure dice 6.5, se cobran 6');
  await page.click('#adj-save');
  await page.waitForSelector('#adj-dialog', { state: 'hidden' });
  await until(page, () => [...document.querySelectorAll('#hrs-report-tables tbody tr')].find((tr) => tr.textContent.includes('Quique'))?.cells[2].textContent === '6');
  const aj = tables.horas_ajustes[0];
  assert.deepEqual([aj.user_id, aj.columna, aj.delta, aj.updated_by, new Date(aj.fecha + 'T00:00:00').getDay()], [ids.qa, 'facturable', -0.5, ids.lead, 1]);
  assert.equal(tables.horas.find((h) => h.user_id === ids.qa).facturable, 6.5, 'la línea del QA no cambia');
  assert.equal(+(await qRow().locator('td').nth(6).textContent()), totalBefore - 0.5);
  assert.equal(await factCell().getAttribute('class'), 'adj');
  assert.match(await factCell().getAttribute('title'), /Ajustado por Laura Lead: 6\.5 → 6 · Azure dice 6\.5, se cobran 6/);
  await page.screenshot({ path: DIR + 'tests/shot-horas-ajuste.png', fullPage: true });

  await factCell().locator('.hrs-adj-btn').click();
  await page.waitForSelector('#adj-dialog[open]');
  assert.equal(await page.inputValue('#adj-motivo'), 'Azure dice 6.5, se cobran 6');
  assert.equal(await page.isVisible('#adj-remove'), true);
  await page.fill('#adj-value', '7');
  await page.click('#adj-save');
  await until(page, () => [...document.querySelectorAll('#hrs-report-tables tbody tr')].find((tr) => tr.textContent.includes('Quique'))?.cells[2].textContent === '7');
  assert.equal(tables.horas_ajustes.length, 1); assert.equal(tables.horas_ajustes[0].delta, 0.5);
  ok('Horas (Lead): ajusta un número del consolidado con motivo; queda marcado y la línea del QA no cambia');

  await page.selectOption('#hrs-mode', 'month');
  await page.waitForSelector('#hrs-report-tables caption:has-text("Octubre")');
  assert.equal(await page.locator('#hrs-report-tables .hrs-adj-btn').count(), 0, 'en el mes no se ajusta');
  assert.equal(await factCell().textContent(), '7');
  assert.equal(await factCell().getAttribute('class'), 'adj');
  ok('Horas: el mes suma los ajustes de las semanas y no se ajusta ahí');
  await page.selectOption('#hrs-mode', 'week');
  await page.waitForSelector('#hrs-report-tables .hrs-adj-btn');
  await factCell().locator('.hrs-adj-btn').click();
  await page.click('#adj-remove');
  await until(page, () => [...document.querySelectorAll('#hrs-report-tables tbody tr')].find((tr) => tr.textContent.includes('Quique'))?.cells[2].textContent === '6.5');
  assert.equal(tables.horas_ajustes.length, 0);
  ok('Horas (Lead): quitar el ajuste vuelve al número calculado');
  await page.click('#hrs-tab-mine');
  await page.waitForSelector('#hrs-days .hrs-line');

  // Otra semana: no hay líneas; feriado de Costa Rica con botón para cargarlo.
  await page.evaluate(() => { hrsWeek = new Date(2026, 8, 14); return loadMyHours(); });
  const tueHol = page.locator('#hrs-days .hrs-day[data-date="2026-09-15"]');
  assert.match(await tueHol.locator('h3').textContent(), /Feriado: Día de la Independencia/);
  await tueHol.locator('button:has-text("Cargar feriado")').click();
  await new Promise((r) => setTimeout(r, 250));
  const fer = tables.horas.find((h) => h.fecha === '2026-09-15');
  assert.deepEqual([fer.user_id, fer.tipo, fer.horas, fer.facturable, fer.tarea], [ids.qa, 'FERIADO', 8, 0, 'Día de la Independencia']);
  ok('Horas: los feriados de Costa Rica se cargan con un botón');

  failNextWrite = '42501';
  await tueHol.locator('.hrs-line [data-f=horas]').fill('4');
  await tueHol.locator('.hrs-line [data-f=horas]').press('Tab');
  await until(page, () => document.querySelector('#hrs-days .hrs-day[data-date="2026-09-15"] [data-f=horas]').value === '8');
  assert.ok(dialogs.at(-1).includes('No tenés permiso'));
  ok('Horas: si Supabase rechaza el cambio, avisa y vuelve a mostrar lo guardado');
  await page.screenshot({ path: DIR + 'tests/shot-horas.png', fullPage: true });
  await context.close();
}
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('#nav-horas');
  await page.click('#hrs-tab-report');
  await page.waitForSelector('#hrs-report-tables tbody tr:has-text("Brayner Rosales")');
  await page.click('#hrs-pick-btn');
  const box = page.locator('#hrs-picker-list label', { hasText: 'Brayner Rosales' }).locator('input');
  await box.waitFor();
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  await until(page, () => ![...document.querySelectorAll('#hrs-report-tables tbody tr')].some((tr) => tr.textContent.includes('Brayner Rosales')));
  assert.equal(users['admin@bcr.test'].en_informe, false);
  assert.ok(await page.locator('#hrs-report-tables tbody tr', { hasText: 'Quique' }).count() > 0);
  await page.screenshot({ path: DIR + 'tests/shot-horas-informe.png', fullPage: true });
  await box.check();
  await page.waitForSelector('#hrs-report-tables tbody tr:has-text("Brayner Rosales")');
  assert.equal(users['admin@bcr.test'].en_informe, true);
  ok('Horas (ADMIN): elige quién sale en el consolidado');

  rejectNextPatch = true;
  const qbox = page.locator('#hrs-picker-list label', { hasText: 'Quique' }).locator('input');
  await qbox.uncheck();
  await page.waitForSelector('#hrs-status.error');
  assert.equal(await qbox.isChecked(), true, 'si no se guarda, la casilla vuelve a como estaba');
  ok('Horas (ADMIN): si no se puede guardar la elección, avisa y deja la casilla como estaba');
  await context.close();
}
// Feedback y eliminar usuarios
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.click('.sidebar-logout:has-text("Enviar feedback")');
  await page.waitForSelector('#fb-dialog[open]');
  await page.click('#fb-send');
  assert.equal(tables.feedback.length, 0, 'vacío no se envía');
  await page.fill('#fb-text', '  En Horas me gustaría <b>copiar</b> la semana anterior.  ');
  assert.equal(await page.textContent('#fb-count'), '58 / 2000');
  await page.click('#fb-send');
  await page.waitForSelector('#fb-status.ok');
  await page.waitForSelector('#fb-dialog', { state: 'hidden' });
  assert.deepEqual([tables.feedback.length, tables.feedback[0].autor, tables.feedback[0].mensaje], [1, 'Quique QA <b>', 'En Horas me gustaría <b>copiar</b> la semana anterior.']);
  assert.equal(await page.isVisible('#atab-feedback'), false);
  ok('Feedback: cualquier usuario lo envía desde el menú');
  await context.close();
}
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'lead@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.evaluate(() => showPage('admin'));
  assert.equal(await page.isVisible('#atab-feedback'), false);
  const leadRead = await page.evaluate(async () => (await supabaseClient.from('feedback').select('*')).data);
  assert.deepEqual(leadRead, []);
  ok('Feedback: un Lead no ve la pestaña ni puede leerlo');
  await context.close();
}
{
  const { context, page } = await newPage();
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.evaluate(() => showPage('admin'));
  await page.waitForSelector('#fb-badge:not([hidden])');
  assert.equal(await page.textContent('#fb-badge'), '1');
  await page.click('#atab-feedback');
  await page.waitForSelector('#list-feedback .fb-item.unread');
  assert.equal(await page.textContent('#list-feedback .fb-msg'), 'En Horas me gustaría <b>copiar</b> la semana anterior.');
  assert.match(await page.textContent('#list-feedback .fb-head'), /Quique QA <b>/);
  await page.screenshot({ path: DIR + 'tests/shot-feedback.png', fullPage: true });
  await page.click('#list-feedback button:has-text("Marcar leído")');
  await page.waitForSelector('#list-feedback .crud-empty:has-text("No hay feedback sin leer")');
  assert.equal(tables.feedback[0].leido, true);
  assert.equal(await page.isVisible('#fb-badge'), false);
  await page.check('input[name=fb-filter][value=all]');
  await page.waitForSelector('#list-feedback .fb-item:not(.unread)');
  answers.push(true);
  await page.click('#list-feedback .crud-btn-del');
  await page.waitForSelector('#list-feedback .crud-empty:has-text("Todavía no hay feedback")');
  assert.equal(tables.feedback.length, 0);
  ok('Feedback (ADMIN): lo lee, lo marca como leído y lo elimina');

  users['borrar@bcr.test'] = { id: 'a0000000-0000-4000-8000-000000000077', password: 'pw', full_name: 'Bruno Borrar', role: 'QA', active: true };
  tables.horas.push({ id: 900, user_id: 'a0000000-0000-4000-8000-000000000077', fecha: '2026-10-12', tipo: 'TRABAJO', soli: '', tarea: '', horas: 8, facturable: 8 });
  await page.click('#atab-users');
  await page.waitForSelector('#list-users .crud-item:has-text("Bruno Borrar")');
  assert.equal(await page.locator(`#list-users .user-delete[data-id="${ids.admin}"]`).count(), 0, 'no se puede eliminar a sí mismo');
  const del = page.locator('#list-users .crud-item', { hasText: 'Bruno Borrar' }).locator('.user-delete');
  answers.push(false);
  await del.click();
  assert.ok(users['borrar@bcr.test'], 'si cancela no se elimina');
  assert.match(dialogs.at(-1), /Se borran su usuario y sus horas registradas/);
  answers.push(true);
  await del.click();
  await page.waitForSelector('#users-status.ok:has-text("Bruno Borrar fue eliminado")');
  await until(page, () => !document.querySelector('#list-users').textContent.includes('Bruno Borrar'));
  assert.equal(users['borrar@bcr.test'], undefined);
  assert.equal(tables.horas.some((h) => h.id === 900), false);
  ok('ADMIN: elimina un usuario (con confirmación; no a sí mismo)');
  await context.close();
}
{
  const { context, page } = await newPage({ width: 375, height: 760 });
  await page.goto('http://app.test/index.html');
  await login(page, 'qa@bcr.test');
  await page.waitForSelector('.mobile-topbar', { state: 'visible' });
  assert.equal(await page.isVisible('#mobile-feedback'), true);
  await page.click('.mobile-nav-btn:has-text("Horas")');
  await page.waitForSelector('#hrs-days .hrs-line');
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal en Horas móvil: ' + overflow);
  assert.equal(await page.isVisible('#hrs-days .hrs-line .hrs-f > span'), true, 'en móvil cada campo muestra su etiqueta');
  await page.screenshot({ path: DIR + 'tests/shot-horas-movil.png', fullPage: true });
  const monday = await page.evaluate(() => calcToISO(hrsMonday(new Date())));
  tables.horas_ajustes.push({ id: 99, user_id: ids.qa, fecha: monday, columna: 'licencia', delta: 3, motivo: 'secreto del lead', updated_by: ids.lead });
  await page.click('#hrs-tab-report');
  await page.waitForSelector('#hrs-report-tables table');
  const qaRow = page.locator('#hrs-report-tables tbody tr', { hasText: 'Quique' });
  assert.equal(await qaRow.locator('td').nth(4).textContent(), '3');
  assert.equal(await page.locator('#hrs-report-tables td.adj, #hrs-report-tables .hrs-adj-btn').count(), 0);
  assert.ok(!(await page.content()).includes('secreto del lead'));
  tables.horas_ajustes = [];
  ok('Horas (QA): ve el número final ajustado, sin marca ni motivo');
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal en consolidado móvil: ' + overflow);
  ok('Horas en móvil: líneas en tarjetas con etiquetas; el consolidado se desplaza dentro de su recuadro');
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'errores de JS en la página: ' + errors.join(' | '));
ok('sin errores de JavaScript ni bloqueos de CSP/integridad en la página');
