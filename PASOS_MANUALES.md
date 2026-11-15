# GUÍA DE PASOS MANUALES OBLIGATORIOS (POST-AUDITORÍA)
**Proyecto:** Velvet Hub / Morbohub  
**Fecha de Auditoría:** 15 de Noviembre de 2026  
**Objetivo:** Instrucciones paso a paso de acciones externas, rotación de credenciales, configuración en la nube y ejecución en base de datos que deben ser aplicadas manualmente por el administrador del sistema.

---

## ÍNDICE DE PASOS

1. [PASO 1: Rotación de Secretos y Llaves en Supabase](#paso-1-rotación-de-secretos-y-llaves-en-supabase)
2. [PASO 2: Rotación de Credenciales en Patreon Developer Portal](#paso-2-rotación-de-credenciales-en-patreon-developer-portal)
3. [PASO 3: Configuración de Variables de Entorno en Cloudflare Pages](#paso-3-configuración-de-variables-de-entorno-en-cloudflare-pages)
4. [PASO 4: Limpieza de Secretos en el Historial de Git](#paso-4-limpieza-de-secretos-en-el-historial-de-git)
5. [PASO 5: Ejecución de Scripts SQL en Supabase](#paso-5-ejecución-de-scripts-sql-en-supabase)
6. [PASO 6: Verificación de Ajustes de Build en Cloudflare Pages](#paso-6-verificación-de-ajustes-de-build-en-cloudflare-pages)
7. [PASO 7: Despliegue y Purga de Caché de Borde](#paso-7-despliegue-y-purga-de-caché-de-borde)

---

## PASO 1: Rotación de Secretos y Llaves en Supabase

> [!CAUTION]
> Debido a que las claves de Supabase (`anon` y `service_role`) estuvieron expuestas en el código fuente histórico antes de esta auditoría, **DEBEN ser invalidadas y regeneradas inmediatamente**.

1. Inicia sesión en tu cuenta de **[Supabase](https://supabase.com/dashboard)**.
2. Selecciona tu proyecto (`morbohub` / `velvet`).
3. Ve a **Project Settings** (icono de engranaje en la barra lateral) > **API**.
4. En la sección **JWT Settings**:
   - Localiza la opción **JWT Secret**.
   - Haz clic en **Generate new secret** o ingresa una cadena aleatoria segura de 64 caracteres.
   - Haz clic en **Apply changes**.
   *(Esto invalidará automáticamente todas las claves `anon` y `service_role` previamente emitidas y cerrará las sesiones activas comprometidas).*
5. Copia los nuevos valores generados:
   - **Project URL** (ejemplo: `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`)
   - **`anon` `public` key**
   - **`service_role` `secret` key** (guárdala en un gestor seguro como 1Password o Bitwarden; nunca la compartas).

---

## PASO 2: Rotación de Credenciales en Patreon Developer Portal

Si utilizas la integración de Patreon para membresías VIP:

1. Ingresa a **[Patreon Developer Portal](https://www.patreon.com/portal/registration/register-clients)**.
2. Localiza tu cliente registrado para Morbohub / Velvet Hub.
3. Haz clic en **Regenerate Client Secret**.
4. Copia el nuevo `PATREON_CLIENT_SECRET`.
5. Confirma que la **Redirect URI** esté apuntando a la URL canónica de producción:
   `https://morbohub.pages.dev/api/auth/patreon/callback`

---

## PASO 3: Configuración de Variables de Entorno en Cloudflare Pages

1. Inicia sesión en el **[Cloudflare Dashboard](https://dash.cloudflare.com/)**.
2. Ve a **Workers & Pages** > Selecciona tu proyecto **`morbohub`**.
3. Dirígete a **Settings** > **Environment variables**.
4. En la sección **Production** (y también en Preview si pruebas ramas), haz clic en **Add variables** o **Edit variables** y configura exactamente la siguiente lista:

| Nombre de la Variable | Valor a Configurar | Tipo / Cifrado |
| :--- | :--- | :--- |
| `SUPABASE_URL` | La URL de tu proyecto de Supabase (`https://xxxx.supabase.co`) | Plaintext |
| `SUPABASE_ANON_KEY` | La nueva clave pública `anon` regenerada en el Paso 1 | Plaintext |
| `SUPABASE_SERVICE_ROLE_KEY` | La nueva clave privada `service_role` regenerada en el Paso 1 | **Secret (Encrypt)** |
| `MEDIA_SECRET` | Genera una cadena aleatoria criptográfica de mínimo 32 caracteres (ejemplo generado con `openssl rand -hex 32`) | **Secret (Encrypt)** |
| `PATREON_CLIENT_ID` | Identificador de cliente obtenido en Patreon | Plaintext |
| `PATREON_CLIENT_SECRET` | El nuevo secreto regenerado en el Paso 2 | **Secret (Encrypt)** |
| `PATREON_CAMPAIGN_ID` | ID numérico de tu campaña de Patreon | Plaintext |
| `MASTER_EMAIL` | Correo del administrador de la plataforma | Plaintext |

5. Haz clic en **Save** para persistir las variables en el entorno de ejecución de Cloudflare Pages Functions.

---

## PASO 4: Limpieza de Secretos en el Historial de Git

> [!WARNING]
> Aunque los secretos ya fueron eliminados del árbol de trabajo actual, permanecen legibles en los commits antiguos del historial (`f7cac1f`, `eb4af5a`, `75d2262`, `340cc8e`). Antes de hacer público el repositorio o compartir acceso, purga el historial.

Se recomienda utilizar **`git-filter-repo`** (herramienta oficial recomendada por Git):

1. Realiza una copia de seguridad local completa de tu carpeta antes de continuar:
   ```powershell
   Copy-Item -Recurse VERSION_CLOUDFLARE VERSION_CLOUDFLARE_BACKUP
   ```
2. Instala `git-filter-repo` (requiere Python 3):
   ```powershell
   pip install git-filter-repo
   ```
3. Crea un archivo `expressions.txt` con los patrones exactos de las claves antiguas que deseas reemplazar por `REDACTED`:
   ```text
   regex:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+==>REDACTED_TOKEN
   ```
4. Ejecuta el filtro en tu repositorio:
   ```powershell
   git filter-repo --replace-text expressions.txt --force
   ```
5. Si deseas purgar archivos históricos que ya no deben existir (como viejos archivos `.env` o bases de datos):
   ```powershell
   git filter-repo --invert-paths --path .env --path .env.local --force
   ```
6. Si tienes un remoto configurado en GitHub/GitLab:
   ```powershell
   git remote add origin <URL_DE_TU_REPOSITORIO>
   git push origin fix/auditoria-completa --force
   ```

---

## PASO 5: Ejecución de Scripts SQL en Supabase

Abre el **SQL Editor** en el panel de control de Supabase (`https://supabase.com/dashboard/project/_/sql`). Ejecuta los archivos de la carpeta `sql/` **en el orden estricto indicado a continuación**:

### 1. `sql/01_rls_policies.sql` (Políticas de Seguridad a Nivel de Fila)
- **Qué hace:** Activa `ROW LEVEL SECURITY` en `public.items`, `profiles`, `favorites`, `invite_keys` y `source_aliases`.
- **Efecto:** Bloquea accesos no autorizados, protege las claves de invitación, asegura que los usuarios solo vean sus propios favoritos y restringe la visibilidad de contenidos bloqueados.
- **Instrucción:** Pega el contenido completo del archivo en el SQL Editor y presiona **Run**.

### 2. `sql/02_minor_protection_audit.sql` (Protección Estricta de Menores y Triggers)
- **Qué hace:** Audita si existen registros con palabras clave de riesgo, normaliza términos prohibidos y crea un trigger `trg_prevent_illegal_terms` que rechaza automáticamente (`RAISE EXCEPTION`) cualquier inserción o actualización futura que contenga términos ilícitos.
- **Instrucción:** Pega el contenido y presiona **Run**. Verifica en la pestaña de resultados que la tabla de auditoría reporte `0` registros de riesgo.

### 3. `sql/03_data_integrity_audit.sql` (Auditoría de Integridad de Catálogo - Solo Lectura)
- **Qué hace:** Es un script 100% de solo lectura (`SELECT`). Detecta cómics con 0 páginas, portadas caídas o vacías, duplicados y desajustes de conteo.
- **Instrucción:** Pega el contenido y presiona **Run**. Revisa los resultados para identificar qué ítems requieren enriquecimiento o re-escaneo con los scrapers.

### 4. `sql/04_indexes.sql` (Índices Concurrentes de Alto Rendimiento)
- **Qué hace:** Crea índices parciales compuestos y GIN (`CONCURRENTLY IF NOT EXISTS`) para acelerar la paginación a menos de 15ms y las búsquedas trigram a menos de 50ms.
- **Instrucción:** Pega el contenido y presiona **Run**.
> **Nota:** La instrucción `CONCURRENTLY` garantiza que tus tablas no sufran ningún bloqueo de lectura ni escritura mientras se construyen los índices.

### 5. `sql/05_thumbnails_lqip.sql` (Migración de Color Dominante y LQIP)
- **Qué hace:** Añade de forma no bloqueante (`DEFAULT NULL`, operación O(1)) las columnas `thumb_color` y `thumb_lqip` en la tabla `public.items`.
- **Instrucción:** Pega el contenido y presiona **Run**. Incluye la consulta de actualización por lotes en segundo plano para poblar progresivamente las miniaturas sin saturar la base de datos.

---

## PASO 6: Verificación de Ajustes de Build en Cloudflare Pages

En el dashboard de Cloudflare:

1. Ve a **Workers & Pages** > **`morbohub`** > **Settings** > **Builds & deployments**.
2. Verifica que los parámetros de compilación sean exactamente los siguientes:
   - **Framework preset:** `None`
   - **Build command:** *(dejar completamente vacío)*
   - **Build output directory:** `public`
   - **Root directory:** `/` (o `VERSION_CLOUDFLARE` si desplegaste desde la raíz de un monorepo).
3. En la sección **Functions** > **Compatibility flags**:
   - Agrega la bandera: `nodejs_compat`
   - Fecha de compatibilidad: `2024-09-23` (o la más reciente disponible).

---

## PASO 7: Despliegue y Purga de Caché de Borde

1. **Despliegue de la rama auditada:**
   Si tienes integración continua con Git conectada a Cloudflare Pages, haz merge de la rama `fix/auditoria-completa` a tu rama de producción (`main` / `master`) o sube la rama para generar un despliegue de vista previa.
   
   Alternativamente, puedes desplegar directamente por CLI con Wrangler:
   ```powershell
   cd VERSION_CLOUDFLARE
   npx wrangler pages deploy public --project-name=morbohub
   ```

2. **Purga Completa de Caché de Cloudflare Edge:**
   - Ve a **Caching** > **Configuration** en el panel del dominio Cloudflare.
   - Haz clic en **Purge Everything**.
   - Confirma la acción.
   *(Esto asegura que las respuestas viejas con caché de paginación o el Service Worker v10 sean inmediatamente sustituidos por el nuevo shell y Service Worker `v11-velvet-turbo`).*

3. **Verificación Inmediata en Navegador:**
   - Abre `https://morbohub.pages.dev/api/version`.
   - Debes recibir la respuesta JSON con `"version": "3.1.0"` y `"cache_version": "v11-velvet-turbo"`.
   - En el pie de página de la web principal debe mostrarse discretamente:  
     `v3.1.0 (v11-velvet-turbo) • Cloudflare Pages Native`.

---
*Fin de la guía de pasos manuales.*
