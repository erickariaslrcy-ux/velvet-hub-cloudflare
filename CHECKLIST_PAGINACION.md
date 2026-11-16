# Checklist de Pruebas: Paginación Rediseñada Velvet Pro

**Entorno de ejecución:** `VERSION_CLOUDFLARE` (rama `feat/rediseno-paginacion`)  
**URL de prueba local:** `npm run dev` (o `wrangler pages dev public` en `http://localhost:8788`)  

> **Nota de verificación técnica:**  
> Las pruebas marcadas como **[PC / DevTools]** se pueden validar 100% en navegador de escritorio o mediante las herramientas de emulación táctil de Chrome DevTools / Firefox Responsive View.  
> Las pruebas marcadas como **[Android Real]** involucran hardware táctil nativo (gestos de inercia física, renderizado de `env(safe-area-inset-bottom)` sobre la barra de navegación del sistema y teclado virtual suave). No se puede afirmar su comportamiento físico sin un dispositivo real.

---

## 1. Navegación Secuencial Básica (Página 2, 3, 10 y Última)

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **PAG-01** | Inicio en Página 1 | Cargar la raíz `/` o `/comics`. | Botón "Anterior" (flecha izquierda) está deshabilitado (`disabled`, semitransparente). Botón `1` está activo con degradado rosa/violeta y brillo suave. | PC / DevTools | [ ] |
| **PAG-02** | Avance a Página 2 | Clic / toque en el botón con número `2` o en la flecha "Siguiente". | Desplazamiento suave hacia `#comics-grid`. La cuadrícula carga los 12 ítems de la página 2. El botón `2` pasa a activo. El botón "Anterior" se habilita. URL cambia a `?page=2`. | PC / DevTools | [ ] |
| **PAG-03** | Avance a Página 3 | Clic / toque en el botón `3`. | Desplazamiento suave. Carga página 3. URL cambia a `?page=3`. Botón activo es el `3`. | PC / DevTools | [ ] |
| **PAG-04** | Salto a Página 10 | En PC: ingresar `10` en el campo "Ir a:" y presionar Enter.<br>En Móvil: abrir Bottom Sheet y escribir `10`. | La vista se desplaza a `#comics-grid`. Se renderiza la ventana inteligente: `1 … 8 9 [10] 11 12 … 1562`. URL cambia a `?page=10`. | PC / DevTools | [ ] |
| **PAG-05** | Salto a la Última Página | Clic en el botón numérico `1562` (o atajo "Última" en el Bottom sheet móvil). | Se carga la última página del catálogo. La ventana inteligente muestra `1 … 1560 1561 [1562]`. El botón "Siguiente" (flecha derecha) queda deshabilitado (`disabled`). URL cambia a `?page=1562`. | PC / DevTools | [ ] |

---

## 2. Campo Integrado "Ir a Página" (Valores Válidos e Inválidos)

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **VAL-01** | Valor Válido Intermedio | Escribir `50` en el campo numérico y pulsar "Ir" (o Enter). | Salto exitoso a página 50. Ventana muestra `1 … 48 49 [50] 51 52 … 1562`. El input se limpia automáticamente. | PC / DevTools | [ ] |
| **VAL-02** | Entrada Vacía | Dejar el campo vacío y presionar el botón "Ir" o Enter. | **No recarga ni navega**. El borde del input se ilumina en rojo suave con micro-vibración (*shake*). Aparece mensaje flotante: *"Escribe un número entre 1 y 1562"*. Se oculta solo en 3s. | PC / DevTools | [ ] |
| **VAL-03** | Número Cero (`0`) | Escribir `0` y confirmar. | Error visible. Borde rojo suave, no dispara petición a la API. | PC / DevTools | [ ] |
| **VAL-04** | Número Negativo (`-5`) | Escribir `-5` y confirmar. | Error visible. Borde rojo suave, no dispara petición a la API. | PC / DevTools | [ ] |
| **VAL-05** | Número Excedido (`9999`) | Escribir `9999` (mayor que 1562) y confirmar. | Error visible con mensaje *"Escribe un número entre 1 y 1562"*. El input mantiene el foco. | PC / DevTools | [ ] |
| **VAL-06** | Decimal o Caracteres (`7.5` / `abc`) | Escribir texto o decimal y presionar Enter. | Se rechaza con validación estricta de enteros. | PC / DevTools | [ ] |
| **VAL-07** | Página Actual | Estando en la página `7`, escribir `7` y presionar Enter. | **No ejecuta petición de red ni reinicia el scroll** (evita recargas innecesarias). | PC / DevTools | [ ] |
| **VAL-08** | Puntos Suspensivos Interactivos | Clic en los puntos suspensivos `…` entre páginas. | En Desktop: enfoca y selecciona el campo "Ir a:". En Móvil: abre el Bottom Sheet. | PC / DevTools | [ ] |

