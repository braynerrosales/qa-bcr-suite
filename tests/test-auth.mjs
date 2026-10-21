// Prueba las Fases 2 y 3 con el cliente real de supabase-js y un Supabase simulado en la red.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Requiere: npm i playwright-core y supabase-js descomprimido en ./package (npm pack @supabase/supabase-js@2.117.2).
const DIR = fileURLToPath(new URL('..', import.meta.url));
const SUPA = 'https://demo.supabase.co';
// La app: index.html con la CSP apuntando al Supabase simulado; css/ y js/ se sirven tal cual,
// salvo js/config.js (URL y clave del simulado). sin-config.html carga una configuración vacía.
const html = readFileSync(DIR + 'index.html', 'utf8');
const configured = html
  .replaceAll(/https:\/\/[a-z0-9]+\.supabase\.co(?=[ ;])/g, SUPA)
  .replaceAll(/wss:\/\/[a-z0-9]+\.supabase\.co(?=[ ;])/g, SUPA.replace('https', 'wss'));
const unconfigured = html.replace('src="js/config.js"', 'src="js/sin-config.js"');
const config = readFileSync(DIR + 'js/config.js', 'utf8');
const configJs = config
  .replace(/const SUPABASE_URL='[^']*';/, `const SUPABASE_URL='${SUPA}';`)
  .replace(/const SUPABASE_ANON_KEY='[^']*';/, "const SUPABASE_ANON_KEY='anon-test-key';");
const emptyConfigJs = config
  .replace(/const SUPABASE_URL='[^']*';/, "const SUPABASE_URL='';")
  .replace(/const SUPABASE_ANON_KEY='[^']*';/, "const SUPABASE_ANON_KEY='';");
const STATIC = /^\/(css\/[\w-]+\.css|js\/[\w-]+\.js|img\/[\w-]+\.png)$/;
const TYPES = { css: 'text/css', js: 'application/javascript', png: 'image/png' };

const supabaseJs = readFileSync(DIR + 'package/dist/umd/supabase.js', 'utf8');

