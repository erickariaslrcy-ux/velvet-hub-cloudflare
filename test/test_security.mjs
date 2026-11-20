import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== INICIANDO PRUEBAS UNITARIAS DE SEGURIDAD (FASE 2) ===");

// 1. Verificación de ausencia de secretos hardcodeados
console.log("\n[1] Verificando ausencia de secretos hardcodeados en el código...");
const filesToCheck = [
  path.join("public", "index.html"),
  path.join("public", "velvet.html"),
  path.join("lib", "patreon.ts"),
  path.join("app", "api", "media", "route.ts"),
  path.join("app", "api", "video", "stream", "route.ts"),
  path.join("functions", "api", "[[path]].js")
];

const FORBIDDEN_PATTERNS = [
  /velvet_ultra_stealth_secret_key_2026/,
  /0gJLjj89ySdbwdCHgGvPnPLbrPGBouKCe2yH5u4mBnDk0BMbe21AcQ7cwVtK5Cbu/,
  /A4GVPPsrInVVr1vEjAyFyD8eOLzt0qFqqae2-TCDepH-aX1aKLFD0B_wTN33YLtd/,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/, // Raw JWT service_role
  /velvet_master_media_hmac_secret_production_2026/
];

for (const file of filesToCheck) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, "utf-8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(
        !pattern.test(content),
        `¡ALERTA DE SEGURIDAD! Secreto detectado en ${file} con patrón ${pattern}`
      );
    }
  }
}
console.log("✓ CERO secretos hardcodeados en los archivos auditados.");

// 2. Verificación de Web Crypto API (HMAC-SHA256) y eliminación de XOR
console.log("\n[2] Verificando firma y validación de tokens Web Crypto (HMAC-SHA256)...");
const functionsCode = fs.readFileSync(path.join("functions", "api", "[[path]].js"), "utf-8");

assert.ok(functionsCode.includes("async function getHmacKey"), "Debe implementar getHmacKey con Web Crypto");
assert.ok(functionsCode.includes("function timingSafeEqualHex"), "Debe implementar comparación en tiempo constante");
assert.ok(functionsCode.includes("async function encodeMediaToken"), "Debe implementar encodeMediaToken");
assert.ok(functionsCode.includes("async function decodeMediaToken"), "Debe implementar decodeMediaToken");
assert.ok(!functionsCode.includes("xorBytes"), "No debe contener lógica de descifrado XOR");

// Extraer el bloque de funciones utilitarias y criptográficas
const testModuleCode = functionsCode.substring(
  functionsCode.indexOf("// ============================================================================="),
  functionsCode.indexOf("export async function onRequest")
);

const testContext = {};
const fn = new Function("exports", testModuleCode + `
  exports.getHmacKey = getHmacKey;
  exports.timingSafeEqualHex = timingSafeEqualHex;
  exports.encodeMediaToken = encodeMediaToken;
  exports.decodeMediaToken = decodeMediaToken;
  exports.decodePayload = decodePayload;
  exports.isSafeUpstreamUrl = isSafeUpstreamUrl;
  exports.sanitizeSearchQuery = sanitizeSearchQuery;
  exports.sanitizeSlug = sanitizeSlug;
  exports.validateSort = validateSort;
  exports.validatePage = validatePage;
  exports.validatePageSize = validatePageSize;
  exports.getCorsHeaders = getCorsHeaders;
`);
fn(testContext);

const testSecret = "test_media_secret_secure_key_2026_subtle_crypto";
const testTargetUrl = "https://pmvhaven.com/video/sample1080p.mp4";
const testReferer = "https://pmvhaven.com/";