---

## 3. Experiencia en Android / Pantalla Táctil Móvil (< 768px)

> *Nota:* Pruebe en Chrome DevTools activando el emulador de dispositivos (ej. Pixel 7 / Galaxy S20), y confirme en un teléfono Android físico real.

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **MOB-01** | Componente Compacto de Una Sola Fila | Abrir la vista en viewport < 768px (ej. 390px ancho). | Se observa una sola fila limpia: botón `Anterior` circular (≥ 44px, exactamente 46px), botón central `"Página 1 de 1562"` y botón `Siguiente` circular (46px). Cero scroll horizontal o cortes. | DevTools / Android | [ ] |
| **MOB-02** | Apertura de Hoja Inferior (Bottom Sheet) | Tocar el botón central `"Página 1 de 1562"`. | La hoja inferior se desliza suavemente desde abajo hacia arriba con fondo oscuro translúcido (`backdrop-filter: blur(8px)`). El scroll del documento se congela. El campo de texto recibe el foco. | DevTools / Android | [ ] |
| **MOB-03** | Atajos Rápidos en Hoja Inferior | Abrir la hoja y probar los 4 botones de acceso rápido:<br>1. `Primera (1)`<br>2. `+10 pág`<br>3. `-10 pág`<br>4. `Última (1562)` | La hoja se cierra inmediatamente tras tocar un atajo, el catálogo navega a la página elegida y hace scroll suave al inicio de la cuadrícula. Botones `-10` y `+10` se deshabilitan si no procede. | DevTools / Android | [ ] |
| **MOB-04** | Cierre de Hoja por Tocar Fuera | Abrir la hoja y tocar en cualquier parte del fondo oscuro superior. | La hoja se desliza hacia abajo y se oculta sin alterar la página activa. | DevTools / Android | [ ] |
| **MOB-05** | Cierre con Botón de Cruz o Tecla Escape | Tocar el icono `✕` de la esquina superior derecha o presionar `Escape`. | La hoja se cierra de inmediato. | DevTools / Android | [ ] |
| **MOB-06** | Safe Area en Dispositivos con Barra Gestual | Inspeccionar la parte inferior de la hoja en un teléfono Android real con barra de gestos activa. | El contenido de la hoja respeta el espacio inferior con `env(safe-area-inset-bottom)`, impidiendo que la barra gestual del sistema tape los botones. | **Android Real** | [ ] |
| **MOB-07** | Objetivos Táctiles (Touch Targets) | Verificar con inspección CSS los tamaños de los botones táctiles en móvil. | Todos los botones interactivos (anterior, central, siguiente, shortcuts) tienen dimensiones mínimas de 44px × 44px (cumpliendo pautas WCAG 2.5.5). | DevTools / Android | [ ] |

---

## 4. Historial del Navegador y Sincronización de URL (?page=X)

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **NAV-01** | Botón Atrás del Navegador | Estando en pág 1, avanzar a pág 2, luego a pág 5. Presionar el botón "Atrás" del navegador. | La URL regresa a `?page=2`. El catálogo carga los cómics de la pág 2 y el componente de paginación resalta el botón `2` sin recargar toda la ventana. | PC / Android | [ ] |
| **NAV-02** | Botón Adelante del Navegador | Tras el paso anterior, presionar el botón "Adelante" del navegador. | La URL avanza a `?page=5`. El componente y la cuadrícula reflejan la pág 5 de inmediato. | PC / Android | [ ] |
| **NAV-03** | Recargar en Página Intermedia | Con la URL `http://localhost:8788/comics?page=8`, presionar `Ctrl + R` (F5). | La página se recarga e inicia directamente en la página 8 del catálogo, mostrando la ventana inteligente centrada en el `8`. | PC / Android | [ ] |
| **NAV-04** | URL con Página Fuera de Rango Superior | Ingresar manualmente `http://localhost:8788/comics?page=99999`. | El sistema autocorrige automáticamente el valor a `1562` (o el total real de páginas) cargando la última página válida. | PC / Android | [ ] |
| **NAV-05** | URL con Parámetro Inválido | Ingresar manualmente `http://localhost:8788/comics?page=cero` o `?page=-10`. | El sistema autocorrige automáticamente el valor a `1`, cargando la primera página sin lanzar excepciones en consola. | PC / Android | [ ] |

---

