"use client";

import Link from "next/link";
import FavButton from "./FavButton";
import { imgSrc } from "@/lib/img";
import type { CardItem } from "@/lib/types";

export default function ItemGrid({
  items,
  favs,
  admin,
}: {
  items: CardItem[];
  favs: Set<number>;
  admin?: boolean;
}) {
  if (!items.length) {
    return (
      <div className="empty-catalog card glass" style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: "3rem", marginBottom: 12 }}>🔍</div>
        <h3 style={{ fontSize: "1.3rem", fontWeight: 700, color: "#fff" }}>No se encontraron títulos</h3>
        <p className="muted small" style={{ color: "rgba(255,255,255,0.6)", marginTop: 8 }}>
          Intenta con otra palabra clave o navega entre Cómics y Videos.
        </p>
      </div>
    );
  }

  return (
    <div className="grid">
      {items.map((it) => {
        const isVideo = it.media_type === "video";
        return (
          <div key={it.id} className="item-card glass" style={{ position: "relative", overflow: "hidden", borderRadius: 14 }}>
            <Link href={`/item/${it.id}`} className="card-link-wrapper" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
              <div className="card-cover-box" style={{ position: "relative", width: "100%", aspectRatio: isVideo ? "16/9" : "3/4", background: "#0a0a0f", overflow: "hidden" }}>
                {it.has_cover ? (
                  <img
                    src={imgSrc(it.id)}
                    alt={it.title}
                    loading="lazy"
                    className="card-cover-img"
                    style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform 0.3s ease" }}
                    onError={(e) => {
                      // Fallback visual si el upstream falla
                      (e.target as HTMLImageElement).style.display = "none";
                      const p = (e.target as HTMLElement).parentElement;
                      if (p) p.style.background = "linear-gradient(135deg, #1f1128, #0f0a18)";
                    }}
                  />
                ) : (
                  <div className="card-cover-placeholder" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "2rem" }}>
                    <span>{isVideo ? "🎬" : "📖"}</span>
                  </div>
                )}

                {/* Insignias Superiores */}
                <div className="card-top-badges" style={{ position: "absolute", top: 8, left: 8, right: 8, display: "flex", justifyContent: "space-between", pointerEvents: "none" }}>
                  {isVideo ? (
                    <span className="badge" style={{ background: "rgba(255, 45, 85, 0.9)", color: "#fff", fontWeight: 800, fontSize: "0.68rem", padding: "3px 8px", borderRadius: 6, backdropFilter: "blur(4px)" }}>
                      1080p HD
                    </span>
                  ) : it.page_count > 0 ? (
                    <span className="badge badge-pages" style={{ background: "rgba(0, 0, 0, 0.75)", color: "#fff", fontWeight: 700, fontSize: "0.68rem", padding: "3px 8px", borderRadius: 6, backdropFilter: "blur(4px)" }}>
                      📑 {it.page_count}p
                    </span>
                  ) : (
                    <span />
                  )}
                  <span style={{ background: "rgba(147, 51, 234, 0.8)", color: "#fff", fontSize: "0.62rem", fontWeight: 800, padding: "3px 6px", borderRadius: 6 }}>
                    VIP
                  </span>
                </div>

                {/* Ícono de Play para videos */}
                {isVideo && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                    <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(255, 45, 85, 0.85)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 20px rgba(255,45,85,0.6)" }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 3 }}>
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  </div>
                )}

                {/* Degradado inferior protector */}
                <div className="card-gradient-overlay" style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "40%", background: "linear-gradient(to top, rgba(10,10,15,0.9), transparent)", pointerEvents: "none" }} />
              </div>

              <div className="card-body" style={{ padding: "12px 14px" }}>
                <h3 className="card-title" title={it.title} style={{ fontSize: "0.92rem", fontWeight: 700, color: "#fff", margin: 0, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", minHeight: "2.5em" }}>
                  {it.title}
                </h3>

                <div className="card-footer-meta" style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="badge" style={{ background: isVideo ? "rgba(255,45,85,0.15)" : "rgba(147,51,234,0.15)", color: isVideo ? "#ff4d6d" : "#c084fc", fontSize: "0.7rem", fontWeight: 700, padding: "2px 8px", borderRadius: 999 }}>
                    {isVideo ? "Transmisión HD" : "Cómic Digital"}
                  </span>
                  {it.tags && it.tags.length > 0 && (
                    <span style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.4)" }}>
                      #{it.tags[0]}
                    </span>
                  )}
                </div>
              </div>
            </Link>

            {/* Botón de favorito independiente */}
            <div className="card-fav-anchor" style={{ position: "absolute", top: 8, right: 8, zIndex: 10 }}>
              <FavButton id={it.id} initial={favs.has(it.id)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