const users = {
  'admin@bcr.test': { id: 'a0000000-0000-4000-8000-000000000001', password: 'pw', full_name: 'Brayner Rosales', role: 'ADMIN', active: true },
  'lead@bcr.test': { id: 'a0000000-0000-4000-8000-000000000002', password: 'pw', full_name: 'Laura Lead', role: 'QA_LEAD', active: true },
  'qa@bcr.test': { id: 'a0000000-0000-4000-8000-000000000003', password: 'pw', full_name: 'Quique QA <b>', role: 'QA', active: true },
  'off@bcr.test': { id: 'a0000000-0000-4000-8000-000000000004', password: 'pw', full_name: 'Inactivo', role: 'QA', active: false },
};
// Pedidos a la base hechos con la contraseña temporal (la base real no da permisos hasta cambiarla).
const tempCalls = [];
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
// Avisos de solicitudes: último "visto" por usuario, llamadas al contador y fallo forzado de marcar_visto.
let vistas = {};
const rpcCalls = { novedades: 0, marcarVisto: 0 };
let rejectNextVisto = false;
let delayNovedades = 0; // ms: respuesta atrasada del contador
let failAvisos = false; // solicitudes_avisos responde 500
const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };
const solicitudesIniciales = () => [
  { id: 1, nombre: 'Solicitud P3_081 Gobierno <b>Digital</b>', informe_semanal: true, encargados: ['Beto Uno'], horas: null, pend_plan: false, pend_actualizar: false, plan_enviado: true, cierre_enviado: false, cierra: isoDay(5), observaciones: '', cerrada: false },
  { id: 2, nombre: 'Solicitud P3_070 Tucan vencida', informe_semanal: false, encargados: [], horas: 4, pend_plan: false, pend_actualizar: false, plan_enviado: false, cierre_enviado: false, cierra: isoDay(-3), observaciones: 'Entró tarde', cerrada: false },
  { id: 3, nombre: 'QA_OPC_47 Proyecto Digitalizacion', informe_semanal: false, encargados: [], horas: null, pend_plan: true, pend_actualizar: false, plan_enviado: false, cierre_enviado: false, cierra: null, observaciones: '', cerrada: false },
  { id: 4, nombre: 'Solicitud P2_191 TPSISTAR cerrada', informe_semanal: false, encargados: [], horas: null, pend_plan: false, pend_actualizar: false, plan_enviado: false, cierre_enviado: true, cierra: '2026-01-23', observaciones: '', cerrada: true },
];
function resetData(empty = false) {
  vistas = {};
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
        rows.push({ id: nextId(rows), active: true, ...item, ...(name === 'solicitudes' ? solStampNew(item, me) : {}) });
      }
    }
    return r201(json);
  }
  const target = lead ? rows.filter(match) : [];   // el RLS filtra: 0 filas, sin error
  // Igual que el trigger solicitudes_touch: registra quién y cuándo.
  const stamp = name === 'solicitudes' ? { updated_by: me.id, updated_at: new Date().toISOString() } : {};
  if (method === 'PATCH') target.forEach((r) => { const plan = name === 'solicitudes' && body.plan_enviado && !r.plan_enviado; Object.assign(r, body, stamp); if (plan) Object.assign(r, { plan_enviado_at: new Date().toISOString(), plan_enviado_by: me.id }); });
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
// Igual que el trigger solicitudes_touch (20261025000001_solicitudes_avisos.sql): autor y plan enviado.
function solStampNew(item, me) {
  const now = new Date().toISOString();
  return { updated_by: me.id, updated_at: now, created_at: now, created_by: me.id, ...(item.plan_enviado ? { plan_enviado_at: now, plan_enviado_by: me.id } : {}) };
}
// Igual que solicitudes_avisos() (20261026000001_solicitudes_avisos_lista.sql).
function solAvisos(me) {
  const desde = new Date(Date.now() - 7 * 864e5).toISOString(), visto = vistas[me.id];
  const nombre = (id) => byId(id)?.[1].full_name ?? null;
  const ev = [];
  for (const s of tables.solicitudes) {
    if (s.created_by && s.created_by !== me.id && s.created_at > desde) ev.push({ solicitud_id: s.id, nombre: s.nombre, tipo: 'nueva', autor: nombre(s.created_by), fecha: s.created_at });
    if (s.plan_enviado && s.plan_enviado_by && s.plan_enviado_by !== me.id && s.plan_enviado_at > desde) ev.push({ solicitud_id: s.id, nombre: s.nombre, tipo: 'plan', autor: nombre(s.plan_enviado_by), fecha: s.plan_enviado_at });
  }
  return ev.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.solicitud_id - a.solicitud_id).slice(0, 10).map((e) => ({ ...e, sin_ver: !!visto && e.fecha > visto }));
}
// Igual que solicitudes_novedades(): lo que otros crearon o pasaron a plan enviado desde tu último visto.
function solNovedades(me) {
  vistas[me.id] ??= new Date().toISOString();
  const v = vistas[me.id];
  return tables.solicitudes.filter((s) => (s.created_by && s.created_by !== me.id && s.created_at > v)
    || (s.plan_enviado_by && s.plan_enviado_by !== me.id && s.plan_enviado_at > v)).length;
}

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
  // Igual que el trigger horas_cierre: un QA no toca semanas anteriores a las dos últimas.
  const openFrom = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7 - 14); return d.toLocaleDateString('en-CA'); })();
  const closed = (r) => !isLead(me) && r.fecha < openFrom;
  const closedError = () => json(400, { code: 'P0001', message: 'Esa semana está cerrada: solo podés cambiar horas desde el ' + openFrom.split('-').reverse().join('/') + '. Para corregir una semana anterior, pedíselo a un QA Lead.' });
  const stamp = (r) => Object.assign(r, { updated_by: me.id, updated_at: new Date().toISOString() }, r.tipo !== 'TRABAJO' ? { facturable: 0 } : {});
  if (method === 'POST') {
    const r = stamp({ id: Math.max(0, ...tables.horas.map((x) => x.id)) + 1, user_id: me?.id, tipo: 'TRABAJO', soli: '', tarea: '', facturable: 0, ...body });
    if (!ownOrLead(me, r)) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "horas"' });
    if (checkRow(r)) return json(400, { code: '23514', message: 'violates check constraint ' + checkRow(r) });
    if (closed(r)) return closedError();
    tables.horas.push(r);
    return json(201, [{ ...r }]);
  }
  if (method === 'PATCH') {
    if ('user_id' in body) return json(403, { code: '42501', message: 'permission denied for table horas' });
    for (const r of visible) { const n = stamp({ ...r, ...body }); if (checkRow(n)) return json(400, { code: '23514', message: 'check' }); if (closed(r) || closed(n)) return closedError(); }
    visible.forEach((r) => stamp(Object.assign(r, body)));
    return json(200, visible.map((r) => ({ ...r })));
  }
  if (method === 'DELETE') { if (visible.some(closed)) return closedError(); tables.horas = tables.horas.filter((r) => !visible.includes(r)); return json(200, visible.map((r) => ({ id: r.id }))); }
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
    const path = new URL(url).pathname;
    if (path === '/index.html') return r.fulfill({ contentType: 'text/html', body: configured });
    if (path === '/sin-config.html') return r.fulfill({ contentType: 'text/html', body: unconfigured });
    if (path === '/js/config.js') return r.fulfill({ contentType: TYPES.js, body: configJs });
    if (path === '/js/sin-config.js') return r.fulfill({ contentType: TYPES.js, body: emptyConfigJs });
    if (STATIC.test(path)) return r.fulfill({ contentType: TYPES[path.split('.').pop()], body: readFileSync(DIR + path.slice(1)) });
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
    // Como private.app_role(): con la contraseña temporal solo se lee el propio perfil.
    if (url.pathname.startsWith('/rest/v1/') && url.pathname !== '/rest/v1/profiles' && byId(subOf(req))?.[1].must_change_password) {
      tempCalls.push(url.pathname);
      return json(403, { code: '42501', message: 'permission denied' });
    }

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
        // Quien tiene horas no se elimina (FK on delete restrict).
        if (tables.horas.some((h) => h.user_id === b.id) || tables.horas_ajustes.some((a) => a.user_id === b.id)) {
          return json(409, { error: 'Tiene horas registradas: no se elimina para no cambiar los informes. Para que no entre más, desmarcá "Activo".' });
        }
        delete users[t[0]];
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
    if (url.pathname === '/rest/v1/rpc/solicitudes_avisos') {
      const me = byId(subOf(req))?.[1];
      if (!isLead(me)) return json(403, { code: '42501', message: 'Sin permiso' });
      if (failAvisos) return json(500, { code: 'XX000', message: 'falla simulada' });
      return json(200, solAvisos(me));
    }
    if (url.pathname === '/rest/v1/rpc/solicitudes_novedades' || url.pathname === '/rest/v1/rpc/solicitudes_marcar_visto') {
      const me = byId(subOf(req))?.[1];
      if (!isLead(me)) { rpcCalls.denied = (rpcCalls.denied || 0) + 1; return json(403, { code: '42501', message: 'Sin permiso' }); }
      if (url.pathname.endsWith('novedades')) { rpcCalls.novedades++; const n = solNovedades(me); if (delayNovedades) await new Promise((r) => setTimeout(r, delayNovedades)); return json(200, n); }
      rpcCalls.marcarVisto++;
      if (rejectNextVisto) { rejectNextVisto = false; return json(500, { code: 'XX000', message: 'falla simulada' }); }
      const antes = vistas[me.id] ?? new Date().toISOString();
      vistas[me.id] = new Date().toISOString();
      return json(200, antes);
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
const dialogs = [];   // título y mensaje de cada diálogo de la app
const answers = [];   // respuestas en orden: string para pedir texto, false para cancelar

// Los avisos de error no frenan la página: se espera a que aparezca el último.
async function waitDialog(re) {
  for (let i = 0; i < 100 && !re.test(dialogs.at(-1) ?? ''); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(dialogs.at(-1) ?? '', re, dialogs.join(' | '));
}
async function newPage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  await setup(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // La app no usa alert/confirm/prompt: si aparece uno del navegador, es un error.
  page.on('dialog', (d) => { errors.push('diálogo del navegador: ' + d.message()); d.dismiss(); });
  // Su diálogo (#ui-dialog) se responde con sus propios botones, en el orden de answers.
  await page.exposeFunction('__uiAnswer', (msg) => { dialogs.push(msg); const a = answers.shift(); return a === undefined ? true : a; });
  await page.addInitScript(() => {
    new MutationObserver(async () => {
      const d = document.getElementById('ui-dialog');
      if (!d || !d.open || d.dataset.test || window.__manualDialog) return;
      d.dataset.test = '1';
      const title = document.getElementById('ui-title').textContent;
      const a = await window.__uiAnswer([title, document.getElementById('ui-msg').textContent].filter(Boolean).join(' · '));
      if (typeof a === 'string') document.getElementById('ui-input').value = a;
      document.getElementById(a === false ? 'ui-cancel' : 'ui-ok').click();
      delete d.dataset.test;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
  });
  page.on('console', (m) => { if (/Content Security Policy|integrity|Acción desconocida/i.test(m.text())) errors.push(m.text()); });
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
  // click y no uncheck: la app vuelve a marcar la casilla al fallar, y uncheck reintentaría el clic
  // (el segundo cambio ya no se rechaza y se guarda).
  await qaRow.locator('input[type=checkbox]').click();
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
  await waitDialog(/No tenés permiso/);
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
  await waitDialog(/Ya existe un registro con ese nombre/);
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
  // Primer ingreso: el diálogo se abre solo, antes de cargar la app, sin "Cancelar", y Escape no lo cierra.
  await c2.page.waitForSelector('#pw-dialog[open]');
  assert.equal(await c2.page.isVisible('.layout'), false);
  await c2.page.screenshot({ path: DIR + 'tests/shot-temporal.png' });
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
  // Con la contraseña nueva entra y carga los datos; antes no pidió nada más que su perfil.
  await c2.page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await c2.page.textContent('#sidebar-user-role'), 'QA Lead');
  await c2.page.waitForSelector('#project-grid .proj-btn', { state: 'attached' });
  assert.deepEqual(tempCalls, []);
  ok('primer ingreso: obliga a cambiar la contraseña temporal antes de cargar la app (sin Cancelar ni Escape)');
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

  // Historial: guardar el daily de hoy (ausente + uno que habló) y verlo en su pestaña.
  assert.equal(await page.isVisible('#dly-hist'), false, 'el historial está en otra pestaña');
  await page.click('#dly-tab-hist');
  await page.waitForSelector('#dly-hist-body .sol-empty');
  assert.match(await page.textContent('#dly-hist-body'), /No hay dailies guardados este mes/);
  assert.equal(await page.inputValue('#dly-mode'), 'month', 'abre en Mes');
  await page.click('#dly-tab-hoy');
  assert.equal(await page.isVisible('#rollBtn'), true);
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
  await page.click('#dly-save-status .status-link');
  assert.equal(await page.getAttribute('#dly-tab-hist', 'aria-selected'), 'true');
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
  // Semana: solo las tarjetas de cada día.
  await page.selectOption('#dly-mode', 'week');
  await page.waitForFunction(() => document.getElementById('dly-hist-month').textContent.startsWith('Semana del'));
  await page.waitForSelector('#dly-hist-body .dly-day');
  assert.equal(await page.locator('#dly-hist-body table').count(), 0);
  assert.equal(await page.getAttribute('#dly-prev', 'aria-label'), 'Semana anterior');
  await page.selectOption('#dly-mode', 'month');
  await page.waitForSelector('#dly-hist-body table');
  ok('Daily: guarda el daily de hoy (orden, quién habló y quién no asistió) y lo muestra en la pestaña Historial, por semana o mes');
  await page.click('#dly-tab-hoy');

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
  await page.click('#dly-tab-hist');
  await page.click('[aria-label="Mes anterior"]');
  await page.waitForSelector('#dly-hist-body .sol-empty');
  await page.click('#dtab2');
  await page.waitForFunction(() => document.getElementById('dly-hist-title').textContent === 'Historial del Daily 2');
  await page.click('#dly-tab-hoy');
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
  await page.click('.sol-toolbar button:has-text("Informes semanales")');
  await page.waitForSelector('#inf-dialog[open]');
  const inf = await page.locator('#inf-table tbody tr').evaluateAll((trs) => trs.map((t) => [...t.cells].map((c) => c.textContent)));
  assert.deepEqual(inf.map((r) => r.join(' | ')).sort(), [
    'QA_OPC_47 Proyecto Digitalizacion | N/A | N/A',
    'Solicitud P3_070 Tucan vencida | N/A | N/A',
    'Solicitud P3_081 Gobierno <b>Digital</b> | Sí | Beto Uno',
  ]);
  assert.equal(await page.locator('#inf-table b').count(), 0, 'los nombres se escapan');
  assert.match(await page.textContent('#inf-sub'), /abiertas .*: 3, 1 con informe semanal/);
  assert.match(await page.textContent('#inf-msg'), /enviarlo a las 4:30 pm[\s\S]*lo envían a las 4:50 pm/);
  await page.fill('#inf-h1', '15:15');
  assert.match(await page.textContent('#inf-msg'), /enviarlo a las 3:15 pm/);
  await page.click('#inf-dialog button:has-text("Cerrar")');
  ok('Solicitudes: mensaje de informes semanales con las horas y la lista de abiertas (N/A si no aplica)');

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


  // Popup de nueva solicitud: solo el nombre es obligatorio; el estado es un combo.
  await page.click('#sol-new-open');
  await page.waitForSelector('#sol-new-dialog[open]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sol-new-name');
  assert.equal(await page.inputValue('#sol-new-estado'), 'pend_plan');
  assert.deepEqual(await page.locator('#sol-new-estado option').allTextContents(), ['Pendiente de plan', 'Plan enviado', 'Pendiente de actualizar', 'Sin estado']);
  assert.equal(await page.isVisible('#sol-new-enc-field'), false, 'los encargados solo aparecen con informe semanal');
  let solWrites = writes.length;
  await page.click('#sol-new-btn');
  await page.waitForSelector('#sol-new-status.error:has-text("Escribí el nombre")');
  assert.equal(await page.getAttribute('#sol-new-name', 'aria-invalid'), 'true');
  assert.equal(writes.length, solWrites, 'sin nombre no guarda');
  await page.fill('#sol-new-name', '  Solicitud   P3_090 Nueva <i>x</i> ');
  await page.selectOption('#sol-new-estado', 'plan_enviado');
  await page.fill('#sol-new-horas', '6.5');
  await page.fill('#sol-new-cierra', '2026-11-20');
  await page.check('#sol-new-informe');
  await page.waitForSelector('#sol-new-enc-field:not([hidden])');
  await page.selectOption('#sol-new-enc select', 'Beto Uno');
  await page.selectOption('#sol-new-enc select', 'Caro Dos');
  await page.click('#sol-new-enc .sol-chip:has-text("Caro Dos") button');
  assert.deepEqual(await page.locator('#sol-new-enc .sol-chip').allTextContents(), ['Beto Uno×']);
  await page.fill('#sol-new-obs', 'Entra el lunes');
  await page.screenshot({ path: DIR + 'tests/shot-sol-nueva.png' });
  await page.click('#sol-new-btn');
  await page.waitForSelector('#sol-status.ok');
  assert.equal(await page.isVisible('#sol-new-dialog'), false);
  const nueva = tables.solicitudes.find((s) => s.nombre === 'Solicitud P3_090 Nueva <i>x</i>');
  assert.deepEqual([nueva.pend_plan, nueva.plan_enviado, nueva.pend_actualizar, nueva.horas, nueva.cierra, nueva.informe_semanal, nueva.encargados, nueva.observaciones],
    [false, true, false, 6.5, '2026-11-20', true, ['Beto Uno'], 'Entra el lunes']);
  assert.equal(await page.locator('#sol-body .sol-name').evaluateAll((els) => els.some((e) => e.value === 'Solicitud P3_090 Nueva <i>x</i>')), true);
  ok('Solicitudes: el popup agrega una nueva con estado (combo), horas, fecha, informe con encargados y notas');

  // Mismo código que una existente (P3_081 = P3_81): pregunta antes de agregar.
  await page.click('#sol-new-open');
  await page.waitForSelector('#sol-new-dialog[open]');
  assert.equal(await page.inputValue('#sol-new-name'), '', 'cada vez arranca vacío');
  assert.equal(await page.isChecked('#sol-new-informe'), false);
  await page.fill('#sol-new-name', 'Otra Solicitud P3_81');
  answers.push(false);
  solWrites = writes.length;
  await page.click('#sol-new-btn');
  await until(page, () => document.activeElement?.id === 'sol-new-name');
  assert.equal(dialogs[dialogs.length - 1], 'Ya hay una solicitud con ese código · Solicitud P3_081 Renombrada (cerrada)');
  assert.equal(writes.length, solWrites, 'si cancela no guarda');
  await page.selectOption('#sol-new-estado', '');
  answers.push(true);
  await page.click('#sol-new-btn');
  await page.waitForSelector('#sol-new-dialog', { state: 'hidden' });
  const otra = tables.solicitudes.find((s) => s.nombre === 'Otra Solicitud P3_81');
  assert.deepEqual([otra.pend_plan, otra.plan_enviado, otra.pend_actualizar, otra.horas, otra.cierra, otra.informe_semanal, otra.encargados], [false, false, false, null, null, false, []]);
  ok('Solicitudes: avisa si ya hay una con el mismo código; "Sin estado" no marca ninguna casilla');

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

// 19b. Avisos de solicitudes: cada QA Lead y Admin ve cuántas novedades hay desde su última visita
{
  const adm = await newPage();
  const lead = await newPage();
  const admId = users['admin@bcr.test'].id;
  vistas = {}; // las secciones anteriores dejaron novedades: se arranca de cero
  await adm.page.goto('http://app.test/index.html');
  await login(adm.page, 'admin@bcr.test');
  await adm.page.waitForSelector('.layout', { state: 'visible' });
  await adm.page.click('#nav-daily');
  await until(adm.page, () => document.getElementById('sol-badge') !== null);
  assert.equal(await adm.page.isVisible('#sol-badge'), false, 'sin novedades no hay contador');
  // El ADMIN vio Solicitudes justo antes de que el lead cree una.
  vistas[admId] = new Date().toISOString();

  await lead.page.goto('http://app.test/index.html');
  await login(lead.page, 'lead@bcr.test');
  await lead.page.waitForSelector('.layout', { state: 'visible' });
  await lead.page.click('#home-solicitudes');
  await lead.page.waitForSelector('#sol-body tr');
  await lead.page.click('#sol-new-open');
  await lead.page.waitForSelector('#sol-new-dialog[open]');
  await lead.page.fill('#sol-new-name', 'Solicitud P3_300 Aviso');
  await lead.page.click('#sol-new-btn');
  await lead.page.waitForSelector('#sol-new-dialog', { state: 'hidden' });
  const fila = tables.solicitudes.find((s) => s.nombre === 'Solicitud P3_300 Aviso');
  assert.equal(fila.created_by, users['lead@bcr.test'].id);
  rtPush('INSERT', { ...fila });
  await adm.page.waitForSelector('#sol-badge:not([hidden])');
  assert.equal(await adm.page.textContent('#sol-badge'), '1');
  // El número es parte del nombre del botón (un aria-label en un span no lo lee el lector de pantalla).
  assert.equal(await adm.page.getAttribute('#nav-solicitudes', 'aria-label'), 'Solicitudes, 1 novedad');
  assert.equal(await adm.page.getAttribute('#mnav-solicitudes', 'aria-label'), 'Solicitudes, 1 novedad');
  assert.equal(await adm.page.getAttribute('#sol-badge', 'aria-hidden'), 'true');
  assert.equal(await adm.page.textContent('#msol-badge'), '1');
  assert.equal(await adm.page.getAttribute('#msol-badge', 'hidden'), null);
  assert.equal(await lead.page.isVisible('#sol-badge'), false, 'el autor no ve su propio aviso');
  await adm.page.screenshot({ path: DIR + 'tests/shot-sol-aviso.png' });
  await adm.page.emulateMedia({ colorScheme: 'dark' });
  await adm.page.screenshot({ path: DIR + 'tests/shot-sol-aviso-oscuro.png' });
  await adm.page.emulateMedia({ colorScheme: 'light' });

  // Una ráfaga de cambios en vivo se junta en una sola consulta por pestaña.
  await new Promise((r) => setTimeout(r, 500));
  const antes = rpcCalls.novedades;
  for (let i = 0; i < 5; i++) rtPush('UPDATE', { ...fila, observaciones: 'r' + i }, { id: fila.id });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(rpcCalls.novedades - antes <= 2, 'consultas por la ráfaga: ' + (rpcCalls.novedades - antes));
  assert.equal(await adm.page.textContent('#sol-badge'), '1');
  ok('Solicitudes: los demás QA Lead y Admin ven el contador de novedades en vivo; el autor no');

  // Al abrir Solicitudes se marcan las novedades y el contador vuelve a cero.
  const tag = (pg, id) => pg.locator(`#sol-body tr[data-id="${id}"] .sol-new`);
  await adm.page.click('#nav-solicitudes');
  await adm.page.waitForSelector(`#sol-body tr[data-id="${fila.id}"] .sol-new:not([hidden])`);
  assert.equal(await tag(adm.page, fila.id).textContent(), 'Nueva');
  assert.equal(await adm.page.isVisible('#sol-badge'), false);
  assert.equal(await adm.page.locator('#sol-body .sol-new:not([hidden])').count(), 1, 'solo lo nuevo lleva etiqueta');
  assert.equal(await adm.page.getAttribute('#nav-solicitudes', 'aria-label'), null, 'sin novedades el botón se llama Solicitudes');
  await adm.page.screenshot({ path: DIR + 'tests/shot-sol-etiqueta.png' });
  await adm.page.emulateMedia({ colorScheme: 'dark' });
  await adm.page.screenshot({ path: DIR + 'tests/shot-sol-etiqueta-oscuro.png' });
  await adm.page.emulateMedia({ colorScheme: 'light' });
  // Mientras está en la pantalla, lo que llega en vivo se etiqueta y no sube el contador.
  const vistos = rpcCalls.marcarVisto;
  // Una abierta, sin plan enviado y de antes (sin autor).
  const sol3 = tables.solicitudes.find((s) => !s.cerrada && !s.plan_enviado && !s.created_by);
  await lead.page.locator(`#sol-body tr[data-id="${sol3.id}"] input[aria-label="Plan enviado"]`).check();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sol3.plan_enviado_by, users['lead@bcr.test'].id);
  rtPush('UPDATE', { ...sol3 }, { id: sol3.id });
  await adm.page.waitForSelector(`#sol-body tr[data-id="${sol3.id}"] .sol-new:not([hidden])`);
  assert.equal(await tag(adm.page, sol3.id).textContent(), 'Plan enviado');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await adm.page.isVisible('#sol-badge'), false);
  assert.ok(rpcCalls.marcarVisto > vistos, 'vuelve a marcar visto');
  // Segunda visita sin novedades: no queda ninguna etiqueta.
  await adm.page.click('#nav-daily');
  await adm.page.click('#nav-solicitudes');
  await until(adm.page, () => document.querySelectorAll('#sol-body tr').length > 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await adm.page.locator('#sol-body .sol-new:not([hidden])').count(), 0);
  ok('Solicitudes: al abrir se marcan las novedades («Nueva», «Plan enviado») y el contador vuelve a cero');

  // Si no se puede marcar visto, la pantalla carga igual, sin etiquetas, y el contador sigue.
  await adm.page.click('#nav-daily');
  tables.solicitudes.push({ ...fila, id: 301, nombre: 'Solicitud P3_301 Otra', created_at: new Date().toISOString() });
  rtPush('INSERT', tables.solicitudes.at(-1));
  await adm.page.waitForSelector('#sol-badge:not([hidden])');
  rejectNextVisto = true;
  await adm.page.click('#nav-solicitudes');
  await adm.page.waitForSelector('#sol-body tr[data-id="301"]');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await adm.page.locator('#sol-body .sol-new:not([hidden])').count(), 0);
  assert.equal(await adm.page.textContent('#sol-badge'), '1');
  ok('Solicitudes: si no se puede marcar visto, la lista carga igual y el contador queda como estaba');

  // Una respuesta atrasada del contador no lo vuelve a encender después de abrir Solicitudes.
  await adm.page.click('#nav-daily');
  tables.solicitudes.push({ ...fila, id: 302, nombre: 'Solicitud P3_302 Atrasada', created_at: new Date().toISOString() });
  delayNovedades = 1500;
  rtPush('INSERT', tables.solicitudes.at(-1));
  await new Promise((r) => setTimeout(r, 500));
  await adm.page.click('#nav-solicitudes');
  await adm.page.waitForSelector('#sol-body tr[data-id="302"]');
  await new Promise((r) => setTimeout(r, 2000));
  delayNovedades = 0;
  assert.equal(await adm.page.isVisible('#sol-badge'), false, 'la respuesta vieja encendió el contador');
  ok('Solicitudes: una respuesta atrasada del contador no lo enciende con la pantalla abierta');

  // Si se corta el tiempo real, al reconectar se vuelve a pedir el contador (lo de mientras no llega en vivo).
  await adm.page.click('#nav-daily');
  tables.solicitudes.push({ ...fila, id: 303, nombre: 'Solicitud P3_303 Sin conexión', created_at: new Date().toISOString() });
  for (const s of [...rtSockets]) await s.ws.close();
  await adm.page.waitForSelector('#sol-badge:not([hidden])', { timeout: 15000 });
  assert.equal(await adm.page.textContent('#sol-badge'), '1');
  ok('Solicitudes: al reconectarse el tiempo real, el contador se pone al día');

  // Cierra sesión y entra un QA en la misma pestaña: ni contador ni canal del anterior.
  const negadas = rpcCalls.denied || 0;
  await adm.page.evaluate(() => logout());
  await adm.page.waitForSelector('#auth-email', { state: 'visible' });
  await login(adm.page, 'qa@bcr.test');
  await adm.page.waitForSelector('.layout', { state: 'visible' });
  rtPush('UPDATE', { ...fila, observaciones: 'otra' }, { id: fila.id });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await adm.page.isVisible('#sol-badge'), false);
  assert.equal(await adm.page.evaluate(() => solChannel), null);
  assert.equal(rpcCalls.denied || 0, negadas, 'con QA no se pide el contador');
  ok('Solicitudes: QA no tiene contador ni canal, aunque antes hubiera entrado un ADMIN en la misma pestaña');
  await adm.context.close();
  await lead.context.close();

  // En el celular el contador va en el menú de arriba.
  const mob = await newPage({ width: 375, height: 812 });
  vistas[admId] = new Date(Date.parse(fila.created_at) - 1000).toISOString();
  await mob.page.goto('http://app.test/index.html');
  await login(mob.page, 'admin@bcr.test');
  await mob.page.waitForSelector('#msol-badge:not([hidden])');
  assert.ok(await mob.page.isVisible('#msol-badge'));
  const overflow = await mob.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal con el contador en móvil: ' + overflow);
  await mob.page.locator('#mnav-solicitudes').scrollIntoViewIfNeeded();
  await mob.page.screenshot({ path: DIR + 'tests/shot-sol-aviso-movil.png' });
  ok('Solicitudes en móvil: el contador se ve en el menú de arriba sin desbordar');
  await mob.context.close();
}

