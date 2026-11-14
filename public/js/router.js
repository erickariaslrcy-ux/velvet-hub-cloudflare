/**
 * VELVET HUB - CLIENT ROUTER & VIEW TRANSITIONS ENGINE (v3.0)
 * 
 * Soporta:
 * - URLs reales semánticas (/videos, /comics, /cosplay, /v/:slug, /c/:slug, /g/:slug, /boveda/*, /cuenta, /acceso)
 * - Intercepción inteligente de enlaces <a> (clic primario SPA, mientras Clic Central y Ctrl/Cmd+Clic pasan al navegador nativo)
 * - View Transitions API (con fallback suave 60/120fps)
 * - Restauración exacta de scroll al pulsar "Atrás/Adelante"
 * - Redirección automática de enlaces legados (#, ?tab=, /video/*, /comic/*)
 * - Precarga predictiva (hover >= 150ms / touchstart) cancelable y respetando Save-Data
 * - Control de ciclo de vida con limpieza total de memoria (HLS destroy, intervals, observers)
 */

(function (window) {
  'use strict';

  const scrollPositions = new Map();
  let prefetchTimer = null;
  const prefetchedUrls = new Set();

  function slugify(text) {
    if (!text) return 'item';
    return String(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '')
      .slice(0, 50) || 'item';
  }

  const VelvetRouter = {
    currentRoute: null,
    isNavigating: false,

    // =======================================================================
    // 1. GENERADORES DE URLS CANÓNICAS
    // =======================================================================
    getItemUrl(item, action = 'view') {
      if (!item) return '/';
      const type = item.media_type || (item.video_sources && item.video_sources.length > 0 ? 'video' : 'comic');
      const slug = slugify(item.title);

      // Si tiene id explícito (numérico o hex ObjectId), usarlo prioritariamente
      let idPart = '';
      if (item.id) {
        idPart = String(item.id);
      } else if (item.source && item.source_id) {
        idPart = `${item.source}--${encodeURIComponent(item.source_id)}`;
      } else {
        idPart = 'item';
      }

      if (type === 'video') {
        return `/v/${idPart}-${slug}`;
      } else if (type === 'gallery') {
        return `/g/${idPart}-${slug}`;
      } else {
        if (action === 'read') {
          return `/c/${idPart}-${slug}/leer`;
        }
        return `/c/${idPart}-${slug}`;
      }
    },

    parseItemToken(token) {
      if (!token) return { id: null, source: null, sourceId: null };

      // 1. Formato source--sourceId(-slug)
      if (token.includes('--')) {
        const parts = token.split('--');
        const source = parts[0];
        const rest = parts.slice(1).join('--');
        const dashIdx = rest.indexOf('-');
        const sourceId = dashIdx !== -1 ? rest.slice(0, dashIdx) : rest;
        return { id: null, source: decodeURIComponent(source), sourceId: decodeURIComponent(sourceId) };
      }

      // 2. Formato Stealth vh_
      if (token.startsWith('vh_')) {
        return { id: null, rawStealth: token, source: null, sourceId: null };
      }

      // 3. ID estándar (numérico, hex ObjectId 24-char, o alfanumérico) antes del primer guión del slug
      const firstDash = token.indexOf('-');
      const id = firstDash !== -1 ? token.slice(0, firstDash) : token;
      return { id, source: null, sourceId: null };
    },

    // =======================================================================
    // 2. PARSER DE RUTAS
    // =======================================================================
    parsePath(pathname, search = '', hash = '') {
      let path = pathname || window.location.pathname;
      let s = search || window.location.search;
      let h = hash || window.location.hash;

      // 1. Manejo de URLs legadas con hash (ej: /#videos, /#vault, /#history)
      if (h) {
        if (h === '#videos') return { name: 'catalog', mode: 'videos', canonical: '/videos' };
        if (h === '#comics') return { name: 'catalog', mode: 'comics', canonical: '/comics' };
        if (h === '#cosplay' || h === '#galleries') return { name: 'catalog', mode: 'galleries', canonical: '/cosplay' };
        if (h === '#vault' || h === '#favoritos') return { name: 'vault', tab: 'favorites', canonical: '/boveda/favoritos' };
        if (h === '#historial' || h === '#history') return { name: 'vault', tab: 'history', canonical: '/boveda/historial' };
        if (h === '#cuenta' || h === '#account') return { name: 'vault', tab: 'account', canonical: '/cuenta' };
      }

      // 2. Manejo de parámetros query legados (ej: ?tab=vault, ?tab=videos, /favoritos)
      const q = new URLSearchParams(s);
      const tabParam = q.get('tab');
      if (path === '/favoritos' || tabParam === 'vault') {
        return { name: 'vault', tab: 'favorites', canonical: '/boveda/favoritos' };
      }
      if (path === '/historial') {
        return { name: 'vault', tab: 'history', canonical: '/boveda/historial' };
      }
      if (tabParam === 'videos' && path === '/') return { name: 'catalog', mode: 'videos', canonical: '/videos' };
      if (tabParam === 'comics' && path === '/') return { name: 'catalog', mode: 'comics', canonical: '/comics' };
      if (tabParam === 'galleries' && path === '/') return { name: 'catalog', mode: 'galleries', canonical: '/cosplay' };

      // 3. Rutas canónicas del nuevo sistema
      if (path === '/' || path === '/index.html') {
        return { name: 'home', mode: 'comics', canonical: '/' };
      }
      if (path === '/videos') {
        return { name: 'catalog', mode: 'videos', category: q.get('cat') || 'all', page: Number(q.get('page')) || 1, query: q.get('q') || '', canonical: '/videos' };
      }
      if (path === '/comics') {
        return { name: 'catalog', mode: 'comics', category: q.get('cat') || 'all', page: Number(q.get('page')) || 1, query: q.get('q') || '', canonical: '/comics' };
      }
      if (path === '/cosplay') {
        return { name: 'catalog', mode: 'galleries', category: q.get('cat') || 'all', page: Number(q.get('page')) || 1, query: q.get('q') || '', canonical: '/cosplay' };
      }

      // 4. Bóveda, Historial y Cuenta
      if (path === '/boveda' || path === '/boveda/favoritos') {
        return { name: 'vault', tab: 'favorites', canonical: '/boveda/favoritos' };
      }
      if (path === '/boveda/historial') {
        return { name: 'vault', tab: 'history', canonical: '/boveda/historial' };
      }
      if (path === '/cuenta') {
        return { name: 'vault', tab: 'account', canonical: '/cuenta' };
      }
      if (path === '/acceso') {
        return { name: 'auth', next: q.get('next') || '/', canonical: '/acceso' };
      }

      // 5. Video: /v/:slug o legada /video/:id
      const vMatch = path.match(/^\/v\/([^\/]+)$/) || path.match(/^\/video\/([^\/]+)(?:\/(.+))?$/);
      if (vMatch) {
        const rawToken = vMatch[1];
        const parsed = this.parseItemToken(rawToken);
        return {
          name: 'video',
          rawToken,
          id: parsed.id,
          source: vMatch[2] ? decodeURIComponent(vMatch[1]) : parsed.source,
          sourceId: vMatch[2] ? decodeURIComponent(vMatch[2]) : parsed.sourceId,
          canonical: path
        };
      }

      // 6. Cómic: /c/:slug o /c/:slug/leer o legada /comic/:id
      const cReadMatch = path.match(/^\/c\/([^\/]+)\/leer$/);
      if (cReadMatch) {
        const rawToken = cReadMatch[1];
        const parsed = this.parseItemToken(rawToken);
        const page = Math.max(1, parseInt(q.get('p'), 10) || 1);
        return {
          name: 'reader',
          mediaType: 'comic',
          rawToken,
          id: parsed.id,
          source: parsed.source,
          sourceId: parsed.sourceId,
          page,
          canonical: path
        };
      }
      const cMatch = path.match(/^\/c\/([^\/]+)$/) || path.match(/^\/comic\/([^\/]+)(?:\/(.+))?$/);
      if (cMatch) {
        const rawToken = cMatch[1];
        const parsed = this.parseItemToken(rawToken);
        return {
          name: 'comic',
          rawToken,
          id: parsed.id,
          source: cMatch[2] ? decodeURIComponent(cMatch[1]) : parsed.source,
          sourceId: cMatch[2] ? decodeURIComponent(cMatch[2]) : parsed.sourceId,
          canonical: path
        };
      }

      // 7. Galería: /g/:slug o legada /gallery/:id o /galeria/:id
      const gMatch = path.match(/^\/g\/([^\/]+)$/) || path.match(/^\/(?:gallery|galeria)\/([^\/]+)(?:\/(.+))?$/);
      if (gMatch) {
        const rawToken = gMatch[1];
        const parsed = this.parseItemToken(rawToken);
        return {
          name: 'gallery',
          rawToken,
          id: parsed.id,
          source: gMatch[2] ? decodeURIComponent(gMatch[1]) : parsed.source,
          sourceId: gMatch[2] ? decodeURIComponent(gMatch[2]) : parsed.sourceId,
          canonical: path
        };
      }

      // 404 Desconocido
      return { name: '404', path, canonical: path };
    },

    // =======================================================================
    // 3. NAVEGACIÓN Y VIEW TRANSITIONS
    // =======================================================================
    navigate(targetUrl, replace = false, preserveScroll = false) {
      if (!targetUrl) return;

      const currentPath = window.location.pathname;
      if (!preserveScroll) {
        scrollPositions.set(currentPath, window.scrollY);
      }

      const urlObj = new URL(targetUrl, window.location.origin);
      const parsed = this.parsePath(urlObj.pathname, urlObj.search, urlObj.hash);

      // Si la URL canónica difiere (ej: enlace legado), usar la canónica
      const finalUrl = (parsed.canonical || urlObj.pathname) + urlObj.search;

      if (replace) {
        window.history.replaceState({ url: finalUrl, route: parsed }, '', finalUrl);
      } else {
        window.history.pushState({ url: finalUrl, route: parsed }, '', finalUrl);
      }

      this.executeRoute(parsed, preserveScroll);
    },

    executeRoute(route, preserveScroll = false) {
      // 1. Limpieza de memoria y recursos de la vista anterior
      window.dispatchEvent(new CustomEvent('velvet:route-leave', { detail: { from: this.currentRoute, to: route } }));

      // 2. Actualizar estado interno
      this.currentRoute = route;

      // 3. Transición de vista con View Transitions API si está disponible
      const render = () => {
        window.dispatchEvent(new CustomEvent('velvet:route-render', { detail: route }));
        this.updateDocumentMeta(route);
        this.updateActiveNavLinks(route.canonical || window.location.pathname);

        if (!preserveScroll) {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      };

      if (document.startViewTransition && !document.documentElement.classList.contains('reduce-motion')) {
        document.startViewTransition(() => render());
      } else {
        render();
      }
    },

    updateDocumentMeta(route) {
      const titles = {
        home: 'Velvet Hub — Cómics +18, Videos & Modelos VIP Sin Censura',
        videos: 'Videos +18 Sin Censura — Velvet Hub',
        comics: 'Cómics +18 & Hentai VIP — Velvet Hub',
        galleries: 'Galerías Cosplay & Modelos VIP — Velvet Hub',
        vault_favorites: 'Mi Bóveda: Favoritos — Velvet Hub',
        vault_history: 'Mi Bóveda: Historial — Velvet Hub',
        account: 'Mi Cuenta Velvet VIP — Velvet Hub',
        auth: 'Acceso VIP & Membresía — Velvet Hub',
        '404': 'Página no encontrada &bull; Velvet Hub'
      };

      let title = titles.home;
      if (route.name === 'catalog') {
        title = titles[route.mode] || titles.home;
      } else if (route.name === 'vault') {
        if (route.tab === 'history') title = titles.vault_history;
        else if (route.tab === 'account') title = titles.account;
        else title = titles.vault_favorites;
      } else if (route.name === 'auth') {
        title = titles.auth;
      } else if (route.name === '404') {
        title = titles['404'];
      }

      document.title = title;
    },

    updateActiveNavLinks(currentPath) {
      document.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href) return;
        const isActive = href === currentPath || (href.startsWith('/boveda') && currentPath.startsWith('/boveda'));
        if (isActive) {
          link.setAttribute('aria-current', 'page');
          link.classList.add('nav-link-active');
        } else {
          link.removeAttribute('aria-current');
          link.classList.remove('nav-link-active');
        }
      });
    },

    // =======================================================================
    // 4. INTERCEPTOR DE CLICS DE ENLACES
    // =======================================================================
    bindLinkInterceptor() {
      document.addEventListener('click', (e) => {
        // Ignorar si se pulsó dentro de un botón de favoritos o controles interactivos
        if (e.target.closest('.card-fav-btn') || e.target.closest('[data-no-route]') || e.target.closest('button')) {
          return;
        }

        const link = e.target.closest('a[href]');
        if (!link) return;

        // Comprobación estricta de teclas modificadoras (Shift, Ctrl, Cmd, Alt) o clic no izquierdo
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) {
          // Dejar que el navegador realice su comportamiento nativo (abrir en pestaña nueva, menú contextual, etc.)
          return;
        }

        const target = link.getAttribute('target');
        const href = link.getAttribute('href');
        if (target === '_blank' || link.hasAttribute('download') || href.startsWith('mailto:') || href.startsWith('tel:')) {
          return;
        }

        const url = new URL(href, window.location.origin);
        // Si es un dominio externo, no interceptar
        if (url.origin !== window.location.origin) {
          return;
        }

        // Si es una ruta interna de Velvet Hub, interceptar y navegar sin recargar
        e.preventDefault();
        this.navigate(url.pathname + url.search + url.hash);
      });
    },

    // =======================================================================
    // 5. MOTOR DE PREFETCH INTELIGENTE (Hover >= 150ms / touchstart)
    // =======================================================================
    bindPrefetchEngine() {
      const isSlowConnection = () => {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) return false;
        return conn.saveData === true || conn.effectiveType === '2g' || conn.effectiveType === '3g';
      };

      const prefetch = (url) => {
        if (!url || prefetchedUrls.has(url)) return;
        if (isSlowConnection() || document.documentElement.classList.contains('velvet-data-saver')) return;

        prefetchedUrls.add(url);
        const parsed = this.parsePath(url);

        // Si es un item (video, cómic o galería), precargar el endpoint de detalle
        if (parsed.id && (parsed.name === 'video' || parsed.name === 'comic' || parsed.name === 'gallery')) {
          const fetchUrl = `/api/items/id/${parsed.id}`;
          if (fetchUrl) {
            const linkTag = document.createElement('link');
            linkTag.rel = 'prefetch';
            linkTag.as = 'fetch';
            linkTag.href = fetchUrl;
            linkTag.crossOrigin = 'anonymous';
            document.head.appendChild(linkTag);
          }
        } else if (parsed.source && parsed.sourceId) {
          const fetchUrl = `/api/items/${parsed.source}/${encodeURIComponent(parsed.sourceId)}`;
          const linkTag = document.createElement('link');
          linkTag.rel = 'prefetch';
          linkTag.as = 'fetch';
          linkTag.href = fetchUrl;
          linkTag.crossOrigin = 'anonymous';
          document.head.appendChild(linkTag);
        }
      };

      document.addEventListener('mouseover', (e) => {
        const link = e.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href || href.startsWith('http') || href.startsWith('#')) return;

        clearTimeout(prefetchTimer);
        prefetchTimer = setTimeout(() => {
          prefetch(href);
        }, 150);
      });

      document.addEventListener('mouseout', (e) => {
        if (e.target.closest('a[href]')) {
          clearTimeout(prefetchTimer);
        }
      });

      document.addEventListener('touchstart', (e) => {
        const link = e.target.closest('a[href]');
        if (link) {
          const href = link.getAttribute('href');
          if (href) prefetch(href);
        }
      }, { passive: true });
    },

    // =======================================================================
    // 6. INICIALIZACIÓN DEL ENRUTADOR
    // =======================================================================
    init() {
      this.bindLinkInterceptor();
      this.bindPrefetchEngine();

      window.addEventListener('popstate', (e) => {
        const path = window.location.pathname;
        const savedScroll = scrollPositions.get(path) || 0;
        const route = this.parsePath(path, window.location.search, window.location.hash);
        this.executeRoute(route, true);

        requestAnimationFrame(() => {
          window.scrollTo({ top: savedScroll, behavior: 'instant' });
        });
      });

      // Procesar la ruta inicial al cargar el documento
      const initialRoute = this.parsePath(window.location.pathname, window.location.search, window.location.hash);
      
      // Si la URL inicial contenía hash o query legada, normalizarla sin recargar
      if (initialRoute.canonical && initialRoute.canonical !== window.location.pathname) {
        window.history.replaceState({ url: initialRoute.canonical, route: initialRoute }, '', initialRoute.canonical);
      }

      this.executeRoute(initialRoute, false);
    }
  };

  window.VelvetRouter = VelvetRouter;
})(window);
