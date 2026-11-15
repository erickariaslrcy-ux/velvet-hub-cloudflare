# Guía de Rotación y Despliegue Zero-Downtime

Esta guía detalla el **flujo exacto de 10 pasos en orden estricto** para migrar, desplegar, rotar credenciales y purgar el historial sin provocar caídas ni interrupciones de servicio (*Zero-Downtime*).

> [!CAUTION]
> **REGLA DE ORO DE ZERO-DOWNTIME:**
> **NUNCA** rotes las claves en Supabase antes de desplegar el código nuevo en producción. Si rotas las claves antes, tu sitio en producción quedará inmediatamente roto con errores `401 Unauthorized` para todos los usuarios mientras compila el despliegue.

---

## 📊 Tabla Unificada de Variables de Entorno

| Variable | Tipo | Obligatoria | Para qué sirve en el Sistema | De dónde se copia el valor |
| :--- | :--- | :--- | :--- | :--- |
| `SUPABASE_URL` | Plain text | **Sí** | URL base de la API REST PostgREST y Auth | Supabase Dashboard ➔ Project Settings ➔ API ➔ Project URL |
| `SUPABASE_ANON_KEY` | Plain text | **Sí** | Clave pública para catálogo general y sesiones de usuario bajo RLS | Supabase Dashboard ➔ Project Settings ➔ API ➔ Project API keys (`anon` `public`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** 🔒 | **Sí** | Clave administrativa del backend para consultar páginas de cómics y videos en el servidor | Supabase Dashboard ➔ Project Settings ➔ API ➔ Project API keys (`service_role` `secret`) |
| `MEDIA_SECRET` | **Secret** 🔒 | **Sí** | Secreto de 256 bits para firma Web Crypto HMAC-SHA256 de `/api/media` | Generado en terminal local: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ENVIRONMENT` | Plain text | No (def: `production`) | Identifica si el entorno es `production` o `preview` | Escribir `production` o `preview` |
| `POSTGREST_COUNT_MODE` | Plain text | No (def: `count=exact`) | Modo de conteo en catálogo (`count=exact` o `count=estimated`) | Escribir `count=exact` (o `count=estimated` si supera 100k items) |
| `ENABLE_PMVHAVEN_LIVE` | Plain text | No (def: `true`) | Activa o desactiva la consulta en vivo a la API externa de PMVHaven | Escribir `true` o `false` |
| `PATREON_CLIENT_ID` | Plain text | No | ID de cliente OAuth2 para vinculación de cuentas Patreon | Patreon Developer Portal ➔ My Clients ➔ Client ID |
| `PATREON_CLIENT_SECRET` | **Secret** 🔒 | No | Clave secreta OAuth2 para intercambiar tokens de Patreon | Patreon Developer Portal ➔ My Clients ➔ Client Secret |
| `PATREON_CAMPAIGN_ID` | Plain text | No | Identificador de campaña de Patreon para validar tiers | Patreon Creator Dashboard ➔ Configuración de Campaña |

---

## 🚀 Secuencia de Operación en 10 Pasos

### Paso 1: Revocar Token de GitHub
- **Tiempo**: 1 minuto.
- **Ruta**: GitHub ➔ *Settings* ➔ *Developer Settings* ➔ *Personal Access Tokens* ➔ *Tokens (classic)*.
- **Acción**: Si utilizaste un token personal en algún comando o URL remota, pulsa **Revoke**. Esto neutraliza cualquier token expuesto sin afectar a los visitantes de tu web.
- **Señal de éxito**: El token desaparece del listado en GitHub.

---

### Paso 2: Ejecutar Verificación Pre-vuelo
- **Tiempo**: 1 minuto.
- **Ruta**: Consola de PowerShell en la raíz del proyecto.
- **Acción**: Ejecuta:
  ```powershell
  .\tools\00_preflight.ps1
  ```
- **Señal de éxito**: Imprime `RESULTADO PRE-VUELO: APROBADO (Todo listo)`.

---

### Paso 3: Aplicar Script SQL Maestro en Supabase
- **Tiempo**: 2 minutos.
- **Ruta**: [Supabase Dashboard ➔ SQL Editor](https://supabase.com/dashboard/project/_/sql).
- **Acción**: Abre una nueva consulta (*New query*), pega el contenido íntegro de [`sql/EJECUTAR_TODO_EN_ORDEN.sql`](file:///sql/EJECUTAR_TODO_EN_ORDEN.sql) y pulsa **Run**.
- **Señal de éxito**: En la pestaña *Messages* aparece: `NOTICE: TODO EL SCRIPT SE EJECUTÓ CORRECTAMENTE. 100% APROBADO.`

---

### Paso 4: Verificar Permisos del Rol `anon` en Vivo
- **Tiempo**: 1 minuto.
- **Ruta**: Consola de PowerShell local.
- **Acción**: Ejecuta:
  ```powershell
  .\tools\01_verificar_anon.ps1
  ```
  (Ingresa tu URL de Supabase y tu clave `anon` actual con entrada oculta).
- **Señal de éxito**: Imprime `RESULTADO: APROBADO (La seguridad del rol anon es sólida)`.

---

### Paso 5: Subir Rama y Cargar Variables en Preview de Cloudflare
- **Tiempo**: 4 minutos.
- **Ruta**:
  1. Terminal: Ejecuta `.\tools\03_preview.ps1` para subir la rama `fix/auditoria-completa` a origin (push normal, sin `--force`).
  2. Cloudflare Dashboard ➔ *Workers & Pages* ➔ *morbohub* ➔ *Settings* ➔ *Environment variables*.
- **Acción**: En la sección **Preview**, añade las 4 variables críticas usando tus **claves actuales** y un **`MEDIA_SECRET` nuevo** (generado con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`):
  - `SUPABASE_URL`: Tu URL actual de Supabase
  - `SUPABASE_ANON_KEY`: Tu clave anon actual
  - `SUPABASE_SERVICE_ROLE_KEY`: Tu clave service_role actual *(Encrypt 🔒)*
  - `MEDIA_SECRET`: El nuevo secreto generado *(Encrypt 🔒)*
  - `ENVIRONMENT`: `preview`
