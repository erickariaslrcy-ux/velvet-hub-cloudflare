-- ==============================================================================
-- 02B_MINOR_PROTECTION_BACKFILL.SQL
-- SANEAMIENTO Y RESPALDO HISTÓRICO DE ELEMENTOS (TRANSACCIÓN PROTEGIDA)
-- Proyecto: Velvet Hub / Morbohub
-- Estado: Ejecutar tras revisar 02_minor_protection_audit.sql e instalar 02_minor_protection_trigger.sql.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CONTEO PREVIO DE FILAS AFECTADAS
-- ------------------------------------------------------------------------------
select count(*) as items_detectados_para_bloqueo
from public.items
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  );

-- ------------------------------------------------------------------------------
-- 2. TRANSACCIÓN ATÓMICA CON CREACIÓN DE RESPALDO Y BLOQUEO PREVENTIVO
-- ------------------------------------------------------------------------------
begin;

-- 2.1 Crear tabla de respaldo fechada con las filas exactas que van a ser bloqueadas
-- Permite trazabilidad y restauración inmediata en caso de falsos positivos.
create table if not exists public.items_backup_20261115 as
select *
from public.items
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  );

-- 2.2 Aplicación del bloqueo defensivo a nivel de registro
update public.items
set status = 'blocked'
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  );

-- 2.3 Verificación de éxito dentro de la transacción (debe retornar 0)
select count(*) as items_pendientes_tras_update
from public.items
where status <> 'blocked'
  and (
    public.minor_content_match(coalesce(search_text, ''))
    or public.minor_content_match(coalesce(title, ''))
  );

commit;

-- ------------------------------------------------------------------------------
-- 3. CONSULTA DE VERIFICACIÓN POST-COMMIT
-- ------------------------------------------------------------------------------
select
  (select count(*) from public.items_backup_20261115) as total_respaldados,
  (select count(*) from public.items where status = 'blocked') as total_bloqueados_en_items;