// 19c. Campana de avisos: la lista de qué se agregó o pasó a plan enviado
{
  const adm = await newPage();
  const lead = await newPage();
  const admId = users['admin@bcr.test'].id;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  vistas = {};
  await adm.page.goto('http://app.test/index.html');
  await login(adm.page, 'admin@bcr.test');
  await adm.page.waitForSelector('.layout', { state: 'visible' });
  await adm.page.click('#nav-daily');
  while (!vistas[admId]) await wait(50);
  await wait(20);

  await lead.page.goto('http://app.test/index.html');
  await login(lead.page, 'lead@bcr.test');
  await lead.page.waitForSelector('.layout', { state: 'visible' });
  await lead.page.click('#home-solicitudes');
  await lead.page.waitForSelector('#sol-body tr');
  await lead.page.click('#sol-new-open');
  await lead.page.waitForSelector('#sol-new-dialog[open]');
  await lead.page.fill('#sol-new-name', 'Solicitud P3_400 <b>Campana</b>');
  await lead.page.selectOption('#sol-new-estado', '');
  await lead.page.click('#sol-new-btn');
  await lead.page.waitForSelector('#sol-new-dialog', { state: 'hidden' });
  const fila = tables.solicitudes.find((s) => s.nombre === 'Solicitud P3_400 <b>Campana</b>');
  rtPush('INSERT', { ...fila });
  await adm.page.waitForSelector('#avisos-btn .nav-count:not([hidden])');
  assert.equal(await adm.page.textContent('#avisos-btn .nav-count'), '1');
  assert.equal(await adm.page.getAttribute('#avisos-btn', 'aria-label'), 'Avisos, 1 sin ver');

  const items = () => adm.page.locator('#avisos-list .aviso');
  await adm.page.click('#avisos-btn');
  await adm.page.waitForSelector('#avisos-panel[open] .aviso');
  assert.equal(await items().first().locator('.aviso-txt').textContent(), 'Laura Lead creó Solicitud P3_400 <b>Campana</b>');
  assert.equal(await adm.page.locator('#avisos-panel b').count(), 0, 'el nombre se ve como texto');
  assert.equal(await items().first().getAttribute('class'), 'aviso aviso-nuevo');
  assert.equal(await adm.page.evaluate(() => document.activeElement.classList.contains('aviso')), true, 'el foco va al primer aviso');
  assert.equal(await adm.page.isVisible('#sol-badge'), false);
  assert.equal(await adm.page.isVisible('#avisos-btn .nav-count'), false);
  assert.equal(await adm.page.getAttribute('#avisos-btn', 'aria-expanded'), 'true');
  await adm.page.screenshot({ path: DIR + 'tests/shot-avisos.png' });
  await adm.page.emulateMedia({ colorScheme: 'dark' });
  await adm.page.screenshot({ path: DIR + 'tests/shot-avisos-oscuro.png' });
  await adm.page.emulateMedia({ colorScheme: 'light' });
  await adm.page.keyboard.press('Escape');
  await adm.page.waitForSelector('#avisos-panel', { state: 'hidden' });
  assert.equal(await adm.page.evaluate(() => document.activeElement.id), 'avisos-btn');
  assert.equal(await adm.page.getAttribute('#avisos-btn', 'aria-label'), 'Avisos');
  assert.equal(await adm.page.getAttribute('#avisos-btn', 'aria-expanded'), 'false');
  await adm.page.click('#avisos-btn');
  await adm.page.waitForSelector('#avisos-panel[open] .aviso');
  assert.equal(await adm.page.locator('#avisos-list .aviso-nuevo').count(), 0, 'la segunda vez ya está visto');
  ok('Campana: muestra quién agregó qué, resalta lo nuevo, marca visto y se cierra con Esc');

  // Con el panel abierto, lo que llega en vivo aparece arriba.
  const sol = tables.solicitudes.find((s) => !s.cerrada && !s.plan_enviado && s.id !== fila.id);
  await lead.page.locator(`#sol-body tr[data-id="${sol.id}"] input[aria-label="Plan enviado"]`).check();
  while (!sol.plan_enviado_by) await wait(50);
  rtPush('UPDATE', { ...sol }, { id: sol.id });
  await until(adm.page, (t) => document.querySelector('#avisos-list .aviso-txt')?.textContent === t, `Laura Lead pasó ${sol.nombre} a Plan enviado`);
  ok('Campana: con el panel abierto, lo que llega en vivo aparece arriba');

  // Ir a una solicitud cerrada con el filtro en "Abiertas": cambia a "Todas" y resalta la fila.
  fila.cerrada = true; fila.cierre_enviado = true;
  await adm.page.locator('#avisos-list .aviso', { hasText: 'P3_400' }).click();
  await adm.page.waitForSelector(`#sol-body tr[data-id="${fila.id}"].sol-flash`);
  assert.equal(await adm.page.isVisible('#page-solicitudes'), true);
  assert.equal(await adm.page.inputValue('#sol-filter'), 'all');
  assert.equal(await adm.page.isVisible('#avisos-panel'), false);
  // Una que ya no existe: avisa.
  await adm.page.click('#avisos-btn');
  await adm.page.waitForSelector('#avisos-panel[open] .aviso');
  tables.solicitudes = tables.solicitudes.filter((s) => s.id !== sol.id);
  await adm.page.locator('#avisos-list .aviso', { hasText: `pasó ${sol.nombre} a Plan enviado` }).click();
  while (!dialogs.includes('Esa solicitud ya no existe.')) await wait(50);
  ok('Campana: tocar un aviso lleva a la solicitud (aunque esté cerrada) o avisa si ya no existe');

  // Si falla la carga, se puede reintentar; cambiar de pantalla cierra el panel.
  failAvisos = true;
  await adm.page.click('#avisos-btn');
  await adm.page.waitForSelector('#avisos-panel[open] .avisos-error');
  assert.equal(await adm.page.textContent('#avisos-panel .avisos-error span'), 'No se pudieron cargar los avisos.');
  failAvisos = false;
  await adm.page.click('#avisos-panel .avisos-error button');
  await adm.page.waitForSelector('#avisos-panel[open] .aviso');
  await adm.page.click('#nav-daily');
  await adm.page.waitForSelector('#avisos-panel', { state: 'hidden' });
  ok('Campana: si falla la carga se puede reintentar; cambiar de pantalla cierra el panel');
  await adm.context.close();
  await lead.context.close();

  // En el celular: la campana arriba y el panel sin desbordar.
  const mob = await newPage({ width: 375, height: 812 });
  await mob.page.goto('http://app.test/index.html');
  await login(mob.page, 'admin@bcr.test');
  await mob.page.waitForSelector('#mavisos-btn', { state: 'visible' });
  await mob.page.click('#mavisos-btn');
  await mob.page.waitForSelector('#avisos-panel[open] .aviso');
  const overflow = await mob.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal con el panel abierto en móvil: ' + overflow);
  const box = await mob.page.locator('#avisos-panel').boundingBox();
  assert.ok(box.x >= 15 && box.x + box.width <= 360, 'el panel queda dentro de la pantalla: ' + JSON.stringify(box));
  await mob.page.screenshot({ path: DIR + 'tests/shot-avisos-movil.png' });
  ok('Campana en móvil: arriba, con el panel dentro de la pantalla');
  await mob.context.close();

  const qa = await newPage();
  await qa.page.goto('http://app.test/index.html');
  await login(qa.page, 'qa@bcr.test');
  await qa.page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await qa.page.isVisible('#avisos-btn'), false);
  assert.equal(await qa.page.locator('#mavisos-btn').getAttribute('hidden'), '');
  ok('Campana: QA no la ve');
  await qa.context.close();
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

  // Semana cerrada: hace tres semanas el QA ve sus líneas, pero no las puede cambiar.
  const viejo = new Date(); viejo.setDate(viejo.getDate() - (viejo.getDay() + 6) % 7 - 21);
  const viejoIso = viejo.toLocaleDateString('en-CA');
  tables.horas.push({ id: 950, user_id: ids.qa, fecha: viejoIso, tipo: 'TRABAJO', soli: 'P3_9', tarea: 'Semana vieja', horas: 8, facturable: 8 });
  for (let i = 0; i < 3; i++) await page.click('button[aria-label="Semana anterior"]');
  await page.waitForSelector('#hrs-status.info:has-text("Semana cerrada")');
  const oldLine = page.locator(`#hrs-days .hrs-day[data-date="${viejoIso}"] .hrs-line`);
  assert.equal(await oldLine.locator('[data-f=horas]').isDisabled(), true);
  assert.equal(await oldLine.locator('.sol-del').isVisible(), false);
  assert.equal(await page.locator('#hrs-days button:has-text("Agregar línea")').count(), 0);
  // La base lo rechaza aunque se salte la pantalla.
  const forced = await page.evaluate(async (id) => (await supabaseClient.from('horas').update({ tarea: 'Cambiada' }).eq('id', id).select('*')).error?.message, 950);
  assert.match(forced, /Esa semana está cerrada/);
  assert.equal(tables.horas.find((h) => h.id === 950).tarea, 'Semana vieja');
  await page.click('button[aria-label="Semana siguiente"]');
  await page.waitForSelector('#hrs-days button:has-text("Agregar línea")');
  assert.equal(await page.locator('#hrs-status.info').count(), 0);
  await page.click('button:has-text("Esta semana")');
  ok('Horas (QA): semanas anteriores a las dos últimas quedan cerradas (solo lectura, y la base lo rechaza)');

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
  // La tabla anterior (antes de la corrección) sigue visible mientras recarga: esperar el dato nuevo.
  await until(page, () => [...document.querySelectorAll('#hrs-report-tables tbody tr')].find((tr) => tr.textContent.includes('Quique'))?.cells[2].textContent === '6.5');
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
  // has-text no distingue mayúsculas: "Octubre" ya calzaba con "Semana … de octubre" de la tabla anterior.
  await until(page, () => { const c = [...document.querySelectorAll('#hrs-report-tables caption')]; return c.length > 0 && !c.some((x) => x.textContent.startsWith('Semana')); });
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
  await waitDialog(/No tenés permiso/);
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
  await qbox.click(); // click y no uncheck: ver "ADMIN: si Supabase rechaza el cambio"
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
  assert.match(dialogs.at(-1), /Si tiene horas registradas no se elimina/);
  answers.push(true);
  await del.click();
  await page.waitForSelector('#users-status.error:has-text("Tiene horas registradas")');
  assert.ok(users['borrar@bcr.test'], 'con horas no se elimina');
  assert.equal(tables.horas.some((h) => h.id === 900), true, 'sus horas se conservan');
  ok('ADMIN: no elimina a quien tiene horas (se conservan para los informes)');
  tables.horas = tables.horas.filter((h) => h.id !== 900);
  answers.push(true);
  await del.click();
  await page.waitForSelector('#users-status.ok:has-text("Bruno Borrar fue eliminado")');
  await until(page, () => !document.querySelector('#list-users').textContent.includes('Bruno Borrar'));
  assert.equal(users['borrar@bcr.test'], undefined);
  ok('ADMIN: elimina un usuario sin horas (con confirmación; no a sí mismo)');
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

