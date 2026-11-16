# CHECKLIST_DATOS.md — Guía de Verificación de Sincronización Multi-Dispositivo

Este checklist permite verificar en dispositivos reales (PC y teléfono Android) que la base de datos PostgreSQL actúa como la única fuente de verdad y que no se mezclan cuentas ni se pierden datos de favoritos, historial, progreso y preferencias.

---

## Preparativos Iniciales
- **Dispositivo A:** Computadora (Chrome / Edge / Firefox en modo escritorio).
- **Dispositivo B:** Teléfono móvil Android (Chrome / Brave / Firefox para Android).
- **Cuentas de Prueba:**
  - Cuenta 1: `usuario1@velvet.test`
  - Cuenta 2: `usuario2@velvet.test`

---

## 1. Sincronización de Favoritos entre Dispositivos

- [ ] **1.1 Agregar Favorito en PC y ver en Teléfono:**
  1. En **Dispositivo A (PC)**, iniciar sesión con `Cuenta 1`.
  2. Navegar al catálogo de cómics y agregar un cómic a favoritos pulsando el botón de corazón.
  3. Verificar que el contador del menú de usuario en PC se incrementa inmediatamente.
  4. En **Dispositivo B (Teléfono)**, iniciar sesión con la misma `Cuenta 1`.
  5. Entrar a `/boveda/favoritos`.
  6. **Resultado Esperado:** El cómic agregado en PC debe aparecer inmediatamente en la lista del teléfono y el contador del menú debe coincidir exactamente.

- [ ] **1.2 Eliminar Favorito en Teléfono y ver en PC:**
  1. En **Dispositivo B (Teléfono)**, quitar el favorito recién agregado.
  2. En **Dispositivo A (PC)**, recargar la página o navegar a la Bóveda.
  3. **Resultado Esperado:** El favorito ya no aparece en PC y los contadores en ambos dispositivos se reducen sincronizadamente.

- [ ] **1.3 Idempotencia:**
  1. Pulsar rápidamente varias veces el botón de agregar a favoritos sobre el mismo elemento con la conexión lenta.
  2. **Resultado Esperado:** Solo se crea 1 registro en la base de datos. Cero registros duplicados.

---

## 2. Sincronización de Historial y Progreso Continuo

- [ ] **2.1 Progreso de Lectura de Cómics:**
  1. En **Dispositivo A (PC)** con `Cuenta 1`, abrir un cómic de 30 páginas y leer hasta la página **18**.
  2. Pausar o cerrar el lector (se dispara el guardado inmediato de progreso vía `keepalive` o `sendBeacon`).
  3. En **Dispositivo B (Teléfono)** con `Cuenta 1`, abrir la página de inicio (`/`).
  4. Revisar la fila *"Continuar Leyendo"*:
     - **Resultado Esperado:** Debe aparecer la tarjeta del cómic con la barra de progreso neón mostrando exactamente *"Pág. 18 de 30 (60%)"*.
  5. Tocar la tarjeta en el teléfono:
     - **Resultado Esperado:** El lector debe reanudar exactamente en la página 18.

- [ ] **2.2 Progreso de Reproducción de Videos:**
  1. En **Dispositivo B (Teléfono)**, reproducir un video y avanzar hasta el minuto **12:35**.
  2. Pausar la reproducción.
  3. En **Dispositivo A (PC)**, entrar a `/boveda/historial`.
  4. **Resultado Esperado:** El video aparece en la parte superior del historial con el indicador *"12:35 / Duración Total"*.

- [ ] **2.3 Concurrencia de Progreso (Prevención de Pisado Obsoleto):**
  1. En Dispositivo A, avanzar un cómic a la página **25**.
  2. Si un Dispositivo B desconectado intenta enviar posteriormente un progreso viejo (página 5):
  3. **Resultado Esperado:** La función RPC `upsert_history` descarta la actualización vieja (`WHERE excluded.client_timestamp >= user_history.client_timestamp`) y conserva intacta la página 25.

---

## 3. Paginación Real en la Base de Datos (24 por Página)

- [ ] **3.1 Paginación con Volumen (>150 registros):**
  1. Con una cuenta que tenga más de 150 favoritos o historial:
  2. Entrar a `/boveda/favoritos`.
  3. Inspeccionar la pestaña Network en herramientas de desarrollador:
     - Verificar que la petición a `/api/user/favorites?page=1&pageSize=24` devuelve exactamente 24 elementos y cabecera `Content-Range: 0-23/X`.
     - Verificar que el navegador **NUNCA** solicita los 150 registros para renderizar la página 1.
  4. Navegar a la **Página 2**:
     - La petición debe solicitar `page=2` (Range `24-47`).
     - Verificar que no hay elementos repetidos con respecto a la Página 1.
  5. Navegar a la **Última Página (ej. Página 7)**:
     - Debe mostrar únicamente los elementos sobrantes (por ejemplo, 16 elementos si el total es 160).
     - La paginación debe indicar con precisión `"Página 7 de 7"`.

---

## 4. Aislamiento Estricto entre Cuentas (User A vs User B)

- [ ] **4.1 Cierre e Inicio con Diferente Cuenta en el Mismo Dispositivo:**
  1. En **Dispositivo A (PC)**, tener favoritos guardados con `Cuenta 1`.
  2. Cerrar sesión (`Cerrar Sesión` en menú de usuario).
  3. Iniciar sesión inmediatamente con `Cuenta 2` (cuenta limpia).
  4. Entrar a `/boveda/favoritos`.
  5. **Resultado Esperado:** 
     - La Bóveda de `Cuenta 2` está vacía (0 favoritos).
     - El menú de usuario muestra `0`.
     - En ningún momento se visualizan datos residuales o cacheados de `Cuenta 1`.

- [ ] **4.2 Preferencias Aisladas:**
  1. En `Cuenta 1`, activar el efecto Ambilight y calidad 1080p.
  2. En `Cuenta 2`, cambiar a calidad 480p y desactivar Ambilight.
  3. Iniciar sesión en otro dispositivo con `Cuenta 1`: debe mantener 1080p y Ambilight activo.

---

## 5. Resiliencia ante Desconexión y Service Worker

- [ ] **5.1 Bypass de Caché en Endpoints Personales:**
  1. Inspeccionar las peticiones en la pestaña Network.
  2. Comprobar que `/api/user/favorites`, `/api/user/history` y `/api/user/preferences`:
     - Tienen cabecera `Cache-Control: private, no-cache, no-store, must-revalidate`.
     - Nunca devuelven respuestas servidas desde el Service Worker (`(ServiceWorker)` en Chrome DevTools).
     - Al alternar de usuario, el Service Worker no sirve datos del usuario anterior.
