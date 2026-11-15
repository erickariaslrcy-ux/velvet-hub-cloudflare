"use client";
import { useState } from "react";

export default function FavButton({ id, initial, big }: { id: number; initial: boolean; big?: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: id, favorite: next }),
    }).catch(() => null);
    if (!res || !res.ok) setOn(!next);
    setBusy(false);
  }

  return (
    <button
      className={`fav-btn ${on ? "on" : ""} ${big ? "big" : ""}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? "Quitar de favoritos" : "Agregar a favoritos"}
    >
      {on ? "♥" : "♡"}{big && (on ? " En favoritos" : " Agregar a favoritos")}
    </button>
  );
}