// BETA: solo Generar tareas, Daily y Días hábiles
{
  users['beta@bcr.test'] = { id: 'a0000000-0000-4000-8000-000000000077', password: 'pw', full_name: 'Bea Beta', role: 'BETA', active: true };
  const { context, page } = await newPage();
  const horasReqs = [];
  page.on('request', (r) => { if (/\/rest\/v1\/(horas|solicitudes|rpc\/horas_resumen)/.test(r.url())) horasReqs.push(r.url()); });
  await page.goto('http://app.test/index.html');
  await login(page, 'beta@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await page.textContent('#sidebar-user-role'), 'Beta');
  for (const id of ['nav-horas', 'nav-solicitudes', 'nav-admin', 'home-horas', 'home-solicitudes']) assert.equal(await page.isVisible('#' + id), false, id + ' visible para BETA');
  for (const id of ['nav-qa', 'nav-daily', 'nav-calc']) assert.equal(await page.isVisible('#' + id), true, id + ' oculto para BETA');
  await page.evaluate(() => showPage('horas'));
  assert.equal(await page.isVisible('#page-home'), true, 'BETA no entra a Horas aunque lo pida');
  await page.click('#nav-daily');
  await page.waitForSelector('#rollBtn');
  await page.click('#nav-calc');
  assert.equal(await page.isVisible('#page-calc'), true);
  assert.deepEqual(horasReqs, [], 'BETA no pide horas ni solicitudes');
  ok('BETA: ve solo Generar tareas, Daily y Días hábiles; no entra a Horas ni pide sus datos');
  await context.close();
  const adm = await newPage();
  await adm.page.goto('http://app.test/index.html');
  await login(adm.page, 'admin@bcr.test');
  await adm.page.waitForSelector('.layout', { state: 'visible' });
  assert.ok((await adm.page.locator('#nu-role option').allTextContents()).includes('Beta'));
  await adm.context.close();
  delete users['beta@bcr.test'];
  ok('ADMIN: puede crear usuarios con rol Beta');
}

{
  // El diálogo propio con el teclado, en celular, claro y oscuro.
  const { context, page } = await newPage({ width: 390, height: 760 });
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  await page.evaluate(() => { window.__manualDialog = true; window.__r = uiConfirm('Se borra también su plantilla.', { title: '¿Eliminar la variante "urgente"?', ok: 'Eliminar', danger: true }); });
  await page.waitForSelector('#ui-dialog[open]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ui-cancel', 'al borrar, el foco arranca en Cancelar');
  await page.screenshot({ path: DIR + 'tests/shot-dialogo.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: DIR + 'tests/shot-dialogo-oscuro.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__r), false);
  await page.evaluate(() => { window.__r = uiPrompt('Nombre', 'Ana', { title: 'Editar persona' }); });
  await page.waitForSelector('#ui-dialog[open]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ui-input');
  await page.fill('#ui-input', 'Ana María');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__r), 'Ana María');
  await page.evaluate(() => { window.__r = Promise.all([uiAlert('Primero'), uiAlert('Segundo')]); });
  await page.waitForSelector('#ui-dialog[open]');
  assert.equal(await page.textContent('#ui-msg'), 'Primero');
  await page.click('#ui-ok');
  await page.waitForFunction(() => document.getElementById('ui-msg').textContent === 'Segundo');
  await page.click('#ui-ok');
  await page.evaluate(() => window.__r);
  assert.equal(await page.isVisible('#ui-dialog'), false);
  await context.close();
  ok('diálogo propio: foco en Cancelar al borrar, Escape cancela, Enter guarda el texto, uno detrás de otro');
}

