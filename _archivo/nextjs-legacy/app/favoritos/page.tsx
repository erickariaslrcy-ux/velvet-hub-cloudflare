import Nav from "@/components/Nav";
import ItemGrid from "@/components/ItemGrid";
import { getUser, isAdmin } from "@/lib/supabase/server";
import { CARD_COLUMNS, type CardItem } from "@/lib/types";
import { redirect } from "next/navigation";

export default async function FavoritosPage() {
  const { supabase, user } = await getUser();
  const admin = await isAdmin();

  if (!user) {
    redirect("/?tab=vault");
  }

  const { data: favRows } = await supabase
    .from("favorites")
    .select("item_id,created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1000);

  const ids = (favRows ?? []).map((r: { item_id: number }) => r.item_id);
  let items: CardItem[] = [];
  if (ids.length) {
    const { data } = await supabase.from("catalog").select(CARD_COLUMNS).in("id", ids);
    const byId = new Map(((data ?? []) as CardItem[]).map((i) => [i.id, i]));
    items = ids.map((id) => byId.get(id)).filter(Boolean) as CardItem[];
  }

  return (
    <>
      <Nav active="favoritos" />
      <main className="container" style={{ paddingBottom: 60, paddingTop: 20 }}>
        <div className="breadcrumb-row" style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: "#fff" }}>❤️ Mis Favoritos</h1>
          <p className="muted small" style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.6)" }}>
            {items.length} {items.length === 1 ? "título guardado" : "títulos guardados"} en tu colección personal
          </p>
        </div>

        <ItemGrid items={items} favs={new Set(ids)} admin={admin} />
      </main>
    </>
  );
}
