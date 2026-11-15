# VELVET HUB / MORBOHUB

Plataforma privada y agregador de medios de alto rendimiento para cómics, videos en alta definición y galerías fotográficas.

## 1. Arquitectura de Producción

El proyecto se ejecuta de forma autónoma y nativa en la red global de borde de **Cloudflare Pages**:

- **Frontend:** Single Page Application (SPA) ultraligera en HTML5/Vanilla JS (`public/index.html`), estilizada con Tailwind CSS y FontAwesome, optimizada para móviles (Android/iOS) y PC.
- **Backend (API Edge):** Cloudflare Pages Functions (`functions/api/[[path]].js`) con enrutamiento de borde, latencia <10ms, soporte de streaming con Range requests y caché RAM Isolate de nivel 1.
- **Base de Datos y Autenticación:** Supabase PostgreSQL con Row Level Security (RLS), autenticación de usuarios por token JWT y filtro estricto de protección de menores en triggers de base de datos.
- **Seguridad Multimedia:** Stealth Media Proxy con tokens firmados mediante **HMAC-SHA256**, validación de expiración (`exp`) y protección estricta Anti-SSRF contra redes privadas y metadatos de nube.

> **Nota:** La capa experimental de Next.js ha sido archivada de forma no destructiva en `_archivo/nextjs-legacy/` para optimizar los tiempos de build y mantener una arquitectura limpia y unificada.

---

## 2. Estructura de Directorios

```text
VERSION_CLOUDFLARE/
├── functions/             # Backend Cloudflare Pages Functions
│   └── api/
│       └── [[path]].js    # API unificada (catálogo, auth, media proxy, version)
├── public/                # Raíz estática del despliegue en Cloudflare Pages
│   ├── index.html         # SPA principal (interfaz, visor y reproductor)
│   ├── js/                # Módulos del cliente (router, store, vault)
│   ├── sw.js              # Service Worker (v11-velvet-turbo)
│   ├── _headers           # Cabeceras HTTP de seguridad (CSP, HSTS, CORS)
│   ├── _redirects         # Reescrituras SPA (/* -> /index.html 200) y 301
│   └── _routes.json       # Configuración de invocación de Functions (/api/*)
├── sql/                   # Scripts SQL para auditoría y migraciones en Supabase
│   ├── 01_rls_policies.sql
│   ├── 02_minor_protection_audit.sql
│   ├── 03_data_integrity_audit.sql
│   ├── 04_indexes.sql
│   └── 05_thumbnails_lqip.sql
├── sync/                  # Scripts de sincronización en Python con Supabase
├── test/                  # Pruebas automatizadas de paginación y seguridad
└── _archivo/              # Código legado preservado para referencia histórica
```

---

## 3. Variables de Entorno Requeridas

Configura las siguientes variables en el panel de **Cloudflare Pages** (Settings > Environment variables):

| Variable | Tipo | Propósito |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Pública / Servidor | URL de tu instancia Supabase (`https://xxxx.supabase.co`). |
| `SUPABASE_ANON_KEY` | Pública | Clave anónima pública de Supabase (utilizada con RLS). |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo Servidor | Clave administrativa para registro con llaves de invitación. |
| `MEDIA_SECRET` | Solo Servidor | Clave secreta (mínimo 32 caracteres) para firmar tokens HMAC-SHA256. |
| `PATREON_CLIENT_ID` | Opcional | Identificador de cliente para OAuth2 con Patreon. |
| `PATREON_CLIENT_SECRET` | Opcional | Secreto de cliente para OAuth2 con Patreon. |
| `PATREON_CAMPAIGN_ID` | Opcional | Identificador de campaña de Patreon. |
| `MASTER_EMAIL` | Opcional | Correo del administrador de la plataforma. |

---

## 4. Ejecución y Pruebas Locales

### Requisitos Previos
- Node.js >= 20.0.0
- Wrangler CLI (instalado automáticamente en devDependencies)

### Pasos de Instalación y Ejecución
1. Clona el repositorio y sitúate en la carpeta del proyecto:
   ```powershell
   cd VERSION_CLOUDFLARE
   ```
2. Instala las herramientas de desarrollo:
   ```powershell
   npm install
   ```
3. Ejecuta la suite de verificación automatizada:
   ```powershell
   npm run check
   ```
4. Inicia el servidor de desarrollo local de Cloudflare Pages:
   ```powershell
   npm run dev
   ```
   El sitio estará disponible en `http://localhost:8788`.

---

## 5. Endpoints de la API (`/api/*`)

- `GET /api/version`: Información de versión, commit, motor y observabilidad.
- `GET /api/items`: Catálogo paginado con filtros de búsqueda (`q`), categoría (`category`), etiqueta (`tag`) y orden (`sort`).
- `GET /api/items/:source/:id`: Detalle completo de cómic, video o galería fotográfica.
- `GET /api/media?t=<token>`: Streaming y proxificado de imágenes y video con firma HMAC-SHA256.
- `POST /api/auth/login`: Autenticación con Supabase Auth.
- `POST /api/auth/register`: Registro atómico mediante código de invitación (`invite_code`).
- `GET/POST/DELETE /api/favorites`: Gestión de favoritos del usuario autenticado.
- `GET/POST/DELETE /api/user/history`: Registro y sincronización de progreso de lectura e historial.
- `GET /api/tags`: Listado de etiquetas destacadas.
