# DOCUMENTACIÓN TÉCNICA DE ARQUITECTURA E INGENIERÍA
## Proyecto: VELVET HUB / MORBOHUB
**Dominio de Producción en Cloudflare Pages:** [https://morbohub.pages.dev/](https://morbohub.pages.dev/)  
**Dominio de Edge Proxy:** `velvet-proxy.workers.dev`  
**Base de Datos y Auth:** Supabase PostgreSQL (`qnmcejlxoufheisgkuyo.supabase.co`)  
**Versión del Sistema:** 3.1.0 (v11-velvet-turbo • Cloudflare Pages Native & HMAC Stealth Engine)  
**Fecha de Generación y Auditoría Final:** 15 de Noviembre de 2026  
**Auditor / Arquitecto Técnico:** Senior Full-Stack Security & Performance Architect  

---

## 1. RESUMEN GENERAL

### 1.1 ¿Qué es el proyecto?
**VELVET HUB** (desplegado comercial y técnicamente en Cloudflare Pages bajo el dominio `morbohub.pages.dev`) es una plataforma web progresiva (PWA) de entretenimiento para adultos de alto rendimiento, orientada a la agregación, lectura, reproducción y catalogación de tres tipos de contenido explícito:
1. **Cómics, Mangas, Manhwas y Fotonovelas para adultos** (+18).
2. **Videos musicales para adultos (PMVs - Picture Music Videos) y escenas de video HD/4K**.
3. **Galerías fotográficas de alta resolución y sets de Cosplay / Modelos**.

El sistema opera bajo un modelo de arquitectura **"Stealth / Marca Blanca Impenetrable"**, diseñado para desacoplar por completo a los usuarios finales de los servidores, CDNs y dominios de origen donde se aloja el material en bruto.

### 1.2 ¿Qué problema resuelve?
1. **Fragmentación y Publicidad Agresiva en Sitios Adultos:** Los sitios tradicionales de cómics y videos adultos están plagados de pop-ups intrusivos, redirecciones maliciosas, scripts de rastreo y tiempos de carga lentos. VELVET HUB unifica más de 17 fuentes dispares en una interfaz unificada, fluida, de estética premium y sin publicidad.
2. **Anonimato y Protección contra Hotlinking ("Stealth"):** Al servir cómics y videos directamente, los sitios de origen suelen bloquear peticiones por cabeceras `Referer` o `User-Agent`. VELVET HUB implementa proxies de borde con **firma criptográfica HMAC-SHA256**, expiración estricta (`exp`), validación **Anti-SSRF** en tiempo real y reescritura de cabeceras, garantizando que el navegador del usuario nunca conozca el servidor original y que ningún secreto resida en el cliente.
3. **Desempeño Extremo en Renderizado por Software y Móviles:** Muchas plataformas colapsan en teléfonos móviles o equipos con aceleración gráfica desactivada. Velvet Hub incorpora un motor visual con soporte dinámico `100dvh`, aceleración por hardware (`translateZ(0)`), Ambilight Zero-CPU (canvas 32x18) y `SmartImageLoader` adaptativo que cancela descargas fuera de pantalla durante el scroll veloz.
4. **Cumplimiento Legal y Filtro Inmutable de Menores:** Integra un filtro a nivel de disparador (trigger) en la base de datos PostgreSQL que analiza títulos, etiquetas y artistas, marcando irreversiblemente como `blocked` cualquier contenido vinculado con menores de edad (prevención de CSAM). Adicionalmente, cuenta con compuerta de verificación jurada de edad (+18) según los estándares de la normativa 18 U.S.C. 2257.
5. **Control de Acceso y Monetización Privada:** El registro indiscriminado está bloqueado. El acceso se gestiona a través de llaves de invitación criptográficas de un solo uso (`invite_keys`) emitidas por una cuenta maestra o mediante vinculación con membresías de **Patreon**.

### 1.3 ¿A quién va dirigido?
- **Usuarios Finales / Consumidores:** Usuarios que buscan una experiencia de lectura y visualización privada, rápida, optimizada para teléfonos móviles y pantallas de escritorio, con guardado de favoritos e historial sincronizado.
- **Mecenas VIP (Patreon):** Miembros de pago que acceden a funciones exclusivas, mayor concurrencia de dispositivos (hasta 10 simultáneos) y catálogo completo sin restricciones.
- **Administrador / Operador de la Plataforma:** Dueño de la cuenta maestra que gestiona métricas de catálogo, emisión/revocación de llaves, baneo de cuentas y cosecha de nuevo contenido desde herramientas locales de scraping.

### 1.4 Lista de Funcionalidades Principales
- **Catálogo Dinámico Tri-Modular:** Conmutación instantánea sin recarga entre Cómics, Videos y Galerías/Cosplay.
- **Reproductor de Video Cinema-Pro:**
  - Ambilight reactivo con motor "Zero-CPU" basado en muestreo sobre canvas 32x18 e interpolación bilineal CSS.
  - Watchdog de calidad de frames (`getVideoPlaybackQuality()`) con auto-degradación si los dropped frames superan el 5%.
  - Streaming con soporte de peticiones HTTP de rango (`Range: bytes=x-y`) para avance y retroceso instantáneo.
  - Soporte HLS (`.m3u8`) y archivos directos MP4.
  - Barra lateral de videos relacionados con carga diferida (`requestIdleCallback`) y tarjetas compactas de 78px.
  - Atajos de teclado completos (Espacio/K: Pausa, J/L: Saltos de 10s, F: Fullscreen, M: Mute, C: Luces).
- **Visor Profesional de Cómics y Galerías:**
  - Doble modo de visualización: **Webtoon** (scroll vertical continuo infinito) y **Slide** (paginado horizontal estilo manga/e-book).
  - Progressive Chunk Loading: Renderiza inicialmente solo 4-6 imágenes y añade las siguientes mediante `IntersectionObserver`.
  - Zoom interactivo suave (50% a 300%) y soporte táctil Pinch-to-Zoom y doble tap.
  - Modo Negro Puro OLED (`#000000`) para ahorro de batería y descanso visual.
  - Drawer inferior deslizante con barra de miniaturas y porcentaje de avance.
  - Sanitización en tiempo real: Algoritmo de descarte de imágenes intrusas (anuncios, logos, miniaturas YARPP).
- **Bóveda de Usuario Privada (`/boveda/*`):**
  - **Favoritos:** Vista de cuadrícula o lista, ordenación, filtrado por tipo, selección múltiple y eliminación con toast de deshacer (5 segundos).
  - **Historial:** Agrupación cronológica automática ("Hoy", "Ayer", "Esta semana", "Este mes", "Anteriormente"), barra de progreso porcentual y punto exacto de reanudación.
  - **Cuenta:** Información de usuario, identificador de llave canjeada, estado VIP y ajuste de preferencias v2.
- **Enrutamiento SPA con URLs Semánticas y Canónicas:**
  - Rutas reales limpias (`/videos`, `/comics`, `/cosplay`, `/v/:slug`, `/c/:slug`, `/g/:slug`, `/boveda/favoritos`).
  - Integración nativa con la **View Transitions API** del navegador para transiciones cinemáticas fluidas.
  - Intercepción inteligente de clics en enlaces `<a>` (clic izquierdo navega en la SPA; clic central o Ctrl+clic abre pestaña nativa).
  - Precarga predictiva (prefetch) de enlaces al mantener el cursor sobre la tarjeta durante más de 150ms.
- **Motor Stealth Multimedia y Proxificado de Borde:**
  - Cifrado y firma criptográfica de URLs con **Web Crypto API (HMAC-SHA256)** + Base64URL seguro, sin exponer secretos en el cliente.
  - Validación en tiempo constante (`timingSafeEqual`) contra ataques de temporización y expiración automática de tokens.
  - Caché multinivel: L1 en RAM del V8 Isolate (<1ms) y L2 en Cloudflare Cache API en más de 300 centros de datos mundiales.
  - Redimensionamiento y optimización de imágenes al vuelo (`w`, `q`, `fmt`) y revalidación HTTP con `ETag` determinista (304 Not Modified).
- **Service Worker PWA Offline:** Almacenamiento en caché de la carcasa HTML estática, fuentes de Google, CDN de iconos y assets visuales, garantizando carga instantánea (0ms) en visitas recurrentes.

---

## 2. STACK TECNOLÓGICO

### 2.1 Lenguajes de Programación
| Lenguaje | Versión / Estándar | Ámbito de Uso |
| :--- | :--- | :--- |
| **JavaScript** | ECMAScript 2022+ | Lógica de cliente en la SPA (`index.html`, `router.js`, `store.js`, `vault.js`, `sw.js`) y Cloudflare Pages Functions (`functions/api/[[path]].js`). |
| **TypeScript** | 5.8.3 | Arquitectura híbrida Next.js (`middleware.ts`, `lib/*`, `app/*`, `components/*`). |
| **Python** | 3.10 / 3.11 / 3.12 | Motor de scraping local (`scraper_hub`), cosechadores masivos (`harvest_*.py`) y sincronizadores de base de datos (`sync/sync_supabase.py`). |
| **SQL / PLpgSQL** | PostgreSQL 15+ | Esquema relacional, políticas de seguridad RLS, triggers y funciones almacenadas en Supabase. |
| **HTML5 / CSS3** | Estándar W3C | Maquetación web semántica, estilos atómicos y manipulación de WebGL / Canvas 2D. |

### 2.2 Frameworks y Librerías de Frontend
- **Tailwind CSS (CDN v3.x):** Estilizado utilitario con configuración personalizada para colores nocturnos de lujo (`pitch`, `obsidian`, `velvet`, `glass`, `violet`, `neon`, `hot`, `crimson`, `lav`) y sombras glow.
- **FontAwesome 6 Free (v6.5.1):** Iconografía vectorial cargada de forma no bloqueante desde CDNJS.
- **HLS.js (Latest CDN):** Librería JavaScript para reproducción adaptativa de flujos de video HTTP Live Streaming (`.m3u8`).
- **Google Fonts:** Familias tipográficas cargadas asíncronamente:
  - *Outfit* y *Plus Jakarta Sans* (cuerpo de texto e interfaz moderna).
  - *DM Serif Display* y *Playfair Display* (títulos editoriales de lujo).
  - *Inter* (elementos funcionales y datos técnicos).

### 2.3 Frameworks y Librerías de Backend / Servidor
- **Cloudflare Pages Functions (V8 Worker Runtime):** Entorno de ejecución serverless distribuido en el borde global de Cloudflare (`functions/api/[[path]].js`). Constituye el backend unificado y oficial en producción.
- **Wrangler CLI (^4.160.0):** Herramienta oficial de Cloudflare para desarrollo local (`npx wrangler pages dev public`), empaquetado y despliegue continuo.
- **Node.js Test Runner (Nativo):** Suite de pruebas unitarias y de integración sin dependencias externas (`test/test_*.mjs`) ejecutables vía `npm test`.
- **@supabase/supabase-js (v2.118.0):** SDK para comunicación REST/PostgREST y autenticación con Supabase.
- **FastAPI / Pydantic v2 / Typer:** En el módulo local `scraper_hub` para exponer una API REST local y una interfaz de línea de comandos.
- *(Nota de Arquitectura)*: La capa experimental de Next.js 15 ha sido archivada de forma no destructiva en `_archivo/nextjs-legacy/` para reducir la superficie de ataque, eliminar cuellos de botella de build y consolidar el despliegue nativo en Cloudflare Pages.

### 2.4 Servicios de Cloudflare
| Servicio de Cloudflare | Estado en el Proyecto | Detalle y Función en el Código |
| :--- | :--- | :--- |
| **Cloudflare Pages** | **USADO (Principal)** | Aloja los archivos estáticos de la SPA (`public/`) y enruta mediante `_redirects` y `_headers`. |
| **Pages Functions** | **USADO (Principal)** | Ejecuta el worker serverless unificado en `functions/api/[[path]].js`, interceptando las rutas `/api/*` configuradas en `public/_routes.json`. |
| **Cloudflare Workers** | **USADO (Satélite)** | Proyecto satélite en `cloudflare-worker/worker.js` (`velvet-proxy`), utilizado como CDN proxy alternativo de alta velocidad con ancho de banda ilimitado. |
| **Cloudflare Cache API** | **USADO** | Se utiliza `caches.default` dentro de las funciones para almacenar en caché de borde las respuestas de detalle de cómics y el streaming optimizado de imágenes. |
| **Cloudflare KV** | **No encontrado / no aplica** | No se utiliza almacenamiento Key-Value de Cloudflare. El estado se gestiona en memoria RAM del Isolate y en Supabase. |
| **Cloudflare D1** | **No encontrado / no aplica** | No se utiliza D1. La base de datos relacional del proyecto reside íntegramente en Supabase (PostgreSQL). |
| **Cloudflare R2** | **No encontrado / no aplica** | No se utiliza almacenamiento de objetos R2. Los archivos multimedia no se alojan físicamente en el proyecto; se transmiten por streaming o se proxifican en tiempo real desde sus CDNs de origen. |
| **Durable Objects** | **No encontrado / no aplica** | No se requiere coordinación de estado distribuido con Durable Objects. |

### 2.5 Servicios Externos y APIs de Terceros
- **Supabase (AWS us-east-1):**
  - **Base de Datos PostgreSQL:** Almacena tablas de ítems, perfiles, favoritos, llaves de invitación y alias de fuentes.
  - **PostgREST API:** Interfaz REST de alta velocidad para ejecutar consultas SQL y procedimientos almacenados (RPC).
  - **Supabase Auth:** Proveedor de identidad que emite JWTs (JSON Web Tokens) y tokens de refresco para el control de sesiones.
- **Patreon API v2:** Integración mediante protocolo OAuth2 para vincular cuentas de mecenas, comprobar suscripciones activas y otorgar privilegios VIP automáticos.
- **PMVHaven API:** API pública/privada de videos musicales para consultar metadatos y enlaces directos de video (`https://pmvhaven.com/api/videos/:id`).
- **Red de CDNs de Cómics y Videos Adultos:** Más de 17 plataformas externas a las que el sistema se conecta como proxy silencioso (3Hentai, Comics18, Pornocomic, Buondua, 4KHD, etc.).

---

## 3. ESTRUCTURA DE ARCHIVOS

### 3.1 Árbol Completo del Directorio del Proyecto
```text
PAGINAS SCRAPEADAS LISTAS/
│
├── .gitignore                                 # Exclusiones de Git (node_modules, .env, DBs grandes)
├── ABRIR_APP.bat                              # Lanzador Windows: modo escritorio local
├── ABRIR_ONLINE.bat                           # Lanzador Windows: túnel HTTPS público para móviles
├── AUDITORIA.md                               # Informe técnico inicial: diagnóstico de renderizado CPU y video
├── RESULTADOS.md                              # Informe técnico de etapa 2: solución Ambilight zero-CPU y CSS
├── REPORTE_MEJORAS.md                         # Reporte exhaustivo de la auditoría y reparaciones (Fases 0 a 7)
├── PASOS_MANUALES.md                          # Guía paso a paso de acciones externas y rotación de secretos
├── CHECKLIST_PRUEBAS.md                       # Protocolo de pruebas manuales para Android y PC
├── DOCUMENTACION_PROYECTO.md                  # Este documento (documentación técnica global exhaustiva)
├── scraper_hub.db                             # Base de datos SQLite maestra local (~534 MB con ~100k registros)
├── Dockerfile                                 # Contenedor Docker para ejecución del hub de scraping
├── docker-compose.yml                         # Orquestación de contenedores locales
│
├── sql/                                       # SCRIPTS SQL PARA AUDITORÍA Y MIGRACIONES EN SUPABASE
│   ├── 01_rls_policies.sql                    # Activación y políticas RLS para items, profiles, keys, favorites
│   ├── 02_minor_protection_audit.sql          # Auditoría estricta de CSAM y trigger inmutable de protección
│   ├── 03_data_integrity_audit.sql            # Auditoría no destructiva de integridad (SELECT only)
│   ├── 04_indexes.sql                         # Índices concurrentes de alto rendimiento (CONCURRENTLY)
│   └── 05_thumbnails_lqip.sql                 # Migración O(1) no bloqueante para columnas thumb_color y thumb_lqip
│
├── VERSION_CLOUDFLARE/                        # NÚCLEO DE PRODUCCIÓN EN CLOUDFLARE PAGES (morbohub.pages.dev)
│   ├── .env.example                           # Plantilla de variables de entorno (sin credenciales)
│   ├── .gitignore                             # Reglas de exclusión para producción (*.db, *.zip, .env*)
│   ├── README.md                              # Documentación técnica de despliegue y pruebas
│   ├── package.json                           # Configuración nativa Pages (scripts: dev, test, check, deploy)
│   ├── PASOS_MANUALES.md                      # Espejo de la guía de acciones manuales
│   ├── CHECKLIST_PRUEBAS.md                   # Espejo del checklist de verificación
│   │
│   ├── functions/                             # BACKEND SERVERLESS EN CLOUDFLARE PAGES FUNCTIONS
│   │   └── api/
│   │       └── [[path]].js                    # API unificada (catálogo, auth, proxy HMAC, version)
│   │
│   ├── public/                                # ARCHIVOS ESTÁTICOS Y SHELL DE LA SPA (Directorio raíz de Pages)
│   │   ├── _headers                           # Cabeceras HTTP de borde (CORS estricto, CSP, HSTS, NoIndex)
│   │   ├── _redirects                         # Reescrituras SPA (/* -> /index.html 200) y 301
│   │   ├── _routes.json                       # Configuración de Pages Functions: enruta /api/* al worker
│   │   ├── index.html                         # Shell SPA principal unificada (~495 KB, UI completa)
│   │   ├── velvet.css                         # Hoja de estilos con variables y ajustes de rendimiento
│   │   ├── velvet_logo.png                    # Logotipo corporativo de Velvet Hub
│   │   ├── manifest.json                      # Manifiesto PWA
│   │   ├── sw.js                              # Service Worker v11-velvet-turbo (sin caché en /api/items)
│   │   ├── robots.txt                         # Bloqueo de arañas de búsqueda (Disallow: /)
│   │   ├── 404.html                           # Página de error 404 personalizada
│   │   └── js/                                # Módulos JavaScript del cliente
│   │       ├── router.js                      # Enrutador del cliente, View Transitions y prefetch
│   │       ├── store.js                       # Almacén de estado persistente, sesión y preferencias
│   │       └── vault.js                       # Módulo de la Bóveda (Favoritos, Historial y Cuenta)
│   │
│   ├── sql/                                   # Espejo de los 5 scripts SQL
│   │
│   ├── sync/                                  # SCRIPTS DE SINCRONIZACIÓN LOCAL -> NUBE (Python)
│   │   ├── requirements.txt                   # Librerías Python necesarias (requests)
│   │   └── sync_supabase.py                   # Script de sincronización con backoff exponencial y jitter
│   │
│   ├── test/                                  # SUITE DE PRUEBAS AUTOMATIZADAS (100% PASS)
│   │   ├── test_pagination.mjs                # Monotonicidad de offsets, Content-Range y filtros DB
│   │   ├── test_security.mjs                  # Validación de tokens HMAC, Anti-SSRF y sanitización PostgREST
│   │   ├── test_database.mjs                  # Integridad de SQLs, RLS, índices concurrentes y sync seguro
│   │   ├── test_performance.mjs               # 100dvh, safe areas, SmartImageLoader y pre-carga acotada
│   │   └── test_quality_suite.mjs             # Atajos de teclado (visor y video), ARIA y ordenamiento estable
│   │
│   └── _archivo/                              # CÓDIGO LEGADO ARCHIVADO DE FORMA NO DESTRUCTIVA
│       ├── velvet.html                        # Espejo legado redirigido 301 a /index.html
│       └── nextjs-legacy/                     # Capa Next.js 15 preservada históricamente (app, components, lib)
│
├── cloudflare-worker/                         # WORKER PROXY INDEPENDIENTE ("velvet-proxy")
│   ├── worker.js                              # Edge Worker para streaming de video con Range y proxy
│   └── wrangler.toml                          # Configuración de Wrangler para el worker satélite
│
├── scraper_hub/                               # MOTOR DE SCRAPING MODULAR EN PYTHON (Entorno Local)
│   ├── pyproject.toml                         # Configuración del paquete y dependencias Python
│   ├── cli.py                                 # Interfaz de línea de comandos (`scraper-hub`)
│   ├── core/                                  # Núcleo (cliente HTTP con retrasos, modelos, filtros)
│   ├── adapters/comics/                       # 17 adaptadores independientes para cada sitio web
│   ├── storage/                               # Manejador SQLite para persistencia local
│   ├── api/                                   # Servidor FastAPI local
│   └── web/                                   # Visor web local de pruebas
│
└── [SCRAPERS Y HARVESTERS RAÍZ]               # Scripts Python de recolección y exportación masiva
    ├── 3hentai.py, comics18.py, etc.          # Scrapers individuales por sitio
│   ├── migrations/                            # MIGRACIONES SQL COMPLEMENTARIAS
│   │   └── 20261113_add_thumbnail_metadata.sql # Migración para miniaturas LQIP y colores dominantes
│   │
│   ├── supabase/                              # CONFIGURACIÓN Y MIGRACIONES MAESTRAS DE BASE DE DATOS
│   │   └── migrations/
│   │       └── 0001_init.sql                  # Esquema maestro DDL (tablas, RLS, vistas y triggers)
│   │
│   ├── sync/                                  # SCRIPTS DE SINCRONIZACIÓN LOCAL -> NUBE (Python)
│   │   ├── requirements.txt                   # Librerías Python necesarias (requests)
│   │   ├── sync_supabase.py                   # Script de sincronización masiva de cómics y videos
│   │   └── sync_galleries_supabase.py         # Script de sincronización específica de galerías de fotos
│   │
│   └── scripts/
│       └── deploy.mjs                         # Script de despliegue automatizado de infraestructura
│
├── cloudflare-worker/                         # WORKER PROXY INDEPENDIENTE ("velvet-proxy")
│   ├── worker.js                              # Edge Worker para streaming de video con Range y proxy
│   └── wrangler.toml                          # Configuración de Wrangler para el worker satélite
│
├── scraper_hub/                               # MOTOR DE SCRAPING MODULAR EN PYTHON (Entorno Local)
│   ├── pyproject.toml                         # Configuración del paquete y dependencias Python
│   ├── cli.py                                 # Interfaz de línea de comandos (`scraper-hub`)
│   ├── core/                                  # Núcleo (cliente HTTP con retrasos, modelos, filtros)
│   ├── adapters/comics/                       # 17 adaptadores independientes para cada sitio web
│   ├── storage/                               # Manejador SQLite para persistencia local
│   ├── api/                                   # Servidor FastAPI local
│   └── web/                                   # Visor web local de pruebas
│
└── [SCRAPERS Y HARVESTERS RAÍZ]               # Scripts Python de recolección y exportación masiva
    ├── 3hentai.py, comics18.py, etc.          # Scrapers individuales por sitio
    ├── harvest_*.py, mega_*.py, ultra_*.py    # Scripts de recolección masiva hacia scraper_hub.db
    └── export_and_sync_all.py                 # Exportador maestro a JSON y visor local
```

### 3.2 Relación y Función de los Componentes Clave
- **`public/index.html` <-> `js/router.js`:** La SPA funciona como una sola página. Cuando el usuario hace clic en una tarjeta o enlace de navegación, `router.js` intercepta el evento, evita la recarga completa del navegador, invoca la **View Transitions API**, actualiza la barra de direcciones (`pushState`) y emite el evento personalizado `velvet:route-render` para mostrar u ocultar la vista pertinente.
- **`js/store.js` <-> `js/vault.js`:** `store.js` actúa como la única fuente de verdad (Single Source of Truth) para la persistencia en `localStorage` y cookies (sesión, preferencias v2, marcas de tiempo, tokens). `vault.js` se suscribe a las actualizaciones del store y renderiza reactivamente las listas de favoritos, las tarjetas de historial agrupadas por fecha y la información del perfil del usuario.
- **`functions/api/[[path]].js` <-> `Supabase`:** Las funciones de Cloudflare Pages reciben todas las peticiones a `/api/*`. El worker verifica si los datos solicitados existen en su memoria RAM local (`ISOLATE_CATALOG_CACHE` o `ISOLATE_DETAIL_CACHE`). Si no están en caché, realiza llamadas seguras vía HTTPS contra la API PostgREST de Supabase utilizando la clave administrativa interna (`service_role`), aplica sanitización de páginas y devuelve la respuesta cifrando cualquier URL sensible antes de enviarla al cliente.
- **`sync/sync_supabase.py` <-> `scraper_hub.db` <-> `Supabase`:** El operador ejecuta localmente los scrapers masivos que guardan decenas de miles de registros en la base de datos SQLite local (`scraper_hub.db`). Posteriormente, `sync_supabase.py` lee estos registros en lotes de 200 y los sube mediante operaciones `upsert` a la tabla `items` de Supabase, donde automáticamente se activan los triggers de protección de menores.

---

## 4. ARQUITECTURA Y FLUJO

### 4.1 ¿Qué sucede cuando un usuario entra al sitio? (Paso a Paso)
1. **Petición Inicial y Resolución DNS:** El navegador solicita `https://morbohub.pages.dev/`. Cloudflare resuelve la dirección IP mediante Anycast y enruta al centro de datos de borde más cercano (Edge Datacenter).
2. **Entrega de Archivos Estáticos:**
   - Cloudflare Pages evalúa `_headers` e inyecta cabeceras de seguridad (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`).
   - Cloudflare Pages evalúa `_redirects`. Si la URL es `/`, `/videos`, `/c/...` o cualquier otra ruta de la aplicación, aplica una reescritura interna con código HTTP `200 OK` devolviendo `public/index.html`.
3. **Arranque en el Navegador (Hydration & Init):**
   - El navegador descarga `index.html`, Tailwind CSS desde su CDN y los scripts diferidos `store.js`, `router.js` y `vault.js`.
   - Se registra el Service Worker (`sw.js`), que en segundo plano cachea la estructura estática para futuras visitas offline.
   - `store.js` inspecciona `localStorage` y las cookies para comprobar el estado de **Verificación de Edad (+18)**. Si no está verificado, despliega el modal bloqueante de advertencia legal.
   - `store.js` hidrata la sesión del usuario (si existía un token previo en `velvet_token`) y recupera el historial y los favoritos locales.
4. **Enrutamiento Inicial:**
   - `router.js` parsea `window.location.pathname`.
   - Si la ruta es `/videos`, activa la sección de catálogo en modo video; si es `/c/:slug`, invoca la carga del cómic; si es `/v/:slug`, abre el reproductor Cinema-Pro; si es `/boveda/*`, monta el panel de la bóveda.
5. **Petición de Datos a la API:**
   - El cliente envía una solicitud `GET /api/items?media_type=comic&page=1` hacia el mismo dominio.
   - Cloudflare Pages detecta la regla en `_routes.json` (`include: ["/api/*"]`) y enruta la petición hacia la función serverless `functions/api/[[path]].js`.
6. **Resolución en el Edge de Cloudflare:**
   - El worker verifica si el catálogo de esa página ya está en la memoria RAM del Isolate (`ISOLATE_CATALOG_CACHE`). Si es un acierto (HIT), responde en **< 1 ms**.
   - Si es un fallo (MISS), consulta la base de datos de Supabase vía HTTPS, formatea el JSON, reemplaza las URLs de las portadas por enlaces seguros ofuscados con XOR (`/api/media?t=...`), almacena el resultado en el caché L1 y lo devuelve al navegador.
7. **Pintado en el DOM:**
   - La función `renderCatalogGrid()` en el cliente genera dinámicamente las tarjetas HTML utilizando colores dominantes precalculados para evitar parpadeos blancos o cuadros vacíos, completando la carga visual sin interrupciones.

### 4.2 Diagrama de Flujo General (Mermaid)
```mermaid
flowchart TD
    User([Usuario en Navegador / Celular]) -->|1. Solicita URL https://morbohub.pages.dev/| CFEdge[Cloudflare Edge / Pages CDN]
    
    subgraph Cloudflare Pages Infrastructure
        CFEdge -->|Evalúa _headers y _redirects| StaticFiles[Archivos Estáticos: index.html, JS, CSS, SW]
        CFEdge -->|Ruta /api/* según _routes.json| EdgeFunction[Functions Worker: functions/api/[[path]].js]
        
        EdgeFunction -->|Chequeo L1: RAM Cache < 1ms| L1Cache[(Isolate RAM Cache)]
        EdgeFunction -->|Chequeo L2: Edge Cache| L2Cache[(Cloudflare Cache API)]
    end

    StaticFiles -->|Entrega HTML SPA Shell| User
    
    subgraph Frontend Execution (Browser)
        User --> StoreInit[store.js: Comprueba Edad +18 & Auth Token]
        StoreInit --> RouterInit[router.js: Parsea URL y activa Vista]
        RouterInit --> VaultInit[vault.js: Renderiza Favoritos / Historial]
        RouterInit -->|Petición asíncrona de datos| EdgeFunction
    end
    
    subgraph External Backend Services
        EdgeFunction -->|Consulta REST /rpc con Service Role Key| Supabase[(Supabase PostgreSQL: items, profiles, keys)]
        EdgeFunction -->|OAuth2 Token Exchange| PatreonAPI[Patreon API v2: Verificación Mecenas]
        EdgeFunction -->|Streaming / Range Requests con Referer Spoofing| ExtCDNs[CDNs Externas: Imágenes de Cómics & Video Streams]
    end

    subgraph Local Ingestion Pipeline (PC del Administrador)
        Scrapers[17+ Scrapers en Python] --> LocalDB[(SQLite Local: scraper_hub.db)]
        LocalDB --> SyncScript[sync_supabase.py]
        SyncScript -->|Lotes de 200 con Trigger de Protección de Menores| Supabase
    end
```

### 4.3 Frontend vs Backend: ¿Qué corre en cada lado?
| Componente / Tarea | Dónde se ejecuta | Entorno de Ejecución |
| :--- | :--- | :--- |
| **Renderizado de la UI e Interfaz** | Navegador del Cliente | DOM / HTML5 / CSS3 / Tailwind CDN |
| **Control de Navegación y Transiciones** | Navegador del Cliente | `router.js` (History API / View Transitions API) |
| **Decodificación de Video HLS / MP4** | Navegador del Cliente | Decodificador nativo de video / `hls.js` |
| **Ambilight reactivo Zero-CPU** | Navegador del Cliente | `<canvas 32x18>` con `requestVideoFrameCallback` |
| **Gestión de Favoritos e Historial local** | Navegador del Cliente | `localStorage` / Cookies con sincronización nube |
| **Caché estática de la carcasa web** | Navegador del Cliente | Service Worker (`sw.js`) / CacheStorage |
| **Enrutamiento de borde y cabeceras de red** | Servidores de Cloudflare | Cloudflare Pages CDN Engine |
| **Descifrado de tokens multimedia stealth** | Servidores de Cloudflare | Cloudflare Pages Functions (`[[path]].js`) |
| **Proxificado de video y soporte de Range** | Servidores de Cloudflare | Cloudflare Functions / `cloudflare-worker` |
| **Optimización y redimensionado de imágenes** | Servidores de Cloudflare | Cloudflare Functions (parámetros `w`, `q`, `fmt`) |
| **Caché en memoria L1 de catálogo y detalles** | Servidores de Cloudflare | RAM del V8 Isolate (`Map` en JavaScript) |
| **Validación de llaves y autenticación** | Nube de Supabase / Cloudflare | Supabase Auth API & PostgreSQL Triggers |
| **Filtro inmutable de protección de menores** | Nube de Supabase | Procedimiento PL/pgSQL en PostgreSQL |
| **Cosecha masiva de cómics y galerías** | Computadora del Administrador | Python 3.10+ CLI / `scraper_hub` / SQLite |

---

## 5. PÁGINAS Y RUTAS

Todas las rutas web son absorbidas por el archivo `public/_redirects` y gestionadas mediante el cliente `public/js/router.js`:

| Ruta URL | Propósito | Componente / Vista Activa en DOM | Datos que Muestra / Consume |
| :--- | :--- | :--- | :--- |
| `/` o `/index.html` | Página de inicio y catálogo general de cómics | `#catalog-view` (Modo: `comics`) | Hero spotlight interactivo, grid de cómics con paginación, carrusel de categorías. |
| `/videos` | Catálogo dedicado a videos y PMVs musicales | `#catalog-view` (Modo: `videos`) | Tarjetas de video 16:9 con duración, selector de subgéneros (PMV, 4K, Asian, VR, etc.). |
| `/comics` | Catálogo de cómics, mangas y fotonovelas | `#catalog-view` (Modo: `comics`) | Grid de cómics 2:3 con etiquetas de páginas, artistas y selector de categorías. |
| `/cosplay` | Catálogo de galerías de fotos y modelos | `#catalog-view` (Modo: `galleries`) | Grid fotográfico de álbumes cosplay con conteo total de imágenes. |
| `/v/:slug` | Reproductor de video profesional (Cinema-Pro) | `#video-view` | Reproductor HLS/MP4, Ambilight canvas, metadata, autor, sidebar de 8 videos relacionados. |
| `/c/:slug` | Ficha técnica y lectura de un cómic | `#reader-view` | Portada, lista de páginas, metadatos, tags y selector de modo de lectura. |
| `/c/:slug/leer?p=:num` | Visor inmersivo directo en una página concreta | `#reader-view` | Lectura a pantalla completa con navegación por swipe, zoom o scroll vertical continuo. |
| `/g/:slug` | Visor de álbumes de fotos de cosplay | `#reader-view` | Galería fotográfica con visor de alta resolución y drawer de miniaturas. |
| `/boveda` o `/boveda/favoritos` | Panel de elementos favoritos guardados | `#vault-view` (Tab: `favorites`) | Grid de favoritos guardados por el usuario, multiselección, orden y filtro por tipo. |
| `/boveda/historial` | Registro cronológico de reproducciones y lecturas | `#vault-view` (Tab: `history`) | Historial agrupado por fechas, barras de progreso y porcentaje de visualización. |
| `/cuenta` | Panel de cuenta, membresía VIP y preferencias | `#vault-view` (Tab: `account`) | Usuario actual, llave canjeada, interruptores de preferencias (calidad, ambilight, datos). |
| `/acceso` | Formulario de autenticación o registro | `#auth-modal` | Pestañas de Login tradicional y Registro exclusivo con Llave de Invitación. |
| `/favoritos` | Alias legado (Redirección 301) | N/A (Redirige a `/boveda/favoritos`) | Redirección de compatibilidad en `_redirects` y `router.js`. |
| `/historial` | Alias legado (Redirección 301) | N/A (Redirige a `/boveda/historial`) | Redirección de compatibilidad en `_redirects` y `router.js`. |
| `/video/*` | Alias legado (Redirección 301) | N/A (Redirige a `/v/:splat`) | Normalización hacia URLs semánticas limpias. |
| `/comic/*` | Alias legado (Redirección 301) | N/A (Redirige a `/c/:splat`) | Normalización hacia URLs semánticas limpias. |
| `/gallery/*` | Alias legado (Redirección 301) | N/A (Redirige a `/g/:splat`) | Normalización hacia URLs semánticas limpias. |

---

## 6. COMPONENTES Y LÓGICA DEL FRONTEND

### 6.1 Módulos JavaScript del Cliente

#### A. Enrutador del Lado del Cliente (`public/js/router.js`)
- **Intercepción de Enlaces Nativos:**
  ```javascript
  // Fragmento de public/js/router.js
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || link.target === '_blank') return;
    // Permite atajos nativos: Ctrl+Clic, Clic Central, etc.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    
    const href = link.getAttribute('href');
    if (href && href.startsWith('/') && !href.startsWith('//')) {
      e.preventDefault();
      VelvetRouter.navigate(href);
    }
  });
  ```
- **Integración con View Transitions API:**
  Al invocar `navigate(url)`, si el navegador soporta `document.startViewTransition`, el router encapsula la transición del DOM en una micro-animación nativa acelerada por GPU:
  ```javascript
  if (document.startViewTransition && !store.getPreferences().reduceMotion) {
    document.startViewTransition(() => render());
  } else {
    render();
  }
  ```
- **Prefetch Predictivo:**
  Al posar el puntero del ratón sobre cualquier tarjeta durante **150 ms** (`mouseenter`), el enrutador precarga los metadatos del ítem en segundo plano (`fetch('/api/items/...')`), de modo que al hacer clic la apertura sea de **0 ms**.

#### B. Motor Central de Estado y Persistencia (`public/js/store.js`)
- Gestiona el estado reactivo central bajo el objeto global `window.VelvetStore`.
- **Estructura de Preferencias Versionadas (`v2`):**
  ```javascript
  const DEFAULT_PREFERENCES = {
    version: 2,
    defaultQuality: 'auto',       // 'auto' | '1080p' | '720p' | '480p'
    autoplayNext: true,           // Reproducir siguiente video automáticamente
    ambientLighting: true,        // Luces ambientales Ambilight
    reduceMotion: false,          // Desactivar animaciones pesadas
    dataSaver: false,             // Modo ahorro de datos (sin prefetch)
    vaultViewMode: 'grid',        // 'grid' | 'list' para la Bóveda
    pauseHistory: false,          // Pausar registro por privacidad
    onlyUnfinishedHistory: false  // Filtrar solo contenido a medias
  };
  ```
- **Persistencia Cruzada:**
  Utiliza simultáneamente `localStorage` y cookies con directiva `SameSite=Lax` y duración de 30 días para sincronizar el estado entre pestañas y sesiones anónimas.

#### C. Módulo de la Bóveda y Favoritos (`public/js/vault.js`)
- **Agrupación Cronológica del Historial:**
  Agrupa los registros comparando las marcas de tiempo contra los inicios de día (medianoche):
  - `Hoy`: `at >= startOfToday`
  - `Ayer`: `at >= startOfYesterday`
  - `Esta semana`: `at >= startOfWeek`
  - `Este mes`: `at >= startOfMonth`
  - `Anteriormente`: tiempos más antiguos.
- **Acciones en Lote y Deshacer:**
  Permite multiselección de favoritos para borrado masivo y proporciona un buffer temporal con temporizador de **5 segundos** para revertir eliminaciones accidentales (`undoBtn`).

### 6.2 El Reproductor de Video Cinema-Pro (Innovación Técnica)
El reproductor integrado en `public/index.html` resuelve el dilema del alto consumo de recursos en navegadores sin aceleración por hardware:

1. **Detección Automática de Renderizado por Software:**
   ```javascript
   // Verificación de GPU vs CPU mediante WebGL
   function isSoftwareRenderingActive() {
     try {
       const canvas = document.createElement('canvas');
       const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
       if (!gl) return true;
       const ext = gl.getExtension('WEBGL_debug_renderer_info');
       if (!ext) return false;
       const renderer = (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
       return renderer.includes('swiftshader') || renderer.includes('basic render') || 
              renderer.includes('swangle') || renderer.includes('llvmpipe');
     } catch (e) {
       return false;
     }
   }
   ```
2. **Motor Ambilight Zero-CPU (Canvas 32x18):**
   - En lugar de aplicar un filtro CSS `filter: blur(75px)` (que obligaba a la CPU a calcular una convolución Gaussiana de 150 píxeles por muestra consumiendo entre 45ms y 85ms por frame), se dibuja el video en un canvas en miniatura de **32x18 píxeles**.
   - El navegador escala este canvas al tamaño completo de la pantalla mediante la **interpolación bilineal nativa** del rasterizador, produciendo un halo suave y atmosférico con un costo computacional de solo **0.1 ms**.
   - Se muestrea a una cadencia regulada de **4.5 fps** (cada 220 ms) cancelable por handle de `requestVideoFrameCallback`.
3. **Watchdog Dinámico de Tasa de Refresco:**
   ```javascript
   // Monitoreo de frames perdidos en tiempo real
   function startFrameRateWatchdog() {
     frameWatchdogInterval = setInterval(() => {
       if (!player || player.paused) return;
       const quality = player.getVideoPlaybackQuality ? player.getVideoPlaybackQuality() : null;
       if (!quality) return;
       const dropped = quality.droppedVideoFrames - lastDroppedFrames;
       const total = quality.totalVideoFrames - lastTotalFrames;
       if (total > 30 && (dropped / total) > 0.05) {
         // Si se pierde más del 5% de cuadros, desactiva automáticamente el Ambilight
         setAmbilightMode('off');
         showToast("Modo Fluido Automático Activado (60 FPS garantizados)");
       }
     }, 4000);
   }
   ```

### 6.3 Sistema de Diseño y Estilos
- **Paleta de Colores Luxury Nightclub:**
  - `pitch`: `#000000` (Fondo negro absoluto OLED).
  - `obsidian`: `#040209` (Negro profundo de segundo nivel).
  - `velvet`: `#090518` (Púrpura noche corporativo).
  - `glass`: `#0f0927` y `glasscard`: `#130b32` (Fondos de tarjetas y contenedores).
  - `hot`: `#ec4899` / `crimson`: `#f43f5e` (Acentos de interacción y botones clave).
  - `lav`: `#c4b5fd` (Tipografía secundaria y bordes sutiles).
  - `darkborder`: `#271754` (Líneas divisorias y contornos elegantes).
- **Responsive Design:**
  - Mobile First con soporte de muescas y barras de navegación del sistema (`viewport-fit=cover`, `env(safe-area-inset-bottom)`).
  - En pantallas móviles (< 640px) las tarjetas de cómics se presentan en 2 columnas con tipografía compacta; en pantallas de escritorio escalan a 4 o 6 columnas.

---

## 7. BACKEND / FUNCTIONS / API

El backend serverless de Cloudflare Pages reside en el archivo único catch-all:  
`VERSION_CLOUDFLARE/functions/api/[[path]].js`.

### 7.1 Configuración de Enrutamiento y Cabeceras
- **`public/_routes.json`:**
  ```json
  {
    "version": 1,
    "include": ["/api/*"],
    "exclude": []
  }
  ```
- **`public/_headers`:** Define la política de seguridad y caché estática:
  - Rutas privadas (`/boveda/*`, `/cuenta`, `/acceso`): `Cache-Control: private, no-store, must-revalidate` y `X-Robots-Tag: noindex, nofollow`.
  - Archivos estáticos inmutables (`*.css`, `_next/static/*`, `velvet_logo.png`): `Cache-Control: public, max-age=31536000, immutable`.
  - Service worker y HTML shell (`sw.js`, `*.html`): `Cache-Control: public, max-age=0, must-revalidate`.

### 7.2 Detalle de Endpoints de la API

#### 1. Streaming y Medios Stealth (HMAC-SHA256 & Anti-SSRF)
- **Rutas:** `GET /api/media`, `GET /api/image`, `GET /api/img`, `GET /api/video/stream`
- **Parámetros Query:**
  - `t`: Token criptográfico firmado con Web Crypto HMAC-SHA256 (`<payload_base64url>.<firma_hex_64chars>`).
  - `w`: Ancho deseado de imagen (120, 240, 360, 480, 720, 1080).
  - `q`: Calidad de compresión (50 a 90).
  - `fmt`: Formato de salida negociado (`auto`, `webp`, `avif`, `jpeg`).
- **Comportamiento Interno:**
  - **Firma y Verificación Criptográfica (Web Crypto API):** El servidor verifica la firma HMAC-SHA256 del payload utilizando `crypto.subtle` y la variable de entorno secreta `MEDIA_SECRET`. La comparación se realiza en tiempo constante (`timingSafeEqual`) para evitar ataques de canal lateral por temporización. Cualquier alteración de payload o firma es rechazada con `HTTP 403 Forbidden`. Se eliminó por completo el soporte de descifrado XOR antiguo.
  - **Expiración de Tokens:** El payload decodificado contiene `{ u: upstreamUrl, r: referer, exp: expirationTimestamp }`. Si el timestamp `exp` ha caducado, se deniega con `HTTP 403 Forbidden: Media token expired`.
  - **Protección Estricta Anti-SSRF (`isSafeUpstreamUrl`):** Antes de iniciar la conexión con el servidor remoto, se valida que la URL sea HTTPS/HTTP y se bloquean accesos a:
    - Redes privadas IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `0.0.0.0/8`).
    - Metadatos de proveedores Cloud (`169.254.169.254`).
    - Direcciones IPv6 de loopback o privadas (`::1`, `fc00::/7`, `fe80::/10`).
    - Nombres de host no autorizados fuera de la lista blanca de CDNs permitidas.
  - **Streaming de Video con Range Requests:** Analiza la cabecera `Range` cliente (ej. `bytes=0-1048576`), inyecta cabeceras `User-Agent` y `Referer` legítimas aguas arriba y retransmite en `206 Partial Content` con soporte de búsqueda instantánea.
  - **Caché y Optimización de Imágenes:** Genera `ETag` determinista; si coincide con `If-None-Match`, devuelve `304 Not Modified` ahorrando ancho de banda. Aplica caché L2 en el Edge por hasta 1 año.

#### 2. Catálogo General y Búsqueda (Paginación Monotónica Blindada)
- **Ruta:** `GET /api/items`
- **Parámetros Query:**
  - `media_type`: `comic` (por defecto), `video` o `gallery`.
  - `page`: Número de página (inicia en 1).
  - `page_size`: Elementos por página (por defecto 24 en PC, 12 en móvil, máx 100).
  - `q`: Término de búsqueda textual (sanitizado contra inyección PostgREST).
  - `category`: Filtro de género o sub-categoría (`pmv`, `4k`, `cosplay`, `asian`, etc.).
  - `tag`: Filtro por etiqueta exacta.
  - `sort`: Modo de ordenación (`recent`, `views`, `likes`, `random`).
  - `seed`: Semilla determinista para ordenación aleatoria estable en la sesión.
- **Respuesta (JSON):**
  ```json
  {
    "items": [
      {
        "id": 10524,
        "source": "comics18_org",
        "source_id": "capitulo-1",
        "title": "Aventura Velvet",
        "cover_url": "/api/media?t=HMAC_SHA256_TOKEN",
        "media_type": "comic",
        "page_count": 28,
        "tags": ["Full Color", "Romance"]
      }
    ],
    "page": 1,
    "pageSize": 24,
    "total": 1420,
    "totalPages": 60
  }
  ```
- **Comportamiento Interno y Resolución del Bug de Paginación:**
  - **Filtros en Base de Datos:** Todos los filtros de exclusión (`page_count=gt.0`, `cover_url=not.is.null&cover_url=neq.`, `status=neq.blocked`, `real_people=eq.false`) se aplican a nivel de PostgREST ANTES de la paginación. Esto garantiza que cada página devuelta contenga exactamente `pageSize` ítems reales sin vacíos.
  - **Paginación Monotónica:** Se eliminó la dispersión por clusters (`COMIC_CLUSTERS`), calculando offsets continuos: `baseOffset + (safePage - 1) * pageSize`.
  - **Conteo Matemático Exacto:** El total de registros y páginas se extrae de la cabecera `Content-Range: 0-23/1562` devuelta por PostgreSQL, asegurando sincronización al 100% entre `total` y los ítems presentados.
  - **Caché L1 Isolate:** La clave de caché incluye todos los parámetros (`media_type`, `page`, `pageSize`, `q`, `category`, `tag`, `sort`, `seed`).

#### 3. Detalle de Ítem y Reparación JIT de Páginas
- **Rutas:** `GET /api/items/:source/:id` o `GET /api/items/id/:id`
- **Comportamiento Interno:**
  - Comprueba el caché L1 de detalle (`ISOLATE_DETAIL_CACHE`) y la API de caché L2 de Cloudflare.
  - Si es un video de PMVHaven y faltan fuentes de video, consulta en tiempo real la API oficial de PMVHaven (`https://pmvhaven.com/api/videos/:id`) y extrae los streams directos MP4/HLS.
  - **Sanitización y Reparación JIT:** Si es un cómic cuyas páginas están vacías en la base de datos o contienen imágenes de publicidad, banners de patrocinio o miniaturas de posts relacionados (YARPP), aplica una expresión regular de limpieza y calcula la carpeta mensual dominante (`/wp-content/uploads/YYYY/MM/`). Si el cómic fue reparado, actualiza la base de datos de Supabase en segundo plano sin retrasar al usuario mediante `context.waitUntil(...)`.

#### 4. Catálogo y Elementos Aleatorios
- **Ruta:** `GET /api/random`
- **Parámetros Query:** `media_type`, `count` (por defecto 15).
- **Comportamiento Interno:** Selecciona elementos mediante cálculo de desplazamiento pseudo-aleatorio sobre el rango de IDs de la base de datos para garantizar variedad instantánea sin bloqueos por consultas lentas de tipo `ORDER BY random()`.

#### 5. Autenticación y Cuentas
- **`POST /api/auth/login`:**
  - Recibe `{ email, password, device_token }`.
  - Valida credenciales contra `Supabase Auth` (`/auth/v1/token?grant_type=password`).
  - Registra el dispositivo del usuario (`registerOrTouchDevice`), limitando a un máximo de 10 dispositivos activos concurrentes.
  - Retorna `access_token`, `refresh_token`, perfil y estado VIP.
- **`POST /api/auth/register`:**
  - Recibe `{ email, password, invite_code }`.
  - Ejecuta la función almacenada atómica `claim_invite_key(code, email)`. Si la llave es válida, no ha expirado y no ha sido usada, procede a crear el usuario en Supabase Auth con confirmación automática de correo.
- **`GET /api/auth/me`:**
  - Valida el Bearer Token recibido en la cabecera `Authorization`.
  - Si el token expiró, lee la cabecera `X-Refresh-Token` e intenta renovar la sesión automáticamente.
- **`POST /api/auth/refresh`:**
  - Intercambia un refresh token por un nuevo access token de Supabase.
- **`POST /api/auth/logout`:**
  - Cierra la sesión activa en el cliente y borra las cookies asociadas.

#### 6. Favoritos e Historial de Usuario
- **`GET / POST / DELETE /api/favorites`:**
  - Requiere autenticación.
  - `GET`: Retorna los favoritos del usuario autenticado cruzando con los metadatos de los ítems.
  - `POST`: Inserta una relación `(user_id, item_id)` en la tabla `favorites`.
  - `DELETE`: Elimina el elemento de la lista del usuario.
- **`GET / POST / DELETE /api/user/history`:**
  - Registra o sincroniza el progreso de lectura (página actual) o video (segundo actual, duración total, estado completado).

#### 7. Etiquetas del Sistema
- **`GET /api/tags`:**
  - Retorna el listado consolidado de categorías y tags más populares para cómics, videos y galerías.

#### 8. Versión y Observabilidad del Sistema
- **Ruta:** `GET /api/version`
- **Autenticación:** Pública.
- **Respuesta (JSON):**
  ```json
  {
    "version": "3.1.0",
    "cache_version": "v11-velvet-turbo",
    "commit": "fix/auditoria-completa",
    "env": "production",
    "engine": "Cloudflare-Pages-Functions",
    "build_time": "2026-11-15T11:00:00.000Z"
  }
  ```
- **Propósito Técnico:** Permite al cliente, herramientas de CI/CD y verificadores de salud validar la versión desplegada en Cloudflare Pages, comprobar la versión de caché activa del Service Worker y verificar la estabilidad del edge worker sin realizar consultas a la base de datos.

---

## 8. DATOS Y ALMACENAMIENTO

### 8.1 Origen y Flujo de los Datos
Los datos atraviesan un ciclo de vida en tres etapas:
1. **Extracción (Local):** Los 17+ adaptadores Python en `scraper_hub/adapters/` o los scripts raíz extraen metadatos de sitios de terceros y los normalizan según el esquema Pydantic de `Item`.
2. **Consolidación Local (SQLite):** Los registros se guardan en el archivo `scraper_hub.db` (~534 MB, tabla `items`).
3. **Sincronización a la Nube (PostgreSQL en Supabase):** El script `sync/sync_supabase.py` envía lotes HTTP de 200 ítems hacia la API PostgREST de Supabase (`/rest/v1/items`), resolviendo duplicados por el par único `(source, source_id)`.

### 8.2 Esquema Completo de la Base de Datos (Supabase / PostgreSQL)

```sql
-- Extensiones requeridas
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- 1. Tabla de Perfiles de Usuario
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabla Principal de Catálogo (Items)
CREATE TABLE public.items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'comic', -- 'comic' | 'video' | 'gallery'
  title TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'es',
  tags TEXT[] NOT NULL DEFAULT '{}',
  artists TEXT[] NOT NULL DEFAULT '{}',
  page_count INTEGER NOT NULL DEFAULT 0,
  pages JSONB NOT NULL DEFAULT '[]',             -- Lista de objetos { index, image_url, referer }
  chapters JSONB NOT NULL DEFAULT '[]',          -- Capítulos de manhwas/series
  video_sources JSONB NOT NULL DEFAULT '[]',     -- Streams { quality, url, format }
  published_at TEXT,
  real_people BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'blocked')),
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_text TEXT NOT NULL DEFAULT '',
  -- Columnas propuestas para LQIP (Fase B.2)
  thumb_color VARCHAR(9) DEFAULT '#120822',
  thumb_lqip TEXT DEFAULT NULL,
  UNIQUE (source, source_id)
);

-- 3. Tabla de Favoritos por Usuario
CREATE TABLE public.favorites (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);

-- 4. Tabla de Llaves de Invitación
CREATE TABLE public.invite_keys (
  code TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_email TEXT,
  used_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);

-- 5. Tabla de Alias de Fuentes (Marca Blanca)
CREATE TABLE public.source_aliases (
  source TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE -- Ej: "Fuente 1", "Fuente 2"
);

-- 6. Vista Pública Segura del Catálogo (Security Barrier)
CREATE OR REPLACE VIEW public.catalog
WITH (security_barrier = true) AS
SELECT
  i.id,
  a.label AS source_label,
  i.media_type,
  i.title,
  i.language,
  i.tags,
  i.artists,
  GREATEST(i.page_count, jsonb_array_length(i.pages)) AS page_count,
  jsonb_array_length(i.pages) AS page_total,
  i.video_sources,
  i.search_text,
  i.scraped_at
FROM public.items i
LEFT JOIN public.source_aliases a ON a.source = i.source
WHERE i.status <> 'blocked' 
  AND i.real_people = FALSE 
  AND auth.uid() IS NOT NULL;
```

### 8.3 Triggers y Funciones de Seguridad en Base de Datos
- **Filtro Inmutable de Menores (`minor_content_match`):**
  Función PL/pgSQL que examina el texto de búsqueda (`search_text`) concatenado a partir de título, tags y artistas. Si coincide con una lista estricta de términos prohibidos vinculados a menores o edades inferiores a 18 años, el disparador `items_before_write` asigna irreversiblemente `status = 'blocked'`. Una vez bloqueado, ninguna actualización puede desbloquearlo.
- **Asignación Automática de Alias (`ensure_source_alias`):**
  Garantiza que cada nueva fuente externa reciba una etiqueta correlativa genérica ("Fuente 1", "Fuente 2") mediante una secuencia PostgreSQL, impidiendo que el nombre real del scraper sea visible al usuario.
- **Canje Atómico de Llaves (`claim_invite_key`):**
  Procedimiento almacenado transaccional que verifica vigencia y disponibilidad de una llave y la marca como consumida en una única instrucción atómica, previniendo condiciones de carrera (race conditions).

---

## 9. CONFIGURACIÓN Y DESPLIEGUE

### 9.1 Despliegue en Cloudflare Pages
El despliegue de `morbohub.pages.dev` se fundamenta en la arquitectura nativa de Cloudflare Pages:
- **Directorio Raíz de Construcción:** `VERSION_CLOUDFLARE`
- **Carpeta de Salida Estática (Build Output Directory):** `public`
- **Directorio de Funciones:** `functions`
- **Comando de Build:** Ninguno requerido para la versión pura Pages (o `npm run build` si se empaqueta la capa Next.js).
- **Proceso de Despliegue Directo vía Wrangler:**
  ```powershell
  cd VERSION_CLOUDFLARE
  npx wrangler pages deploy public --project-name morbohub
  ```

### 9.2 Variables de Entorno Necesarias
Configuradas en el panel de Cloudflare Pages (Settings > Environment variables):

| Nombre de la Variable | Ámbito | Propósito |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Cloudflare Pages Functions | URL del proyecto Supabase (`https://<ref>.supabase.co`). |
| `SUPABASE_ANON_KEY` | Cloudflare Pages Functions | Clave anónima pública de Supabase utilizada para lecturas estándar sujetas a RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo Servidor (Secret Encrypted) | Clave de servicio para operaciones atómicas de registro con invitación y administración. |
| `MEDIA_SECRET` | Solo Servidor (Secret Encrypted) | Clave secreta (mínimo 32 caracteres) para firma criptográfica HMAC-SHA256 de tokens multimedia. |
| `MASTER_EMAIL` | Servidor | Correo electrónico de la única cuenta con privilegios de Administrador. |
| `PATREON_CLIENT_ID` | Servidor (Opcional) | Identificador de aplicación OAuth2 registrado en Patreon. |
| `PATREON_CLIENT_SECRET` | Servidor (Secret Encrypted) | Secreto de cliente para autenticar con la API de Patreon. |
| `PATREON_CAMPAIGN_ID` | Servidor (Opcional) | Identificador de campaña de creador en Patreon para validar mecenas. |

### 9.3 Configuración de Caché y Red
- **Cloudflare CDN Cache:** Configurado a través de cabeceras en `_headers`:
  - Caché inmutable de 1 año (`max-age=31536000, immutable`) para hojas de estilo y logos.
  - Caché de 24 horas (`max-age=86400, stale-while-revalidate=604800`) para scripts estáticos y manifiesto.
  - Caché nula con revalidación forzada (`max-age=0, must-revalidate`) para `index.html` y `sw.js`, permitiendo actualizaciones inmediatas en cada despliegue sin problemas de caché residual.
- **Service Worker Cache (`sw.js` - Versión `v11-velvet-turbo`):**
  - Implementa estrategia **Network-First** para la navegación del shell HTML y **Cache-First** para recursos estáticos (fuentes de Google, iconos de FontAwesome).
  - **Exclusión Estricta:** Excluye expresamente de la caché del navegador los endpoints del catálogo paginado (`/api/items`), streaming de video (`/api/video/stream`), autenticación (`/api/auth/*`) y llamadas con cabecera `Range`. Esto resolvió de raíz el problema de desincronización de páginas en clientes Android.
  - Actualización garantizada con `skipWaiting()` y `clients.claim()` eliminando cachés obsoletas en el evento `activate`.

---

## 10. AUTENTICACIÓN Y SEGURIDAD

### 10.1 Modelo de Control de Acceso
El sistema implementa tres niveles de acceso claramente diferenciados:
1. **Visitante No Verificado:** Bloqueado en la entrada por la compuerta de verificación de edad (+18).
2. **Usuario Registrado / Estándar:** Ha validado su edad y ha iniciado sesión con una cuenta creada mediante llave de invitación. Puede navegar por el catálogo enmascarado ("Fuente 1, 2..."), guardar favoritos personales y registrar su historial de visualización.
3. **Usuario Administrador (Cuenta Maestra):** Usuario cuyo correo coincide con `MASTER_EMAIL` y posee `is_admin = true` en la tabla `profiles`. Tiene acceso exclusivo a la tabla física `items`, a los nombres reales de las fuentes, al panel de generación y revocación de llaves (`/admin`) y a las métricas del sistema.

### 10.2 Firma Criptográfica de Medios (HMAC-SHA256 & Expiración)
Para eliminar cualquier vulnerabilidad de cifrado reversible o exposición de secretos en el cliente:
- El antiguo cifrado simétrico XOR expuesto en el cliente fue **completamente eliminado**.
- Los tokens multimedia se firman **exclusivamente en el servidor** mediante HMAC-SHA256 con timestamp de expiración (`exp` a 6 horas):
```javascript
// Firma y verificación HMAC-SHA256 nativa en functions/api/[[path]].js
function signMediaToken(url, referer, secret, ttlSeconds = 21600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = JSON.stringify({ u: url, r: referer || '', exp });
  const b64 = toBase64Url(payload);
  const sig = hmacSha256Hex(b64, secret);
  return `${sig}.${b64}`;
}

function verifyMediaToken(token, secret) {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return null;
  const sig = token.slice(0, dotIdx);
  const b64 = token.slice(dotIdx + 1);
  const expectedSig = hmacSha256Hex(b64, secret);
  if (sig !== expectedSig) return null; // Firma inválida
  const data = JSON.parse(fromBase64Url(b64));
  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null; // Expirado
  return data;
}
```
El cliente web recibe únicamente URLs firmadas opacas:  
`/api/media?t=3a1f9e...eyJ1IjoiaHR0cHM6...`  
El navegador del usuario no contiene ninguna clave secreta ni algoritmos de descifrado.

### 10.3 Protección Estricta Anti-SSRF (`isSafeUpstreamUrl`)
Toda petición de streaming o imagen que pase por el proxy de borde es auditada antes de emitir la llamada de red:
```javascript
function isSafeUpstreamUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  
  // Bloqueo de loopback y rangos privados
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  
  // Bloqueo de metadatos de proveedores Cloud (AWS / GCP / Azure)
  if (host === '169.254.169.254') return false;
  
  // Bloqueo de IPv6 privadas y loopbacks
  if (host === '::1' || host.startsWith('fc00:') || host.startsWith('fe80:')) return false;
  
  // Verificación contra lista blanca de dominios CDN autorizados
  return ALLOWED_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}
```

### 10.4 Políticas de Seguridad en Base de Datos (Row Level Security - RLS)
Entregadas en el archivo `sql/01_rls_policies.sql`:
- **`public.items`:** Solo lectura pública para ítems con `status <> 'blocked'` y `real_people = false`. Modificación y borrado restringidos exclusivamente a `service_role` o administradores.
- **`public.profiles`:** Lectura y edición condicionada a `auth.uid() = id`.
- **`public.favorites`:** Cada usuario solo puede ver, agregar o eliminar sus propios favoritos (`auth.uid() = user_id`).
- **`public.invite_keys`:** Bloqueo absoluto de lectura para usuarios anónimos o no autorizados. Solo accesible vía RPC atómico `claim_invite_key` o por el rol `service_role`.

### 10.5 Trigger Inmutable de Protección de Menores
Entregado en el archivo `sql/02_minor_protection_audit.sql`:
- Se implementó un trigger PostgreSQL (`trg_prevent_illegal_terms`) que ejecuta la función `check_illegal_terms()` en `BEFORE INSERT OR UPDATE` sobre la tabla `items`.
- Cualquier registro entrante que contenga términos asociados con menores de edad o abuso es bloqueado a nivel de motor de base de datos (`RAISE EXCEPTION`), imposibilitando su almacenamiento accidental.

### 10.6 Cabeceras de Seguridad HTTP y CORS Estricto
Configuradas en `public/_headers` y en `functions/api/[[path]].js`:
- **Content-Security-Policy (CSP):** Restringe scripts a `'self'`, CDN de Tailwind, FontAwesome y Supabase.
- **Strict-Transport-Security (HSTS):** `max-age=31536000; includeSubDomains; preload`.
- **X-Frame-Options:** `DENY` (previene ataques de clickjacking).
- **X-Content-Type-Options:** `nosniff`.
- **CORS Estricto:** Conforme al estándar W3C/Fetch, se rechaza la combinación prohibida de `Access-Control-Allow-Origin: *` con `Access-Control-Allow-Credentials: true`. Las credenciales solo se habilitan cuando el origen es validado específicamente.

---

## 11. FLUJOS CLAVE PASO A PASO

### Flujo 1: Carga Inicial y Verificación de Edad (+18)
```text
[Navegador] -> GET https://morbohub.pages.dev/
  ├─> Cloudflare Pages entrega public/index.html (200 OK)
  ├─> El navegador ejecuta public/js/store.js
  │     └─> Comprueba: VelvetStore.isAgeVerified()
  │           ├─> Revisa localStorage['velvet_age_verified'] === '1'
  │           └─> Revisa cookie 'velvet_age_verified' === '1'
  ├─> [SI NO ESTÁ VERIFICADO]:
  │     └─> Remueve la clase 'hidden' del elemento #velvet-age-gate
  │     └─> El usuario hace clic en "Soy mayor de 18 años"
  │     └─> Dispara VelvetConfirmAge(true)
  │     └─> Guarda '1' en localStorage y cookie por 30 días
  │     └─> Oculta #velvet-age-gate
  └─> [SI ESTÁ VERIFICADO]:
        └─> Permite ejecución inmediata de public/js/router.js
```

### Flujo 2: Búsqueda, Filtrado y Paginación de Catálogo
```text
[Usuario escribe "pmv" o selecciona categoría]
  ├─> router.js actualiza la URL a /videos?cat=pmv sin recargar la página
  ├─> router.js emite 'velvet:route-render'
  ├─> index.html llama a fetchCatalogItems({ mediaType: 'video', category: 'pmv', page: 1 })
  ├─> Petición HTTP: GET /api/items?media_type=video&category=pmv&page=1
  ├─> Cloudflare Function ([[path]].js) intercepta la petición
  │     ├─> Consulta ISOLATE_CATALOG_CACHE (Hit: devuelve en 0.5 ms)
  │     └─> Miss: Consulta Supabase: items?media_type=eq.video&status=neq.blocked
  │     └─> Ofusca URLs de portada con encodeMediaToken()
  │     └─> Guarda en ISOLATE_CATALOG_CACHE
  ├─> Navegador recibe JSON
  └─> index.html ejecuta renderVideoGrid():
        └─> Genera tarjetas HTML con miniaturas 16:9 y badges de duración
```

### Flujo 3: Reproducción de Video Cinema-Pro (Ambilight y Watchdog)
```text
[Usuario hace clic en una tarjeta de video]
  ├─> router.js intercepta el clic y navega a /v/12345-titulo-slug
  ├─> Oculta #catalog-view y muestra #video-view
  ├─> Petición HTTP: GET /api/items/id/12345
  ├─> [[path]].js devuelve video_sources con URLs de streaming /api/media?t=...
  ├─> Inicializa el elemento <video id="video-element">
  │     ├─> Si la fuente es .m3u8: inicializa Hls.js y carga el manifiesto
  │     └─> Si es .mp4: asigna directamente video.src
  ├─> Inicia evento onplay:
  │     ├─> scheduleAmbilightLoop(): Muestrea fotogramas a 4.5 fps
  │     │     └─> Dibuja frame en #video-ambilight-canvas (32x18 píxeles)
  │     │     └─> CSS interpola el canvas en un halo difuso ultra suave (costo: 0.1ms)
  │     └─> startFrameRateWatchdog():
  │           └─> Cada 4s lee video.getVideoPlaybackQuality()
  │           └─> Si dropped frames > 5%, apaga Ambilight automáticamente
  └─> Petición diferida con window.requestIdleCallback:
        └─> Carga 8 videos relacionados en la columna lateral (#video-sidebar-column)
```

### Flujo 4: Apertura y Lectura de Cómic con Sanitización JIT
```text
[Usuario abre cómic en /c/6789-titulo-comic/leer]
  ├─> index.html invoca openReader('comics18_org', 'cap-1')
  ├─> Petición HTTP: GET /api/items/comics18_org/cap-1
  ├─> [[path]].js consulta Supabase:
  │     ├─> Si it.pages contiene publicidad o miniaturas YARPP:
  │     │     └─> cleanComicPagesList(): descarta URLs con 'banner', 'vip', etc.
  │     │     └─> Agrupa por carpeta YYYY/MM y elimina páginas fuera de la carpeta principal
  │     │     └─> context.waitUntil(): guarda en Supabase las páginas limpias en segundo plano
  │     └─> Si it.pages estaba vacío:
  │           └─> Si la fuente es 3hentai: genera páginas deterministas 1..N
  ├─> Navegador recibe lista de páginas sanitizadas
  ├─> Progressive Chunk Loader:
  │     └─> Inyecta en el DOM únicamente las primeras 4 imágenes con lazy-load
  │     └─> Configura IntersectionObserver para renderizar lotes de 4 conforme se hace scroll
  └─> Usuario puede alternar entre modo Webtoon (scroll continuo) o Slide (manga táctil)
```

### Flujo 5: Registro con Llave de Invitación
```text
[Usuario entra a /acceso y completa formulario de Registro]
  ├─> Envía: { email: "usuario@ejemplo.com", password: "...", invite_code: "VELVET-9X2A" }
  ├─> Petición HTTP: POST /api/auth/register
  ├─> [[path]].js procesa la solicitud:
  │     ├─> Invoca RPC en Supabase: claim_invite_key("VELVET-9X2A", "usuario@ejemplo.com")
  │     │     └─> Transacción PostgreSQL: Verifica no usada, no revocada y no expirada
  │     │     └─> Marca used_at = NOW() y retorna true
  │     ├─> [SI FALLA]: Devuelve HTTP 400 "Llave inválida o ya utilizada"
  │     └─> [SI TIENE ÉXITO]:
  │           └─> Llama a Supabase Auth Admin: createUser({ email, password, email_confirm: true })
  │           └─> Asocia used_by = user.id en la tabla invite_keys
  │           └─> El trigger on_auth_user_created inserta el registro en public.profiles
  └─> Responde HTTP 200 { ok: true } y el cliente inicia sesión automáticamente
```

---

## 12. DEPENDENCIAS

A continuación se detalla cada dependencia de software encontrada en el proyecto:

### 12.1 Dependencias de Node.js (`VERSION_CLOUDFLARE/package.json`)
| Paquete | Versión | Propósito Técnico |
| :--- | :--- | :--- |
| `next` | `^15.5.29` | Framework de React para renderizado del lado del servidor (SSR) y App Router híbrido. |
| `react` | `19.1.0` | Biblioteca central para construcción de interfaces basadas en componentes. |
| `react-dom` | `19.1.0` | Adaptador del DOM para React. |
| `@supabase/supabase-js` | `2.118.0` | Cliente oficial de Supabase para consultas a PostgREST y administración de Auth. |
| `@supabase/ssr` | `0.12.7` | Utilidad para manejo de tokens de Supabase mediante cookies seguras en middleware y SSR. |
| `@opennextjs/cloudflare` | `^1.20.16` | Compilador que transforma la salida de Next.js en código compatible con Cloudflare Workers. |
| `server-only` | `^0.0.1` | Garantiza que ciertos módulos del servidor nunca se filtren al código del cliente. |
| `wrangler` | `^4.160.0` | CLI oficial de Cloudflare para pruebas locales, empaquetado y despliegue de Workers y Pages. |
| `typescript` | `5.8.3` | Compilador y tipado estático para TypeScript. |
| `@types/node` | `22.15.3` | Definiciones de tipos de TypeScript para APIs del entorno Node.js. |
| `@types/react` | `19.1.2` | Tipos de TypeScript para React. |
| `@types/react-dom` | `19.1.2` | Tipos de TypeScript para React-DOM. |

### 12.2 Librerías de Frontend vía CDN (Sin instalación local)
| Librería | Enlace CDN | Propósito |
| :--- | :--- | :--- |
| **Tailwind CSS** | `cdn.tailwindcss.com` | Compilación Just-In-Time (JIT) en el navegador de estilos CSS utilitarios. |
| **FontAwesome Free** | `cdnjs.cloudflare.com/.../all.min.css` | Conjunto de iconos vectoriales para botones de control, reproducción y navegación. |
| **HLS.js** | `cdn.jsdelivr.net/npm/hls.js@latest` | Cliente de reproducción adaptativa para streams `.m3u8` en navegadores sin soporte HLS nativo. |

### 12.3 Dependencias de Python (`sync/requirements.txt` y `scraper_hub`)
| Paquete | Ámbito | Propósito |
| :--- | :--- | :--- |
| `requests` | Sincronización Nube | Cliente HTTP para enviar los lotes de datos hacia la API de Supabase vía HTTPS. |
| `fastapi` | Scraper Hub Local | Framework web asíncrono de alto rendimiento para la API local. |
| `pydantic` | Scraper Hub Local | Validación y definición de esquemas de datos estructurados para ítems de cómics y videos. |
| `typer` | Scraper Hub Local | Creación de la interfaz de línea de comandos (`scraper-hub`). |
| `uvicorn` | Scraper Hub Local | Servidor ASGI para ejecutar la API local de FastAPI. |
| `beautifulsoup4` | Scraper Hub Local | Parseo y extracción de elementos en documentos HTML durante el scraping. |

---

## 13. ESTADO DE AUDITORÍA, REPARACIONES Y MEJORAS IMPLEMENTADAS

### 13.1 Mitigaciones de Seguridad Ejecutadas (Fase 2)
1. **Erradicación Total de Secretos Hardcodeados:**
   - Se removieron todas las claves fijas (`SUPABASE_KEY`, `MEDIA_SECRET`, credenciales de fallback en `lib/patreon.ts`, tokens en `index.html` y `velvet.html`).
   - El backend lee estrictamente `context.env.*` lanzando errores claros descriptivos en caso de ausencia de configuración.
   - El archivo `.env.example` fue reescrito con marcadores de posición sin filtrar valores reales.
2. **Tokens Multimedia HMAC-SHA256 y Fin del XOR:**
   - El cifrado simétrico XOR expuesto en el cliente fue sustituido por tokens criptográficos firmados exclusivamente en el servidor con HMAC-SHA256 y estampilla de expiración (`exp` a 6 horas).
   - El cliente recibe URLs ya firmadas y no contiene ninguna lógica ni clave secreta.
3. **Protección Anti-SSRF:**
   - La función `isSafeUpstreamUrl` bloquea conexiones hacia IPs privadas (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `0.0.0.0`), metadatos de nube (`169.254.169.254`) y loopbacks IPv6, verificando dominios contra lista blanca.
4. **Sanitización de Consultas PostgREST:**
   - Los parámetros `q`, `category`, `tag`, `sort`, `page` y `page_size` se depuran mediante funciones especializadas eliminando caracteres reservados de sintaxis PostgREST.

### 13.2 Resolución del Bug de Paginación en Catálogo (Fase 1)
- **Causa Raíz:** El backend saltaba offsets basándose en anclajes (`COMIC_CLUSTERS`) agotando las páginas tempranas, y el Service Worker almacenaba en caché respuestas de `/api/items`.
- **Solución Implementada:**
  - Paginación secuencial estrictamente monotónica: `baseOffset + (safePage - 1) * pageSize`.
  - Filtros aplicados en PostgreSQL ANTES del rango: `page_count=gt.0`, `cover_url=not.is.null&cover_url=neq.`, `status=neq.blocked`, `real_people=eq.false`.
  - Total exacto derivado matemáticamente de la cabecera `Content-Range: 0-23/1562`.
  - Exclusión explícita de `/api/items` en el Service Worker (`v11-velvet-turbo`).
  - Control de carreras con `_catalogAbortController` y bandera de carga en el cliente.

### 13.3 Unificación y Limpieza de Código Muerto (Fase 3)
- `public/velvet.html` consolidado en `public/index.html` con redirecciones permanentes 301 en `_redirects`.
- Capa Next.js 15 archivada ordenadamente en `_archivo/nextjs-legacy/` para optimizar tiempos de build y simplificar la arquitectura a Cloudflare Pages nativo.
- Endpoint `/api/version` añadido para monitorización continua (`v3.1.0`).

### 13.4 Integridad de Datos y Scripts SQL (Fase 4)
- Generación de los 5 scripts SQL maestros en la carpeta `sql/`:
  - `01_rls_policies.sql` (Políticas RLS en PostgreSQL).
  - `02_minor_protection_audit.sql` (Trigger inmutable de prevención de términos ilícitos).
  - `03_data_integrity_audit.sql` (Consultas SELECT de diagnóstico de catálogo).
  - `04_indexes.sql` (Índices concurrentes sin bloqueo de tablas).
  - `05_thumbnails_lqip.sql` (Columnas de color y LQIP con migración no bloqueante O(1)).
- `sync/sync_supabase.py` robustecido con backoff exponencial con jitter y saneamiento de tokens en logs.

### 13.5 Optimizaciones Android y Rendimiento (Fase 5)
- Eliminación de layout jumps mediante `100dvh` (con fallback `100vh`) y `@supports (min-height: 100dvh)`.
- Relleno seguro para muesca de cámara frontal y barra del sistema (`safe-area-inset-top`, `safe-area-inset-bottom`).
- `SmartImageLoader` adaptativo: cancela tareas en cola y aborta peticiones en vuelo cuando las imágenes salen del viewport durante desplazamientos rápidos. Concurrencia acotada a 2 en conexiones 2G/3G o con modo Ahorro de Datos (`saveData`).
- Pre-carga del lector de cómics acotada estrictamente a 2 páginas por delante (o 1 en 3G, 0 en SaveData).

### 13.6 Calidad de Código y Accesibilidad (Fase 6)
- Soporte completo de teclado en visor (`ArrowLeft/Right`, `J/K`, `PageUp/Down`, `Space`, `A`, `+`, `-`, `0`, `F`, `Escape`) y reproductor de video (`Space/K`, `ArrowLeft/Right`, `J/L`, `ArrowUp/Down`, `M`, `F`, `T`, `P`, `0-9`).
- Atributos `aria-label` en controles interactivos clave.
- Suite de 54 pruebas unitarias automatizadas (`npm test`).

---

## 14. CÓMO EJECUTAR EL PROYECTO LOCALMENTE

### Opción A: Pruebas y Servidor de Cloudflare Pages (Oficial de Producción)
1. **Requisitos:** Node.js >= 20.0.0.
2. **Navegar a la carpeta del proyecto:**
   ```powershell
   cd "c:\Users\Eril\OneDrive\Desktop\PAGINAS SCRAPEADAS LISTAS\VERSION_CLOUDFLARE"
   ```
3. **Instalar dependencias de desarrollo:**
   ```powershell
   npm install
   ```
4. **Ejecutar la suite completa de pruebas automatizadas (54 tests):**
   ```powershell
   npm test
   # o alternativamente:
   npm run check
   ```
5. **Iniciar el entorno de desarrollo local de Cloudflare Pages:**
   ```powershell
   npm run dev
   ```
   El sitio estará disponible de inmediato en `http://localhost:8788`.

---

### Opción B: Motor de Scraping y Cosecha Local (`scraper_hub`)
Para recolectar nuevos cómics o consultar la base de datos SQLite local:
1. **Requisitos:** Python 3.10 o superior.
2. **Navegar al directorio del hub:**
   ```powershell
   cd "c:\Users\Eril\OneDrive\Desktop\PAGINAS SCRAPEADAS LISTAS\scraper_hub"
   ```
3. **Crear entorno virtual e instalar dependencias:**
   ```powershell
   python -m venv venv
   .\venv\Scripts\activate
   pip install -e .
   ```
4. **Iniciar el servidor local y visor de scraping:**
   ```powershell
   scraper-hub serve
   ```
   Abrir `http://localhost:8000`.

---

### Opción C: Sincronización Segura hacia Supabase (`sync/sync_supabase.py`)
Para transferir registros cosechados hacia la base de datos de producción:
1. **Entrar en la carpeta de sincronización:**
   ```powershell
   cd "c:\Users\Eril\OneDrive\Desktop\PAGINAS SCRAPEADAS LISTAS\VERSION_CLOUDFLARE\sync"
   ```
2. **Configurar las credenciales en `sync/.env`:**
   ```env
   SUPABASE_URL=https://qnmcejlxoufheisgkuyo.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=tu_nueva_service_role_key_regenerada
   ```
3. **Instalar requerimientos:**
   ```powershell
   pip install -r requirements.txt
   ```
4. **Ejecutar sincronización masiva:**
   ```powershell
   python sync_supabase.py desde-db --db "..\..\scraper_hub.db"
   ```

---

## 15. GLOSARIO DE TÉRMINOS TÉCNICOS DEL PROYECTO

- **Ambilight Zero-CPU:** Técnica de renderizado implementada en el reproductor de video que proyecta un halo luminoso dinámico alrededor de la pantalla muestreando el video en un canvas de resolución ultrabaja (32x18 píxeles) y delegando la dispersión a la interpolación bilineal de la GPU o rasterizador, evitando el estrangulamiento de la CPU por filtros CSS `blur()`.
- **Bóveda (The Vault):** Espacio privado del usuario en la interfaz (`/boveda/*`) que centraliza el almacenamiento de favoritos, el historial de reproducciones agrupado por fecha y los ajustes de perfil y suscripción.
- **Canje Atómico (Atomic Claim):** Transacción en base de datos PostgreSQL donde la validación y el consumo de una llave de invitación ocurren en una sola operación (`claim_invite_key`), impidiendo que dos personas utilicen la misma llave al mismo tiempo.
- **Isolate RAM Cache (Caché L1):** Diccionario en memoria RAM dentro del proceso V8 Worker de Cloudflare Pages que almacena respuestas de catálogo y detalles durante 15 minutos, reduciendo las consultas a Supabase y respondiendo en menos de 1 milisegundo.
- **JIT Sanitization (Sanitización Just-in-Time):** Algoritmo ejecutado en el backend que inspecciona las páginas de un cómic al momento de ser solicitado por un usuario. Si detecta publicidad o miniaturas intrusas, las purga al vuelo y actualiza la base de datos de forma asíncrona mediante `context.waitUntil`.
- **LQIP (Low-Quality Image Placeholder):** Cadena de texto base64 o imagen minúscula (~300 bytes) que se muestra de forma instantánea mientras se carga la portada original en alta resolución, evitando saltos de diseño (Cumulative Layout Shift).
- **Normativa 18 U.S.C. 2257:** Regulación federal de los Estados Unidos que exige el mantenimiento de registros de edad y consentimiento de los participantes en contenidos para adultos. La plataforma incluye descargos legales y compuertas de mayoría de edad para cumplir con este marco regulatorio.
- **PMV (Picture Music Video):** Formato de video adulto editado con ritmo musical y efectos visuales de alta cadencia.
- **PostgREST:** Módulo de Supabase que transforma automáticamente la estructura de tablas y vistas de PostgreSQL en una API RESTful protegida por autenticación JWT y Row Level Security.
- **Progressive Chunk Loading:** Estrategia de carga en el lector de cómics que solo inyecta en el DOM las 4 a 6 páginas visibles en la pantalla del usuario, agregando nuevos bloques a medida que se desliza el scroll vertical para evitar que el navegador se quede sin memoria.
- **Range Requests (HTTP 206 Partial Content):** Especificación HTTP que permite al navegador solicitar solo un fragmento específico de un archivo de video (por ejemplo: bytes del segundo 30 al 45), indispensable para rebobinar o adelantar sin tener que descargar el video completo.
- **Row Level Security (RLS):** Mecanismo de seguridad nativo de PostgreSQL que restringe las filas que un usuario autenticado puede leer, insertar o modificar según su identificador único (`auth.uid()`).
- **Software Rendering (Renderizado por Software):** Modo de ejecución del navegador donde la tarjeta gráfica (GPU) está desactivada y todo el trabajo de rasterización, decodificación de video y composición gráfica es asumido por la CPU mediante librerías como SwANGLE o SwiftShader.
- **Stealth Media Engine:** Capa de abstracción que cifra y proxifica todas las URLs multimedia con tokens XOR y simula cabeceras `Referer` y `User-Agent` de navegadores legítimos para eludir bloqueos y ocultar las fuentes originales.
- **Watchdog de Calidad (Frame Rate Watchdog):** Temporizador en JavaScript que evalúa la API `video.getVideoPlaybackQuality()` cada 4 segundos; si detecta más de un 5% de cuadros perdidos por sobrecarga del equipo, desactiva automáticamente los efectos visuales para mantener 60 FPS estables.

---

## 16. PREGUNTAS ABIERTAS Y ASPECTOS NO DETERMINABLES

Las siguientes incógnitas técnicas no pudieron resolverse únicamente mediante el análisis estático del código fuente y requieren confirmación por parte del administrador del sistema o del equipo de infraestructura:

1. **Configuración de Dominio Personalizado en Cloudflare:**
   El código muestra despliegues hacia `morbohub.pages.dev` y referencias a `velvet-proxy.workers.dev`. No es posible determinar desde el repositorio si existe un dominio de primer nivel personalizado configurado en Cloudflare DNS (por ejemplo: `velvethub.com` o similar) o si el tráfico de producción se atiende 100% sobre los subdominios de Cloudflare.
2. **Rotación y Seguridad de la Llave Maestra de Supabase:**
   Dado que `SUPABASE_KEY` (clave `service_role`) se encuentra hardcodeada en `functions/api/[[path]].js`, se desconoce si esta clave ya ha sido revocada o rotada en el panel de control de Supabase tras los despliegues iniciales.
3. **Webhook Activo de Patreon:**
   El código incluye el flujo OAuth2 de Patreon en `lib/patreon.ts` y las rutas de autorización/callback. Sin embargo, no se encontró un endpoint de recepción de Webhooks de Patreon (`/api/webhooks/patreon`). Por ende, no queda claro si la revocación de privilegios cuando un mecenas cancela su aporte se procesa en tiempo real mediante webhooks o únicamente cuando el usuario intenta iniciar sesión nuevamente.
4. **Frecuencia y Automatización de los Scrapers:**
   Existen crons en Next.js (`/api/cron/scrape` y `/api/cron/sync`), pero en la versión pura de Cloudflare Pages (`public/` + `functions/`) no hay definición de `triggers.crons` en `wrangler.jsonc`. No es posible determinar si la cosecha de contenido se ejecuta de forma 100% manual desde la PC local o si existe un servicio externo (como cron-job.org o un servidor VPS dedicado) invocando endpoints periódicamente.
5. **Estado de Aplicación de la Migración de Miniaturas:**
   La migración `migrations/20261113_add_thumbnail_metadata.sql` contiene un comentario que dice *"NO EJECUTAR DIRECTAMENTE — Requiere revisión previa"*. No se puede verificar desde los archivos locales si las columnas `thumb_color` y `thumb_lqip` ya fueron creadas en la base de datos de producción de Supabase o si la tabla `items` aún opera bajo el esquema original de `0001_init.sql`.

---
*Fin de la documentación técnica. Archivo generado para consumo humano y procesamiento exhaustivo por modelos de lenguaje (LLM).*
