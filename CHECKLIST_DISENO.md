# ✅ Guía de Verificación y Checklist de Calidad — Rediseño UI Velvet Hub
**Rama Git:** `feat/rediseno-ui`  
**Dispositivos de Prueba:** PC / Escritorio (1920x1080, 1366x768) y Móviles Android (360px, 390px, 412px)  

---

## 📱 Dimensiones y Entornos de Prueba Recomendados

Para auditar el comportamiento visual y táctil en Android desde el inspector de Chrome/Edge DevTools (modo dispositivo `Ctrl+Shift+M`):
- **Android Compacto (360px de ancho):** Galaxy S8 / A-Series (`360 x 740`).
- **Android Estándar (390px - 393px de ancho):** Galaxy S21 / Pixel 7 (`393 x 851`) / iPhone 13/14 (`390 x 844`).
- **Android Grande / Flagship (412px de ancho):** Galaxy S23 Ultra / Pixel 8 Pro (`412 x 915`).
- **PC / Escritorio:** Monitor estándar (`1920 x 1080` y `1366 x 768`).

---

## 📋 Lista de Verificación Paso a Paso

### Bloque 1: Elementos Eliminados (X Roja)
- [ ] **1.1 Ausencia del badge de catálogo:** Cargar la página principal y verificar que junto a la barra de categorías ya **NO** aparece el badge *"24 Cómics Calientes Listos"*.
- [ ] **1.2 Ausencia del encabezado del catálogo:** Comprobar que arriba del grid de cómics ya **NO** existe el texto *"Últimas Novedades Calientes"* ni el badge *"24 historias listas para leer"*. Las portadas del catálogo deben subir inmediatamente en la pantalla.
- [ ] **1.3 Ausencia de subtítulo en Continuar Leyendo:** Verificar que en la sección de Continuar Leyendo únicamente figura el título *"Continuar Leyendo"* con su ícono de reloj, sin el subtítulo *"Reanuda donde lo dejaste con 1 toque"*.
- [ ] **1.4 Consola libre de errores:** Abrir la consola de desarrollador (`F12 -> Console`) y confirmar que no existen errores de JavaScript (`TypeError: null`) al cargar la página o cambiar de pestaña.

---

### Bloque 2: Barra de Categorías Horizontal
- [ ] **2.1 Touch Target en Android (≥ 40-44px):** Inspeccionar los botones de categoría en DevTools o en un teléfono real; cada chip tiene una altura táctil de `40px` (`h-10`) con acolchado horizontal cómodo para pulsación con el pulgar.
- [ ] **2.2 Desplazamiento horizontal fluido (*Scroll-Snap*):** En móvil, deslizar horizontalmente con el dedo. La fila se desplaza con aceleración nativa y se alinea limpiamente con cada botón (`snap-x snap-mandatory`).
- [ ] **2.3 Máscara de desvanecimiento:** En móvil (< 768px), verificar que en el extremo derecho de la barra de categorías se observa un sutil degradado transparente a oscuro que insinúa al usuario la existencia de más opciones.
- [ ] **2.4 Sin saltos de línea:** En todas las resoluciones (360px a 412px), verificar que ningún botón de categoría divide su texto en dos renglones (`whitespace-nowrap`).
- [ ] **2.5 Estado activo vibrante:** Comprobar que la categoría seleccionada tiene un degradado neón rosa/violeta con borde iluminado y sombra, mientras las inactivas permanecen en tono translúcido oscuro.
- [ ] **2.6 Sincronización en URL (`?cat=`):**
  - Pulsar en *"Parodias Animadas"*; la barra de direcciones debe actualizarse a `https://.../?cat=parody`.
  - Pulsar el botón **"Atrás"** del navegador; la URL debe regresar al estado anterior y los chips deben actualizar su estado activo sin recargar la página completa.
- [ ] **2.7 Integridad del filtro de Parodias:** Pulsar *"Parodias Animadas"* y verificar que el catálogo lista cómics y parodias reales (más de 8,000 resultados disponibles en base de datos).

---

### Bloque 3: Menú de Ordenación (Sort Menu)
- [ ] **3.1 Reemplazo del select nativo:** Verificar que el antiguo `<select>` blanco fue completamente sustituido por el botón personalizado de diseño Velvet Hub (`#sort-menu-btn`).
- [ ] **3.2 Comportamiento en PC (Dropdown Flotante):**
  - En pantalla > 768px, hacer clic en el botón de ordenación.
  - Se despliega un menú flotante hacia abajo con fondo `#120726/95`, desenfoque de fondo y borde violeta.
  - La flecha chevron rota suavemente 180°.
  - Hacer clic fuera del menú o presionar la tecla `Escape`; el menú debe cerrarse de inmediato y devolver el foco al botón.
  - Navegar con flechas `ArrowDown` y `ArrowUp` del teclado; el selector debe recorrer las opciones accesibles.
