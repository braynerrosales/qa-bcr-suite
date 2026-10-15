#!/usr/bin/env node
// QA BCR Suite v3 — migración del JSON actual a Supabase.
//
// No se conecta a Supabase ni necesita claves: lee el JSON exportado por la app
// y genera dos archivos SQL para pegar en el SQL Editor de Supabase.
//
//   node scripts/migrate-data.mjs qa-bcr-suite-data.json [carpeta-salida]
//
//   seed.sql            inserta todo en una sola transacción; si ya hay datos, no hace nada
//   verify-seed.sql     compara get_app_config() con el JSON original
//
// Los dos contienen datos del equipo: no se suben al repositorio.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , input, outDir = 'out'] = process.argv;
if (!input) {
  console.error('Uso: node scripts/migrate-data.mjs <qa-bcr-suite-data.json> [carpeta-salida]');
  process.exit(1);
}

const db = JSON.parse(readFileSync(input, 'utf8'));
for (const key of ['people', 'rules', 'projects']) {
  if (!db[key] || typeof db[key] !== 'object') {
    console.error(`El JSON no tiene la sección "${key}".`);
    process.exit(1);
  }
}

const q = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`);
const groupId = (code) => `(select id from public.daily_groups where code = ${q(code)})`;
const memberId = (code, name) =>
  `(select id from public.daily_members where daily_group_id = ${groupId(code)} and name = ${q(name)})`;
const projectId = (code) => `(select id from public.projects where code = ${q(code)})`;
const variantId = (code, name) =>
  `(select id from public.project_variants where project_id = ${projectId(code)} and name = ${q(name)})`;

const warnings = [];
const sql = [];
const counts = { groups: 0, members: 0, firstGroup: 0, lastFixed: 0, projects: 0, variants: 0, inactiveVariants: 0, templates: 0, tasks: 0 };

sql.push(`-- Generado por scripts/migrate-data.mjs desde ${input} el ${new Date().toISOString()}`);
sql.push('-- Contiene datos del equipo: no subir al repositorio.');
sql.push('begin;');
sql.push(`do $$
begin
    if exists (select 1 from public.daily_groups) or exists (select 1 from public.projects) then
        raise exception 'La base ya tiene datos. La migración inicial solo se ejecuta sobre una base vacía.';
    end if;
