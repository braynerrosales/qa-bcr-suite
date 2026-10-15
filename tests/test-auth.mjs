// Prueba la Fase 2 con el cliente real de supabase-js y un Supabase simulado en la red.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Requiere: npm i playwright-core y supabase-js descomprimido en ./package (npm pack @supabase/supabase-js@2.117.2).
const DIR = new URL('..', import.meta.url).pathname;
const SUPA = 'https://demo.supabase.co';
const html = readFileSync(DIR + 'index.html', 'utf8');
const configured = html
  .replace("const SUPABASE_URL='';", `const SUPABASE_URL='${SUPA}';`)
  .replace("const SUPABASE_ANON_KEY='';", "const SUPABASE_ANON_KEY='anon-test-key';");
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

async function setup(context) {
  await context.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await context.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
    (r) => r.fulfill({ contentType: 'application/javascript', body: supabaseJs }));
  await context.route('http://app.test/**', (r) => {
    const url = r.request().url();
    if (url.endsWith('/index.html')) return r.fulfill({ contentType: 'text/html', body: configured });
    if (url.endsWith('/sin-config.html')) return r.fulfill({ contentType: 'text/html', body: html });
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
    return json(404, { message: 'no simulado: ' + req.method() + ' ' + url.pathname });
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const ok = (m) => console.log('OK  ' + m);
const errors = [];

async function newPage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  await setup(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
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

  await page.click('.sidebar-logout');
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

await browser.close();
assert.deepEqual(errors, [], 'errores de JS en la página: ' + errors.join(' | '));
ok('sin errores de JavaScript en la página');
