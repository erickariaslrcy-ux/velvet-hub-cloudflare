import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUser } from "@/lib/auth-user";

export const runtime = "nodejs";

// GET /api/user/history - Devuelve historial y progreso del usuario
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const meta = user.user_metadata || {};
    const history = Array.isArray(meta.history) ? meta.history : [];
    const progress = meta.progress && typeof meta.progress === "object" ? meta.progress : {};

    return NextResponse.json(history, {
      headers: {
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "X-Velvet-Progress": JSON.stringify(progress),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/user/history - Guarda o actualiza un ítem en el historial y progreso
export async function POST(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const item = body.item || body;
    if (!item || (!item.id && !item.source_id)) {
      return NextResponse.json({ error: "Datos de ítem incompletos" }, { status: 400 });
    }

    const admin = createAdminClient();
    const meta = user.user_metadata || {};
    let currentHistory: any[] = Array.isArray(meta.history) ? [...meta.history] : [];
    let currentProgress: Record<string, any> =
      meta.progress && typeof meta.progress === "object" ? { ...meta.progress } : {};

    // 1. Clave de identificación única (preferir ID numérico, luego composite)
    const itemId = item.id || null;
    const itemKey = itemId ? String(itemId) : `${item.source}:${item.source_id}`;

    // 2. Filtrar entrada previa en historial
    currentHistory = currentHistory.filter((h: any) => {
      if (itemId && h.id && Number(h.id) === Number(itemId)) return false;
      if (item.source && item.source_id && h.source === item.source && h.source_id === item.source_id) {
        return false;
      }
      return true;
    });

    // 3. Crear nuevo registro limpio y ligero
    const newEntry = {
      id: itemId,
      source: item.source || "",
      source_id: item.source_id || "",
      title: item.title || "Sin título",
      cover_url: item.cover_url || "",
      url: item.url || "",
      media_type: item.media_type || "comic",
      page: item.page || 1,
      total: item.total || 1,
      currentTime: item.currentTime || 0,
      duration: item.duration || 0,
      completed: !!item.completed,
      at: Date.now(),
    };

    currentHistory.unshift(newEntry);
    if (currentHistory.length > 50) currentHistory = currentHistory.slice(0, 50);

    // 4. Actualizar diccionario de progreso para reanudar exacto
    currentProgress[itemKey] = {
      page: newEntry.page,
      total: newEntry.total,
      currentTime: newEntry.currentTime,
      duration: newEntry.duration,
      completed: newEntry.completed,
      at: newEntry.at,
    };
    if (item.source && item.source_id) {
      currentProgress[`${item.source}:${item.source_id}`] = currentProgress[itemKey];
    }

    // 5. Guardar en Supabase auth.users user_metadata
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        history: currentHistory,
        progress: currentProgress,
      },
    });

    return NextResponse.json({ ok: true, count: currentHistory.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/user/history - Borra el historial o un ítem específico
export async function DELETE(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = createAdminClient();
    const meta = user.user_metadata || {};

    const url = new URL(req.url);
    const removeId = url.searchParams.get("id");
    const removeSource = url.searchParams.get("source");
    const removeSourceId = url.searchParams.get("source_id");

    let currentHistory: any[] = Array.isArray(meta.history) ? [...meta.history] : [];
    let currentProgress: Record<string, any> =
      meta.progress && typeof meta.progress === "object" ? { ...meta.progress } : {};

    if (removeId || (removeSource && removeSourceId)) {
      currentHistory = currentHistory.filter((h: any) => {
        if (removeId && h.id && String(h.id) === String(removeId)) return false;
        if (removeSource && removeSourceId && h.source === removeSource && h.source_id === removeSourceId) {
          return false;
        }
        return true;
      });
      if (removeId) delete currentProgress[String(removeId)];
      if (removeSource && removeSourceId) delete currentProgress[`${removeSource}:${removeSourceId}`];
    } else {
      currentHistory = [];
      currentProgress = {};
    }

    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        history: currentHistory,
        progress: currentProgress,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
