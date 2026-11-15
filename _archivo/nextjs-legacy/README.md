# ARCHIVO DE CÓDIGO LEGADO: NEXT.JS / OPENNEXT

## Motivo del Archivo
Durante la auditoría de ingeniería (Fase 0 y Fase 3), se confirmó fehacientemente que la plataforma en producción (`https://morbohub.pages.dev/`) se ejecuta exclusivamente bajo la arquitectura nativa de **Cloudflare Pages + Pages Functions + Supabase**.

Los componentes y rutas contenidos en este directorio (`app/`, `components/`, `lib/`, `wrangler.jsonc`, `open-next.config.ts`):
1. Pertenecían a un prototipo experimental con Next.js 15 y OpenNext.
2. En producción, las rutas catch-all de Next.js se limitaban a leer el archivo estático `public/index.html` con `fs.readFileSync`.
3. Todo el catálogo real, autenticación, streaming de video y lógica de negocio se ejecuta de forma autónoma en `functions/api/[[path]].js` y en la Single Page Application `public/index.html`.
4. Mantener estas carpetas en la raíz provocaba confusión sobre la fuente de verdad arquitectónica y saturaba los tiempos de compilación y límites de memoria de Cloudflare.

Este directorio se conserva de manera no destructiva con fines históricos y de referencia.
