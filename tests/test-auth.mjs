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
const created = [];           // cuerpos enviados a admin-create-user
let failConfig = false;      // get_app_config responde 500
let failNextWrite = null;    // código de error para la próxima escritura
let tables;
function resetData(empty = false) {
  tables = empty ? { daily_groups: [], daily_members: [], daily_rules: [], daily_rule_members: [], projects: [], project_variants: [], templates: [] } : {
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
  const filters = [...url.searchParams].filter(([k]) => !['select', 'on_conflict', 'columns'].includes(k))
    .map(([k, v]) => [k, v.replace(/^eq\./, '')]);
  const match = (r) => filters.every(([k, v]) => String(r[k]) === v);
  const pick = (r) => Object.fromEntries((url.searchParams.get('select') || '*').split(',').map((c) => [c, r[c]]));
  const method = req.method();
  if (method === 'GET') return json(200, rows.filter(match).map(pick));
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
        rows.push({ id: nextId(rows), active: true, ...item });
      }
    }
    return r201(json);
  }
  const target = lead ? rows.filter(match) : [];   // el RLS filtra: 0 filas, sin error
  if (method === 'PATCH') target.forEach((r) => Object.assign(r, body));
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

async function setup(context) {
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
      return json(200, { access_token: tokenFor(u), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email } });
    }
    if (url.pathname === '/auth/v1/user') {
      const e = byId(subOf(req));
      if (!e) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      if (req.method() === 'PUT') {
        const { password } = req.postDataJSON();
        if (password === e[1].password) return json(422, { code: 422, error_code: 'same_password', msg: 'New password should be different from the old password.' });
        e[1].password = password;
      }
      return json(200, { id: e[1].id, aud: 'authenticated', role: 'authenticated', email: e[0] });
    }
    if (url.pathname === '/auth/v1/logout') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });

    if (url.pathname === '/rest/v1/profiles') {
      const me = byId(subOf(req))?.[1];
      const visible = Object.entries(users)
        .filter(([, u]) => u.id === me?.id || me?.active)
        .map(([email, u]) => ({ id: u.id, full_name: u.full_name, email, role: u.role, active: u.active }))
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
      // Igual que supabase/functions/admin-create-user: solo ADMIN activo.
      if (functionMissing) return json(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
      const me = byId(subOf(req))?.[1];
      if (!me) return json(401, { error: 'La sesión no es válida. Iniciá sesión de nuevo.' });
      if (me.role !== 'ADMIN' || !me.active) return json(403, { error: 'Solo un ADMIN puede crear usuarios.' });
      const b = req.postDataJSON();
      created.push(b);
      if (users[b.email]) return json(409, { error: 'Ya existe un usuario con ese correo.' });
      const id = 'a0000000-0000-4000-8000-0000000000' + String(10 + created.length);
      users[b.email] = { id, password: b.password, full_name: b.full_name, role: b.role, active: true };
      return json(200, { id, email: b.email, full_name: b.full_name, role: b.role });
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

  await login(page, 'qa@bcr.test', 'mala');
  await page.waitForSelector('#auth-error.error');
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
  ok('ADMIN: cambia el rol y ve "✓ Guardado"');

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
  if (overflow > 0) console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && e.offsetParent !== null).slice(0, 8).map(e => `${e.tagName}.${e.className}#${e.id} w=${Math.round(e.getBoundingClientRect().width)} right=${Math.round(e.getBoundingClientRect().right)}`)));
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
  assert.deepEqual(await page.locator('#variant-select option').allTextContents(), ['Seleccionar variante...', 'Normal', "X'><b>"]);
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
  await page.click('#nu-submit');
  await page.waitForSelector('#user-create-status.ok');
  assert.match(await page.textContent('#user-create-status'), /nora@bcr\.test \(QA Lead\)/);
  assert.deepEqual(created.at(-1), { full_name: 'Nora Nueva', email: 'nora@bcr.test', role: 'QA_LEAD', password: temp });
  await until(page, (n) => document.querySelectorAll('#list-users .crud-item').length === n + 1, before);
  assert.equal(await page.inputValue('#nu-password'), '');
  ok('ADMIN: crea un usuario con rol y contraseña temporal; aparece en la lista');

  await page.fill('#nu-name', 'Otra');
  await page.fill('#nu-email', 'nora@bcr.test');
  await page.fill('#nu-password', 'temporal-123');
  await page.click('#nu-submit');
  await page.waitForSelector('#user-create-status.error');
  assert.equal(await page.textContent('#user-create-status'), '⚠ Ya existe un usuario con ese correo.');
  ok('correo repetido: muestra el error de la función');

  functionMissing = true;
  await page.fill('#nu-email', 'otra@bcr.test');
  await page.click('#nu-submit');
  await page.waitForFunction(() => /no está publicada/.test(document.getElementById('user-create-status').textContent));
  functionMissing = false;
  ok('función sin publicar: lo explica');
  await page.screenshot({ path: DIR + 'tests/shot-crear-usuario.png', fullPage: true });
  await context.close();

  const c2 = await newPage();
  await c2.page.goto('http://app.test/index.html');
  await login(c2.page, 'nora@bcr.test', temp);
  await c2.page.waitForSelector('.layout', { state: 'visible' });
  assert.equal(await c2.page.textContent('#sidebar-user-role'), 'QA Lead');
  await c2.page.click('.sidebar-user-actions button:has-text("Cambiar contraseña")');
  await c2.page.fill('#pw-new', 'nueva-clave-segura');
  await c2.page.fill('#pw-confirm', 'otra-cosa-distinta');
  await c2.page.click('#pw-submit');
  assert.equal(await c2.page.textContent('#pw-status'), 'Las contraseñas no coinciden.');
  await c2.page.fill('#pw-confirm', 'nueva-clave-segura');
  await c2.page.click('#pw-submit');
  await c2.page.waitForSelector('#pw-status.ok');
  assert.equal(users['nora@bcr.test'].password, 'nueva-clave-segura');
  await c2.page.waitForSelector('#pw-dialog', { state: 'hidden' });
  ok('el usuario nuevo entra con la temporal y cambia su contraseña');
  await c2.context.close();
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

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, 'scroll horizontal en Daily móvil: ' + overflow);
  await page.locator('#listBody .participant-item').first().locator('.p-absent-btn').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: DIR + 'tests/shot-daily-movil.png' });
  ok('Daily en móvil con el botón No asistió: sin scroll horizontal');
  await context.close();
}

await browser.close();
assert.deepEqual(errors, [], 'errores de JS en la página: ' + errors.join(' | '));
ok('sin errores de JavaScript ni bloqueos de CSP/integridad en la página');
