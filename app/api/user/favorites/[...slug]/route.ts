import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/auth-user";

export const runtime = "nodejs";

// POST /api/user/favorites/sync
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ slug?: string[] }> }
) {
  const { slug = [] } = await props.params;
  if (slug[0] === "sync") {
    try {
      const user = await getAuthenticatedUser(req);
      if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

      const body = await req.json().catch(() => ({}));
      const incomingItems: any[] = Array.isArray(body.items) ? body.items : [];

      const admin = createAdminClient();
      const meta = user.user_metadata || {};
      const existingFavs: any[] = Array.isArray(meta.favorites) ? meta.favorites : [];

      const favMap = new Map<string, any>();
      existingFavs.forEach((f) => {
        if (!f) return;
        const k = f.id ? String(f.id) : `${f.source}:${f.source_id}`;
        favMap.set(k, f);
      });

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

      const merged = Array.from(favMap.values()).slice(0, 250);
      await admin.auth.admin.updateUserById(user.id, {
        user_metadata: { ...meta, favorites: merged },
      });

      return NextResponse.json({ ok: true, items: merged, count: merged.length });
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Ruta no encontrada" }, { status: 404 });
}

// GET /api/user/favorites/sync
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ slug?: string[] }> }
) {
  const { slug = [] } = await props.params;
  if (slug[0] === "sync") {
    const user = await getAuthenticatedUser(req);
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    const meta = user.user_metadata || {};
    return NextResponse.json(Array.isArray(meta.favorites) ? meta.favorites : []);
  }
  return NextResponse.json({ error: "Ruta no encontrada" }, { status: 404 });
}

// DELETE /api/user/favorites/:itemId o /api/user/favorites/:source/:sourceId
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ slug?: string[] }> }
) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const { slug = [] } = await props.params;
    if (slug.length === 0) {
      return NextResponse.json({ error: "Faltan parámetros" }, { status: 400 });
    }

    const admin = createAdminClient();
    const meta = user.user_metadata || {};
    let currentFavs: any[] = Array.isArray(meta.favorites) ? [...meta.favorites] : [];

    let removedItemId: number | null = null;
    let source: string | null = null;
    let sourceId: string | null = null;

    // Caso 1: /api/user/favorites/{itemId}
    if (slug.length === 1 && /^\d+$/.test(slug[0])) {
      removedItemId = Number(slug[0]);
      currentFavs = currentFavs.filter((f: any) => {
        if (f.id && Number(f.id) === removedItemId) return false;
        return true;
      });
      try {
        await admin.from("favorites").delete().eq("user_id", user.id).eq("item_id", removedItemId);
      } catch {}
    } else {
      // Caso 2: /api/user/favorites/{source}/{...sourceId}
      source = slug[0];
      sourceId = slug.slice(1).join("/");
      currentFavs = currentFavs.filter((f: any) => {
        if (f.source === source && f.source_id === sourceId) return false;
        return true;
      });

      try {
        const { data: item } = await admin
          .from("items")
          .select("id")
          .eq("source", source)
          .eq("source_id", sourceId)
          .maybeSingle();

        if (item) {
          await admin.from("favorites").delete().eq("user_id", user.id).eq("item_id", item.id);
        }
      } catch {}
    }

    // Actualizar favoritos en user_metadata
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        favorites: currentFavs,
      },
    });

    return NextResponse.json({ ok: true, count: currentFavs.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
