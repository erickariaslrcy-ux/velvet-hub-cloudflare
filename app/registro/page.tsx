"use client";
import { useState } from "react";
import Link from "next/link";

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

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          access_key: code.trim().toUpperCase(),
          email: email.trim().toLowerCase(),
          password,
          username: email.split("@")[0],
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || data.error || "No se pudo crear la cuenta VIP");
        setBusy(false);
        return;
      }

      if (data.token) {
        localStorage.setItem("velvet_auth_token", data.token);
      }
      if (data.refresh_token) {
        localStorage.setItem("velvet_refresh_token", data.refresh_token);
      }
      if (data.device_token) {
        localStorage.setItem("velvet_device_token", data.device_token);
      }
      if (data.user) {
        localStorage.setItem("velvet_current_user", JSON.stringify(data.user));
      }

      window.location.href = "/";
    } catch {
      setError("Error de conexión con el servidor");
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Crear cuenta VIP</h1>

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
        <label>
          Llave de invitación VIP
          <input
            className="input mono"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX-XXXX"
          />
        </label>
        <label>
          Correo electrónico
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="tu@correo.com"
          />
        </label>
        <label>
          Contraseña (mínimo 6)
          <input
            className="input"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} /> Confirmo que soy mayor de 18 años
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Creando…" : "Crear cuenta VIP"}</button>
        <p className="small muted">¿Ya tienes cuenta? <Link href="/login" style={{ color: "var(--accent-2)" }}>Inicia sesión</Link></p>
      </form>
    </main>
  );
}
