import sys
import os
import json
import sqlite3
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync_supabase import load_env, Supabase, to_row

load_env()
sb = Supabase()

db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scraper_hub.db"))
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

cur = conn.cursor()
cur.execute("SELECT * FROM items WHERE media_type = 'gallery' AND page_count > 0")
rows = cur.fetchall()
print(f"Galerías listas con fotos encontradas en DB: {len(rows)}")

payload = []
for r in rows:
    payload.append(to_row({
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
        "real_people": False,
        "status": "verified",
        "pages": json.loads(r["pages_json"] or "[]"),
        "chapters": [],
        "video_sources": [],
    }))

conn.close()

if payload:
    print(f"Subiendo {len(payload)} galerías a Supabase...")
    done = sb.upsert(payload)
    print(f"✔ ¡Éxito! {done} galerías sincronizadas en Supabase.")
else:
    print("No hay galerías listas para subir.")
