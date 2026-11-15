# Checklist de Pruebas de Botones y Eventos (Preview)

Este documento lista todos los elementos interactivos que fueron migrados de manejadores inline (`onclick` / `onsubmit`) a delegación declarativa de eventos (`data-action`), indicando su ubicación exacta, su comportamiento esperado y una casilla de verificación para comprobarlos en tu entorno de Preview de Cloudflare Pages (en PC y en móvil Android).

---

## 🧭 1. Barra de Navegación y Cabecera Global

| Elemento | Pantalla / Ubicación | Atributo `data-action` | Comportamiento Esperado al Pulsar | Verificado PC | Verificado Android |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Logo Velvet Hub** | Navbar superior izquierdo | `data-action="reset-home"` | Regresa a la portada (`/`), resetea los filtros de búsqueda y restaura el catálogo completo. | [ ] | [ ] |
| **Formulario de Búsqueda** | Navbar central | `data-action="search"` | Al enviar el formulario (Enter o botón buscar), filtra el catálogo por término sin recargar la página. | [ ] | [ ] |
| **Botón Limpiar Búsqueda (X)** | Dentro del input de búsqueda | `data-action="clear-search"` | Borra el texto del input, oculta el botón (X) y recarga el catálogo sin filtro. | [ ] | [ ] |
| **Botón Aleatorio (Dado)** | Navbar superior derecho | `data-action="fetch-random"` | Selecciona un elemento al azar del catálogo y abre instantáneamente su visor de lectura o reproductor. | [ ] | [ ] |
| **Botón de Usuario / Perfil** | Navbar superior derecho | `data-action="user-button"` | Si no has iniciado sesión, abre el Modal VIP de Autenticación. Si ya estás logueado, abre el menú de cuenta. | [ ] | [ ] |
| **Botón Subir Arriba (Scroll Top)** | Esquina inferior derecha (flotante) | `data-action="scroll-top"` | Desplaza la ventana suavemente hacia la parte superior (`top: 0`). | [ ] | [ ] |

---

## 🎠 2. Carrusel Principal de Portada (Hero Carousel)

| Elemento | Pantalla / Ubicación | Atributo `data-action` | Comportamiento Esperado al Pulsar | Verificado PC | Verificado Android |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Flecha Anterior (<)** | Lateral izquierdo del carrusel | `data-action="hero-prev"` | Desplaza al slide anterior del cómic/video destacado. | [ ] | [ ] |
| **Flecha Siguiente (>)** | Lateral derecho del carrusel | `data-action="hero-next"` | Desplaza al siguiente slide destacado. | [ ] | [ ] |
| **Botón Leer / Ver Ahora** | Interior del slide activo | `data-action="hero-read"` | Abre directamente el cómic en el lector o el video en el reproductor. | [ ] | [ ] |
| **Botón Corazón (Favorito)** | Interior del slide activo | `data-action="hero-fav"` | Añade o remueve el ítem del carrusel en Mi Bóveda (cambia el ícono a corazón lleno y muestra toast). | [ ] | [ ] |

---

## 📖 3. Visor de Cómics y Galerías (Reader)

| Elemento | Pantalla / Ubicación | Atributo `data-action` | Comportamiento Esperado al Pulsar | Verificado PC | Verificado Android |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Botón Volver (Flecha atrás)** | Barra superior (HUD) izquierda | `data-action="reader-close"` | Cierra el lector, detiene auto-scroll y restaura la vista del catálogo sin parpadeos. | [ ] | [ ] |
| **Botón Favorito (Corazón)** | Barra superior (HUD) derecha | `data-action="reader-fav-toggle"` | Alterna el estado de favorito del cómic en curso (notificación toast de confirmación). | [ ] | [ ] |
| **Modo de Lectura** | Barra superior (HUD) derecha | `data-action="reader-mode-toggle"` | Alterna entre modo **Cascada** (scroll vertical continuo) y modo **Slide** (página por página). | [ ] | [ ] |
| **Auto-Scroll (Play/Pausa)** | Barra superior (HUD) derecha | `data-action="reader-autoscroll-toggle"` | Inicia o pausa el desplazamiento automático hacia abajo con velocidad constante. | [ ] | [ ] |
| **Restablecer Zoom (100%)** | Controles de zoom (HUD) | `data-action="reader-zoom-reset"` | Restaura la escala de las imágenes al 100% de ancho de lectura. | [ ] | [ ] |
| **Pantalla Completa** | Barra superior (HUD) derecha | `data-action="fullscreen-toggle"` | Solicita pantalla completa al navegador vía Fullscreen API. | [ ] | [ ] |

