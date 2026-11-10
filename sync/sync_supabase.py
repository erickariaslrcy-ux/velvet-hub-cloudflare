"""
Sube el catálogo de scraper_hub a Supabase para que lo vea el sitio web.

Se ejecuta en tu PC (donde los sitios sí cargan). Usa los adaptadores y el
filtro de scraper_hub tal cual; además la base de datos aplica su propio piso
fijo de protección de menores al recibir cada ítem.

Requiere en el entorno o en un archivo .env junto a este script:
    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=...

Uso:
    python sync_supabase.py desde-db --db ..\\scraper_hub\\scraper_hub.db
    python sync_supabase.py listar --fuente all --paginas 3
    python sync_supabase.py completar --limite 200
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from typing import Any, Dict, Iterable, List, Optional

import requests

BATCH = 200


def load_env() -> None:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class Supabase:
    def __init__(self) -> None:
        url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            sys.exit("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (en el entorno o en sync/.env).")
        self.rest = url.rstrip("/") + "/rest/v1"
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    def upsert(self, rows: List[Dict[str, Any]]) -> int:
        """Inserta o actualiza por (source, source_id). Agrupa por columnas para no
        borrar páginas ya guardadas cuando un listado trae el ítem sin páginas."""
        groups: Dict[tuple, List[Dict[str, Any]]] = {}
        for r in rows:
            groups.setdefault(tuple(sorted(r.keys())), []).append(r)
        done = 0
        for cols, group in groups.items():
            for i in range(0, len(group), BATCH):
                chunk = group[i : i + BATCH]
                for attempt in range(3):
                    resp = self.s.post(
                        f"{self.rest}/items",
                        params={"on_conflict": "source,source_id", "columns": ",".join(cols)},
                        headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                        data=json.dumps(chunk, ensure_ascii=False).encode("utf-8"),
                        timeout=60,
                    )
                    if resp.ok:
                        done += len(chunk)
                        break
                    if attempt == 2 or resp.status_code < 500:
                        print(f"  ! Error {resp.status_code}: {resp.text[:300]}")
                        break
                    time.sleep(2 * (attempt + 1))
        return done

    def missing_pages(self, limit: int, source: Optional[str]) -> List[Dict[str, Any]]:
        params = {
            "select": "source,source_id,url",
            "pages": "eq.[]",
            "chapters": "eq.[]",
            "status": "neq.blocked",
            "order": "id.desc",
            "limit": str(limit),
        }
        if source and source != "all":
            params["source"] = f"eq.{source}"
        resp = self.s.get(f"{self.rest}/items", params=params, timeout=60)
        resp.raise_for_status()
        return resp.json()


def item_row(item: Any) -> Dict[str, Any]:
    """Convierte un scraper_hub Item (pydantic) a fila de Supabase."""
    d = item.model_dump(mode="json")
    return to_row(d)


def to_row(d: Dict[str, Any]) -> Dict[str, Any]:
    pages = d.get("pages") or []
    chapters = d.get("chapters") or []
    video_sources = d.get("video_sources") or []
    row: Dict[str, Any] = {
        "source": d["source"],
        "source_id": str(d["source_id"]),
        "url": d.get("url") or "",
        "media_type": d.get("media_type") or "comic",
        "title": (d.get("title") or str(d["source_id"]))[:500],
        "cover_url": d.get("cover_url") or "",
        "language": d.get("language") or "es",
        "tags": [t for t in (d.get("tags") or []) if t],
        "artists": [a for a in (d.get("artists") or []) if a],
        "page_count": int(d.get("page_count") or len(pages) or 0),
        "published_at": d.get("published_at"),
        "real_people": bool(d.get("real_people")),
        "status": d.get("status") or "pending",
    }
    # Solo enviar páginas/capítulos/videos si vienen, para no borrar los ya guardados.
    if pages:
        row["pages"] = [{"index": p["index"], "image_url": p["image_url"], "referer": p.get("referer")} for p in pages]
    if chapters:
        row["chapters"] = chapters
    if video_sources:
        row["video_sources"] = video_sources
    return row


def from_sqlite(db_path: str) -> Iterable[Dict[str, Any]]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    for r in con.execute("select * from items"):
        if not r["url"] and r["status"] == "blocked":
            continue
        v_sources = []
        if "video_sources_json" in r.keys() and r["video_sources_json"]:
            try:
                v_sources = json.loads(r["video_sources_json"])
            except Exception:
                pass
        yield to_row(
            {
                "source": r["source"],
                "source_id": r["source_id"],
                "url": r["url"],
                "media_type": r["media_type"],
                "title": r["title"],
                "cover_url": r["cover_url"],
                "language": r["language"],
                "tags": json.loads(r["tags_json"] or "[]"),
                "artists": json.loads(r["artists_json"] or "[]"),
                "page_count": r["page_count"],
                "published_at": r["published_at"],
                "real_people": bool(r["real_people"]),
                "status": r["status"],
                "pages": json.loads(r["pages_json"] or "[]"),
                "chapters": json.loads(r["chapters_json"] or "[]"),
                "video_sources": v_sources,
            }
        )
    con.close()


def adapters(source: str):
    from scraper_hub.core.registry import get_adapter, list_adapters

    if source == "all":
        return list_adapters()
    a = get_adapter(source)
    if not a:
        sys.exit(f"Fuente '{source}' no existe.")
    return [a]


def cmd_desde_db(sb: Supabase, args) -> None:
    rows = list(from_sqlite(args.db))
    print(f"Subiendo {len(rows)} ítems desde {args.db}…")
    print(f"Listo: {sb.upsert(rows)} subidos.")


def cmd_listar(sb: Supabase, args) -> None:
    for a in adapters(args.fuente):
        total = 0
        for page in range(1, args.paginas + 1):
            try:
                items = a.list_page(page)
            except Exception as e:
                print(f"  {a.id} pág {page}: error {e}")
                break
            if not items:
                break
            total += sb.upsert([item_row(it) for it in items])
        print(f"{a.id}: {total} ítems subidos")


def cmd_completar(sb: Supabase, args) -> None:
    from scraper_hub.core.models import BlockedItemError
    from scraper_hub.core.registry import get_adapter

    pending = sb.missing_pages(args.limite, args.fuente)
    print(f"{len(pending)} ítems sin páginas. Abriendo cada uno…")
    ok = 0
    for i, r in enumerate(pending, 1):
        a = get_adapter(r["source"])
        if not a:
            continue
        try:
            item = a.get_item(r["url"] or r["source_id"])
        except BlockedItemError:
            sb.upsert([{"source": r["source"], "source_id": r["source_id"], "status": "blocked", "title": r["source_id"]}])
            continue
        except Exception as e:
            print(f"  [{i}] {r['source']}:{r['source_id']} error: {e}")
            continue
        row = item_row(item)
        row["source_id"] = r["source_id"]  # mantener la clave del listado
        ok += sb.upsert([row])
        if i % 10 == 0:
            print(f"  {i}/{len(pending)}")
    print(f"Listo: {ok} completados.")


def main() -> None:
    load_env()
    p = argparse.ArgumentParser(description="Sube el catálogo de scraper_hub a Supabase.")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("desde-db", help="Sube todo lo que ya está en scraper_hub.db")
    d.add_argument("--db", default=os.path.join("..", "scraper_hub", "scraper_hub.db"))

    l = sub.add_parser("listar", help="Scrapea listados y los sube")
    l.add_argument("--fuente", default="all")
    l.add_argument("--paginas", type=int, default=1)

    c = sub.add_parser("completar", help="Abre los ítems sin páginas y sube sus páginas")
    c.add_argument("--fuente", default="all")
    c.add_argument("--limite", type=int, default=100)

    args = p.parse_args()
    sb = Supabase()
    {"desde-db": cmd_desde_db, "listar": cmd_listar, "completar": cmd_completar}[args.cmd](sb, args)


if __name__ == "__main__":
    main()
