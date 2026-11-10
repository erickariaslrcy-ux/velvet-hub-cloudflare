import Link from "next/link";
import { isAdmin } from "@/lib/supabase/server";

export default async function Nav({ active }: { active?: "buscar" | "favoritos" | "admin" }) {
  const admin = await isAdmin();
  return (
    <header className="nav glass">
      <div className="container nav-inner">
        <Link href="/buscar" className="brand-logo" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <img src="/velvet_logo.png" alt="Velvet Logo" style={{ width: 34, height: 34, objectFit: "contain", filter: "drop-shadow(0 0 8px rgba(255, 45, 85, 0.6))" }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 900, letterSpacing: "1px", fontSize: "1.1rem", color: "#fff", lineHeight: 1 }}>
              VELVET <span style={{ color: "#ff2d55" }}>HUB</span>
            </span>
            <span style={{ fontSize: "0.62rem", color: "rgba(255,255,255,0.55)", letterSpacing: "0.5px" }}>
              VIP PRIVATE STREAMING
            </span>
          </div>
          <span className="brand-tag" style={{ background: "linear-gradient(135deg, #ff2d55, #9333ea)", color: "#fff", fontWeight: 800, fontSize: "0.65rem", padding: "2px 7px", borderRadius: 999 }}>+18</span>
        </Link>

        <nav className="nav-links">
          <Link href="/buscar" className={`nav-item ${active === "buscar" ? "active" : ""}`}>
            <span className="nav-icon">🔍</span>
            <span className="nav-label">Catálogo</span>
          </Link>

          <Link href="/favoritos" className={`nav-item ${active === "favoritos" ? "active" : ""}`}>
            <span className="nav-icon">❤️</span>
            <span className="nav-label">Favoritos</span>
          </Link>

          {admin && (
            <Link href="/admin" className={`nav-item ${active === "admin" ? "active" : ""}`}>
              <span className="nav-icon">⚙️</span>
              <span className="nav-label">Admin</span>
            </Link>
          )}

          <form action="/auth/salir" method="post" className="nav-logout-form">
            <button type="submit" className="nav-item nav-logout-btn" title="Cerrar sesión">
              <span className="nav-icon">🚪</span>
              <span className="nav-label">Salir</span>
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