// Ejecución de pruebas asíncronas de Web Crypto
async function runCryptoTests() {
  // 2.1 Comparación en tiempo constante
  assert.equal(testContext.timingSafeEqualHex("abcdef0123456789", "abcdef0123456789"), true);
  assert.equal(testContext.timingSafeEqualHex("abcdef0123456789", "abcdef0123456780"), false);
  assert.equal(testContext.timingSafeEqualHex("abcdef", "abcdef00"), false);

  // 2.2 Generación y verificación de token válido
  const token = await testContext.encodeMediaToken(testTargetUrl, testReferer, testSecret);
  assert.ok(token.includes("."), "El token debe contener el separador punto entre payload y firma");
  const parts = token.split(".");
  assert.equal(parts.length, 2, "El token debe tener exactamente payload y firma");
  assert.equal(parts[1].length, 64, "La firma HMAC-SHA256 debe tener 64 caracteres hexadecimales (256 bits)");

  const decoded = await testContext.decodeMediaToken(token, testSecret);
  assert.ok(decoded, "El token válido debe verificarse exitosamente");
  assert.equal(decoded.u, testTargetUrl);
  assert.equal(decoded.r, testReferer);
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000), "El token debe tener expiración futura");

  // 2.3 Token alterado en payload (tampering)
  const [b64Data, sig] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ u: "https://evil.com/malware.exe", exp: decoded.exp })).toString("base64url");
  const tamperedToken = `${tamperedPayload}.${sig}`;
  const tamperedRes = await testContext.decodeMediaToken(tamperedToken, testSecret);
  assert.equal(tamperedRes, null, "El token con payload alterado debe ser rechazado inmediatamente");

  // 2.4 Token alterado en firma
  const fakeSig = sig.substring(0, 63) + (sig[63] === "a" ? "b" : "a");
  const fakeSigToken = `${b64Data}.${fakeSig}`;
  const fakeSigRes = await testContext.decodeMediaToken(fakeSigToken, testSecret);
  assert.equal(fakeSigRes, null, "El token con firma alterada debe ser rechazado");

  // 2.5 Token expirado
  const expiredPayloadStr = JSON.stringify({ u: testTargetUrl, r: testReferer, exp: Math.floor(Date.now() / 1000) - 100 });
  const expiredB64 = Buffer.from(expiredPayloadStr).toString("base64url");
  const key = await testContext.getHmacKey(testSecret);
  const enc = new TextEncoder();
  const expSigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(expiredB64));
  const expSigHex = Array.from(new Uint8Array(expSigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const expiredToken = `${expiredB64}.${expSigHex}`;
  const expiredRes = await testContext.decodeMediaToken(expiredToken, testSecret);
  assert.equal(expiredRes, null, "El token expirado debe ser rechazado aunque la firma sea matemáticamente válida");

  // 2.6 Rechazo total de tokens XOR legados
  const legacyXorToken = Buffer.from("legacy_xor_encrypted_garbage_string").toString("base64url");
  const xorRes = await testContext.decodeMediaToken(legacyXorToken, testSecret);
  assert.equal(xorRes, null, "Cualquier token XOR sin firma HMAC debe ser rechazado sin excepción");

  // 2.7 decodePayload rechaza parámetros url directos sin token
  const payloadRes = await testContext.decodePayload(null, testSecret);
  assert.equal(payloadRes, null, "Petición sin token firmado debe rechazarse");

  console.log("✓ Web Crypto HMAC-SHA256 validado: tokens válidos, alterados, expirados y XOR probados exitosamente.");
}
await runCryptoTests();

// 3. Verificación de Protección Anti-SSRF y Lista Blanca de Dominios
console.log("\n[3] Verificando protección estricta Anti-SSRF...");
const dangerousUrls = [
  "http://localhost:8080/admin",
  "http://127.0.0.1:3000/internal",
  "http://127.0.0.2:80/",
  "http://169.254.169.254/latest/meta-data/", // AWS/Cloudflare metadata
  "http://10.0.0.5:8080/",
  "http://192.168.1.1/admin",
  "http://172.16.0.10/",
  "http://0.0.0.0:8000/",
  "http://[::1]/",
  "http://internal.service.local/",
  "https://attacker-domain.xyz/phishing.jpg",
  "file:///etc/passwd",
  "gopher://localhost:11211/",
  // Pruebas específicas de evasión por sufijo de dominio y límite de punto
  "https://evil-ovh.net/exploit.jpg",
  "https://ovh.net.evil.com/exploit.jpg",
  "https://attackerpmvhaven.com/malware.mp4",
  "https://pmvhaven.com.attacker.com/malware.mp4",
  // Alojamiento abierto de terceros (Blogger / páginas arbitrarias)
  "https://myblog.blogspot.com/image.jpg",
  "https://blogspot.com/evil.jpg",
  "https://malicious-phishing.pages.dev/exploit.jpg"
];

for (const badUrl of dangerousUrls) {
  assert.equal(
    testContext.isSafeUpstreamUrl(badUrl),
    false,
    `SSRF o evasión de límite de punto permitida indebidamente para: ${badUrl}`
  );
}

const legitimateUrls = [
  "https://pmvhaven.com/videos/hls/1080p.mp4",
  "https://pmvhavencloud.s3.eu-west-par.io.cloud.ovh.net/video.mp4",
  "https://comics18.org/data/covers/comic1.jpg",
  "https://comics18.net/data/covers/comic1.jpg",
  "https://melapelacomics.com/pages/01.webp",
  "https://qnmcejlxoufheisgkuyo.supabase.co/storage/v1/object/public/covers/1.jpg",
  "https://pic.xascdn.li/image.jpg",
  "https://cdn.leakgallery.com/media/test.jpg",
  "https://manhwaweb.com/uploads/1.jpg",
  "https://static-ap.cdnanp.com/img.jpg",
  "https://v3.cdnde.com/video.mp4",
  "https://morbohub.pages.dev/velvet_logo.png"
];

for (const goodUrl of legitimateUrls) {
  assert.equal(
    testContext.isSafeUpstreamUrl(goodUrl),
    true,
    `URL legítima rechazada indebidamente: ${goodUrl}`
  );
}
console.log("✓ Protección Anti-SSRF validada (bloquea IPs privadas, metadata de nube y cubre dominios de raspadores).");

// 4. Verificación de Sanitización Anti-Inyección PostgREST
console.log("\n[4] Verificando sanitización contra inyección en PostgREST...");
const maliciousQuery = "milf),id.gt.0,status.eq.blocked(";
const cleanQ = testContext.sanitizeSearchQuery(maliciousQuery);
assert.ok(!cleanQ.includes(")"), "No debe contener paréntesis de cierre");
assert.ok(!cleanQ.includes("("), "No debe contener paréntesis de apertura");
assert.ok(!cleanQ.includes(","), "No debe contener comas de PostgREST");
assert.ok(!cleanQ.includes("."), "No debe contener operadores de PostgREST");

assert.equal(testContext.validateSort("drop table;--"), "recent");
assert.equal(testContext.validateSort("views"), "views");
assert.equal(testContext.validatePage(-5), 1);
assert.equal(testContext.validatePage(99999999), 50000);
assert.equal(testContext.validatePageSize(500), 100);
console.log("✓ Validación y sanitización de parámetros contra inyección de filtros validada.");

// 5. Verificación de Cabeceras CORS
console.log("\n[5] Verificando cabeceras CORS...");
const wildcardHeaders = testContext.getCorsHeaders("*");
assert.equal(wildcardHeaders["Access-Control-Allow-Credentials"], undefined, "No debe permitir credenciales con origin wildcard");

const originHeaders = testContext.getCorsHeaders("https://morbohub.pages.dev");
assert.equal(originHeaders["Access-Control-Allow-Credentials"], "true");
assert.equal(originHeaders["Access-Control-Allow-Origin"], "https://morbohub.pages.dev");
console.log("✓ Cabeceras CORS estrictas verificadas conforme al estándar W3C/Fetch.");

// 6. Verificación de Scripts SQL y Separación de Auditoría vs Trigger
console.log("\n[6] Verificando existencia y contenido de scripts SQL...");
assert.ok(fs.existsSync(path.join("sql", "01_rls_policies.sql")), "sql/01_rls_policies.sql debe existir");
assert.ok(fs.existsSync(path.join("sql", "02_minor_protection_audit.sql")), "sql/02_minor_protection_audit.sql debe existir");
assert.ok(fs.existsSync(path.join("sql", "02_minor_protection_trigger.sql")), "sql/02_minor_protection_trigger.sql debe existir");
assert.ok(fs.existsSync(path.join("sql", "02b_minor_protection_backfill.sql")), "sql/02b_minor_protection_backfill.sql debe existir");

const rlsContent = fs.readFileSync(path.join("sql", "01_rls_policies.sql"), "utf-8");
assert.ok(rlsContent.includes("alter table public.profiles enable row level security;"));
assert.ok(rlsContent.includes("alter table public.items enable row level security;"));
assert.ok(rlsContent.includes("alter table public.favorites enable row level security;"));
assert.ok(rlsContent.includes("revoke select on public.items from anon;"), "Debe revocar select global a anon en items");
assert.ok(rlsContent.includes("status <> 'blocked'"));
assert.ok(rlsContent.includes("has_column_privilege('anon', 'public.items', 'pages'"), "Debe auditar que pages no sea accesible por anon");
assert.ok(rlsContent.includes("has_column_privilege('anon', 'public.items', 'video_sources'"), "Debe auditar que video_sources no sea accesible por anon");
assert.ok(rlsContent.includes("has_column_privilege('anon', 'public.items', 'status'"), "Debe auditar que status no sea accesible por anon");
assert.ok(rlsContent.includes("has_column_privilege('anon', 'public.items', 'real_people'"), "Debe auditar que real_people no sea accesible por anon");
assert.ok(rlsContent.includes("set local role anon;"), "Debe incluir pruebas de verificación como anon");

const minorAudit = fs.readFileSync(path.join("sql", "02_minor_protection_audit.sql"), "utf-8");
assert.ok(minorAudit.includes("oieastasi"), "Debe tener el mapeo corregido de leetspeak ($ -> s, ! -> i)");
assert.ok(!minorAudit.includes("create trigger"), "02_minor_protection_audit.sql debe ser estrictamente de solo lectura");

const minorTrigger = fs.readFileSync(path.join("sql", "02_minor_protection_trigger.sql"), "utf-8");
assert.ok(minorTrigger.includes("create trigger items_before_write"), "02_minor_protection_trigger.sql debe contener el trigger");
assert.ok(!minorTrigger.includes("update public.items"), "02_minor_protection_trigger.sql NO debe actualizar filas existentes por sí solo");

const minorBackfill = fs.readFileSync(path.join("sql", "02b_minor_protection_backfill.sql"), "utf-8");
assert.ok(minorBackfill.includes("items_backup_"), "02b_minor_protection_backfill.sql debe crear tabla de respaldo");
assert.ok(minorBackfill.includes("begin;"), "Debe ejecutarse en transacción begin");
assert.ok(minorBackfill.includes("commit;"), "Debe cerrarse con commit");
assert.ok(minorBackfill.includes("update public.items"), "Debe aplicar el update defensivo dentro de la transacción");

console.log("✓ Scripts SQL de RLS estricto, auditoría, trigger y backfill con respaldo verificados.");

console.log("\n=== TODAS LAS PRUEBAS DE LA FASE 2 PASARON CON ÉXITO ===");
