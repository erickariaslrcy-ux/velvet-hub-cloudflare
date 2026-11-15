# Lo Que Solo Tú Puedes Hacer (Checklist Mínimo Zero-Downtime)

Este documento contiene la **secuencia cronológica estricta de 10 pasos** para completar la entrega. Todo el código, migraciones, pruebas y verificaciones ya fueron automatizados.

> [!IMPORTANT]
> **REGLA ZERO-DOWNTIME:** Las claves de Supabase se rotan en el **Paso 8** (después de desplegar el código nuevo en Producción en el Paso 7). Nunca antes, para no romper el servicio a los usuarios activos.

---

### [1] Revocar Token Personal de GitHub (si se utilizó)
- **Panel**: GitHub ➔ *Settings* ➔ *Developer Settings* ➔ *Personal Access Tokens*
- **Tiempo**: 1 min | **Acción**: Pulsa *Revoke* en cualquier token expuesto.

### [2] Ejecutar Preflight Automatizado
- **Terminal**: `.\tools\00_preflight.ps1`
- **Tiempo**: 1 min | **Comprobación**: Debe imprimir `RESULTADO PRE-VUELO: APROBADO`.

### [3] Aplicar SQL Maestro en Supabase
- **Panel**: [Supabase Dashboard ➔ SQL Editor](https://supabase.com/dashboard/project/_/sql)
- **Tiempo**: 2 min | **Acción**: Pega [`sql/EJECUTAR_TODO_EN_ORDEN.sql`](file:///sql/EJECUTAR_TODO_EN_ORDEN.sql) y pulsa **Run**.
- **Comprobación**: Mensaje `NOTICE: TODO EL SCRIPT SE EJECUTÓ CORRECTAMENTE. 100% APROBADO.`

### [4] Verificar Permisos de Anon en Vivo
- **Terminal**: `.\tools\01_verificar_anon.ps1`
- **Tiempo**: 1 min | **Comprobación**: Debe imprimir `RESULTADO: APROBADO`.

### [5] Subir Rama y Cargar Variables en Preview de Cloudflare
- **Terminal**: `.\tools\03_preview.ps1` (sube la rama a origin sin `--force`).
- **Panel**: [Cloudflare Dashboard ➔ Workers & Pages ➔ morbohub ➔ Settings ➔ Environment variables](https://dash.cloudflare.com/)
- **Tiempo**: 3 min | **Acción**: En la sección **Preview**, añade las variables con tus **claves actuales** y un nuevo `MEDIA_SECRET` (generado con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`):
  - `SUPABASE_URL`: Tu URL actual
  - `SUPABASE_ANON_KEY`: Tu clave anon actual
  - `SUPABASE_SERVICE_ROLE_KEY`: Tu clave service_role actual *(Encrypt 🔒)*
  - `MEDIA_SECRET`: El nuevo secreto generado *(Encrypt 🔒)*
  - `ENVIRONMENT`: `preview`

### [6] Probar Preview en PC y Android
- **Terminal**: `.\tools\04_probar_preview.ps1 -PreviewUrl "https://su-url.pages.dev"`
- **Tiempo**: 4 min | **Acción**: Revisa botones interactivos según [`CHECKLIST_BOTONES.md`](file:///CHECKLIST_BOTONES.md).
- **Comprobación**: Debe imprimir `RESULTADO PREVIEW: APROBADO`.

### [7] Cargar Variables en Production, Merge, Deploy y Purgar Caché
- **Panel**: Cloudflare Pages ➔ *Settings ➔ Environment variables* (Production).
- **Tiempo**: 3 min | **Acción**:
  1. Copia exactamente las mismas variables a **Production**.
  2. Haz merge de `fix/auditoria-completa` a `main`/`master` y espera el deploy.
  3. En Cloudflare Dashboard ➔ *Caching* ➔ *Configuration*, haz clic en **Purge Everything**.
- **Comprobación**: Visita `https://morbohub.pages.dev` y comprueba que carga la versión 3.1.0.

### [8] Rotar Claves en Supabase y Patreon (Actualizar Variables de Inmediato)
- **Panel**: Supabase ➔ *Settings* ➔ *API* ➔ **JWT Settings** ➔ *Generate a new secret*.
- **Tiempo**: 3 min | **Acción**:
  1. Copia la nueva `anon public` y `service_role secret`.
  2. En Cloudflare Pages (*Production*), actualiza `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` y pulsa **Save**.
  3. En la pestaña *Deployments*, haz clic en **Retry deployment** en el último deploy.
- **Comprobación**: `.\tools\01_verificar_anon.ps1` con la nueva clave devuelve `APROBADO`.

### [9] Activar Trigger de Menores y Saneamiento Histórico
- **Panel**: Supabase Dashboard ➔ *SQL Editor*
- **Tiempo**: 2 min | **Acción**:
  1. Ejecuta [`sql/02_minor_protection_audit.sql`](file:///sql/02_minor_protection_audit.sql) (conteo por término seguro).
  2. Ejecuta [`sql/02_minor_protection_trigger.sql`](file:///sql/02_minor_protection_trigger.sql) (activa trigger defensivo).
  3. Ejecuta [`sql/02b_minor_protection_backfill.sql`](file:///sql/02b_minor_protection_backfill.sql) (respaldo y UPDATE transaccional).
- **Comprobación**: El backfill confirma 0 elementos pendientes tras el bloqueo.

### [10] Limpiar Historial de Git en Espejo Temporal (Opcional)
- **Terminal**: `.\tools\06_limpiar_historial.ps1`
- **Tiempo**: 3 min | **Acción**: El script purga `.env` y sustituye secretos conocidos en un clon espejo fuera del proyecto, certifica que ya no quedan cadenas y te indica el comando manual para hacer push si estás conforme.
