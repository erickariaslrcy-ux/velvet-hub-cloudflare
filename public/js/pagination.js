/**
 * ============================================================================
 * VELVET HUB - CONTROLADOR DE PAGINACIÓN REDISEÑADO (v3.2)
 * Arquitectura modular, sin librerías externas, accesible y reactiva.
 * Compatible con Node.js (CommonJS / ESM) y Browser (window.VelvetPagination).
 * ============================================================================
 */

(function (root) {
  'use strict';

  // ==========================================================================
  // 1. LÓGICA PURA Y CÁLCULOS MATEMÁTICOS
  // ==========================================================================

  /**
   * Calcula la ventana de páginas visible para el catálogo.
   * Reglas:
   * - Si totalPages <= 1: devuelve [] (ocultar paginación).
   * - Si totalPages <= 7: muestra todas [1..totalPages].
   * - Si totalPages > 7:
   *   - Siempre la primera (1) y la última (totalPages).
   *   - 2 páginas a cada lado de la actual (currentPage - 2 .. currentPage + 2).
   *   - Puntos suspensivos ('...') donde se omite.
   *
   * @param {number} currentPage - Página actual
   * @param {number} totalPages - Total de páginas
   * @returns {Array<number|string>} Array con números y '...'
   */
  function calculatePaginationWindow(currentPage, totalPages) {
    let cur = Math.floor(Number(currentPage));
    let total = Math.floor(Number(totalPages));

    if (isNaN(total) || total <= 1) return [];
    if (isNaN(cur) || cur < 1) cur = 1;
    if (cur > total) cur = total;

    if (total <= 7) {
      const all = [];
      for (let i = 1; i <= total; i++) all.push(i);
      return all;
    }

    const left = Math.max(1, cur - 2);
    const right = Math.min(total, cur + 2);

    const items = [1];

    if (left > 2) {
      items.push('...');
    } else if (left === 2) {
      items.push(2);
    }

    for (let i = Math.max(2, left); i <= Math.min(total - 1, right); i++) {
      if (!items.includes(i)) {
        items.push(i);
      }
    }

    if (right < total - 1) {
      items.push('...');
    } else if (right === total - 1) {
      if (!items.includes(total - 1)) {
        items.push(total - 1);
      }
    }

    if (!items.includes(total)) {
      items.push(total);
    }

    return items;
  }

  /**
   * Valida una entrada para el campo "Ir a página".
   * Solo enteros válidos entre 1 y totalPages.
   *
   * @param {string|number} rawValue
   * @param {number} totalPages
   * @returns {{isValid: boolean, page: number|null, error: string|null}}
   */
  function validateJumpPage(rawValue, totalPages) {
    const total = Math.floor(Number(totalPages)) || 1;
    const errorMsg = `Escribe un número entre 1 y ${total}`;

    if (rawValue === null || rawValue === undefined) {
      return { isValid: false, page: null, error: errorMsg };
    }

    const str = String(rawValue).trim();
    if (!str || !/^\d+$/.test(str)) {
      return { isValid: false, page: null, error: errorMsg };
    }

    const parsed = parseInt(str, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > total) {
      return { isValid: false, page: null, error: errorMsg };
    }

    return { isValid: true, page: parsed, error: null };
  }

  /**
   * Extrae y valida el parámetro de página de una URL o querystring.
   * Corrige páginas fuera de rango a la más cercana válida.
   *
   * @param {string} searchOrUrl
   * @param {number} [totalPages]
   * @returns {{page: number, wasCorrected: boolean, raw: string|null}}
   */
  function parseUrlPage(searchOrUrl, totalPages) {
    let query = '';
    if (typeof searchOrUrl === 'string') {
      const qIdx = searchOrUrl.indexOf('?');
      query = qIdx !== -1 ? searchOrUrl.slice(qIdx + 1) : searchOrUrl;
      const hIdx = query.indexOf('#');
      if (hIdx !== -1) query = query.slice(0, hIdx);
    } else if (typeof window !== 'undefined' && window.location) {
      query = window.location.search.replace(/^\?/, '');
    }

    const params = new URLSearchParams(query);
    const raw = params.get('page');

    if (raw === null || raw.trim() === '') {
      return { page: 1, wasCorrected: false, raw: null };
    }

    const parsed = parseInt(raw.trim(), 10);
    if (isNaN(parsed) || parsed < 1) {
      return { page: 1, wasCorrected: true, raw };
    }

    if (totalPages && totalPages > 0 && parsed > totalPages) {
      return { page: totalPages, wasCorrected: true, raw };
    }

    return { page: parsed, wasCorrected: false, raw };
  }

  /**
   * Verifica si es seguro precargar la siguiente página según conexión y modo ahorro.
   *
   * @returns {boolean}
   */
  function shouldPrefetchNextPage() {
    if (typeof navigator === 'undefined') return false;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (conn.saveData === true) return false;
      const effectiveType = conn.effectiveType;
      if (effectiveType === '2g' || effectiveType === 'slow-2g') return false;
    }
    if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('velvet-data-saver')) {
      return false;
    }
    return true;
  }

  // ==========================================================================
  // 2. ESTADO INTERNO DEL COMPONENTE EN NAVEGADOR
  // ==========================================================================
  const state = {
    currentPage: 1,
    totalPages: 1,
    totalItems: 0,
    isPaginating: false,
    initialized: false,
    prefetchTimer: null
  };

  /**
   * Obtiene el contenedor raíz de paginación.
   */
  function getRootElement() {
    return document.getElementById('velvet-pagination-root');
  }

  /**
   * Desplaza suavemente hacia el inicio de la cuadrícula del catálogo.
   */
  function scrollToGrid() {
    const grid = document.getElementById('comics-grid');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const topOffset = rect.top + window.scrollY - 85;
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: Math.max(0, topOffset),
      behavior: prefersReduced ? 'instant' : 'smooth'
    });
  }

  /**
   * Sincroniza la URL con la página actual usando pushState o replaceState.
   */
  function syncUrl(targetPage, replace = false) {
    if (typeof window === 'undefined' || !window.history || !window.location) return;
    try {
      const curUrl = new URL(window.location.href);
      if (targetPage > 1) {
        curUrl.searchParams.set('page', String(targetPage));
      } else {
        curUrl.searchParams.delete('page');
      }
      const newUrl = curUrl.pathname + curUrl.search + curUrl.hash;
      const historyState = window.history.state || {};
      const nextState = { ...historyState, page: targetPage };
      if (replace) {
        window.history.replaceState(nextState, document.title, newUrl);
      } else {
        window.history.pushState(nextState, document.title, newUrl);
      }
    } catch (e) {
      console.warn('[VelvetPagination] Error sincronizando URL:', e);
    }
  }

  /**
   * Ejecuta el salto a una página específica.
   */
  function jumpToPage(targetPage, options = {}) {
    const { fromHistory = false } = options;
    targetPage = parseInt(targetPage, 10);
    if (isNaN(targetPage) || targetPage < 1) targetPage = 1;
    if (state.totalPages && targetPage > state.totalPages) targetPage = state.totalPages;

    // Evitar recarga si ya estamos en esa página
    if (targetPage === state.currentPage && !fromHistory) return;

    // Prevenir doble clic / toque simultáneo
    if (state.isPaginating) return;
    if (typeof window !== 'undefined' && window._isLoadingFeed) return;

    state.isPaginating = true;
    state.currentPage = targetPage;

    // Sincronizar con el estado global de la aplicación si existe
    if (typeof window !== 'undefined' && window.state) {
      window.state.page = targetPage;
    }

    // Cancelar peticiones activas previas con AbortController existente
    if (typeof window !== 'undefined' && window._catalogAbortController) {
      try {
        window._catalogAbortController.abort();
      } catch (e) {}
    }

    // Actualizar URL
    if (!fromHistory) {
      syncUrl(targetPage, false);
    }

    // Mostrar feedback de carga en la barra
    const root = getRootElement();
    if (root) {
      const bar = root.querySelector('.v-pagination-bar');
      if (bar) bar.classList.add('is-loading');
    }

    // Scroll suave al inicio de la cuadrícula
    scrollToGrid();

    // Invocar fetch del catálogo existente
    if (typeof window !== 'undefined' && typeof window.fetchLiveFeed === 'function') {
      window.fetchLiveFeed(false);
    } else {
      state.isPaginating = false;
    }
  }

  function resetLoadingState() {
    state.isPaginating = false;
    const root = getRootElement();
    if (root) {
      const bar = root.querySelector('.v-pagination-bar');
      if (bar) bar.classList.remove('is-loading');
    }
  }

  // ==========================================================================
  // 3. RENDERIZADO DEL COMPONENTE HTML
  // ==========================================================================

  function escapeHtml(text) {
    if (typeof window !== 'undefined' && typeof window.escapeHtml === 'function') {
      return window.escapeHtml(text);
    }
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Renderiza el componente completo en el contenedor raíz.
   */
  function render(currentPage, totalPages, totalItems) {
    const root = getRootElement();
    if (!root) return;

    currentPage = parseInt(currentPage, 10);
    if (isNaN(currentPage) || currentPage < 1) currentPage = 1;
    totalPages = parseInt(totalPages, 10);
    if (isNaN(totalPages) || totalPages < 1) totalPages = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    state.currentPage = currentPage;
    state.totalPages = totalPages;
    state.totalItems = totalItems || 0;
    state.isPaginating = false;

    // Regla 11: Si hay 1 sola página o no hay resultados, ocultar el componente
    if (totalPages <= 1 || totalItems === 0) {
      root.classList.add('v-hidden');
      root.innerHTML = '';
      return;
    }

    root.classList.remove('v-hidden');

    const windowItems = calculatePaginationWindow(currentPage, totalPages);
    const isFirstPage = currentPage <= 1;
    const isLastPage = currentPage >= totalPages;

    // --- 1. ESTRUCTURA DE ESCRITORIO (>= 768px) ---
    let numbersHtml = '';
    windowItems.forEach((item) => {
      if (item === '...') {
        numbersHtml += `
          <button
            type="button"
            class="v-page-btn v-page-ellipsis"
            data-action="focus-jump"
            aria-label="Ir a una página específica"
            title="Saltar a página...">
            &hellip;
          </button>
        `;
      } else {
        const isActive = item === currentPage;
        numbersHtml += `
          <button
            type="button"
            class="v-page-btn v-page-num ${isActive ? 'is-active' : ''}"
            data-action="page-number"
            data-page="${item}"
            aria-label="${isActive ? `Página ${item}` : `Ir a la página ${item}`}"
            ${isActive ? 'aria-current="page"' : ''}>
            ${item}
          </button>
        `;
      }
    });

    const desktopHtml = `
      <div class="v-pagination-desktop">
        <button
          type="button"
          class="v-page-btn v-page-nav-btn v-page-prev"
          data-action="page-prev"
          aria-label="Ir a la página anterior"
          ${isFirstPage ? 'disabled aria-disabled="true"' : ''}>
          <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
        </button>

        <div class="v-page-numbers-group" role="group" aria-label="Páginas numeradas">
          ${numbersHtml}
        </div>

        <button
          type="button"
          class="v-page-btn v-page-nav-btn v-page-next"
          data-action="page-next"
          aria-label="Ir a la página siguiente"
          ${isLastPage ? 'disabled aria-disabled="true"' : ''}>
          <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>

        <div class="v-page-divider" aria-hidden="true"></div>

        <form class="v-page-jump-form" data-action="jump-form" onsubmit="return false;" novalidate>
          <label for="v-page-jump-input-desktop" class="sr-only">Ir a la página</label>
          <span class="v-page-jump-label" aria-hidden="true">Ir a:</span>
          <div class="v-page-jump-input-wrap">
            <input
              id="v-page-jump-input-desktop"
              type="number"
              inputmode="numeric"
              pattern="[0-9]*"
              min="1"
              max="${totalPages}"
              placeholder="${currentPage}"
              class="v-page-jump-input"
              data-action="jump-input"
              aria-label="Número de página destino"
            />
            <div class="v-page-jump-error" id="v-jump-error-desktop" role="alert" aria-live="polite"></div>
          </div>
          <span class="v-page-jump-total" aria-hidden="true">de ${totalPages.toLocaleString()}</span>
          <button
            type="submit"
            class="v-page-jump-submit"
            data-action="confirm-jump"
            aria-label="Confirmar salto a página">
            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          </button>
        </form>
      </div>
    `;

    // --- 2. ESTRUCTURA MÓVIL (< 768px) ---
    const mobileHtml = `
      <div class="v-pagination-mobile">
        <button
          type="button"
          class="v-page-btn v-mobile-nav-btn v-page-prev"
          data-action="page-prev"
          aria-label="Ir a la página anterior"
          ${isFirstPage ? 'disabled aria-disabled="true"' : ''}>
          <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
        </button>

        <button
          type="button"
          class="v-mobile-center-trigger"
          data-action="open-sheet"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-label="Página ${currentPage} de ${totalPages.toLocaleString()}. Toca para saltar a una página">
          <span class="v-mobile-page-txt">Página <strong class="v-mobile-cur">${currentPage}</strong> de ${totalPages.toLocaleString()}</span>
          <i class="fa-solid fa-chevron-up v-mobile-chevron" aria-hidden="true"></i>
        </button>

        <button
          type="button"
          class="v-page-btn v-mobile-nav-btn v-page-next"
          data-action="page-next"
          aria-label="Ir a la página siguiente"
          ${isLastPage ? 'disabled aria-disabled="true"' : ''}>
          <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>
      </div>
    `;

    // --- 3. BOTTOM SHEET PARA ANDROID / MÓVIL ---
    const sheetHtml = `
      <div id="v-page-bottom-sheet" class="v-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="v-sheet-title" aria-hidden="true">
        <div class="v-bottom-sheet-backdrop" data-action="close-sheet"></div>
        <div class="v-bottom-sheet-content">
          <div class="v-sheet-handle-wrap" data-action="close-sheet">
            <div class="v-sheet-handle" aria-hidden="true"></div>
          </div>
          <div class="v-sheet-header">
            <h3 id="v-sheet-title" class="v-sheet-title">Saltar a página</h3>
            <button type="button" class="v-sheet-close-btn" data-action="close-sheet" aria-label="Cerrar ventana de salto">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>

          <div class="v-sheet-body">
            <form class="v-sheet-form" data-action="sheet-jump-form" onsubmit="return false;" novalidate>
              <div class="v-sheet-input-row">
                <div class="v-sheet-input-group">
                  <label for="v-page-jump-input-mobile" class="sr-only">Escribe número de página</label>
                  <input
                    id="v-page-jump-input-mobile"
                    type="number"
                    inputmode="numeric"
                    pattern="[0-9]*"
                    min="1"
                    max="${totalPages}"
                    placeholder="${currentPage}"
                    class="v-sheet-input"
                    data-action="sheet-input"
                  />
                  <span class="v-sheet-input-total">/ ${totalPages.toLocaleString()}</span>
                </div>
                <button type="submit" class="v-sheet-submit-btn" data-action="sheet-confirm" aria-label="Ir a la página">
                  <span>Ir</span>
                  <i class="fa-solid fa-arrow-right text-xs" aria-hidden="true"></i>
                </button>
              </div>
              <div class="v-sheet-error" id="v-jump-error-mobile" role="alert" aria-live="polite"></div>
            </form>

            <div class="v-sheet-shortcuts-label">Atajos rápidos:</div>
            <div class="v-sheet-shortcuts-grid">
              <button type="button" class="v-sheet-shortcut-btn" data-action="quick-shortcut" data-jump="first" aria-label="Ir a la primera página">
                <i class="fa-solid fa-backward-step" aria-hidden="true"></i>
                <span>Primera (1)</span>
              </button>
              <button type="button" class="v-sheet-shortcut-btn" data-action="quick-shortcut" data-jump="prev10" aria-label="Retroceder 10 páginas" ${currentPage <= 10 ? 'disabled' : ''}>
                <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
                <span>-10 pág</span>
              </button>
              <button type="button" class="v-sheet-shortcut-btn" data-action="quick-shortcut" data-jump="next10" aria-label="Avanzar 10 páginas" ${currentPage + 10 > totalPages ? 'disabled' : ''}>
                <span>+10 pág</span>
                <i class="fa-solid fa-angles-right" aria-hidden="true"></i>
              </button>
              <button type="button" class="v-sheet-shortcut-btn" data-action="quick-shortcut" data-jump="last" aria-label="Ir a la última página">
                <span>Última (${totalPages.toLocaleString()})</span>
                <i class="fa-solid fa-forward-step" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    root.innerHTML = `
      <nav class="v-pagination-bar" aria-label="Paginación">
        ${desktopHtml}
        ${mobileHtml}
      </nav>
      ${sheetHtml}
    `;

    // Despachar prefetch predictivo de la página siguiente si aplica
    schedulePrefetchNextPage();
  }

  // ==========================================================================
  // 4. GESTIÓN DE HOJA INFERIOR (BOTTOM SHEET)
  // ==========================================================================

  function openBottomSheet() {
    const sheet = document.getElementById('v-page-bottom-sheet');
    const trigger = document.querySelector('.v-mobile-center-trigger');
    if (!sheet) return;

    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');

    // Bloquear scroll de fondo suavemente
    document.body.style.overflow = 'hidden';

    // Enfocar el input
    setTimeout(() => {
      const input = document.getElementById('v-page-jump-input-mobile');
      if (input) input.focus();
    }, 120);
  }

  function closeBottomSheet() {
    const sheet = document.getElementById('v-page-bottom-sheet');
    const trigger = document.querySelector('.v-mobile-center-trigger');
    if (!sheet) return;

    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');

    document.body.style.overflow = '';

    // Limpiar error
    const errEl = document.getElementById('v-jump-error-mobile');
    if (errEl) errEl.textContent = '';
    const input = document.getElementById('v-page-jump-input-mobile');
    if (input) {
      input.classList.remove('is-invalid');
      input.value = '';
    }
  }

  // ==========================================================================
  // 5. MANEJO DE ERRORES Y VALIDACIONES DEL CAMPO "IR A"
  // ==========================================================================

  function showJumpError(type, message) {
    const isDesktop = type === 'desktop';
    const input = document.getElementById(isDesktop ? 'v-page-jump-input-desktop' : 'v-page-jump-input-mobile');
    const errorEl = document.getElementById(isDesktop ? 'v-jump-error-desktop' : 'v-jump-error-mobile');

    if (input) {
      input.classList.add('is-invalid');
      input.focus();
    }
    if (errorEl) {
      errorEl.textContent = message;
      if (isDesktop) {
        errorEl.classList.add('show');
        setTimeout(() => {
          errorEl.classList.remove('show');
          if (input) input.classList.remove('is-invalid');
        }, 3000);
      }
    }
  }

  function clearJumpError(type) {
    const isDesktop = type === 'desktop';
    const input = document.getElementById(isDesktop ? 'v-page-jump-input-desktop' : 'v-page-jump-input-mobile');
    const errorEl = document.getElementById(isDesktop ? 'v-jump-error-desktop' : 'v-jump-error-mobile');

    if (input) input.classList.remove('is-invalid');
    if (errorEl) {
      errorEl.textContent = '';
      if (isDesktop) errorEl.classList.remove('show');
    }
  }

  function handleJumpSubmit(type) {
    const isDesktop = type === 'desktop';
    const input = document.getElementById(isDesktop ? 'v-page-jump-input-desktop' : 'v-page-jump-input-mobile');
    if (!input) return;

    const validation = validateJumpPage(input.value, state.totalPages);
    if (!validation.isValid) {
      showJumpError(type, validation.error);
      return;
    }

    clearJumpError(type);
    input.value = '';

    if (!isDesktop) {
      closeBottomSheet();
    }

    jumpToPage(validation.page);
  }

  // ==========================================================================
  // 6. DELEGACIÓN DE EVENTOS (DATA-ACTION) & ACCESIBILIDAD
  // ==========================================================================

  function handleRootClick(e) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const action = actionEl.getAttribute('data-action');

    switch (action) {
      case 'page-prev':
        e.preventDefault();
        jumpToPage(state.currentPage - 1);
        break;

      case 'page-next':
        e.preventDefault();
        jumpToPage(state.currentPage + 1);
        break;

      case 'page-number': {
        e.preventDefault();
        const pageNum = parseInt(actionEl.getAttribute('data-page'), 10);
        if (!isNaN(pageNum)) jumpToPage(pageNum);
        break;
      }

      case 'focus-jump': {
        e.preventDefault();
        if (window.innerWidth >= 768) {
          const input = document.getElementById('v-page-jump-input-desktop');
          if (input) {
            clearJumpError('desktop');
            input.focus();
            input.select();
          }
        } else {
          openBottomSheet();
        }
        break;
      }

      case 'confirm-jump':
        e.preventDefault();
        handleJumpSubmit('desktop');
        break;

      case 'open-sheet':
        e.preventDefault();
        openBottomSheet();
        break;

      case 'close-sheet':
        e.preventDefault();
        closeBottomSheet();
        break;

      case 'sheet-confirm':
        e.preventDefault();
        handleJumpSubmit('mobile');
        break;

      case 'quick-shortcut': {
        e.preventDefault();
        const jumpType = actionEl.getAttribute('data-jump');
        let target = state.currentPage;
        if (jumpType === 'first') target = 1;
        else if (jumpType === 'prev10') target = Math.max(1, state.currentPage - 10);
        else if (jumpType === 'next10') target = Math.min(state.totalPages, state.currentPage + 10);
        else if (jumpType === 'last') target = state.totalPages;

        closeBottomSheet();
        jumpToPage(target);
        break;
      }
    }
  }

  function handleRootKeydown(e) {
    if (e.key === 'Escape') {
      const sheet = document.getElementById('v-page-bottom-sheet');
      if (sheet && sheet.classList.contains('is-open')) {
        e.preventDefault();
        closeBottomSheet();
      }
      return;
    }

    if (e.key === 'Enter') {
      const target = e.target;
      if (target && target.id === 'v-page-jump-input-desktop') {
        e.preventDefault();
        handleJumpSubmit('desktop');
      } else if (target && target.id === 'v-page-jump-input-mobile') {
        e.preventDefault();
        handleJumpSubmit('mobile');
      }
    }
  }

  // ==========================================================================
  // 7. PRECARGA PREDICTIVA (PREFETCH)
  // ==========================================================================

  function schedulePrefetchNextPage() {
    if (!shouldPrefetchNextPage()) return;
    if (state.currentPage >= state.totalPages) return;

    clearTimeout(state.prefetchTimer);
    state.prefetchTimer = setTimeout(() => {
      try {
        const nextPage = state.currentPage + 1;
        if (typeof window === 'undefined') return;

        // Construir parámetros replicando el estado actual de filtros
        const curState = window.state || {};
        const params = new URLSearchParams({
          page: nextPage,
          page_size: curState.pageSize || 12,
          sort: curState.sort || 'recent',
          live: 'true'
        });

        if (curState.mode === 'videos') params.append('media_type', 'video');
        else if (curState.mode === 'galleries') params.append('media_type', 'gallery');
        else params.append('media_type', 'comic');

        if (curState.feedSeed) params.append('seed', String(curState.feedSeed));
        if (curState.category && curState.category !== 'all') params.append('category', curState.category);
        if (curState.tag) params.append('tag', curState.tag);
        if (curState.query) params.append('q', curState.query);

        const prefetchUrl = `/api/items?${params.toString()}`;

        // Usar fetch prioritariamente o link rel=prefetch
        fetch(prefetchUrl, { credentials: 'omit', priority: 'low' })
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data && window.CLIENT_CACHE) {
              const cacheKey = `${curState.mode || 'comics'}:${curState.category || 'all'}:${curState.tag || ''}:${nextPage}:${curState.query || ''}:${curState.sort || 'recent'}:${curState.pageSize || 12}:${curState.feedSeed || 0}`;
              window.CLIENT_CACHE.set(cacheKey, { ts: Date.now(), data });
            }
          })
          .catch(() => {});
      } catch (e) {}
    }, 400);
  }

  // ==========================================================================
  // 8. INICIALIZACIÓN Y ENLACE DE EVENTOS
  // ==========================================================================

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Delegación de eventos en document para capturar dentro y fuera del root (ej. bottom sheet)
    document.addEventListener('click', handleRootClick);
    document.addEventListener('keydown', handleRootKeydown);

    // Escuchar botón atrás / adelante del navegador
    window.addEventListener('popstate', (e) => {
      const urlInfo = parseUrlPage(window.location.search, state.totalPages);
      if (urlInfo.page !== state.currentPage) {
        jumpToPage(urlInfo.page, { fromHistory: true });
      }
    });

    // Leer página inicial de la URL al cargar
    const initialUrlInfo = parseUrlPage(window.location.search);
    if (initialUrlInfo.page > 1) {
      state.currentPage = initialUrlInfo.page;
      if (typeof window !== 'undefined' && window.state) {
        window.state.page = initialUrlInfo.page;
      }
    }
  }

  const VelvetPagination = {
    // Funciones matemáticas y lógicas puras
    calculatePaginationWindow,
    validateJumpPage,
    parseUrlPage,
    shouldPrefetchNextPage,

    // Métodos del componente en DOM
    init,
    render,
    jumpToPage,
    resetLoadingState,
    openBottomSheet,
    closeBottomSheet,
    getState: () => ({ ...state })
  };

  root.VelvetPagination = VelvetPagination;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VelvetPagination;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
