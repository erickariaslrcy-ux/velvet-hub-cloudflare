"use client";
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function RegistroPage() {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!adult) {
      setError("Debes confirmar que eres mayor de 18 años");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "No se pudo crear la cuenta");
      setBusy(false);
      return;
    }
    const supabase = createClient();
    await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    window.location.href = "/buscar";
  }

  return (
    <main className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Crear cuenta</h1>

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
          Registrarse con Patreon
        </a>

        <div style={{ textAlign: "center", margin: "14px 0", color: "#888", fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px" }}>
          — O con Llave VIP —
        </div>

        <p className="small muted">El registro manual requiere una llave de invitación.</p>
        <label>Llave de invitación<input className="input mono" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" /></label>
        <label>Correo<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Contraseña (mínimo 8)<input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> Confirmo que soy mayor de 18 años
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Creando…" : "Crear cuenta"}</button>
        <p className="small muted">¿Ya tienes cuenta? <Link href="/login" style={{ color: "var(--accent-2)" }}>Inicia sesión</Link></p>
      </form>
    </main>
  );
}
