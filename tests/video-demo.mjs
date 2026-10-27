// QA BCR Suite — video de demostración: recorre la app con datos inventados (Supabase simulado),
// con un cartel en pantalla y una voz en español que explican cada parte.
//
// Uso (con ffmpeg instalado; la voz es neural de Microsoft con edge-tts —pip install edge-tts—,
// que manda solo el texto de los carteles; si no está, usa la voz de Windows en español):
//   DEMO_VIDEO=1 CHROME_PATH=... node tests/test-auth.mjs
// Sale en tests/out/demo-app.mp4. No corre las pruebas y no usa la base real.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Cada escena: lo que dice el cartel (y la voz). Su duración marca el ritmo del video.
const ESCENAS = {
  inicio: 'Esta es QA BCR Suite, la herramienta del equipo de QA. Cada persona entra con su usuario y ve solo lo que su rol le permite.',
  home: 'El inicio reúne todo: generar tareas, ordenar el Daily, registrar horas, controlar solicitudes y contar días hábiles.',
  tareas: 'Generar tareas convierte los PBI o historias de usuario en las tareas de QA de cada proyecto, listas para copiar a Azure DevOps.',
  proyectos: 'En Proyectos, cada QA agrega proyectos, variantes y tareas. Cada uno borra lo que agregó; los líderes pueden borrar cualquier cosa.',
  daily: 'El Daily sortea quién habla primero, respetando las reglas del equipo. Se marca quién ya habló y quién no asistió.',
  motivo: 'Cada ausencia lleva su motivo: sin justificar, justificada o vacaciones.',
  leads: 'Los líderes van una semana en cada Daily. Con un botón se intercambian, y cada uno sigue cerrando su Daily.',
  historial: 'El historial muestra la asistencia del mes. Las vacaciones y las ausencias justificadas no bajan el porcentaje.',
  horas: 'En Horas, cada persona carga lo que trabajó cada día, facturable o no, además de vacaciones y licencias.',
  consolidado: 'Los líderes ven el consolidado del equipo para el informe.',
  solicitudes: 'Control de solicitudes sigue el plan, el cierre y el informe semanal de cada solicitud, en vivo para todo el equipo.',
  campana: 'La campana avisa cuando alguien crea una solicitud o la pasa a plan enviado.',
  admin: 'En Administración se manejan las personas y reglas del Daily, y los usuarios con su rol: Admin, QA Lead, QA, Beta o QA Boss.',
  tema: 'Funciona en modo claro y oscuro, y también en el celular.',
  cierre: 'QA BCR Suite: el trabajo del equipo de QA, en un solo lugar.',
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hoyISO = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };

const VOZ = process.env.DEMO_VOZ || 'es-CR-MariaNeural';
const segundos = (archivo) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', archivo]).toString());
// Voz neural (edge-tts); si no está instalada, la de Windows. Devuelve el archivo y sus segundos.
function hablar(texto, base, dir) {
  try {
    execFileSync('edge-tts', ['--voice', VOZ, '--rate=+5%', '--text', texto, '--write-media', base + '.mp3'], { stdio: 'ignore' });
    return { archivo: base + '.mp3', seg: segundos(base + '.mp3') };
  } catch {
    const wav = base + '.wav';
    return { archivo: wav, seg: hablarWindows(texto, wav, dir) };
  }
}
// Voz de Windows (System.Speech) en español; devuelve los segundos de audio.
function hablarWindows(texto, wav, dir) {
  const txt = wav.replace(/\.wav$/, '.txt');
  writeFileSync(txt, texto, 'utf8');
  const ps1 = dir + 'voz.ps1';
  writeFileSync(ps1, [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es*' } | Select-Object -First 1",
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$s.Rate = 1',
    '$s.SetOutputToWaveFile($args[1])',
    '$s.Speak([IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8))',
    '$s.Dispose()',
  ].join('\n'), 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, txt, wav]);
  const b = readFileSync(wav);
  const byteRate = b.readUInt32LE(28);
  const data = b.indexOf('data', 12);
  return b.readUInt32LE(data + 4) / byteRate;
}

