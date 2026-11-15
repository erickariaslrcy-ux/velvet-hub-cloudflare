import "server-only";
import { createClient } from "@supabase/supabase-js";

// Cliente con service role: solo en el servidor (rutas API), nunca en el navegador.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
