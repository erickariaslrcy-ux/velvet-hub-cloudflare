# Guía Paso a Paso de Rotación de Credenciales

Esta guía describe con exactitud cada pantalla, campo y botón necesario para rotar las credenciales expuestas en el historial anterior y cargar las nuevas variables seguras en Cloudflare Pages.

---

## 📋 Resumen de Variables y Destinos

| Nombre de Variable | Nivel de Secreto | Dónde se Genera | Dónde se Configura |
| :--- | :--- | :--- | :--- |
| `SUPABASE_URL` | Público | Supabase Dashboard | Cloudflare Pages (Variables) |
| `SUPABASE_ANON_KEY` | Semipúblico (Catálogo) | Supabase Dashboard | Cloudflare Pages (Variables) |
| `SUPABASE_SERVICE_ROLE_KEY` | **CRÍTICO / Secreto** | Supabase Dashboard | Cloudflare Pages (Encrypt / Secret) |
| `MEDIA_SECRET` | **CRÍTICO / Secreto** | Consola local (Web Crypto) | Cloudflare Pages (Encrypt / Secret) |
| `PATREON_CREATOR_ACCESS_TOKEN` | **CRÍTICO / Secreto** | Patreon Developer Portal | Cloudflare Pages (Encrypt / Secret) |

---

## 🖥️ Pantalla 1: Rotar Claves en Supabase (JWT Secret & API Keys)

- **Tiempo estimado**: 3 minutos.
- **Ruta de acceso**: [https://supabase.com/dashboard](https://supabase.com/dashboard) ➔ Selecciona tu proyecto ➔ Ícono de engranaje (**Project Settings**) ➔ **API**.

### Descripción visual de la pantalla:
1. En la página de configuración de API verás dos secciones principales:
   - **Project URL**: Muestra tu `URL` (ej. `https://qnmcejlxoufheisgkuyo.supabase.co`).
   - **Project API keys**: Muestra `anon public` y `service_role secret`.
   - **JWT Settings**: Más abajo verás el campo `JWT Secret`.
2. Dirígete a la sección **JWT Settings**.
3. Haz clic en el botón **Generate a new secret** (o **Roll keys** / **Reset JWT Secret**).
4. El sistema mostrará un diálogo de confirmación advirtiendo que los tokens emitidos anteriormente dejarán de ser válidos. Confirma la acción.
5. Una vez regenerado:
   - Copia el nuevo valor de **`anon public`**.
   - Haz clic en *Reveal* en **`service_role secret`** y cópialo de inmediato en un bloc de notas temporal o gestor de contraseñas (este valor no se volverá a mostrar completo).

> [!IMPORTANT]
> **Señal de éxito**: Una consulta con la clave antigua devuelve `401 Unauthorized`. La nueva clave `anon` responde `200 OK` al consultar el catálogo.

---

## 🖥️ Pantalla 2: Rotar Contraseña de la Base de Datos (PostgreSQL)

- **Tiempo estimado**: 2 minutos.
- **Ruta de acceso**: Supabase Dashboard ➔ **Project Settings** ➔ **Database**.

### Descripción visual de la pantalla:
1. En la pestaña **Database**, desciende hasta la sección **Database Password**.
2. Haz clic en el botón **Reset database password**.
3. Aparecerá un formulario emergente con dos opciones: ingresar una contraseña propia o hacer clic en **Generate a password** (recomendado: genera una clave de 24+ caracteres alfanuméricos aleatorios).
4. Copia la nueva contraseña generada.
5. Haz clic en **Confirm password reset**.

> [!NOTE]
> Esta contraseña solo es requerida si ejecutas scripts locales de sincronización (`sync/sync_supabase.py`). Cloudflare Pages Functions **no** se conecta por TCP directo a Postgres; se comunica exclusivamente vía API HTTP PostgREST con la clave `service_role`.
> **Señal de éxito**: Un banner verde confirma *"Database password updated successfully"*.

---

## 🖥️ Pantalla 3: Rotar Token de Patreon API

- **Tiempo estimado**: 3 minutos.
- **Ruta de acceso**: [https://www.patreon.com/portal/registration/register-clients](https://www.patreon.com/portal/registration/register-clients)

### Descripción visual de la pantalla:
1. Inicia sesión con la cuenta creadora de Patreon vinculada al proyecto.
2. En la lista de **My Clients** / **Clients & API Keys**, localiza la integración de Velvet Hub.
3. Si el token actual fue expuesto, haz clic en **Edit** o en el botón **Generate New Creators Access Token**.
4. Copia el nuevo valor generado para el token de acceso (`access_token`).

> [!TIP]
> **Señal de éxito**: Al ejecutar en PowerShell:
> ```powershell
> curl.exe -H "Authorization: Bearer <nuevo_token>" https://www.patreon.com/api/oauth2/v2/identity
> ```
> Obtienes un JSON con los datos de tu cuenta creadora (HTTP 200).

---

## 🖥️ Pantalla 4: Generar Nuevo `MEDIA_SECRET` (Web Crypto HMAC)

- **Tiempo estimado**: 30 segundos.
- **Ruta de acceso**: Tu terminal local de Windows PowerShell.

### Ejecución:
Ejecuta la siguiente línea para generar una llave criptográfica segura de 256 bits (64 caracteres hexadecimales):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copia la cadena resultante (por ejemplo: `4f9b2d8e1a7c3f5e...`).

> [!IMPORTANT]
> Este secreto es exclusivo para la firma de tokens efímeros de `/api/media`. Al rotarlo, las URLs cacheadas viejas quedarán invalidadas, garantizando que nadie con el secreto anterior pueda solicitar medios a tu nombre.

---

## 🖥️ Pantalla 5: Cargar Variables en Cloudflare Pages

- **Tiempo estimado**: 4 minutos.
- **Ruta de acceso**: [https://dash.cloudflare.com/](https://dash.cloudflare.com/) ➔ **Workers & Pages** ➔ Selecciona tu proyecto (`morbohub`) ➔ **Settings** ➔ **Environment variables**.

### Descripción visual de la pantalla:
1. En la pestaña **Environment variables**, verás dos bloques: **Production** y **Preview**.
2. Haz clic en el botón azul **Add variables**.
3. Añade cada una de las siguientes variables (selecciona **Encrypt** para las claves sensibles):

| Variable Name | Value | Tipo (Type) | Entorno |
| :--- | :--- | :--- | :--- |
| `SUPABASE_URL` | `https://qnmcejlxoufheisgkuyo.supabase.co` | Plain text | Production + Preview |
| `SUPABASE_ANON_KEY` | *(Nueva clave anon de Pantalla 1)* | Plain text | Production + Preview |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Nueva service_role de Pantalla 1)* | **Encrypt** 🔒 | Production + Preview |
| `MEDIA_SECRET` | *(Cadena de 64 caracteres de Pantalla 4)* | **Encrypt** 🔒 | Production + Preview |
| `PATREON_CREATOR_ACCESS_TOKEN` | *(Nuevo token de Pantalla 3)* | **Encrypt** 🔒 | Production + Preview |
| `ENVIRONMENT` | `production` | Plain text | Production + Preview |

4. Haz clic en el botón azul **Save** al final de la página.
5. Ve a la pestaña **Deployments**, localiza el último despliegue (o haz un nuevo commit / re-deploy) y haz clic en **Retry deployment** para que las Functions tomen las nuevas variables.

> [!NOTE]
> **Señal de éxito final**: Al visitar tu sitio o ejecutar `.\tools\04_probar_preview.ps1`, el catálogo carga instantáneamente, las imágenes se visualizan correctamente firmadas, y `/api/version` responde 200 OK.
