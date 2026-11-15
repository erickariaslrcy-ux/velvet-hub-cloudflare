import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("=== INICIANDO PRUEBAS UNITARIAS DE BASE DE DATOS E INTEGRIDAD (FASE 4) ===");

// 1. Verificación de existencia de los 6 scripts SQL (incluyendo separación de trigger)
console.log("\n[1] Verificando presencia de los 6 scripts SQL requeridos...");
const sqlFiles = [
  "01_rls_policies.sql",
  "02_minor_protection_audit.sql",
  "02_minor_protection_trigger.sql",
  "03_data_integrity_audit.sql",
  "04_indexes.sql",
  "05_thumbnails_lqip.sql"
];

for (const file of sqlFiles) {
  const filePath = path.join("sql", file);
  assert.ok(fs.existsSync(filePath), `El script ${filePath} debe existir`);
  const content = fs.readFileSync(filePath, "utf-8");
  assert.ok(content.length > 100, `El script ${filePath} no debe estar vacío`);
}
console.log("✓ Los 5 scripts SQL están presentes y estructurados.");

// 2. Verificación de que 03_data_integrity_audit.sql sea 100% de solo lectura
console.log("\n[2] Verificando que 03_data_integrity_audit.sql sea estrictamente de solo lectura (SELECT)...");
const auditSql = fs.readFileSync(path.join("sql", "03_data_integrity_audit.sql"), "utf-8");
assert.ok(!/\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER)\b/i.test(auditSql), "03_data_integrity_audit.sql NO debe contener operaciones destructivas");
assert.ok(auditSql.includes("SELECT"), "Debe contener consultas SELECT");
assert.ok(auditSql.includes("real_pages_count"), "Debe auditar el conteo real de páginas");
assert.ok(auditSql.includes("discrepancy"), "Debe auditar discrepancias entre page_count y JSON");
assert.ok(auditSql.includes("duplicate_count"), "Debe auditar duplicados");
console.log("✓ Script de auditoría verificado como 100% seguro y de solo lectura.");

// 3. Verificación de creación concurrente de índices en 04_indexes.sql
console.log("\n[3] Verificando creación segura de índices (CONCURRENTLY) en 04_indexes.sql...");
const indexSql = fs.readFileSync(path.join("sql", "04_indexes.sql"), "utf-8");
assert.ok(indexSql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_media_type_id_desc"), "Debe incluir índice (media_type, id DESC)");
assert.ok(indexSql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_tags_gin"), "Debe incluir índice GIN sobre tags");
assert.ok(indexSql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_search_trgm"), "Debe incluir índice trigrama sobre search_text");
assert.ok(indexSql.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_favorites_user_item"), "Debe incluir índice sobre favorites");
console.log("✓ Índices concurrentes de alto rendimiento verificados.");

// 4. Verificación de migración LQIP no bloqueante en 05_thumbnails_lqip.sql
console.log("\n[4] Verificando migración de miniaturas LQIP en 05_thumbnails_lqip.sql...");
const lqipSql = fs.readFileSync(path.join("sql", "05_thumbnails_lqip.sql"), "utf-8");
assert.ok(lqipSql.includes("ADD COLUMN IF NOT EXISTS thumb_color varchar(7) DEFAULT NULL"), "thumb_color debe ser DEFAULT NULL (no bloqueante)");
assert.ok(lqipSql.includes("ADD COLUMN IF NOT EXISTS thumb_lqip text DEFAULT NULL"), "thumb_lqip debe ser DEFAULT NULL (no bloqueante)");
console.log("✓ Migración LQIP no bloqueante verificada.");

// 5. Verificación de sync/sync_supabase.py (reintentos y saneamiento)
console.log("\n[5] Verificando robustez y privacidad en sync/sync_supabase.py...");
const syncPy = fs.readFileSync(path.join("sync", "sync_supabase.py"), "utf-8");
assert.ok(syncPy.includes("def sanitize_log_message"), "Debe definir sanitize_log_message");
assert.ok(syncPy.includes("requests.exceptions.RequestException"), "Debe capturar excepciones de red");
assert.ok(syncPy.includes("backoff"), "Debe implementar reintentos con backoff exponencial");
assert.ok(!syncPy.includes("print(f\"  ! Error {resp.status_code}: {resp.text[:300]}\")"), "No debe imprimir resp.text sin sanear");
console.log("✓ Script de sincronización con backoff exponencial y registro seguro validado.");

console.log("\n=== TODAS LAS PRUEBAS DE LA FASE 4 PASARON CON ÉXITO ===");