{
  // Tema: Auto sigue al sistema; el sol/luna lo fija y se recuerda; Auto vuelve a seguir al sistema.
  const { context, page } = await newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://app.test/index.html');
  await login(page, 'admin@bcr.test');
  await page.waitForSelector('.layout', { state: 'visible' });
  const paper = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim());
  const sw = page.locator('.sidebar .theme-switch'), auto = page.locator('.sidebar .theme-auto');
  assert.equal(await paper(), '#f1f4f8');
  assert.equal(await auto.getAttribute('aria-pressed'), 'true');
  assert.equal(await sw.getAttribute('aria-checked'), 'false');
  assert.equal(await page.textContent('#theme-label'), 'Automático · día (sistema)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await until(page, () => getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() === '#0d1625');
  await until(page, () => document.querySelector('.sidebar .theme-switch').getAttribute('aria-checked') === 'true');
  assert.equal(await page.textContent('#theme-label'), 'Automático · noche (sistema)');
  ok('Tema: en Auto sigue al claro/oscuro del sistema');

  await sw.click();
  await until(page, () => document.documentElement.dataset.theme === 'light');
  assert.equal(await paper(), '#f1f4f8', 'fija día aunque el sistema esté oscuro');
  assert.equal(await auto.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.textContent('#theme-label'), 'Fijado en día');
  assert.equal(await page.evaluate(() => localStorage.getItem('qabcr-tema')), 'light');
  assert.equal(await page.getAttribute('meta[name=theme-color]', 'content'), '#0a3d7e');
  await page.waitForTimeout(800);
  await page.screenshot({ path: DIR + 'tests/shot-tema-dia.png' });
  await sw.click();
  await until(page, () => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.getAttribute('meta[name=theme-color]', 'content'), '#0a1830');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await paper(), '#0d1625', 'fijado en noche no sigue al sistema');
  await page.waitForTimeout(800);
  await page.screenshot({ path: DIR + 'tests/shot-tema-noche.png' });
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'se recuerda al recargar');
  await page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  ok('Tema: el sol/luna fija día o noche, apaga Auto y se recuerda al recargar');

  await auto.click();
  await until(page, () => !document.documentElement.dataset.theme);
  assert.equal(await paper(), '#f1f4f8');
  assert.equal(await page.evaluate(() => localStorage.getItem('qabcr-tema')), null);
  assert.equal(await auto.getAttribute('aria-pressed'), 'true');
  // Auto encendido y se apaga: queda fijado en lo que se ve, sin cambiar el color.
  await auto.click();
  assert.equal(await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('qabcr-tema')]).then(String), 'light,light');
  await auto.click();
  ok('Tema: Auto vuelve a seguir al sistema; apagarlo deja el tema que se ve');

  await page.setViewportSize({ width: 390, height: 760 });
  assert.equal(await page.isVisible('.mobile-account .theme-switch'), true);
  assert.equal(await page.isVisible('.mobile-account .theme-auto'), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'sin scroll horizontal');
  await page.locator('.mobile-account .theme-switch').click();
  await until(page, () => document.documentElement.dataset.theme === 'dark');
  await page.waitForTimeout(800);
  await page.screenshot({ path: DIR + 'tests/shot-tema-movil.png' });
  ok('Tema en celular: el interruptor está junto a los botones de cuenta');
  await context.close();
}

