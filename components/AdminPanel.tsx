"use client";
import { useCallback, useEffect, useState } from "react";

type Key = {
  code: string; note: string; created_at: string; expires_at: string | null;
  used_email: string | null; used_at: string | null; revoked: boolean;
};
type User = { id: string; email: string; created_at: string; last_sign_in_at: string | null; banned_until: string | null };

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString("es") : "—");

function keyState(k: Key) {
  if (k.revoked) return "Revocada";
  if (k.used_at) return `Usada por ${k.used_email ?? "?"}`;
  if (k.expires_at && new Date(k.expires_at) < new Date()) return "Expirada";
  return "Disponible";
}

export default function AdminPanel() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [count, setCount] = useState(1);
  const [days, setDays] = useState(0);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [k, u] = await Promise.all([fetch("/api/admin/keys"), fetch("/api/admin/users")]);
    if (k.ok) setKeys((await k.json()).keys);
    if (u.ok) setUsers((await u.json()).users);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count, days, note }),
    });
    const data = await res.json();
    if (!res.ok) return setMsg(data.error || "Error");
    setFresh(data.keys.map((k: Key) => k.code));
    setNote("");
    load();
  }

  async function revoke(code: string) {
    await fetch("/api/admin/keys", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    load();
  }

  async function toggleBan(u: User) {
    const banned = !(u.banned_until && new Date(u.banned_until) > new Date());
    await fetch("/api/admin/users", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: u.id, banned }) });
    load();
  }

  return (
    <>
      <section className="section card">
        <h2>Generar llaves de invitación</h2>
        <form className="row" onSubmit={generate}>
          <label>Cantidad<input className="input" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 100 }} /></label>
          <label>Expira en días (0 = nunca)<input className="input" type="number" min={0} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }} /></label>
          <label style={{ flex: 1, minWidth: 200 }}>Nota (para quién es)<input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="btn btn-primary" style={{ alignSelf: "end" }}>Generar</button>
        </form>
        {msg && <p className="error">{msg}</p>}
        {fresh.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p className="success">Llaves nuevas (compártelas por privado):</p>
            <pre className="mono card" style={{ padding: 12, whiteSpace: "pre-wrap" }}>{fresh.join("\n")}</pre>
            <button className="btn btn-small" onClick={() => navigator.clipboard.writeText(fresh.join("\n"))}>Copiar</button>
          </div>
        )}
      </section>

      <section className="section card">
        <h2>Llaves ({keys.length})</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Llave</th><th>Nota</th><th>Estado</th><th>Creada</th><th>Expira</th><th></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.code}>
                  <td className="mono">{k.code}</td><td>{k.note}</td><td>{keyState(k)}</td>
                  <td>{fmt(k.created_at)}</td><td>{fmt(k.expires_at)}</td>
                  <td>{!k.used_at && !k.revoked && <button className="btn btn-small" onClick={() => revoke(k.code)}>Revocar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section card">
        <h2>Usuarios ({users.length})</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Correo</th><th>Creado</th><th>Último acceso</th><th>Acceso</th></tr></thead>
            <tbody>
              {users.map((u) => {
                const banned = !!(u.banned_until && new Date(u.banned_until) > new Date());
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td><td>{fmt(u.created_at)}</td><td>{fmt(u.last_sign_in_at)}</td>
                    <td><button className="btn btn-small" onClick={() => toggleBan(u)}>{banned ? "Desbloquear" : "Bloquear"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
