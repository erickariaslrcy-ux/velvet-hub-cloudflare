import { SupabaseClient } from "@supabase/supabase-js";

export interface ActiveDevice {
  token: string;
  userAgent: string;
  lastSeen: number;
}

/**
 * Registra un nuevo dispositivo o actualiza su última conexión.
 * Soporta múltiples dispositivos concurrentes (PC, teléfono, tablet, etc.) hasta maxDevices (por defecto 10).
 */
export async function registerOrTouchDevice(
  admin: SupabaseClient,
  userId: string,
  deviceToken: string,
  maxDevices: number = 10,
  userAgent: string = ""
): Promise<{ allowed: boolean; devicesCount: number; evictedOldest: boolean }> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data.user) {
      return { allowed: false, devicesCount: 0, evictedOldest: false };
    }

    const metadata = data.user.user_metadata || {};
    let devices: ActiveDevice[] = Array.isArray(metadata.active_devices) ? metadata.active_devices : [];

    const existingIndex = devices.findIndex((d) => d.token === deviceToken);
    let evictedOldest = false;

    if (existingIndex >= 0) {
      // Ya registrado, actualizar última actividad
      devices[existingIndex].lastSeen = Date.now();
      if (userAgent) devices[existingIndex].userAgent = userAgent.slice(0, 150);
    } else {
      // Dispositivo nuevo: permitir hasta 10 dispositivos concurrentes
      const limit = Math.max(10, maxDevices);

      // Si supera el límite de 10 dispositivos, expulsamos los más antiguos
      if (devices.length >= limit) {
        devices.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
        while (devices.length >= limit) {
          devices.shift();
          evictedOldest = true;
        }
      }

      devices.push({
        token: deviceToken,
        userAgent: userAgent.slice(0, 150),
        lastSeen: Date.now(),
      });
    }

    // Guardar en la metadata del usuario
    await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...metadata,
        max_devices: Math.max(10, maxDevices),
        active_devices: devices,
      },
    });

    return { allowed: true, devicesCount: devices.length, evictedOldest };
  } catch (err) {
    console.error("Error managing user devices:", err);
    return { allowed: true, devicesCount: 1, evictedOldest: false };
  }
}

/**
 * Valida si el dispositivo actual sigue autorizado.
 * Siempre permite acceso a dispositivos legítimos (hasta 10 concurrentes).
 */
export async function isDeviceAuthorized(
  admin: SupabaseClient,
  userId: string,
  deviceToken: string | null
): Promise<boolean> {
  if (!deviceToken) return true;

  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    if (!data.user) return false;

    const metadata = data.user.user_metadata || {};
    const devices: ActiveDevice[] = Array.isArray(metadata.active_devices) ? metadata.active_devices : [];

    // Si no hay dispositivos registrados o hay pocos, permitir
    if (devices.length <= 10) return true;

    return devices.some((d) => d.token === deviceToken);
  } catch {
    return true;
  }
}
