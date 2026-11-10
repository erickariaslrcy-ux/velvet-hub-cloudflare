// Despliegue completo: repo privado en GitHub, proyecto Supabase con el esquema,
// cuenta maestra y sitio en Vercel. Se ejecuta UNA vez desde la PC:
//
//   node scripts/deploy.mjs ruta/a/secretos.env
//
// El archivo de secretos (fuera del repo) debe tener:
//   GH_TOKEN, VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN, MASTER_EMAIL, MASTER_PASSWORD
// Opcionales: REPO_NAME (biblioteca-web), PROJECT_NAME (biblioteca),
//   SUPABASE_REGION (us-east-1), SUPABASE_PROJECT_REF (para reutilizar uno existente)
//
// Ningún secreto se escribe en el repo. Las claves de Supabase quedan solo en
// Vercel (variables de entorno) y en sync/.env (ignorado por git).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, ".deploy-state.json"); // ignorado por git (.env.* no aplica, ver .gitignore)

function loadEnvFile(file) {
  if (!file || !existsSync(file)) throw new Error(`No encuentro el archivo de secretos: ${file}`);
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    // El archivo manda: una variable ya definida en el sistema (p. ej. otro SUPABASE_ACCESS_TOKEN) no lo pisa.
    if (m && !line.trim().startsWith("#")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile(process.argv[2]);
const need = ["GH_TOKEN", "VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "MASTER_EMAIL", "MASTER_PASSWORD"];
for (const k of need) if (!process.env[k]) throw new Error(`Falta ${k} en el archivo de secretos`);

const E = process.env;
const REPO = E.REPO_NAME || "biblioteca-web";
const PROJECT = E.PROJECT_NAME || "biblioteca";
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log("•", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, token, method, url, body, ok = [200, 201, 204]) {
  const res = await fetch(base + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!ok.includes(res.status)) {
    const err = new Error(`${method} ${url} -> ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`.slice(0, 600));
    err.status = res.status;
    throw err;
  }
  return data;
}
const gh = (m, u, b, ok) => api("https://api.github.com", E.GH_TOKEN, m, u, b, ok);
const sb = (m, u, b, ok) => api("https://api.supabase.com", E.SUPABASE_ACCESS_TOKEN, m, u, b, ok);
const vc = (m, u, b, ok) => {
  const sep = u.includes("?") ? "&" : "?";
  const team = state.vercelTeamId ? `${sep}teamId=${state.vercelTeamId}` : "";
  return api("https://api.vercel.com", E.VERCEL_TOKEN, m, u + team, b, ok);
};

// ---------------------------------------------------------------- GitHub
async function github() {
  const me = await gh("GET", "/user");
  state.ghOwner = me.login;
  let repo;
  try {
    repo = await gh("GET", `/repos/${me.login}/${REPO}`);
    log(`GitHub: el repo ${repo.full_name} ya existe (privado: ${repo.private})`);
    if (!repo.private) await gh("PATCH", `/repos/${me.login}/${REPO}`, { private: true });
  } catch (e) {
    if (e.status !== 404) throw e;
    repo = await gh("POST", "/user/repos", {
      name: REPO,
      private: true,
      description: "Biblioteca privada (Next.js + Supabase)",
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    });
    log(`GitHub: repo privado creado ${repo.full_name}`);
  }
  state.ghRepo = repo.full_name;
  save();

  const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: "pipe" }).toString().trim();
  if (!existsSync(path.join(ROOT, ".git"))) {
    git("init", "-b", "main");
  }
  git("add", "-A");
  try {
    git("-c", "user.name=Biblioteca Deploy", "-c", `user.email=${E.MASTER_EMAIL}`, "commit", "-m", "Biblioteca: sitio inicial");
  } catch { /* nada nuevo que commitear */ }
  // El token va solo en esta llamada; no se guarda en .git/config.
  const pushUrl = `https://x-access-token:${E.GH_TOKEN}@github.com/${repo.full_name}.git`;
  execFileSync("git", ["push", pushUrl, "HEAD:main"], { cwd: ROOT, stdio: "pipe" });
  try { git("remote", "remove", "origin"); } catch {}
  git("remote", "add", "origin", `https://github.com/${repo.full_name}.git`);
  log("GitHub: código subido a main");
}

// ---------------------------------------------------------------- Supabase
async function supabase() {
  let ref = E.SUPABASE_PROJECT_REF || state.supabaseRef;
  if (!ref) {
    const projects = await sb("GET", "/v1/projects");
    const existing = projects.find((p) => p.name === PROJECT);
    if (existing) {
      ref = existing.id ?? existing.ref;
      log(`Supabase: reutilizo el proyecto "${PROJECT}" (${ref})`);
    } else {
      const orgs = await sb("GET", "/v1/organizations");
      if (!orgs.length) throw new Error("La cuenta de Supabase no tiene organizaciones");
      const dbPass = randomBytes(24).toString("base64url");
      const p = await sb("POST", "/v1/projects", {
        name: PROJECT,
        organization_id: orgs[0].id,
        db_pass: dbPass,
        region: E.SUPABASE_REGION || "us-east-1",
      });
      ref = p.id ?? p.ref;
      state.supabaseDbPassword = dbPass; // queda solo en .deploy-state.json (ignorado por git)
      log(`Supabase: proyecto creado (${ref}), esperando a que arranque…`);
    }
    state.supabaseRef = ref;
    save();
  }

  for (let i = 0; i < 90; i++) {
    const p = await sb("GET", `/v1/projects/${ref}`);
    if (p.status === "ACTIVE_HEALTHY") break;
    if (i === 89) throw new Error(`Supabase no quedó listo (estado ${p.status})`);
    await sleep(10000);
  }

  const keys = await sb("GET", `/v1/projects/${ref}/api-keys?reveal=true`);
  const anon = keys.find((k) => k.name === "anon")?.api_key;
  const service = keys.find((k) => k.name === "service_role")?.api_key;
  if (!anon || !service) throw new Error("No pude leer las claves anon/service_role");
  state.supabaseUrl = `https://${ref}.supabase.co`;
  save();

  const sql = readFileSync(path.join(ROOT, "supabase", "migrations", "0001_init.sql"), "utf8");
  await sb("POST", `/v1/projects/${ref}/database/query`, { query: sql });
  log("Supabase: esquema aplicado (catálogo, favoritos, llaves, filtro fijo)");

  // Cuenta maestra
  const authBase = `${state.supabaseUrl}/auth/v1`;
  const h = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
  const r = await fetch(`${authBase}/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email: E.MASTER_EMAIL, password: E.MASTER_PASSWORD, email_confirm: true }),
  });
  if (r.ok) log("Supabase: cuenta maestra creada");
  else {
    const t = await r.text();
    if (!/already|registered|exists/i.test(t)) throw new Error(`No pude crear la cuenta maestra: ${t}`);
    log("Supabase: la cuenta maestra ya existía");
  }
  const email = E.MASTER_EMAIL.toLowerCase().replace(/'/g, "''");
  await sb("POST", `/v1/projects/${ref}/database/query`, {
    query: `insert into public.profiles (id, email, is_admin)
            select id, email, true from auth.users where lower(email) = '${email}'
            on conflict (id) do update set is_admin = true;`,
  });
  log("Supabase: cuenta maestra marcada como admin");

  // Sin registro público: solo por llaves (la ruta /api/redeem usa la API admin).
  await sb("PATCH", `/v1/projects/${ref}/config/auth`, { disable_signup: true });
  log("Supabase: registro público desactivado");

  // Credenciales para el script de sincronización (archivo ignorado por git).
  writeFileSync(
    path.join(ROOT, "sync", ".env"),
    `SUPABASE_URL=${state.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${service}\n`
  );
  return { anon, service };
}

// ---------------------------------------------------------------- Vercel
async function vercel({ anon, service }) {
  if (state.vercelTeamId === undefined) {
    const u = await vc("GET", "/v2/user");
    state.vercelTeamId = u.user?.defaultTeamId || null;
    save();
  }

  let project;
  try {
    project = await vc("GET", `/v9/projects/${PROJECT}`);
    log(`Vercel: el proyecto ${PROJECT} ya existe`);
  } catch (e) {
    if (e.status !== 404) throw e;
    try {
      project = await vc("POST", "/v11/projects", {
        name: PROJECT,
        framework: "nextjs",
        gitRepository: { type: "github", repo: state.ghRepo },
      });
      log("Vercel: proyecto creado y conectado al repo de GitHub");
    } catch (err) {
      log(`Vercel: no pude conectar GitHub (${err.message.slice(0, 160)}). Creo el proyecto sin conexión git.`);
      project = await vc("POST", "/v11/projects", { name: PROJECT, framework: "nextjs" });
    }
  }
  state.vercelProjectId = project.id;
  save();

  const envs = {
    NEXT_PUBLIC_SUPABASE_URL: state.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    MASTER_EMAIL: E.MASTER_EMAIL,
  };
  for (const [key, value] of Object.entries(envs)) {
    await vc("POST", `/v10/projects/${project.id}/env?upsert=true`, {
      key,
      value,
      type: key.startsWith("NEXT_PUBLIC_") ? "plain" : "encrypted",
      target: ["production", "preview", "development"],
    });
  }
  log("Vercel: variables de entorno configuradas");

  // Desplegar con la CLI (no depende de que GitHub esté conectado a Vercel).
  const scope = state.vercelTeamId ? ["--scope", state.vercelTeamId] : [];
  const vercelEnv = { ...process.env, VERCEL_ORG_ID: state.vercelTeamId || "", VERCEL_PROJECT_ID: project.id };
  if (!state.vercelTeamId) delete vercelEnv.VERCEL_ORG_ID;
  const out = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "vercel@latest", "deploy", "--prod", "--yes", "--token", E.VERCEL_TOKEN, ...scope],
    { cwd: ROOT, env: vercelEnv, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" }
  ).toString();
  const urls = out.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/gi) || [];
  const url = urls.pop();
  // Si <proyecto>.vercel.app ya es de otro, Vercel asigna un alias distinto (p. ej. biblioteca-xxxx.vercel.app).
  const aliased = out.match(/Aliased\s+(https:\/\/[a-z0-9.-]+\.vercel\.app)/i)?.[1];
  const prod = aliased || url || `https://${PROJECT}.vercel.app`;
  state.vercelProdUrl = prod;
  state.vercelUrl = url;
  save();
  log(`Vercel: desplegado ${url}`);

  // Redirecciones de auth al dominio del sitio
  await sb("PATCH", `/v1/projects/${state.supabaseRef}/config/auth`, {
    site_url: prod,
    uri_allow_list: `${prod}/**`,
  });
  return prod;
}

const step = process.argv[3]; // opcional: github | supabase | vercel
try {
  if (!step || step === "github") await github();
  let keys;
  if (!step || step === "supabase" || step === "vercel") keys = await supabase();
  let site;
  if (!step || step === "vercel") site = await vercel(keys);
  console.log("\nListo.");
  if (state.ghRepo) console.log(`  Repo privado: https://github.com/${state.ghRepo}`);
  if (state.supabaseRef) console.log(`  Supabase:     https://supabase.com/dashboard/project/${state.supabaseRef}`);
  if (site) console.log(`  Sitio:        ${site}  (último deploy: ${state.vercelUrl})`);
} catch (e) {
  console.error("\nERROR:", e.message);
  process.exit(1);
}