// Datos de demostración: nombres inventados y textos prolijos (las pruebas usan casos raros a propósito).
function prepararDatos(t, users, leadId, adminId) {
  users['admin@bcr.test'].full_name = 'Andrea Admin';
  users['qa@bcr.test'].full_name = 'Quique QA';
  t.daily_members = [
    ['Ana Rojas', 1], ['Beto Vargas', 1], ['Carla Méndez', 1], ['Diego Soto', 1], ['Laura Lead', 1],
    ['Elena Mora', 2], ['Fabián Cruz', 2], ['Gabriela Ruiz', 2], ['Hugo León', 2], ['Marco Lead', 2],
  ].map(([name, g], i) => ({ id: i + 1, daily_group_id: g, name, active: true }));
  t.daily_rule_members = [{ id: 1, daily_member_id: 5, rule_type: 'LAST_FIXED' }, { id: 2, daily_member_id: 10, rule_type: 'LAST_FIXED' }];
  t.project_variants = [{ id: 1, project_id: 2, name: 'normal', active: true }, { id: 2, project_id: 2, name: 'urgente', active: true }];
  t.template_tasks = [
    'QA - {n} - Diseño de casos de prueba.', 'QA - {n} - Ejecución de pruebas funcionales.',
    'QA - {n} - Pruebas de regresión.', 'QA - {n} - Reporte de resultados.',
  ].map((task, i) => ({ id: i + 1, template_id: 2, position: i + 1, task, created_by: null }))
    .concat([{ id: 9, template_id: 1, position: 1, task: 'QA - {n} - Validación de datos.', created_by: null }]);
  t.solicitudes[0].nombre = 'Solicitud P3_081 Gobierno Digital';
  t.solicitudes[0].encargados = ['Ana Rojas'];
  // Historial del mes: algunos Daily con ausencias justificadas y de vacaciones.
  const g1 = t.daily_members.filter((m) => m.daily_group_id === 1);
  t.daily_runs = [-7, -6, -5, -4, -3, -2, -1].map((d, i) => ({
    id: 100 + i, daily_group_id: 1, run_date: hoyISO(d), created_by: leadId,
    members: g1.map((m, j) => {
      const vac = m.name === 'Beto Vargas' && d >= -3, just = m.name === 'Carla Méndez' && d === -5, falta = m.name === 'Diego Soto' && d === -6;
      return { name: m.name, position: m.name === 'Laura Lead' ? 5 : ((j + i) % 4) + 1, completed: !(vac || just || falta), absent: vac || just || falta, motivo: vac ? 'vacaciones' : just ? 'justificada' : null };
    }),
  })).filter((r) => new Date(r.run_date + 'T12:00').getDay() % 6 !== 0);
  t.horas = [0, 1, 2].map((d, i) => ({ id: 500 + i, user_id: adminId, fecha: hoyISO(-((new Date().getDay() + 6) % 7) + d), tipo: 'TRABAJO', soli: 'P3_081', tarea: 'Ejecución de pruebas', horas: 8, facturable: 7, updated_at: new Date().toISOString() }));
}

