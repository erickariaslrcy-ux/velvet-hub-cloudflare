import { redirect } from "next/navigation";
import Nav from "@/components/Nav";
import AdminPanel from "@/components/AdminPanel";
import { getUser, isAdmin } from "@/lib/supabase/server";

type Stat = { source: string; label: string | null; total: number; visibles: number; bloqueados: number; personas_reales: number };

export default async function AdminPage() {
  if (!(await isAdmin())) redirect("/buscar");
  const { supabase } = await getUser();
  const { data } = await supabase.rpc("admin_stats");
  const stats = (data ?? []) as Stat[];

  return (
    <>
      <Nav active="admin" />
      <main className="container">
        <AdminPanel />
        <section className="section card">
          <h2>Catálogo por fuente</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Fuente</th><th>Los usuarios ven</th><th>Total</th><th>Visibles</th><th>Bloqueados (filtro menores)</th><th>Personas reales (ocultos)</th></tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.source}>
                    <td>{s.source}</td><td>{s.label}</td><td>{s.total}</td><td>{s.visibles}</td><td>{s.bloqueados}</td><td>{s.personas_reales}</td>
                  </tr>
                ))}
                {!stats.length && <tr><td colSpan={6} className="muted">Aún no hay catálogo. Súbelo con sync_supabase.py desde tu PC.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