- **Señal de éxito**: Cloudflare Pages despliega automáticamente la rama con una URL de preview (`https://fix-auditoria-completa.morbohub.pages.dev`).

---

### Paso 6: Probar Preview en PC y Android
- **Tiempo**: 5 minutos.
- **Ruta**: Terminal local y navegador móvil.
- **Acción**:
  1. Ejecuta la prueba automatizada contra la URL de Preview:
     ```powershell
     .\tools\04_probar_preview.ps1 -PreviewUrl "https://fix-auditoria-completa.morbohub.pages.dev"
     ```
  2. Abre la URL en Chrome de PC y Chrome de Android y verifica los botones interactivos según [`CHECKLIST_BOTONES.md`](file:///CHECKLIST_BOTONES.md).
- **Señal de éxito**: `04_probar_preview.ps1` imprime `RESULTADO PREVIEW: APROBADO`.

---

### Paso 7: Cargar Variables en Production, Merge, Deploy y Purgar Caché
- **Tiempo**: 4 minutos.
- **Ruta**: Cloudflare Dashboard ➔ *Workers & Pages* ➔ *morbohub*.
- **Acción**:
  1. En *Settings ➔ Environment variables*, copia exactamente las mismas variables configuradas en Preview a la sección **Production**.
  2. Haz merge de la rama `fix/auditoria-completa` a tu rama principal (`main` o `master`) en GitHub.
  3. Espera a que Cloudflare Pages complete el despliegue de Producción.
  4. En Cloudflare Dashboard ➔ *Caching* ➔ *Configuration*, haz clic en **Purge Everything** para eliminar cualquier HTML o Service Worker anterior en caché de borde.
- **Señal de éxito**: Al visitar `https://morbohub.pages.dev`, el sitio carga la versión `3.1.0` y el Service Worker `v11-velvet-turbo`.

---

### Paso 8: Rotar Claves en Supabase y Patreon (Actualizar Variables de Inmediato)
- **Tiempo**: 3 minutos.
- **Ruta**: Supabase Dashboard ➔ *Project Settings* ➔ *API*.
- **Acción**:
  1. En **JWT Settings**, pulsa **Generate a new secret** (o *Roll keys*). Esto invalida las claves antiguas.
  2. Copia de inmediato la nueva `anon public` y la nueva `service_role secret`.
  3. En Patreon Developer Portal, pulsa **Generate New Creators Access Token** (si utilizas Patreon).
  4. Ve de inmediato a Cloudflare Dashboard ➔ *Settings* ➔ *Environment variables* (Production) y actualiza los valores de `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `PATREON_CLIENT_SECRET`.
  5. Pulsa **Save** y en la pestaña *Deployments* haz clic en **Retry deployment** en el último despliegue para aplicar las nuevas claves.
- **Señal de éxito**: `.\tools\01_verificar_anon.ps1` con la nueva clave responde `APROBADO`. La web sigue funcionando sin interrupciones.

---

### Paso 9: Activar Trigger de Protección a Menores y Saneamiento Histórico
- **Tiempo**: 2 minutos.
- **Ruta**: Supabase Dashboard ➔ *SQL Editor*.
- **Acción**:
  1. Ejecuta primero [`sql/02_minor_protection_audit.sql`](file:///sql/02_minor_protection_audit.sql) para ver el desglose cuantitativo por término sin exponer títulos.
  2. Ejecuta [`sql/02_minor_protection_trigger.sql`](file:///sql/02_minor_protection_trigger.sql) para activar el trigger defensivo `items_before_write` sobre nuevas inserciones.
  3. Ejecuta [`sql/02b_minor_protection_backfill.sql`](file:///sql/02b_minor_protection_backfill.sql) para respaldar las filas detectadas en `items_backup_20261115` y aplicar el bloqueo preventivo transaccional.
- **Señal de éxito**: El backfill reporta 0 elementos pendientes tras el `UPDATE`.

---

### Paso 10: Limpiar Historial de Git en un Espejo Temporal
- **Tiempo**: 3 minutos.
- **Ruta**: Consola de PowerShell local.
- **Acción**: Ejecuta:
  ```powershell
  .\tools\06_limpiar_historial.ps1
  ```
  El script clona un espejo temporal en `$env:TEMP`, elimina archivos `.env`, reemplaza las cadenas secretas históricas con `git filter-repo --replace-text` y verifica que ya no quede ningún secreto.
  Revisa el resumen y, solo si estás conforme, ejecuta el comando que el script te indica para aplicar el cambio en GitHub:
  ```powershell
  cd $tempDir
  git push --mirror --force origin
  ```
- **Señal de éxito**: `06_limpiar_historial.ps1` reporta `✓ El historial del clon espejo está 100% LIMPIO de secretos conocidos.`
