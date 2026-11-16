# CHECKLIST_BOVEDA.md — Guía de Verificación Manual de la Bóveda

Este documento contiene los pasos detallados para validar el funcionamiento del rediseño de la Bóveda en entornos de escritorio (PC) y dispositivos móviles (Android).

---

## 1. Navegación y Enrutamiento

- [ ] **Acceso desde el Catálogo:**
  1. Estando en la página principal (`/`), abrir el menú de usuario.
  2. Hacer clic en "Mi Bóveda".
  3. Verificar que la URL cambia a `/boveda/favoritos`.
  4. Verificar que el catálogo principal y el componente de paginación global ("Página 1 de 1562") desaparecen por completo.
  5. Solo debe ser visible la vista de la Bóveda con su barra lateral/pestañas.

- [ ] **Recarga Directa (F5 / Hard Refresh):**
  1. En `/boveda/favoritos`, presionar F5 (o recargar la pestaña del navegador).
  2. Comprobar que la página no da error 404 ni muestra una pantalla en blanco.
  3. Verificar que la vista de la Bóveda se monta directamente con los skeletons de carga y luego el contenido real.

- [ ] **Botones Atrás / Adelante del Navegador:**
  1. Navegar de `/` a `/boveda/favoritos`.
  2. Cambiar a la pestaña "Historial" (`/boveda/historial`).
  3. Presionar el botón "Atrás" del navegador: debe volver a la pestaña "Favoritos".
  4. Presionar "Atrás" de nuevo: debe regresar al catálogo principal con su estado previo intacto.
  5. Presionar "Adelante": debe avanzar a la Bóveda sin recarga forzada.

- [ ] **Cambio entre Pestañas:**
  1. Hacer clic en "Favoritos": verifica que el panel de favoritos se active con su conteo.
  2. Hacer clic en "Historial": verifica que el panel de historial se cargue con sus elementos agrupados o estado vacío.
  3. Hacer clic en "Detalles de Cuenta": verifica que se muestre la información del usuario y los controles de preferencias.

---

## 2. Estados Visuales y Experiencia de Usuario

- [ ] **Estado Visitante (Sin Iniciar Sesión):**
  1. Abrir una ventana de incógnito.
  2. Navegar directamente a `/boveda/favoritos`.
  3. Comprobar que NO muestra "Tu Bóveda está vacía" ni genera errores 401 en consola.
  4. Debe mostrar la tarjeta informativa de visitante con el botón para Iniciar Sesión.

- [ ] **Estado de Carga (Skeletons):**
  1. Al entrar a la Bóveda, verificar que aparecen de inmediato 8 skeletons animados (`animate-pulse`).
  2. Comprobar que no hay parpadeo del mensaje de "Tu Bóveda está vacía" durante la carga.

- [ ] **Estado Vacío Real:**
  1. En una cuenta nueva sin favoritos, entrar a `/boveda/favoritos`.
  2. Verificar que se muestra la ilustración del corazón roto, el texto descriptivo y los botones "Explorar Videos" y "Ver Cómics".
  3. Hacer clic en "Explorar Videos": debe redirigir al catálogo de videos.

- [ ] **Estado de Error con Reintento:**
  1. Desconectar la red o activar el modo Offline en las herramientas de desarrollo.
  2. Intentar recargar la pestaña de favoritos.
  3. Comprobar que aparece el mensaje de error de conexión con el botón "Reintentar".
  4. Restablecer la red y presionar "Reintentar": los datos deben cargarse correctamente sin recargar la ventana.

---

## 3. Modo Seleccionar y Acciones en Lote

- [ ] **Activar Modo Selección:**
  1. En `/boveda/favoritos`, hacer clic en el botón "Seleccionar" en la esquina superior derecha.
  2. Cada tarjeta de favorito debe mostrar un checkbox o indicador táctil de selección.

- [ ] **Barra de Acciones Flotante:**
  1. Seleccionar 2 o más favoritos.
  2. Verificar que en la parte inferior de la pantalla aparece la barra fija con:
     - El conteo de seleccionados ("2 seleccionados").
     - El botón "Quitar de Favoritos".
     - El botón "Cancelar".

- [ ] **Toast de Deshacer (5 Segundos):**
  1. Con 2 elementos seleccionados, pulsar "Quitar de Favoritos".
  2. Las tarjetas deben desaparecer inmediatamente de la lista (actualización optimista).
  3. En la parte inferior debe emerger una notificación toast: *"X favoritos eliminados — Deshacer (5s)"*.
  4. Hacer clic en "Deshacer": los elementos deben reaparecer de inmediato en su posición original sin pérdida de datos.
  5. Repetir la acción sin pulsar "Deshacer" y esperar 5 segundos: el cambio se confirma en la base de datos PostgreSQL.

---

## 4. Pruebas en Android y Dispositivos Móviles

- [ ] **Dimensiones de Pantalla (360px, 390px, 412px):**
  1. Abrir las herramientas de desarrollo en emulación móvil (o probar en dispositivo físico).
  2. Probar con anchos de 360px (Samsung Galaxy A / estándar), 390px (iPhone / Pixel) y 412px (Samsung moderno).
  3. Comprobar que no hay desbordamiento horizontal (sin scroll horizontal indeseado).
  4. Las tarjetas deben presentarse en una grilla de 2 columnas legible y proporcionada.

- [ ] **Objetivos Táctiles (Touch Targets):**
  1. Verificar que todos los botones interactivos (tabs inferiores, botón de selección, checkbox, botones de acción) tengan un tamaño táctil mínimo de 44x44 px.

- [ ] **Zona Segura Inferior (Safe-Area Inset Bottom):**
  1. En dispositivos con barra de navegación por gestos en pantalla completa, verificar que ni la barra de tabs fija ni la barra flotante de selección queden tapadas por la barra del sistema operativo.