export async function grabarDemo({ browser, setup, login, getTables, users, rtPush, DIR }) {
  const out = DIR + 'tests/out/', voz = out + 'voz/', raw = out + 'raw/';
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(voz, { recursive: true });
  mkdirSync(raw, { recursive: true });
  console.log('Generando la voz…');
  const dur = {}, audio = {};
  for (const [id, texto] of Object.entries(ESCENAS)) ({ archivo: audio[id], seg: dur[id] } = hablar(texto, voz + id, voz));

  const t = getTables(), leadId = users['lead@bcr.test'].id;
  prepararDatos(t, users, leadId, users['admin@bcr.test'].id);

  console.log('Grabando el recorrido…');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: raw, size: { width: 1280, height: 720 } } });
  await setup(context);
  const page = await context.newPage();
  const t0 = Date.now(), marcas = [];
  // Muestra el cartel, arranca su voz y mantiene la escena al menos lo que dura la voz.
  async function escena(id, acciones = async () => {}) {
    marcas.push({ id, ms: Date.now() - t0 });
    await page.evaluate((texto) => {
      let el = document.getElementById('demo-cartel');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-cartel';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '99999',
          maxWidth: '900px', width: 'max-content', padding: '14px 24px', borderRadius: '14px', pointerEvents: 'none',
          background: 'rgba(8, 24, 52, 0.94)', color: '#fff', font: '600 20px/1.45 "Public Sans", system-ui, sans-serif',
          textAlign: 'center', boxShadow: '0 12px 32px rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)',
        });
        document.body.appendChild(el);
      }
      el.textContent = texto;
    }, ESCENAS[id]);
    const fin = Date.now() + dur[id] * 1000 + 600;
    await acciones();
    const resto = fin - Date.now();
    if (resto > 0) await espera(resto);
  }
  const aceptar = async () => { await page.waitForSelector('#ui-dialog[open]'); await espera(900); await page.click('#ui-ok'); };

  await page.goto('http://app.test/index.html');
  await page.waitForSelector('#auth-form:not([hidden])');
  await escena('inicio', async () => {
    await espera(1500);
    await page.type('#auth-email', 'admin@bcr.test', { delay: 45 });
    await page.type('#auth-password', 'pw', { delay: 60 });
    await page.click('#auth-submit');
    await page.waitForSelector('.layout', { state: 'visible' });
  });
  await escena('home');
  await escena('tareas', async () => {
    await page.click('#nav-qa');
    await espera(800);
    await page.click('#project-grid .proj-btn[data-type="COMERCIAL"]');
    await espera(600);
    await page.selectOption('#variant-select', 'normal');
    await espera(400);
    await page.type('#pbi-input', '24518 - Pago con tarjeta en la app\n24519 - Alertas de saldo bajo', { delay: 18 });
    await page.click('#btn-gen');
    await page.waitForSelector('#output-section.visible');
  });
  await escena('proyectos', async () => {
    await page.click('#nav-proyectos');
    await page.click('#proy-list .proj-btn[data-code="COMERCIAL"]');
    await page.waitForSelector('#proy-tareas .proy-tarea');
    await espera(1200);
    await page.type('#proy-new-task', 'QA - {n} - Pruebas de accesibilidad.', { delay: 30 });
    await page.press('#proy-new-task', 'Enter');
  });
  await escena('daily', async () => {
    await page.click('#nav-daily');
    await page.click('#dly-tab-hoy');
    await espera(600);
    await page.click('#rollBtn');
    await page.waitForSelector('#listBody .participant-item');
    await espera(1500);
    await page.locator('#listBody .participant-item').first().click();
  });
  await escena('motivo', async () => {
    await page.locator('#listBody .participant-item').nth(2).locator('.p-absent-btn').click();
    await espera(1400);
    await page.click('#dly-motivo-menu [role=menuitem]:text-is("Vacaciones")');
  });
  await escena('leads', async () => {
    await espera(600);
    await page.click('#dly-swap-btn');
    await aceptar();
    await page.waitForSelector('#dly-swap-status.ok');
    await espera(800);
    await page.click('#rollBtn');
  });
  await escena('historial', async () => {
    await page.click('#dly-tab-hist');
    await page.waitForSelector('#dly-hist-body table');
    await espera(2500);
    await page.mouse.wheel(0, 380);
  });
  await escena('horas', async () => {
    await page.click('#nav-horas');
    await page.waitForSelector('#hrs-days .hrs-day');
    await espera(1200);
  });
  await escena('consolidado', async () => {
    await page.click('#hrs-tab-report');
    await espera(1500);
  });
  await escena('solicitudes', async () => {
    await page.click('#nav-solicitudes');
    await page.waitForSelector('#sol-body tr');
  });
  await escena('campana', async () => {
    await page.click('#nav-home');
    await espera(800);
    const nueva = { ...t.solicitudes[1], id: 90, nombre: 'Solicitud P3_302 Firma digital', cerrada: false, cierre_enviado: false, plan_enviado: false, created_by: leadId, created_at: new Date().toISOString() };
    t.solicitudes.push(nueva);
    rtPush('INSERT', { ...nueva });
    await page.waitForSelector('#avisos-btn .nav-count:not([hidden])');
    await espera(1200);
    await page.click('#avisos-btn');
    await page.waitForSelector('#avisos-panel[open] .aviso');
  });
  await page.keyboard.press('Escape');
  await escena('admin', async () => {
    await page.click('#nav-admin');
    await espera(1500);
    await page.click('#atab-rules');
    await espera(1500);
    await page.click('#atab-users');
  });
  await escena('tema', async () => {
    await page.click('#nav-home');
    await espera(600);
    await page.locator('.theme-switch:visible').first().click();
    await espera(1200);
    await page.click('#nav-daily');
  });
  await escena('cierre', async () => { await page.click('#nav-home'); });
  await espera(800);
  const videoPath = await page.video().path();
  await context.close();

  // Une el video con cada voz en su momento.
  console.log('Uniendo video y voz…');
  const ids = Object.keys(ESCENAS);
  const args = ['-y', '-i', videoPath];
  ids.forEach((id) => args.push('-i', audio[id]));
  const mezcla = marcas.map((m, i) => `[${ids.indexOf(m.id) + 1}:a]adelay=${m.ms}|${m.ms}[a${i}]`).join(';')
    + ';' + marcas.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${marcas.length}:normalize=0[voz]`;
  args.push('-filter_complex', mezcla, '-map', '0:v', '-map', '[voz]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', out + 'demo-app.mp4');
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  rmSync(raw, { recursive: true, force: true });
  console.log('Listo: ' + out + 'demo-app.mp4');
}
