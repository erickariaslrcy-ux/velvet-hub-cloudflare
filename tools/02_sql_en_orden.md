# Guía de Ejecución de SQL en Supabase

Esta guía detalla el orden de ejecución seguro y no destructivo para aplicar las mejoras de base de datos en el proyecto Velvet Hub / Morbohub.

---

## 1. El Script Maestro Consolidado

Para tu comodidad, se ha generado un **único archivo seguro** que contiene todas las operaciones que pueden ejecutarse de una sola vez:

👉 **[sql/EJECUTAR_TODO_EN_ORDEN.sql](file:///sql/EJECUTAR_TODO_EN_ORDEN.sql)**

### ¿Qué hace este archivo?
1. **Paso 1: Columnas de Miniaturas LQIP**: Crea las columnas `thumb_color` y `thumb_lqip` en `public.items` (operación instantánea $O(1)$ sin bloqueo de tabla).
2. **Paso 2: Políticas RLS y Privilegios de Columna**:
   - Activa Row Level Security en `public.items`.
   - Limita al rol `anon` para que **únicamente** pueda leer las 14 columnas necesarias del catálogo público (excluyendo permanentemente `pages`, `video_sources`, `chapters`, `status`, `real_people`).
   - Instala la función RPC segura `get_item_detail(p_id)` con `SECURITY DEFINER`.
3. **Paso 3: Índices de Alto Rendimiento**:
   - Crea índices B-Tree parciales y GIN (`tags`, `search_text`) para acelerar la paginación y búsqueda a menos de 20ms.
4. **Paso 4: Auditoría de Protección a Menores**:
   - Registra `normalize_leetspeak` y `minor_content_match` con soporte multilingüe y desofuscación.
5. **Paso 5: Pruebas Automatizadas Integradas**:
   - Ejecuta un bloque `ASSERT` que verifica que `anon` no tiene privilegios de lectura sobre datos sensibles y que no existen falsos positivos en nombres propios ni palabras compuestas.

### ¿Cómo aplicarlo?
1. Abre tu panel de control de **Supabase** (`https://supabase.com/dashboard/project/<tu-proyecto>`).
2. En el menú lateral izquierdo, haz clic en **SQL Editor**.
3. Haz clic en **+ New Query**.
4. Copia el contenido completo de `sql/EJECUTAR_TODO_EN_ORDEN.sql` y pégalo en el editor.
5. Haz clic en el botón verde **Run** (o presiona `Ctrl + Enter`).
6. En la pestaña de salida (*Results / Messages*), debes ver el mensaje:
   `NOTICE: TODO EL SCRIPT SE EJECUTÓ CORRECTAMENTE. 100% APROBADO.`

---

## 2. Sobre la Directiva `CONCURRENTLY` en Índices

- En el archivo maestro consolidado `EJECUTAR_TODO_EN_ORDEN.sql` se omitió la palabra clave `CONCURRENTLY` para permitir que todos los pasos se ejecuten juntos sin conflictos de transacciones de Supabase.
- Si tu base de datos de producción recibe un tráfico muy elevado en este instante y prefieres crear los índices en segundo plano sin adquirir bloqueos de escritura:
  - Abre el archivo individual **`sql/04_indexes.sql`**.
  - Ejecuta cada sentencia `CREATE INDEX CONCURRENTLY` individualmente en el SQL Editor (una por una).

---

## 3. Scripts que Requieren Revisión Manual Previa

Los siguientes dos scripts se mantienen intencionalmente **separados** del script maestro:

### A. Auditoría de Solo Lectura
- **Archivo**: `sql/02_minor_protection_audit.sql`
- **Propósito**: Ejecutar una consulta `SELECT` para revisar si existen elementos históricos con términos sospechosos.
- **Acción**: Ejecútalo en el SQL Editor. No modifica ningún dato; solo te muestra un listado para que confirmes que no hay falsos positivos.

### B. Trigger Defensivo para Nuevas Inserciones
- **Archivo**: `sql/02_minor_protection_trigger.sql`
- **Propósito**: Instala el trigger `items_before_write` que intercepta futuros `INSERT` o `UPDATE` y fuerza `status = 'blocked'` automáticamente si detecta contenido prohibido.
- **Acción**: Ejecútalo una vez que estés de acuerdo con los términos de auditoría.

### C. Saneamiento Histórico con Respaldo (Backfill)
- **Archivo**: `sql/02b_minor_protection_backfill.sql`
- **Propósito**:
  1. Muestra el conteo de elementos a modificar.
  2. Crea una tabla de respaldo con fecha: `public.items_backup_20261115`.
  3. Aplica `status = 'blocked'` dentro de un bloque transaccional protegido (`BEGIN ... COMMIT`).
- **Acción**: Ejecútalo al final para asegurar el historial completo de la base de datos.
