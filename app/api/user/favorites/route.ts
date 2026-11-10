import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/auth-user";

export const runtime = "nodejs";

// GET /api/user/favorites - Obtiene todos los favoritos del usuario (de la nube y base de datos)
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = createAdminClient();
    const meta = user.user_metadata || {};
    const metaFavs: any[] = Array.isArray(meta.favorites) ? meta.favorites : [];

    // También buscar en la tabla SQL favorites
    let sqlFavs: any[] = [];
    try {
      const { data } = await admin
        .from("favorites")
        .select("item_id, created_at, items(id, title, cover_url, media_type, source, source_id, url)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      sqlFavs = (data || [])
        .filter((r) => r.items)
        .map((r: any) => ({
          id: r.items.id,
          title: r.items.title,
          cover_url: r.items.cover_url,
          media_type: r.items.media_type,
          source: r.items.source,
          source_id: r.items.source_id,
          url: r.items.url,
          created_at: r.created_at,
        }));
    } catch (e) {}

    // Combinar sin duplicados (metaFavs tienen prioridad por ser más detallados)
    const combinedMap = new Map<string, any>();
    metaFavs.forEach((f) => {
      if (!f) return;
      const key = f.id ? String(f.id) : `${f.source}:${f.source_id}`;
      combinedMap.set(key, f);
    });
    sqlFavs.forEach((f) => {
      if (!f) return;
      const key = f.id ? String(f.id) : `${f.source}:${f.source_id}`;
      if (!combinedMap.has(key)) combinedMap.set(key, f);
    });

    const items = Array.from(combinedMap.values());

    return NextResponse.json(items, {
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/user/favorites - Guarda un favorito o sincroniza múltiples en user_metadata y SQL
export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const admin = createAdminClient();
    const meta = user.user_metadata || {};
    let cloudFavs: any[] = Array.isArray(meta.favorites) ? [...meta.favorites] : [];

    // CASO A: Sincronización masiva de favoritos (ej: al loguearse o sincronizar entre PC y móvil)
    if (Array.isArray(body.items)) {
      const incomingItems: any[] = body.items;
      const favMap = new Map<string, any>();

      // Primero los existentes en la nube
      cloudFavs.forEach((f) => {
        if (!f) return;
        const k = f.id ? String(f.id) : `${f.source}:${f.source_id}`;
        favMap.set(k, f);
      });

      // Luego los del cliente sin sobreescribir ni perder ninguno
      incomingItems.forEach((f) => {
        if (!f) return;
        const k = f.id ? String(f.id) : `${f.source}:${f.source_id}`;
        if (!favMap.has(k)) {
          favMap.set(k, {
            id: f.id || null,
            source: f.source || "",
            source_id: f.source_id || "",
            title: f.title || "Sin título",
            cover_url: f.cover_url || "",
            url: f.url || "",
            media_type: f.media_type || "comic",
            created_at: f.created_at || new Date().toISOString(),
          });
        }
      });

      const mergedFavs = Array.from(favMap.values()).slice(0, 250);

      await admin.auth.admin.updateUserById(user.id, {
        user_metadata: {
          ...meta,
          favorites: mergedFavs,
        },
      });

      return NextResponse.json({ ok: true, items: mergedFavs, count: mergedFavs.length });
    }

    // CASO B: Guardar un favorito individual
    if (!body.id && !body.source_id && !body.title) {
      return NextResponse.json({ error: "Datos de favorito incompletos" }, { status: 400 });
    }

    const itemId = body.id || body.item_id || null;
    const source = body.source || "";
    const sourceId = body.source_id || "";

    cloudFavs = cloudFavs.filter((f: any) => {
      if (itemId && f.id && Number(f.id) === Number(itemId)) return false;
      if (source && sourceId && f.source === source && f.source_id === sourceId) return false;
      return true;
    });

    const newFav = {
      id: itemId,
      source,
      source_id: sourceId,
      title: body.title || "Sin título",
      cover_url: body.cover_url || "",
      url: body.url || "",
      media_type: body.media_type || "comic",
      created_at: new Date().toISOString(),
    };

    cloudFavs.unshift(newFav);
    if (cloudFavs.length > 250) cloudFavs = cloudFavs.slice(0, 250);

    // Guardar en user_metadata (100% garantizado en la nube)
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        favorites: cloudFavs,
      },
    });

    // Guardar también en tabla SQL si existe
    try {
      let resolvedItemId = itemId;
      if (!resolvedItemId && source && sourceId) {
        const { data: it } = await admin
          .from("items")
          .select("id")
          .eq("source", source)
          .eq("source_id", sourceId)
          .maybeSingle();
        if (it) resolvedItemId = it.id;
      }
      if (resolvedItemId) {
        await admin
          .from("favorites")
          .upsert({ user_id: user.id, item_id: Number(resolvedItemId) }, { onConflict: "user_id,item_id" });
      }
    } catch (e) {}

    return NextResponse.json({ ok: true, item: newFav, count: cloudFavs.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
