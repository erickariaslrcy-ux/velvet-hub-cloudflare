import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createAdminClient } from "@/lib/supabase/admin";

export async function getAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const refreshToken =
    req.headers.get("x-refresh-token") ||
    req.cookies.get("velvet_refresh_token")?.value ||
    null;

  const admin = createAdminClient();

  if (bearerToken) {
    try {
      const { data } = await admin.auth.getUser(bearerToken);
      if (data?.user) return data.user;
    } catch {}
  }

  // Si el bearer token expiró pero hay refresh token disponible, recuperar usuario transparentemente
  if (refreshToken) {
    try {
      const { data: refData } = await admin.auth.refreshSession({ refresh_token: refreshToken });
      if (refData?.user) return refData.user;
    } catch {}
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {},
      },
    }
  );

  try {
    const { data } = await supabase.auth.getUser();
    return data?.user || null;
  } catch {
    return null;
  }
}