end;
$$;`);

// ── Dailys y personas ───────────────────────────────────────
for (const [code, names] of Object.entries(db.people)) {
  const label = code.replace(/^daily(\d+)$/, 'Daily $1');
  sql.push(`\n-- ${label}`);
  sql.push(`insert into public.daily_groups (code, name) values (${q(code)}, ${q(label)});`);
  counts.groups++;

  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length !== names.length) warnings.push(`${code}: se quitaron nombres vacíos o repetidos.`);
  if (unique.length) {
    sql.push(
      `insert into public.daily_members (daily_group_id, name) values\n` +
        unique.map((n) => `    (${groupId(code)}, ${q(n)})`).join(',\n') +
        ';'
    );
  }
  counts.members += unique.length;

  // ── Reglas ────────────────────────────────────────────────
  const rule = db.rules[code] ?? { firstGroup: [], range: 1, lastFixed: [] };
  if (!db.rules[code]) warnings.push(`${code}: no tiene reglas; se crea con rango 1.`);
  sql.push(`insert into public.daily_rules (daily_group_id, first_range) values (${groupId(code)}, ${Number(rule.range) || 0});`);

  // Igual que generateOrder(): si alguien está en las dos listas, gana lastFixed.
  const lastFixed = (rule.lastFixed ?? []).filter((n) => unique.includes(n));
  const firstGroup = (rule.firstGroup ?? []).filter((n) => unique.includes(n) && !lastFixed.includes(n));
  const dropped = [...(rule.firstGroup ?? []), ...(rule.lastFixed ?? [])].filter(
    (n) => !firstGroup.includes(n) && !lastFixed.includes(n)
  );
  if (dropped.length) warnings.push(`${code}: reglas ignoradas (persona inexistente o duplicada): ${dropped.join(', ')}`);

  for (const [type, list] of [['FIRST_GROUP', firstGroup], ['LAST_FIXED', lastFixed]]) {
    for (const n of list) {
      sql.push(`insert into public.daily_rule_members (daily_member_id, rule_type) values (${memberId(code, n)}, '${type}');`);
    }
  }
  counts.firstGroup += firstGroup.length;
  counts.lastFixed += lastFixed.length;
}

for (const code of Object.keys(db.rules)) {
  if (!(code in db.people)) warnings.push(`rules.${code} no tiene personas; no se migra.`);
}

// ── Proyectos, variantes y plantillas ───────────────────────
for (const [code, project] of Object.entries(db.projects)) {
  sql.push(`\n-- Proyecto ${code}`);
  sql.push(`insert into public.projects (code, name, color) values (${q(code)}, ${q(code)}, ${q(project.color ?? null)});`);
  counts.projects++;

  const variants = project.variants ?? [];
  const templates = project.templates ?? {};
  for (const v of variants) {
    sql.push(`insert into public.project_variants (project_id, name) values (${projectId(code)}, ${q(v)});`);
  }
  counts.variants += variants.length;

  // Plantilla con nombre de variante que ya no está en la lista: se conserva
  // con la variante desactivada, para no perder datos ni mostrarla en la app.
  for (const key of Object.keys(templates)) {
    if (key !== '' && !variants.includes(key)) {
      sql.push(`insert into public.project_variants (project_id, name, active) values (${projectId(code)}, ${q(key)}, false);`);
      counts.inactiveVariants++;
      warnings.push(`${code}: la plantilla "${key}" no está en variants; se migra con la variante desactivada.`);
    }
  }
  if (variants.length && '' in templates) {
    warnings.push(`${code}: tiene plantilla sin variante pero también variantes; la app actual no la usa. Se migra igual.`);
  }

  for (const [key, tasks] of Object.entries(templates)) {
    const vId = key === '' ? 'null' : variantId(code, key);
    sql.push(`insert into public.templates (project_id, variant_id) values (${projectId(code)}, ${vId});`);
    counts.templates++;
    const clean = tasks.map((t) => t.trim()).filter(Boolean);
    if (clean.length) {
      const tId = `(select id from public.templates where project_id = ${projectId(code)} and variant_id is not distinct from ${vId})`;
      sql.push(
        `insert into public.template_tasks (template_id, position, task) values\n` +
          clean.map((t, i) => `    (${tId}, ${i + 1}, ${q(t)})`).join(',\n') +
          ';'
      );
    }
    counts.tasks += clean.length;
  }
}

sql.push('\ncommit;');

// ── Verificación ─────────────────────────────────────────────
// Lo esperado es el JSON original, normalizado igual que la migración.
const expected = { people: {}, rules: {}, projects: {} };
for (const [code, names] of Object.entries(db.people)) {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const rule = db.rules[code] ?? { firstGroup: [], range: 1, lastFixed: [] };
  const lastFixed = (rule.lastFixed ?? []).filter((n) => unique.includes(n));
  const firstGroup = (rule.firstGroup ?? []).filter((n) => unique.includes(n) && !lastFixed.includes(n));
  expected.people[code] = unique;
  expected.rules[code] = { firstGroup, range: Number(rule.range) || 0, lastFixed };
}
for (const [code, p] of Object.entries(db.projects)) {
  const templates = {};
  for (const [key, tasks] of Object.entries(p.templates ?? {})) templates[key] = tasks.map((t) => t.trim()).filter(Boolean);
  expected.projects[code] = { color: p.color ?? null, variants: p.variants ?? [], templates };
}

const verify = `-- Verificación de la migración. Ejecutar en el SQL Editor después de seed.sql.
-- Contiene datos del equipo: no subir al repositorio.

-- 1. Conteos
select 'daily_groups' as tabla, count(*) as actual, ${counts.groups} as esperado from public.daily_groups
union all select 'daily_members', count(*), ${counts.members} from public.daily_members
union all select 'FIRST_GROUP', count(*), ${counts.firstGroup} from public.daily_rule_members where rule_type = 'FIRST_GROUP'
union all select 'LAST_FIXED', count(*), ${counts.lastFixed} from public.daily_rule_members where rule_type = 'LAST_FIXED'
union all select 'projects', count(*), ${counts.projects} from public.projects
union all select 'project_variants activas', count(*), ${counts.variants} from public.project_variants where active
union all select 'project_variants inactivas', count(*), ${counts.inactiveVariants} from public.project_variants where not active
union all select 'templates', count(*), ${counts.templates} from public.templates
union all select 'template_tasks', count(*), ${counts.tasks} from public.template_tasks;

-- 2. JSON original vs Supabase (debe devolver iguales = true)
select public.get_app_config() = ${q(JSON.stringify(expected))}::jsonb as iguales;
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'seed.sql'), sql.join('\n') + '\n');
writeFileSync(join(outDir, 'verify-seed.sql'), verify);

console.log(`Generados ${join(outDir, 'seed.sql')} y ${join(outDir, 'verify-seed.sql')}`);
console.log(counts);
if (warnings.length) {
  console.log('\nAvisos:');
  for (const w of warnings) console.log(`  - ${w}`);
}