## 5. Integración con Filtros del Catálogo

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **FLT-01** | Cambio de Categoría Estando Paginado | Estando en la página 10, seleccionar la categoría "Milf" o "3D". | El catálogo filtra el contenido y **vuelve automáticamente a la página 1** (`page = 1`). La paginación recalcula el total de páginas de la nueva categoría. | PC / DevTools | [ ] |
| **FLT-02** | Cambio de Orden Estando Paginado | Estando en la página 4, cambiar el selector de orden a "Más Vistos" o "Más Valorados". | Se reinicia a página 1 con el nuevo criterio de ordenación. | PC / DevTools | [ ] |
| **FLT-03** | Búsqueda por Texto Estando Paginado | Estando en página 6, escribir "Genshin" en el buscador y pulsar Enter. | Se reinicia a página 1 para los resultados de la búsqueda. | PC / DevTools | [ ] |
| **FLT-04** | Paginación Conservando Filtros | Con el filtro "Milf" activo (ej: 42 páginas totales), avanzar a la página 2 y 3. | La URL preserva los parámetros (`?cat=milf&page=2`). Las peticiones a la API envían `category=milf&page=2`. | PC / DevTools | [ ] |
| **FLT-05** | Total con 1 Sola Página | Filtrar por un término con muy pocos resultados (<= 12 ítems, total_pages = 1). | El componente de paginación se **oculta completamente** del DOM (`display: none`), evitando controles redundantes. | PC / DevTools | [ ] |
| **FLT-06** | Cero Resultados (Estado Vacío) | Buscar un término inexistente (ej: "zzxxqq99"). | Se muestra el estado vacío `#empty-state` y la barra de paginación permanece oculta. | PC / DevTools | [ ] |

---

## 6. Rendimiento, Concurrencia y Accesibilidad

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **PRF-01** | Clic Rápido Repetido (Anti-Doble Disparo) | Hacer 5 clics rápidos consecutivos sobre el botón "Siguiente". | Los botones se bloquean (`pointer-events: none`, clase `.is-loading`) durante la solicitud en vuelo. Solo se procesa una transición de página por ciclo; no se duplican peticiones ni se rompe el orden de los datos. | PC / DevTools | [ ] |
| **PRF-02** | Cancelación con AbortController | En pestaña Network con emulación de red "Slow 3G", pulsar página 2 y rápidamente página 3. | La petición de la página 2 se cancela en la consola de red (`(canceled)` por `AbortController`), resolviendo inmediatamente la página 3 sin carreras de datos (*race conditions*). | PC / DevTools | [ ] |
| **PRF-03** | Prefetch Condicional (Red Normal) | Con red rápida estándar, cargar página 1 y observar la pestaña Network tras 400ms. | Se observa una petición de baja prioridad (`priority: low`) precargando `/api/items?page=2...`. | PC / DevTools | [ ] |
| **PRF-04** | Ahorro de Datos (Save-Data Activo) | En DevTools activar el modo Save-Data (`navigator.connection.saveData = true`) o activar la clase `.velvet-data-saver`. | **No se ejecuta prefetch predictivo**, cuidando el consumo de datos móviles del usuario. | DevTools / Android | [ ] |
| **PRF-05** | Accesibilidad por Teclado (Tabulador y Enter) | Navegar por el componente usando únicamente la tecla `Tab` y `Enter`. | Foco visible con anillo violeta brillante (`focus-visible`). El orden de tabulación es estrictamente secuencial y accesible. | PC / DevTools | [ ] |
| **PRF-06** | Atributos ARIA | Inspeccionar el árbol de accesibilidad con DevTools A11y Tree. | `<nav aria-label="Paginación">` presente. Botón activo tiene `aria-current="page"`. Cada botón posee `aria-label` descriptivo. | PC / DevTools | [ ] |
| **PRF-07** | Movimiento Reducido (`prefers-reduced-motion`) | Activar emulación de `prefers-reduced-motion: reduce` en el navegador. | El scroll hacia la cuadrícula se realiza de forma instantánea (`behavior: 'instant'`), y se omiten las transiciones de expansión/deslizamiento del Bottom Sheet. | PC / DevTools | [ ] |

---

## 7. Service Worker y Caché Offline

| ID | Caso de Prueba | Pasos de Ejecución | Resultado Esperado | Entorno | Estado |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **SW-01** | Actualización de Versión de Caché | Abrir pestaña Application -> Service Workers y Cache Storage. | La versión activa es `v12-velvet-turbo`. Las cachés previas de v11 se purgan automáticamente en la activación. | PC / DevTools | [ ] |
| **SW-02** | Caché de Nuevos Assets Estáticos | Inspeccionar la caché `velvet-static-v12-velvet-turbo`. | Contiene `/css/pagination.css` y `/js/pagination.js` almacenados para disponibilidad instantánea 0ms. | PC / DevTools | [ ] |
| **SW-03** | Exclusión de Caché de API | Observar las peticiones a `/api/items`. | El Service Worker NO intercepta ni almacena respuestas obsoletas en `API_CACHE`, garantizando que la paginación y el catálogo rotativo siempre reciban datos frescos del backend. | PC / DevTools | [ ] |