// Seguridad: no toma la sesión de un enlace y no se muestra dentro de un iframe de otro sitio.
{
  const { context, page } = await newPage();
  const qa = users['qa@bcr.test'];
  await page.goto(`http://app.test/index.html#access_token=${tokenFor(qa)}&refresh_token=r-${qa.id}&expires_in=3600&token_type=bearer&type=magiclink`);
  await page.waitForSelector('#auth-form', { state: 'visible' });
  assert.equal(await page.isVisible('.layout'), false);
  ok('un enlace con #access_token no inicia sesión: hay que entrar con correo y contraseña');

  await context.route('http://otro.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<iframe src="http://app.test/index.html" width="800" height="600"></iframe>' }));
  await page.goto('http://otro.test/');
  await new Promise((r) => setTimeout(r, 800));
  if (!page.url().startsWith('http://app.test/')) {
    const frame = page.frames().find((f) => f.url().startsWith('http://app.test/'));
    assert.ok(frame, 'no cargó el iframe');
    await frame.waitForLoadState('domcontentloaded');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).display), 'none');
  }
  ok('dentro de un iframe de otro sitio la app no se muestra (clickjacking)');
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'errores de JS en la página: ' + errors.join(' | '));
ok('sin errores de JavaScript ni bloqueos de CSP/integridad en la página');

// La CSP no permite scripts inline: ni <script> sin src ni atributos on*.
assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
for (const f of ['index.html', ...readdirSync(DIR + 'js').map((f) => 'js/' + f)]) {
  assert.doesNotMatch(readFileSync(DIR + f, 'utf8'), /\son[a-z]+=["']/, f + ' tiene un manejador inline');
}
ok('CSP sin unsafe-inline para scripts y sin manejadores inline en el HTML ni en las plantillas');
