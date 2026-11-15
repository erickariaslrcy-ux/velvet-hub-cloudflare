import type { SupabaseClient } from "@supabase/supabase-js";

// Mapa "Fuente N" -> nombre real. Vacío para usuarios normales.
export async function realSourceMap(supabase: SupabaseClient, admin: boolean) {
  const map = new Map<string, string>();
  if (!admin) return map;
  const { data } = await supabase.rpc("admin_source_aliases");
  for (const r of (data as { source: string; label: string }[] | null) ?? []) map.set(r.label, r.source);
  return map;
}

export async function favoriteIds(supabase: SupabaseClient, userId: string, ids: number[]) {
  if (!ids.length) return new Set<number>();
  const { data } = await supabase.from("favorites").select("item_id").eq("user_id", userId).in("item_id", ids);
  return new Set((data ?? []).map((r: { item_id: number }) => r.item_id));
}
