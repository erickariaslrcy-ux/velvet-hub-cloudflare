"use client";
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setError("Correo o contraseña incorrectos");
      setBusy(false);
      return;
    }
    window.location.href = "/";
  }

  return (
    <main className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Iniciar sesión</h1>

        {/* Botón Acceso Patreon */}
        <a
          href="/api/auth/patreon"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            background: "#FF424D",
            color: "#ffffff",
            padding: "12px",
            borderRadius: "10px",
            fontWeight: 800,
            textDecoration: "none",
            boxShadow: "0 4px 15px rgba(255, 66, 77, 0.35)",
            marginBottom: "16px",
            fontSize: "14px",
            transition: "opacity 0.2s",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.386.524c-4.764 0-8.64 3.876-8.64 8.64 0 4.75 3.876 8.613 8.64 8.613 4.75 0 8.614-3.864 8.614-8.613C24 4.4 20.136.524 15.386.524M.001 23.476H5.2V.524H.001z"/>
          </svg>
          Continuar con Patreon
        </a>

        <div style={{ textAlign: "center", margin: "14px 0", color: "#888", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px" }}>
          — O con tu cuenta —
        </div>

        <label>Correo<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Contraseña<input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        <p className="small muted">¿Tienes una llave de invitación? <Link href="/registro" style={{ color: "var(--accent-2)" }}>Crear cuenta</Link></p>
        <p className="small muted">Solo para mayores de 18 años.</p>
      </form>
    </main>
  );
}
