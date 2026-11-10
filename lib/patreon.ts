import { createAdminClient } from "@/lib/supabase/admin";

export const PATREON_CLIENT_ID =
  process.env.PATREON_CLIENT_ID || "0gJLjj89ySdbwdCHgGvPnPLbrPGBouKCe2yH5u4mBnDk0BMbe21AcQ7cwVtK5Cbu";
export const PATREON_CLIENT_SECRET =
  process.env.PATREON_CLIENT_SECRET || "A4GVPPsrInVVr1vEjAyFyD8eOLzt0qFqqae2-TCDepH-aX1aKLFD0B_wTN33YLtd";
export const PATREON_CAMPAIGN_ID = process.env.PATREON_CAMPAIGN_ID || "17101887";
export const MASTER_EMAIL = (process.env.MASTER_EMAIL || "erickariaslrcy@gmail.com").toLowerCase().trim();

export interface PatreonUserInfo {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string;
  isActivePatron: boolean;
  isCreator: boolean;
  tierTitle: string;
  tierLevel: "free" | "basic" | "pro";
  isPro: boolean;
  amountCents: number;
  maxDevices: number;
}

/**
 * Genera la URL de autorización de OAuth para Patreon
 */
export function getPatreonOAuthUrl(redirectUri: string, state?: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: PATREON_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "identity identity[email] identity.memberships",
  });
  if (state) {
    params.set("state", state);
  }
  return `https://www.patreon.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Intercambia el código temporal por access_token de Patreon
 */
export async function exchangePatreonCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: PATREON_CLIENT_ID,
    client_secret: PATREON_CLIENT_SECRET,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://www.patreon.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Error canjeando código de Patreon (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
}

/**
 * Obtiene la identidad y estado de membresía del usuario desde la API de Patreon
 */
export async function fetchPatreonIdentity(accessToken: string): Promise<PatreonUserInfo> {
  const url =
    "https://www.patreon.com/api/oauth2/v2/identity?" +
    new URLSearchParams({
      include: "memberships.campaign,memberships.currently_entitled_tiers",
      "fields[user]": "email,first_name,full_name,image_url",
      "fields[member]": "patron_status,is_follower,currently_entitled_amount_cents",
      "fields[tier]": "title,amount_cents",
    }).toString();

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error obteniendo perfil de Patreon: ${errText}`);
  }

  const payload = await res.json();
  const userData = payload.data || {};
  const userId = userData.id || "";
  const attrs = userData.attributes || {};
  const email = (attrs.email || "").toLowerCase().trim();
  const fullName = attrs.full_name || attrs.first_name || "Usuario Patreon";
  const avatarUrl = attrs.image_url || "";

  const isCreator = email === MASTER_EMAIL || userId === "232459764";

  let isActivePatron = isCreator; // El creador siempre tiene acceso completo
  let tierTitle = isCreator ? "Creador / Dueño" : "Sin Nivel";
  let amountCents = 0;
  let maxDevices = isCreator ? 10 : 1; // 1 dispositivo por defecto

  const included = Array.isArray(payload.included) ? payload.included : [];

  // Mapear tiers por id
  const tiersMap = new Map<string, { title: string; amount_cents: number }>();
  for (const item of included) {
    if (item.type === "tier" && item.attributes) {
      tiersMap.set(item.id, {
        title: item.attributes.title || "",
        amount_cents: Number(item.attributes.amount_cents) || 0,
      });
    }
  }

  let tierLevel: "free" | "basic" | "pro" = isCreator ? "pro" : "free";
  let isPro = isCreator;

  // Buscar membresía activa
  for (const item of included) {
    if (item.type === "member" && item.attributes) {
      const status = item.attributes.patron_status;
      if (status === "active_patron") {
        isActivePatron = true;
        amountCents = Number(item.attributes.currently_entitled_amount_cents) || 0;

        // Revisar tiers asignados
        const tierRels = item.relationships?.currently_entitled_tiers?.data;
        if (Array.isArray(tierRels) && tierRels.length > 0) {
          const tierId = tierRels[0].id;
          const tierInfo = tiersMap.get(tierId);
          if (tierInfo) {
            tierTitle = tierInfo.title;
          }
        }

        // Membresía Única VIP ($5.99): Acceso total al 100% del catálogo sin niveles
        tierLevel = "pro";
        isPro = true;
        maxDevices = 3;
        if (!tierTitle || tierTitle === "Sin Nivel") {
          tierTitle = "Membresía Velvet VIP ($5.99)";
        }
        break;
      }
    }
  }

  return {
    id: userId,
    email,
    fullName,
    avatarUrl,
    isActivePatron,
    isCreator,
    tierTitle,
    tierLevel,
    isPro,
    amountCents,
    maxDevices,
  };
}
