"use client";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "Correo o contraseña incorrectos");
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

        <label>
          Correo o Usuario
          <input
            className="input"
            type="text"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="tu@correo.com o usuario"
          />
        </label>
        <label>
          Contraseña
          <input
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        <p className="small muted">¿Tienes una llave de invitación? <Link href="/registro" style={{ color: "var(--accent-2)" }}>Crear cuenta</Link></p>
        <p className="small muted">Solo para mayores de 18 años.</p>
      </form>
    </main>
  );
}