- [ ] **3.3 Comportamiento en Android (Hoja Inferior / *Bottom Sheet*):**
  - En emulador o móvil (360px - 412px), tocar el botón de ordenación.
  - Se abre una hoja inferior desde la parte baja con fondo semitransparente oscuro (`backdrop-blur`).
  - La hoja incluye una barra gris de arrastre en la parte superior y botón de cierre `(X)`.
  - Las opciones se tocan cómodamente con el pulgar.
- [ ] **3.4 Opciones soportadas:**
  - Verificar que se muestran exactamente las 5 opciones:
    1. 🎲 **Modo Aleatorio:** Descubre cómics al azar.
    2. 📌 **Más Recientes:** Últimos estrenos agregados.
    3. ⭐ **Más Populares:** Favoritos de la comunidad.
    4. 🔥 **Más Vistos:** Los títulos con más lecturas.
    5. 💎 **Mejor Valorados:** Mayor calificación VIP.
  - Confirmar que la opción rota *"Más páginas"* **NO** figura en el menú.
- [ ] **3.5 Sincronización en URL (`?sort=`):**
  - Tocar *"Más Populares"*; el menú se cierra automáticamente, la URL cambia a `?sort=popular`, la paginación vuelve a la página 1 y el catálogo se refresca con los cómics más populares.

---

### Bloque 4: Fila "Continuar Leyendo"
- [ ] **4.1 Tarjetas verticales en proporción 2:3:**
  - Abrir un cómic cualquiera, avanzar hasta la página 5 y volver al home.
  - La sección *"Continuar Leyendo"* se hace visible.
  - Las tarjetas son verticales con ancho compacto de **155px a 170px**, portada en proporción 2:3 (`aspect-[2/3]`), e imagen de portada nítida.
- [ ] **4.2 Título y barra de progreso:**
  - El título de la obra ocupa como máximo 2 renglones con puntos suspensivos (`line-clamp-2`).
  - Bajo el título, se muestra una barra fina de progreso con acento rosa `#ff2d95` y el texto *"Pág. 5 de X"*.
  - Al pie de la tarjeta figura el botón compacto *"Continuar"*.
- [ ] **4.3 Botón de Descarte (X) y Deshacer (5s):**
  - Tocar el botón circular `(X)` en la esquina superior de la portada.
  - El cómic desaparece de la fila y en la parte inferior aparece una notificación flotante:
    `"Removido de Continuar [Deshacer (5s)]"`.
  - Tocar **"Deshacer"** dentro de los primeros 5 segundos; el cómic debe reaparecer inmediatamente en la fila.
  - Tocar nuevamente `(X)` y esperar más de 5 segundos; la notificación desaparece y el cómic queda permanentemente descartado.
- [ ] **4.4 Ocultamiento automático:**
  - Si se descartan todos los cómics en lectura, o si el usuario no tiene lecturas iniciadas, la sección *"Continuar Leyendo"* debe permanecer completamente oculta sin dejar espacios vacíos ni márgenes en blanco.
- [ ] **4.5 Respeto a preferencia de privacidad:**
  - Ir a *Mi Bóveda -> Cuenta/Configuración* y activar la casilla *"Pausar registro en historial"*.
  - Volver al catálogo; la sección *"Continuar Leyendo"* debe ocultarse automáticamente respetando la privacidad.

---

### Bloque 5: Favicon e Iconografía PWA
- [ ] **5.1 Favicon en pestaña de navegador:**
  - Abrir el sitio en una pestaña de Google Chrome / Edge / Firefox.
  - Verificar que el icono de la pestaña muestra el isotipo de Velvet Hub de forma nítida tanto con el tema claro como con el tema oscuro del sistema operativo.
- [ ] **5.2 Instalación PWA en Android:**
  - En un dispositivo Android o emulador, abrir el menú de Chrome y seleccionar *"Añadir a pantalla de inicio"* o *"Instalar app"*.
  - Comprobar que el icono instalado en la pantalla de inicio del teléfono corresponde al nuevo logo de alta definición (`icon-192.png` / `icon-512.png`).
- [ ] **5.3 Versión de Service Worker:**
  - Abrir DevTools (`F12`) -> Pestaña *Application* -> *Service Workers*.
  - Verificar que el Service Worker activo corresponde a la versión `v12` (`v12-velvet-redesign`), garantizando que la caché anterior no sirva estilos ni activos viejos.

---

## 💻 Comandos de Ejecución de Pruebas Automatizadas
Para ejecutar la suite automatizada completa que valida todos los requisitos anteriores:

```bash
# Ejecutar todas las pruebas unitarias y de integración
npm test

# O ejecutar específicamente la suite de rediseño UI
node test/test_ui_redesign.mjs
```
Ambos comandos deben reportar **100% PASS** con código de salida `0`.
