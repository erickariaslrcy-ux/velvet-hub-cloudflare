# Lo Que Solo Tú Puedes Hacer (Checklist Mínimo)

Este documento reúne las **únicas acciones manuales** que exigen acceso a tus cuentas personales en Supabase, Patreon y Cloudflare. Todo el código, migraciones, pruebas y verificaciones ya fueron automatizados.

---

### Paso 1: Ejecutar el SQL Maestro en Supabase
- **Panel**: [Supabase Dashboard ➔ SQL Editor](https://supabase.com/dashboard/project/_/sql)
- **Tiempo estimado**: 2 minutos.
- **Acción**:
  1. Abre una nueva consulta (*New query*).
  2. Pega el contenido de [`sql/EJECUTAR_TODO_EN_ORDEN.sql`](file:///sql/EJECUTAR_TODO_EN_ORDEN.sql) y pulsa **Run**.
- **Cómo comprobar que quedó bien**:
  Aparece el mensaje verde: `NOTICE: TODO EL SCRIPT SE EJECUTÓ CORRECTAMENTE. 100% APROBADO.`

---

### Paso 2: Rotar Credenciales en Supabase
- **Panel**: [Supabase Dashboard ➔ Project Settings ➔ API](https://supabase.com/dashboard/project/_/settings/api)
- **Tiempo estimado**: 3 minutos.
- **Acción**:
  1. En **JWT Settings**, pulsa **Generate a new secret** (o *Roll keys*).
  2. Copia la nueva clave **`anon public`** y la nueva clave **`service_role secret`**.
  3. *(Opcional)* En la pestaña **Database**, pulsa **Reset database password** si usas scripts locales.
- **Cómo comprobar que quedó bien**:
  Ejecuta en tu terminal:
  ```powershell
  .\tools\01_verificar_anon.ps1
  ```
  Debe imprimir `RESULTADO: APROBADO`.

---

### Paso 3: Rotar Token de Patreon
- **Panel**: [Patreon Developer Portal ➔ Register Clients](https://www.patreon.com/portal/registration/register-clients)
- **Tiempo estimado**: 2 minutos.
- **Acción**:
  Regenera el **Creators Access Token** y copia el nuevo valor.
- **Cómo comprobar que quedó bien**:
  ```powershell
  curl.exe -s -H "Authorization: Bearer <nuevo_token>" https://www.patreon.com/api/oauth2/v2/identity
  ```
  Debe responder con código HTTP 200 y los datos de tu cuenta creadora.

---

### Paso 4: Cargar Variables en Cloudflare Pages
- **Panel**: [Cloudflare Dashboard ➔ Workers & Pages ➔ morbohub ➔ Settings ➔ Environment variables](https://dash.cloudflare.com/)
- **Tiempo estimado**: 4 minutos.
- **Acción**:
  Añade o actualiza las siguientes 5 variables para **Production** y **Preview**:
  - `SUPABASE_URL`: `https://qnmcejlxoufheisgkuyo.supabase.co`
  - `SUPABASE_ANON_KEY`: `<tu nueva clave anon de Paso 2>`
  - `SUPABASE_SERVICE_ROLE_KEY`: `<tu nueva service_role de Paso 2>` *(Encrypt 🔒)*
  - `MEDIA_SECRET`: `<cadena hex de 64 caracteres>` *(Encrypt 🔒 - genera una con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)*
  - `PATREON_CREATOR_ACCESS_TOKEN`: `<tu nuevo token de Paso 3>` *(Encrypt 🔒)*
  Pulsa **Save** y luego en la pestaña *Deployments* pulsa **Retry deployment** en el último despliegue.
- **Cómo comprobar que quedó bien**:
  Ejecuta la prueba automática contra tu despliegue:
  ```powershell
  .\tools\04_probar_preview.ps1 -PreviewUrl "https://morbohub.pages.dev"
  ```
  Debe imprimir `RESULTADO PREVIEW: APROBADO`.

---

### Paso 5 (Opcional): Purgar Historial Antiguo de Git en GitHub
- **Tiempo estimado**: 5 minutos.
- **Acción**:
  Solo si deseas eliminar del historial de GitHub los archivos `.env` viejos ya rotados:
  ```powershell
  .\tools\06_limpiar_historial.ps1
  ```
  El script trabaja en un espejo temporal y se detendrá antes de hacer cualquier push para que tú confirmes la orden final.