---

## 🎬 4. Reproductor de Video (Velvet Cinema)

| Elemento | Pantalla / Ubicación | Atributo `data-action` | Comportamiento Esperado al Pulsar | Verificado PC | Verificado Android |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Botón Volver** | Barra superior del reproductor | `data-action="video-close"` | Detiene la reproducción HLS, libera el objeto de video y regresa al catálogo. | [ ] | [ ] |
| **Luces Ambientales (Ambilight)** | Barra superior derecha | `data-action="video-ambilight-cycle"` | Cicla entre modos de iluminación de fondo: Apagado ➔ Suave ➔ Vívido. | [ ] | [ ] |
| **Atajos de Teclado (?)** | Barra superior derecha | `data-action="shortcuts-open"` | Abre el modal con la lista de atajos (`Espacio`, `J`, `K`, `L`, `M`, `F`, etc.). | [ ] | [ ] |
| **Compartir Enlace** | Barra superior derecha | `data-action="video-share"` | Copia la URL directa del video al portapapeles y emite un toast de éxito. | [ ] | [ ] |
| **Botón Favorito** | Barra superior derecha | `data-action="video-fav-toggle"` | Añade el video a la lista privada de favoritos de la Bóveda. | [ ] | [ ] |
| **Botón Central Play/Pausa** | Centro del fotograma | `data-action="video-play-toggle"` | Alterna reproducción / pausa del stream de video. | [ ] | [ ] |
| **Botón Silenciar (Mute)** | Barra inferior de controles | `data-action="video-mute-toggle"` | Alterna entre sonido activado y silenciado (`muted = true/false`). | [ ] | [ ] |
| **Picture-in-Picture (PiP)** | Barra inferior derecha | `data-action="video-pip-toggle"` | Desprende el video a una ventana flotante del sistema operativo. | [ ] | [ ] |
| **Modo Cine / Teatro** | Barra inferior derecha | `data-action="video-theater-toggle"` | Expande el reproductor al 100% del ancho de la pantalla sin ocultar controles. | [ ] | [ ] |
| **Pantalla Completa** | Barra inferior derecha | `data-action="video-fullscreen-toggle"` | Alterna pantalla completa en el reproductor. | [ ] | [ ] |

---

## 🛡️ 5. Modales, Autenticación y Verificación de Edad

| Elemento | Pantalla / Ubicación | Atributo `data-action` | Comportamiento Esperado al Pulsar | Verificado PC | Verificado Android |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **Botón Entrar (+18)** | Age Gate persistente inicial | `data-action="age-confirm"` | Guarda confirmación en `localStorage`, desbloquea la pantalla y carga portadas. | [ ] | [ ] |
| **Cerrar Modal de Acceso** | Modal VIP (esquina superior) | `data-action="auth-close"` | Cierra el modal de autenticación con animación suave. | [ ] | [ ] |
| **Pestaña Iniciar Sesión** | Modal VIP | `data-action="auth-tab-login"` | Muestra el formulario de usuario/contraseña y oculta el de registro. | [ ] | [ ] |
| **Pestaña Registro con Llave** | Modal VIP | `data-action="auth-tab-register"` | Muestra el formulario para ingresar la llave VIP de invitación. | [ ] | [ ] |
| **Cerrar Atajos de Teclado** | Modal de atajos (?) | `data-action="shortcuts-close"` | Cierra el modal de atajos de teclado. | [ ] | [ ] |

---

## 📱 Protocolo de Prueba Recomendado en Móviles Android
1. Abre tu URL de Preview (`https://fix-auditoria-completa.morbohub.pages.dev`) en Chrome de Android.
2. Pulsa en el botón **Ingresar** del Age Gate (`data-action="age-confirm"`): debe entrar sin saltos de zoom.
3. Toca el botón **Aleatorio** del navbar (`data-action="fetch-random"`): debe abrir un cómic o video de inmediato.
4. En el cómic, toca la pantalla: el HUD debe aparecer; prueba **Auto-Scroll** (`data-action="reader-autoscroll-toggle"`) y **Modo Cascada** (`data-action="reader-mode-toggle"`).
5. Pulsa la flecha volver (`data-action="reader-close"`): debe regresar limpiamente al catálogo sin recargar la web.
