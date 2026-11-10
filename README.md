# Biblioteca (sitio web)

Sitio privado para buscar, leer y guardar favoritos del catálogo que genera `scraper_hub`.
Next.js en Vercel + Supabase (auth y base de datos).

## Cómo funciona

- **Registro solo por llave.** El registro público está desactivado en Supabase. Una persona
  crea su cuenta en `/registro` con una llave que generas tú en `/admin`. Cada llave sirve una vez.
- **Cuenta maestra.** Es la única con `is_admin`. Ve el panel `/admin` (generar y revocar llaves,
  bloquear usuarios, conteo por fuente) y el nombre real de cada fuente.
- **Los usuarios no ven de dónde sale nada.** Leen la vista `catalog`, que muestra "Fuente 1, 2…"
  en vez del sitio y no incluye URLs. Las imágenes pasan por `/api/img?i=<id>&p=<página>`, que
  busca la URL en la base, así que el navegador nunca ve el dominio de origen.
- **Favoritos** por usuario, protegidos con RLS (cada quien solo ve los suyos).

## Filtro de contenido (dos capas)

1. **Tu filtro de `scraper_hub`** (`config/palabras_bloqueadas.txt`) decide qué se sube.
2. **Piso fijo en la base de datos** (`minor_content_match` + trigger en `items`): al guardar un ítem
   revisa título, tags y artistas y marca como `blocked` lo explícito con menores (loli, shota, niña,
   edades < 18…). Nadie, ni el admin, ve un ítem bloqueado, y una actualización no lo desbloquea.
   Los ítems con `real_people = true` también quedan ocultos (requieren verificación 2257 aparte).

## Subir el catálogo (desde tu PC)

```powershell
cd sync
pip install -r requirements.txt
python sync_supabase.py desde-db --db "..\..\scraper_hub\scraper_hub.db"   # lo que ya tienes
python sync_supabase.py listar --fuente all --paginas 3                    # scrapear listados nuevos
python sync_supabase.py completar --limite 200                             # bajar páginas de los que faltan
```

`listar` y `completar` necesitan `scraper_hub` instalado (`pip install -e ..\..\scraper_hub`).
`sync/.env` lo crea el despliegue y nunca va al repo.

## Desarrollo local

```powershell
copy .env.example .env.local   # y rellenar
npm install
npm run dev
```
