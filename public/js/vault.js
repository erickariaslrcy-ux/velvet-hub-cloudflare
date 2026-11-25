/**
 * VELVET HUB - BÓVEDA, HISTORIAL Y CUENTA (v3.0)
 * 
 * Rediseño completo como páginas reales (/boveda/favoritos, /boveda/historial, /cuenta)
 * - Layout con barra lateral izquierda en escritorio y tabs deslizantes en móvil
 * - Favoritos: Grilla/Lista, orden, búsqueda, multi-selección y toast de deshacer (5s)
 * - Historial: Agrupación por fechas (Hoy, Ayer, Esta semana, Este mes, Antes), barra de progreso fina,
 *   reanudación exacta, filtros, borrado por rango y pausa de privacidad
 * - Cuenta: Gestión de usuario, estado VIP, canje de llave y preferencias versionadas
 */

(function (window) {
  'use strict';

  let currentTab = 'favorites';
  let activeUndoTimer = null;
  let lastRemovedFavorite = null;
  let historyFilterType = 'all';
  let historySearchQuery = '';
  let historyOnlyUnfinished = false;
  let historyPage = 1;

  let favPage = 1;
  let favFilterType = 'all';
  let favSortMode = 'recent';
  let favSearchQuery = '';
  let isMultiSelectMode = false;
  const selectedFavIds = new Set();

  function getVaultPageSize() {
    try {
      if (window.VelvetPersonalData && typeof window.VelvetPersonalData.getPersonalPageSize === 'function') {
        return window.VelvetPersonalData.getPersonalPageSize();
      }
      const isAndroidUa = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
      const isMobileViewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth < 768;
      return (isAndroidUa || isMobileViewport) ? 12 : 18;
    } catch (e) {
      return 18;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeVaultTitle(raw, fallback = 'Sin título') {
    const s0 = String(raw || '').trim();
    if (!s0) return fallback;
    let s = s0
      .replace(/\{[^}]{1,90}\}/g, ' ')
      .replace(/[\[\(（【](?:peso\b|aigirl\b|spanish|espa[nñ]ol|english|eng|raw|digital|xasiat|buondua|misskon|4khd|pmvhaven|3hentai)[^\]\)）】]{0,60}[\]\)）】]/gi, ' ')
      .replace(/[\[\(（【][^\]\)）】]{0,80}\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb|p|pics?|photos?|fotos?|imgs?|videos?)\b[^\]\)）】]{0,50}(?:[\]\)）】]|$)/gi, ' ')
      .replace(/[\[\(（【]\s*\d+\s*photo[^\])]*$/gi, ' ')
      .replace(/\]\s*\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\b(?:peso\s*:?\s*)?\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\b\d+\s*(?:pics?|photos?|fotos?|im[aá]genes?|imgs?|videos?)\b(?=\s*(?:[\]|)\-–—]|$))/gi, ' ')
      .replace(/\b(?:xasiat|xascdn|buondua|misskon|4khd|pmvhaven|3hentai|hentaipaw|f95zone|gamcore)\b(?:\.[a-z]{2,5})?/gi, ' ')
      .replace(/\[[^\]]*$/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, '')
      .trim();
    return s || fallback;
  }

  const ALLOWED_VAULT_AVATAR_BGS = new Set([
    'from-pink-600 to-purple-600',
    'from-amber-500 to-rose-600',
    'from-cyan-500 to-blue-600',
    'from-emerald-500 to-teal-700',
    'from-purple-600 to-indigo-800',
    'from-rose-600 to-pink-700'
  ]);

  function safeVaultAvatarBg(raw) {
    const clean = String(raw || '').trim();
    return ALLOWED_VAULT_AVATAR_BGS.has(clean) ? clean : 'from-pink-600 to-purple-600';
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const s = Math.floor(seconds);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  function groupHistoryByDate(items) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const startOfWeek = startOfToday - 86400000 * 6;
    const startOfMonth = startOfToday - 86400000 * 29;

    const groups = {
      today: { label: 'Hoy', items: [] },
      yesterday: { label: 'Ayer', items: [] },
      week: { label: 'Esta semana', items: [] },
      month: { label: 'Este mes', items: [] },
      older: { label: 'Anteriormente', items: [] }
    };

    items.forEach((it) => {
      const at = it.at || Date.now();
      if (at >= startOfToday) {
        groups.today.items.push(it);
      } else if (at >= startOfYesterday) {
        groups.yesterday.items.push(it);
      } else if (at >= startOfWeek) {
        groups.week.items.push(it);
      } else if (at >= startOfMonth) {
        groups.month.items.push(it);
      } else {
        groups.older.items.push(it);
      }
    });

    return groups;
  }

  function buildVaultPageWindow(current, total) {
    if (total <= 7) {
      const all = [];
      for (let i = 1; i <= total; i++) all.push(i);
      return all;
    }
    const pages = [1];
    const left = Math.max(2, current - 1);
    const right = Math.min(total - 1, current + 1);
    if (left > 2) pages.push('...');
    for (let i = left; i <= right; i++) pages.push(i);
    if (right < total - 1) pages.push('...');
    pages.push(total);
    return pages;
  }

  function renderVaultPagination(container, currentPage, totalPages, totalItems, pageSize, onPageChange, ariaLabel = 'Paginación de Bóveda') {
    if (!container) return;
    if (!totalPages || totalPages <= 1) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }

    const cur = Math.min(Math.max(1, parseInt(currentPage, 10) || 1), totalPages);
    const tokens = buildVaultPageWindow(cur, totalPages);

    const pageButtonsHtml = tokens.map((tok) => {
      if (tok === '...') {
        return '<span class="px-1.5 text-lav/50 select-none">…</span>';
      }
      const isCurrent = tok === cur;
      const cls = isCurrent
        ? 'bg-gradient-to-r from-pink-600 to-purple-600 text-white border-pink-400/60 shadow-md'
        : 'bg-white/[0.06] hover:bg-pink-500/20 text-lav hover:text-white border-white/10';
      return `<button type="button" data-vault-page="${tok}" class="vault-pg-num px-3 py-1.5 rounded-xl border ${cls} transition-all cursor-pointer min-h-[44px] min-w-[40px] flex items-center justify-center font-bold" ${isCurrent ? 'aria-current="page"' : ''} aria-label="Página ${tok}">${tok}</button>`;
    }).join('');

    container.innerHTML = `
      <nav class="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 my-4 py-2.5 px-3 sm:px-5 rounded-2xl sm:rounded-full bg-[#0d061e]/95 border border-purple-500/30 text-xs font-bold text-white shadow-lg backdrop-blur-md" aria-label="${escapeHtml(ariaLabel)}">
        <button type="button" class="vault-pg-prev px-3.5 py-1.5 rounded-full bg-white/10 hover:bg-pink-500/20 text-white disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center gap-1" ${cur <= 1 ? 'disabled' : ''} aria-label="Página anterior">
          &larr; <span class="hidden sm:inline">Anterior</span>
        </button>
        <div class="flex items-center gap-1 flex-wrap justify-center">
          ${pageButtonsHtml}
        </div>
        <button type="button" class="vault-pg-next px-3.5 py-1.5 rounded-full bg-white/10 hover:bg-pink-500/20 text-white disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center gap-1" ${cur >= totalPages ? 'disabled' : ''} aria-label="Página siguiente">
          <span class="hidden sm:inline">Siguiente</span> &rarr;
        </button>
        <span class="text-[11px] text-purple-300/80 font-mono pl-1 sm:pl-2">
          Pág ${cur}/${totalPages} &middot; ${totalItems} (${pageSize}/pág.)
        </span>
      </nav>
    `;
    container.classList.remove('hidden');

    const prevBtn = container.querySelector('.vault-pg-prev');
    const nextBtn = container.querySelector('.vault-pg-next');
    if (prevBtn) prevBtn.onclick = () => cur > 1 && onPageChange(cur - 1);
    if (nextBtn) nextBtn.onclick = () => cur < totalPages && onPageChange(cur + 1);
    container.querySelectorAll('.vault-pg-num').forEach((btn) => {
      btn.onclick = () => {
        const p = parseInt(btn.dataset.vaultPage, 10);
        if (Number.isInteger(p) && p >= 1 && p <= totalPages && p !== cur) {
          onPageChange(p);
        }
      };
    });
  }

  function renderFallbackPagination(container, currentPage, totalPages, onPageChange) {
    renderVaultPagination(container, currentPage, totalPages, totalPages * getVaultPageSize(), getVaultPageSize(), onPageChange, 'Paginación de Bóveda');
  }

  function renderSkeletonGrid(container, count = 8) {
    if (!container) return;
    container.className = 'grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 sm:gap-5';
    container.innerHTML = Array.from({ length: count }).map(() => `
      <div class="flex flex-col bg-[#0e071c] border border-purple-500/10 rounded-2xl overflow-hidden animate-pulse">
        <div class="aspect-[3/4] w-full bg-white/[0.04] relative"></div>
        <div class="p-3 space-y-2">
          <div class="h-3 w-4/5 bg-white/[0.06] rounded"></div>
          <div class="h-2.5 w-1/2 bg-white/[0.04] rounded"></div>
        </div>
      </div>
    `).join('');
    container.classList.remove('hidden');
  }

  const VelvetVault = {
    init() {
      window.addEventListener('velvet:route-render', (e) => {
        const route = e.detail;
        if (route.name === 'vault') {
          this.mount(route.tab || 'favorites');
        }
      });

      window.addEventListener('velvet:favorites-updated', () => {
        this.updateCounters();
        if (currentTab === 'favorites') this.renderFavorites();
      });

      window.addEventListener('velvet:favorites-loading', () => {
        if (currentTab === 'favorites') this.renderFavorites();
      });

      window.addEventListener('velvet:favorites-error', () => {
        if (currentTab === 'favorites') this.renderFavorites();
      });

      window.addEventListener('velvet:history-updated', () => {
        this.updateCounters();
        if (currentTab === 'history') this.renderHistory();
      });

      window.addEventListener('velvet:history-loading', () => {
        if (currentTab === 'history') this.renderHistory();
      });

      window.addEventListener('velvet:history-error', () => {
        if (currentTab === 'history') this.renderHistory();
      });

      let lastAdaptiveSize = getVaultPageSize();
      let resizeDebounce = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
          const nextSize = getVaultPageSize();
          if (nextSize === lastAdaptiveSize) return;
          lastAdaptiveSize = nextSize;
          const root = document.getElementById('view-vault');
          if (!root || root.classList.contains('hidden')) return;
          if (currentTab === 'favorites') this.goToFavoritesPage(1);
          else if (currentTab === 'history') this.goToHistoryPage(1);
        }, 180);
      });
    },

    mount(tab = 'favorites') {
      currentTab = tab;
      const root = document.getElementById('view-vault');
      if (!root) return;

      // Ocultar explícitamente el catálogo principal, su paginación y barra de filtros para evitar fugas visuales
      const mainContent = document.getElementById('home-view') || document.getElementById('main-content');
      if (mainContent) mainContent.classList.add('hidden');
      const filterBar = document.getElementById('filter-bar');
      if (filterBar) filterBar.classList.add('hidden');
      const infiniteContainer = document.getElementById('infinite-scroll-container');
      if (infiniteContainer) infiniteContainer.classList.add('hidden');

      // Asegurar visibilidad del contenedor de la Bóveda y ocultar el resto
      const vaultEl = document.getElementById('vault-view') || document.getElementById('view-vault');
      if (vaultEl) vaultEl.classList.remove('hidden');
      document.querySelectorAll('.velvet-view').forEach((el) => {
        if (el.id === 'vault-view' || el.id === 'view-vault') el.classList.remove('hidden');
        else el.classList.add('hidden');
      });

      this.updateTabsUI(tab);
      this.updateCounters();

      const multiselectBtn = document.getElementById('vault-multiselect-toggle-btn');
      const headingEl = document.querySelector('#view-vault h1 span:last-child');
      const subEl = document.querySelector('#view-vault p.text-lav\\/70');

      if (tab === 'account') {
        if (multiselectBtn) multiselectBtn.classList.add('hidden');
        if (headingEl) headingEl.textContent = 'Mi Cuenta & Perfil VIP';
        if (subEl) subEl.textContent = 'Gestiona tu perfil, avatar, seguridad y estado de membresía.';
        this.renderAccount();
      } else if (tab === 'history') {
        historyPage = 1;
        if (multiselectBtn) multiselectBtn.classList.add('hidden');
        if (headingEl) headingEl.textContent = 'Mi Historial de Reproducción';
        if (subEl) subEl.textContent = 'Continúa viendo tus videos, cómics y juegos desde donde los dejaste.';
        if (window.VelvetPersonalData && window.VelvetPersonalData.isAuthenticated()) {
          window.VelvetPersonalData.fetchHistory(1, { filter: historyFilterType, onlyUnfinished: historyOnlyUnfinished, search: historySearchQuery });
        }
        this.renderHistory();
      } else {
        favPage = 1;
        if (multiselectBtn) multiselectBtn.classList.remove('hidden');
        if (headingEl) headingEl.textContent = 'Mi Bóveda Personal';
        if (subEl) subEl.textContent = 'Tus favoritos e historial, en tu cuenta.';
        if (window.VelvetPersonalData && window.VelvetPersonalData.isAuthenticated()) {
          window.VelvetPersonalData.fetchFavorites(1, { filter: favFilterType, sort: favSortMode, search: favSearchQuery });
        }
        this.renderFavorites();
      }
    },

    updateTabsUI(tab) {
      ['favorites', 'history', 'account'].forEach((t) => {
        const desktopBtn = document.getElementById(`vault-sidebar-tab-${t}`);
        const mobileBtn = document.getElementById(`vault-mobile-tab-${t}`);
        const contentPanel = document.getElementById(`vault-panel-${t}`);

        const isActive = t === tab;
        if (desktopBtn) {
          desktopBtn.setAttribute('role', 'tab');
          desktopBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          if (isActive) {
            desktopBtn.className = 'w-full px-4 py-3 rounded-2xl bg-gradient-to-r from-pink-500/20 to-purple-500/10 border border-pink-500/40 text-white font-bold flex items-center justify-between text-xs transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-pink-500';
          } else {
            desktopBtn.className = 'w-full px-4 py-3 rounded-2xl hover:bg-white/[0.04] text-lav/70 hover:text-white font-medium flex items-center justify-between text-xs transition-all border border-transparent focus:outline-none focus:ring-2 focus:ring-purple-500';
          }
        }

        if (mobileBtn) {
          mobileBtn.setAttribute('role', 'tab');
          mobileBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          if (isActive) {
            mobileBtn.className = 'px-4 py-2.5 rounded-full bg-pink-500 text-white font-black text-xs shrink-0 shadow-md min-h-[44px] flex items-center gap-2';
          } else {
            mobileBtn.className = 'px-4 py-2.5 rounded-full bg-white/[0.05] text-lav/70 font-semibold text-xs shrink-0 hover:text-white min-h-[44px] flex items-center gap-2';
          }
        }

        if (contentPanel) {
          contentPanel.setAttribute('role', 'tabpanel');
          if (isActive) contentPanel.classList.remove('hidden');
          else contentPanel.classList.add('hidden');
        }
      });
    },

    updateCounters() {
      if (window.VelvetPersonalData) {
        window.VelvetPersonalData.updateAllCounters();
        return;
      }
      const favs = window.VelvetStore?.getFavorites() || [];
      const hist = window.VelvetStore?.getHistory() || [];

      const favCountEls = document.querySelectorAll('.vault-fav-counter');
      favCountEls.forEach((el) => { el.textContent = String(favs.length); });

      const histCountEls = document.querySelectorAll('.vault-hist-counter');
      histCountEls.forEach((el) => { el.textContent = String(hist.length); });
    },

    // =======================================================================
    // 1. RENDERIZADO DE FAVORITOS (/boveda/favoritos)
    // =======================================================================
    renderFavorites() {
      const container = document.getElementById('vault-favorites-list');
      const emptyEl = document.getElementById('vault-favorites-empty');
      const paginationContainer = document.getElementById('vault-pagination-root');
      if (!container) return;

      const pData = window.VelvetPersonalData;
      const isAuth = pData ? pData.isAuthenticated() : !!window.VelvetStore?.getCurrentUser();

      // ESTADO 1: Visitante sin sesión iniciada
      if (!isAuth) {
        container.innerHTML = '';
        container.classList.add('hidden');
        if (paginationContainer) paginationContainer.classList.add('hidden');
        if (emptyEl) {
          emptyEl.innerHTML = `
            <div class="w-16 h-16 rounded-2xl bg-pink-500/10 border border-pink-500/30 flex items-center justify-center mb-4 shadow-[0_0_20px_rgba(255,45,149,0.2)]">
              <i class="fa-solid fa-lock text-2xl text-pink-500"></i>
            </div>
            <h3 class="font-serif text-xl font-bold text-white mb-2">Inicia sesión en tu Bóveda</h3>
            <p class="text-xs text-lav/70 max-w-sm mb-6 leading-relaxed">
              Entra para ver tus favoritos y tu historial en este móvil y en el PC.
            </p>
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-sm">
              <button type="button" onclick="if(window.openAuthModal) window.openAuthModal('login');" class="px-6 py-3 rounded-full bg-gradient-to-r from-pink-600 to-purple-600 text-white text-xs font-bold active:scale-95 transition-transform shadow-md cursor-pointer min-h-[44px]">
                Iniciar Sesión / Registrarse
              </button>
            </div>
          `;
          emptyEl.classList.remove('hidden');
        }
        return;
      }

      const pageSize = getVaultPageSize();
      const storeFavs = window.VelvetStore?.getFavorites() || [];
      const favState = pData ? pData.getFavoritesState() : {
        items: storeFavs,
        total: storeFavs.length,
        page: favPage,
        pageSize,
        totalPages: Math.max(1, Math.ceil(storeFavs.length / pageSize)),
        isLoading: false,
        error: null
      };

      // ESTADO 2: Cargando (Skeletons solo si no tenemos ítems en memoria o caché previa)
      if (favState.isLoading && (!favState.items || favState.items.length === 0)) {
        if (emptyEl) emptyEl.classList.add('hidden');
        if (paginationContainer) paginationContainer.classList.add('hidden');
        renderSkeletonGrid(container, 8);
        return;
      }

      // ESTADO 3: Error de red / servidor (Con botón de Reintentar)
      if (favState.error) {
        container.innerHTML = `
          <div class="col-span-full py-12 px-4 rounded-3xl bg-[#0e071c] border border-rose-500/30 text-center flex flex-col items-center justify-center">
            <div class="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mb-3">
              <i class="fa-solid fa-triangle-exclamation text-xl text-rose-400"></i>
            </div>
            <h3 class="text-base font-bold text-white mb-1">No se pudieron cargar tus favoritos</h3>
            <p class="text-xs text-lav/70 mb-5 max-w-xs">${escapeHtml(favState.error)}</p>
            <button type="button" onclick="if(window.VelvetPersonalData) window.VelvetPersonalData.fetchFavorites(${favState.page});" class="px-5 py-2.5 rounded-xl bg-pink-500/20 text-pink-300 border border-pink-500/40 hover:bg-pink-500/30 text-xs font-bold transition-all cursor-pointer min-h-[44px] flex items-center justify-center">
              <i class="fa-solid fa-rotate-right mr-1.5"></i> Reintentar
            </button>
          </div>
        `;
        container.className = 'grid grid-cols-1 gap-4';
        container.classList.remove('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (paginationContainer) paginationContainer.classList.add('hidden');
        return;
      }

      let favs = favState.items || [];

      // Filtro local adicional de búsqueda si el usuario escribe
      if (favSearchQuery) {
        const q = favSearchQuery.toLowerCase();
        favs = favs.filter((f) => (f.title || '').toLowerCase().includes(q));
      }

      // Ordenación local adicional si aplica
      if (favSortMode === 'az') {
        favs = favs.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      }

      // ESTADO 4: Bóveda Vacía
      if (favs.length === 0 && (favSearchQuery || favFilterType !== 'all' || favState.total === 0)) {
        container.innerHTML = '';
        container.classList.add('hidden');
        if (paginationContainer) {
          paginationContainer.classList.add('hidden');
          paginationContainer.innerHTML = '';
        }
        if (emptyEl) {
          emptyEl.innerHTML = `
            <div class="w-16 h-16 rounded-2xl bg-pink-500/10 border border-pink-500/30 flex items-center justify-center mb-4 shadow-[0_0_20px_rgba(255,45,149,0.2)]">
              <i class="fa-solid fa-heart-crack text-2xl text-pink-500"></i>
            </div>
            <h3 class="font-serif text-xl font-bold text-white mb-2">Tu Bóveda está vacía</h3>
            <p class="text-xs text-lav/70 max-w-sm mb-6 leading-relaxed">
              Toca el icono del corazón en cualquier video, cómic o galería para guardarlo aquí y acceder sin conexión o desde cualquier dispositivo.
            </p>
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full max-w-sm">
              <a href="/videos" class="px-5 py-2.5 rounded-full bg-gradient-to-r from-pink-600 to-purple-600 text-white text-xs font-bold active:scale-95 transition-transform shadow-md min-h-[44px] flex items-center justify-center">
                Explorar Videos
              </a>
              <a href="/comics" class="px-5 py-2.5 rounded-full bg-white/[0.06] hover:bg-white/[0.1] text-lav hover:text-white text-xs font-bold transition-all border border-white/10 min-h-[44px] flex items-center justify-center">
                Ver Cómics
              </a>
            </div>
          `;
          emptyEl.classList.remove('hidden');
        }
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');
      container.classList.remove('hidden');

      const isClientFavSlice = Boolean(!pData || !pData.isAuthenticated() || favSearchQuery || favSortMode === 'az' || favs.length > pageSize);
      let favTotalItems;
      let favTotalPages;
      let favCurrentPage;
      let pageFavs;

      if (!isClientFavSlice) {
        favTotalItems = Math.max(favState.total || 0, favs.length);
        favTotalPages = Math.max(1, favState.totalPages || Math.ceil(favTotalItems / pageSize));
        favCurrentPage = Math.min(Math.max(1, favState.page || favPage || 1), favTotalPages);
        favPage = favCurrentPage;
        pageFavs = favs.slice(0, pageSize);
      } else {
        favTotalItems = favs.length;
        favTotalPages = Math.max(1, Math.ceil(favTotalItems / pageSize));
        favPage = Math.min(Math.max(1, favPage), favTotalPages);
        favCurrentPage = favPage;
        const startIdx = (favCurrentPage - 1) * pageSize;
        pageFavs = favs.slice(startIdx, startIdx + pageSize);
      }

      const prefs = window.VelvetStore?.getPreferences() || {};
      const isGrid = prefs.vaultViewMode !== 'list';

      if (isGrid) {
        container.className = 'grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 sm:gap-5';
      } else {
        container.className = 'space-y-2.5';
      }

      container.innerHTML = '';

      // ESTADO 5: Con Resultados (Renderizado de tarjetas, máx 18 PC / 12 Android)

      pageFavs.forEach((it) => {
        const itemUrl = window.VelvetRouter?.getItemUrl(it) || '#';
        const coverSrc = it.cover_url
          ? (window.getStealthImageUrl ? window.getStealthImageUrl(it.cover_url, it.url) : it.cover_url)
          : '/velvet_logo.png';
        const isVid = it.media_type === 'video' || (it.video_sources && it.video_sources.length > 0);
        const badgeText = isVid ? 'Video XXX' : (it.media_type === 'gallery' ? 'Galería' : 'Cómic');
        const itemId = it.id || `${it.source}_${it.source_id}`;

        if (isGrid) {
          const card = document.createElement('a');
          card.href = itemUrl;
          card.id = `fav-card-${itemId}`;
          card.className = 'group flex flex-col bg-[#0e071c] border border-purple-500/20 hover:border-pink-500/60 rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(255,45,149,0.25)] transition-all relative cursor-pointer';
          card.onclick = (e) => {
            if (e.target.closest('button') || e.target.closest('input')) return;
            e.preventDefault();
            if (isVid && typeof window.openVideoPlayer === 'function') {
              window.openVideoPlayer(it.source, it.source_id, it.title, it.cover_url, it.url, false, it.id);
            } else if (typeof window.openReader === 'function') {
              window.openReader(it.source, it.source_id, false, it.id);
            } else if (itemUrl && itemUrl !== '#') {
              window.location.href = itemUrl;
            }
          };
          card.innerHTML = `
            <div class="relative aspect-[3/4] w-full overflow-hidden bg-black select-none">
              <img src="${coverSrc}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" onerror="this.src='/velvet_logo.png'" />
              
              <!-- Checkbox multi-select si está activo -->
              ${isMultiSelectMode ? `
                <div class="absolute top-2 left-2 z-20" onclick="event.preventDefault(); event.stopPropagation();">
                  <input type="checkbox" class="w-4 h-4 rounded accent-pink-500 cursor-pointer fav-select-cb" data-fav-id="${escapeHtml(itemId)}" ${selectedFavIds.has(itemId) ? 'checked' : ''} onchange="window.VelvetVault.toggleSelectFav(this.dataset.favId)">
                </div>
              ` : ''}

              <!-- Badge tipo -->
              <span class="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/85 text-[9px] font-black uppercase text-pink-300 border border-pink-500/30">
                ${escapeHtml(badgeText)}
              </span>

              <!-- Botón quitar favorito -->
              <button
                type="button"
                class="absolute bottom-2 right-2 w-7 h-7 rounded-lg bg-black/90 hover:bg-rose-600 text-lav hover:text-white flex items-center justify-center text-xs transition-all shadow-md cursor-pointer border border-white/10"
                title="Quitar de favoritos"
                data-fav-source="${escapeHtml(it.source || '')}"
                data-fav-source-id="${escapeHtml(it.source_id || '')}"
                data-fav-id="${escapeHtml(String(it.id || ''))}"
                onclick="event.preventDefault(); event.stopPropagation(); window.VelvetVault.removeFavoriteItem(this.dataset.favSource, this.dataset.favSourceId, this.dataset.favId)"
              >
                <i class="fa-solid fa-trash-can text-[11px]"></i>
              </button>
            </div>
            <div class="p-2.5 flex-1 flex flex-col justify-between">
              <h4 class="text-xs font-bold text-white group-hover:text-pink-300 transition-colors line-clamp-2 leading-snug">
                ${escapeHtml(sanitizeVaultTitle(it.title))}
              </h4>
            </div>
          `;
          container.appendChild(card);
        } else {
          // Modo lista
          const row = document.createElement('a');
          row.href = itemUrl;
          row.id = `fav-card-${itemId}`;
          row.className = 'group p-2.5 rounded-2xl bg-[#0e071c] border border-purple-500/20 hover:border-pink-500/60 flex items-center justify-between gap-3 transition-all cursor-pointer';
          row.onclick = (e) => {
            if (e.target.closest('button') || e.target.closest('input')) return;
            e.preventDefault();
            if (isVid && typeof window.openVideoPlayer === 'function') {
              window.openVideoPlayer(it.source, it.source_id, it.title, it.cover_url, it.url, false, it.id);
            } else if (typeof window.openReader === 'function') {
              window.openReader(it.source, it.source_id, false, it.id);
            } else if (itemUrl && itemUrl !== '#') {
              window.location.href = itemUrl;
            }
          };
          row.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden flex-1">
              ${isMultiSelectMode ? `
                <input type="checkbox" class="w-4 h-4 rounded accent-pink-500 cursor-pointer shrink-0" data-fav-id="${escapeHtml(itemId)}" ${selectedFavIds.has(itemId) ? 'checked' : ''} onclick="event.stopPropagation();" onchange="window.VelvetVault.toggleSelectFav(this.dataset.favId)">
              ` : ''}
              <div class="w-12 h-12 rounded-xl bg-black overflow-hidden shrink-0 border border-purple-500/30">
                <img src="${escapeHtml(coverSrc)}" class="w-full h-full object-cover" loading="lazy" onerror="this.src='/velvet_logo.png'" />
              </div>
              <div class="truncate">
                <span class="text-xs font-bold text-white truncate block group-hover:text-pink-300">${escapeHtml(sanitizeVaultTitle(it.title))}</span>
                <span class="text-[10px] text-lav/70 font-mono">${escapeHtml(badgeText)}</span>
              </div>
            </div>
            <button
              type="button"
              class="p-2 text-lav/60 hover:text-rose-400 transition-colors cursor-pointer shrink-0"
              title="Quitar de favoritos"
              data-fav-source="${escapeHtml(it.source || '')}"
              data-fav-source-id="${escapeHtml(it.source_id || '')}"
              data-fav-id="${escapeHtml(String(it.id || ''))}"
              onclick="event.preventDefault(); event.stopPropagation(); window.VelvetVault.removeFavoriteItem(this.dataset.favSource, this.dataset.favSourceId, this.dataset.favId)"
            >
              <i class="fa-solid fa-trash-can text-sm"></i>
            </button>
          `;
          container.appendChild(row);
        }
      });

      if (paginationContainer) {
        renderVaultPagination(
          paginationContainer,
          favCurrentPage,
          favTotalPages,
          favTotalItems,
          pageSize,
          (nextPage) => this.goToFavoritesPage(nextPage),
          'Paginación de Favoritos'
        );
      }
    },

    goToFavoritesPage(targetPage = 1) {
      const p = Math.max(1, parseInt(targetPage, 10) || 1);
      favPage = p;
      const pData = window.VelvetPersonalData;
      if (pData && pData.isAuthenticated() && !favSearchQuery && favSortMode !== 'az') {
        pData.fetchFavorites(p, { filter: favFilterType, sort: favSortMode, search: favSearchQuery });
      } else {
        this.renderFavorites();
      }
      const listEl = document.getElementById('vault-favorites-list');
      if (listEl && typeof listEl.scrollIntoView === 'function') {
        try { listEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
      }
    },

    removeFavoriteItem(source, sourceId, id = null) {
      const removed = window.VelvetStore?.removeFavorite(source, sourceId, id);
      lastRemovedFavorite = removed;

      // Animación suave de salida en el DOM sin recargar
      const cardKey = id || `${source}_${sourceId}`;
      const el = document.getElementById(`fav-card-${cardKey}`);
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'scale(0.95)';
        setTimeout(() => el.remove(), 250);
      }

      this.updateCounters();
      this.showUndoToast('Elemento quitado de tus favoritos');
    },

    showUndoToast(message) {
      const toast = document.getElementById('vault-undo-toast');
      const textEl = document.getElementById('vault-undo-text');
      if (!toast || !textEl) return;

      textEl.textContent = message;
      toast.classList.remove('hidden');

      clearTimeout(activeUndoTimer);
      activeUndoTimer = setTimeout(() => {
        toast.classList.add('hidden');
        lastRemovedFavorite = null;
      }, 5000);
    },

    undoRemoveFavorite() {
      if (lastRemovedFavorite) {
        window.VelvetStore?.addFavorite(lastRemovedFavorite);
        lastRemovedFavorite = null;
        const toast = document.getElementById('vault-undo-toast');
        if (toast) toast.classList.add('hidden');
        clearTimeout(activeUndoTimer);
        this.renderFavorites();
      }
    },

    toggleMultiSelect() {
      isMultiSelectMode = !isMultiSelectMode;
      selectedFavIds.clear();
      const bar = document.getElementById('vault-multiselect-bar');
      if (bar) {
        if (isMultiSelectMode) bar.classList.remove('hidden');
        else bar.classList.add('hidden');
      }
      this.renderFavorites();
    },

    toggleSelectFav(id) {
      if (selectedFavIds.has(id)) selectedFavIds.delete(id);
      else selectedFavIds.add(id);

      const countEl = document.getElementById('vault-selected-count');
      if (countEl) countEl.textContent = String(selectedFavIds.size);
    },

    deleteSelectedFavorites() {
      if (selectedFavIds.size === 0) return;
      const favs = window.VelvetStore?.getFavorites() || [];
      const toKeep = favs.filter((f) => {
        const id = f.id || `${f.source}_${f.source_id}`;
        return !selectedFavIds.has(id);
      });
      window.VelvetStore?.setFavorites(toKeep);
      selectedFavIds.clear();
      this.toggleMultiSelect();
      this.renderFavorites();
    },

    // =======================================================================
    // 2. RENDERIZADO DE HISTORIAL (/boveda/historial)
    // =======================================================================
    renderHistory() {
      const container = document.getElementById('vault-history-list');
      const emptyEl = document.getElementById('vault-history-empty');
      if (!container) return;

      let histPaginationContainer = document.getElementById('vault-history-pagination-root');
      if (!histPaginationContainer && container.parentNode) {
        histPaginationContainer = document.createElement('div');
        histPaginationContainer.id = 'vault-history-pagination-root';
        histPaginationContainer.className = 'w-full flex justify-center py-4';
        container.parentNode.appendChild(histPaginationContainer);
      }

      const pageSize = getVaultPageSize();
      const pData = window.VelvetPersonalData;
      const isAuth = pData ? pData.isAuthenticated() : !!window.VelvetStore?.getCurrentUser();
      const histState = pData ? pData.getHistoryState() : null;

      if (histState && histState.isLoading && (!histState.items || histState.items.length === 0)) {
        if (emptyEl) emptyEl.classList.add('hidden');
        if (histPaginationContainer) {
          histPaginationContainer.classList.add('hidden');
          histPaginationContainer.innerHTML = '';
        }
        renderSkeletonGrid(container, Math.min(pageSize, 6));
        return;
      }

      if (histState && histState.error && (!histState.items || histState.items.length === 0)) {
        container.innerHTML = `
          <div class="py-12 px-4 rounded-3xl bg-[#0e071c] border border-rose-500/30 text-center flex flex-col items-center justify-center">
            <h3 class="text-base font-bold text-white mb-1">No se pudo cargar tu historial</h3>
            <p class="text-xs text-lav/70 mb-5 max-w-xs">${escapeHtml(histState.error)}</p>
            <button type="button" onclick="if(window.VelvetPersonalData) window.VelvetPersonalData.fetchHistory(${histState.page});" class="px-5 py-2.5 rounded-xl bg-pink-500/20 text-pink-300 border border-pink-500/40 hover:bg-pink-500/30 text-xs font-bold transition-all cursor-pointer min-h-[44px] flex items-center justify-center">
              <i class="fa-solid fa-rotate-right mr-1.5"></i> Reintentar
            </button>
          </div>
        `;
        container.classList.remove('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (histPaginationContainer) {
          histPaginationContainer.classList.add('hidden');
          histPaginationContainer.innerHTML = '';
        }
        return;
      }

      let hist = (histState && (isAuth || (histState.items && histState.items.length > 0)))
        ? histState.items.slice()
        : (window.VelvetStore?.getHistory() || []);
      const progMap = window.VelvetStore?.getProgressMap() || {};

      // Filtro por tipo
      if (historyFilterType !== 'all') {
        hist = hist.filter((h) => (h.media_type || (h.duration ? 'video' : 'comic')) === historyFilterType);
      }

      // Filtro por búsqueda
      if (historySearchQuery) {
        const q = historySearchQuery.toLowerCase();
        hist = hist.filter((h) => (h.title || '').toLowerCase().includes(q));
      }

      // Filtro "Solo sin terminar"
      if (historyOnlyUnfinished) {
        hist = hist.filter((h) => {
          const key = h.id ? String(h.id) : `${h.source}:${h.source_id}`;
          const p = progMap[key] || progMap[`${h.source}:${h.source_id}`];
          return !(h.completed || p?.completed);
        });
      }

      if (hist.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        if (histPaginationContainer) {
          histPaginationContainer.classList.add('hidden');
          histPaginationContainer.innerHTML = '';
        }
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');
      container.classList.remove('hidden');

      const useServerHistPagination = Boolean(pData && isAuth && histState && !historySearchQuery && !historyOnlyUnfinished && hist.length <= pageSize);
      let histTotalItems;
      let histTotalPages;
      let histCurrentPage;
      let pageHistItems;

      if (useServerHistPagination) {
        histTotalItems = Math.max(histState.total || 0, hist.length);
        histTotalPages = Math.max(1, histState.totalPages || Math.ceil(histTotalItems / pageSize));
        histCurrentPage = Math.min(Math.max(1, histState.page || historyPage || 1), histTotalPages);
        historyPage = histCurrentPage;
        pageHistItems = hist.slice(0, pageSize);
      } else {
        histTotalItems = hist.length;
        histTotalPages = Math.max(1, Math.ceil(histTotalItems / pageSize));
        historyPage = Math.min(Math.max(1, historyPage), histTotalPages);
        histCurrentPage = historyPage;
        const startIdx = (histCurrentPage - 1) * pageSize;
        pageHistItems = hist.slice(startIdx, startIdx + pageSize);
      }

      const groups = groupHistoryByDate(pageHistItems);

      container.innerHTML = '';

      Object.keys(groups).forEach((groupKey) => {
        const group = groups[groupKey];
        if (!group.items || group.items.length === 0) return;

        // Encabezado ligero y sticky de la fecha
        const header = document.createElement('div');
        header.className = 'sticky top-16 z-10 py-2 px-3 bg-[#0a0610]/95 backdrop-blur-md border-b border-purple-500/20 text-xs font-black uppercase tracking-wider text-pink-400 flex items-center justify-between';
        header.innerHTML = `
          <span>${group.label}</span>
          <span class="text-[10px] text-lav/60 font-mono font-normal">${group.items.length} elemento${group.items.length === 1 ? '' : 's'}</span>
        `;
        container.appendChild(header);

        // Lista de items del grupo
        const groupList = document.createElement('div');
        groupList.className = 'space-y-2 py-2';

        group.items.forEach((h) => {
          const isVid = h.media_type === 'video' || !!h.duration;
          const key = h.id ? String(h.id) : `${h.source}:${h.source_id}`;
          const p = progMap[key] || progMap[`${h.source}:${h.source_id}`];

          const isCompleted = !!(h.completed || p?.completed);
          let progressPercent = 0;
          let progressText = '';

          if (isVid) {
            const cur = p?.currentTime || h.currentTime || 0;
            const dur = p?.duration || h.duration || 1;
            progressPercent = Math.min(100, Math.round((cur / dur) * 100));
            progressText = `${formatTime(cur)} / ${formatTime(dur)}`;
          } else {
            const cur = p?.page || h.page || 1;
            const tot = p?.total || h.total || 1;
            progressPercent = Math.min(100, Math.round((cur / tot) * 100));
            progressText = `Pág ${cur}/${tot}`;
          }

          const coverSrc = h.cover_url
            ? (window.getStealthImageUrl ? window.getStealthImageUrl(h.cover_url, h.url) : h.cover_url)
            : '/velvet_logo.png';
          const itemUrl = window.VelvetRouter?.getItemUrl(h) || '#';
          const cardId = `hist-item-${h.id || `${h.source}_${h.source_id}`}`;

          const itemRow = document.createElement('div');
          itemRow.id = cardId;
          itemRow.className = 'group p-3 rounded-2xl bg-[#0e071c] border border-purple-500/20 hover:border-pink-500/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all relative overflow-hidden';
          
          itemRow.innerHTML = `
            <!-- Barra de progreso superior fina neón -->
            <div class="absolute top-0 left-0 right-0 h-0.5 bg-white/5">
              <div class="h-full bg-gradient-to-r from-pink-500 to-purple-500 transition-all duration-300" style="width: ${progressPercent}%;"></div>
            </div>

            <div class="flex items-center gap-3 overflow-hidden flex-1 min-w-0">
              <a href="${itemUrl}" class="shrink-0">
                <div class="${isVid ? 'aspect-video w-20' : 'aspect-[3/4] w-12'} rounded-xl bg-black overflow-hidden border border-purple-500/30">
                  <img src="${coverSrc}" class="w-full h-full object-cover group-hover:scale-105 transition-transform" loading="lazy" onerror="this.src='/velvet_logo.png'" />
                </div>
              </a>
              <div class="truncate flex-1 min-w-0">
                <a href="${itemUrl}" class="text-xs font-bold text-white hover:text-pink-300 truncate block">
                  ${escapeHtml(sanitizeVaultTitle(h.title))}
                </a>
                <div class="flex items-center gap-2 pt-1 text-[11px] text-lav/70">
                  <span class="px-1.5 py-0.5 rounded bg-purple-950/60 border border-purple-500/30 text-[9px] font-bold uppercase text-pink-300">
                    ${isVid ? 'Video XXX' : 'Cómic'}
                  </span>
                  <span>${progressText}</span>
                  ${isCompleted ? '<span class="text-emerald-400 font-bold text-[10px]"><i class="fa-solid fa-check"></i> Completado</span>' : ''}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 shrink-0 self-end sm:self-center">
              <a href="${itemUrl}" class="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm">
                <i class="fa-solid fa-play text-[10px]"></i> Continuar
              </a>
              <button
                type="button"
                class="w-8 h-8 rounded-xl bg-white/[0.04] hover:bg-rose-950/60 text-lav/60 hover:text-rose-400 flex items-center justify-center text-xs transition-colors cursor-pointer"
                title="Eliminar de mi historial"
                data-hist-source="${escapeHtml(h.source || '')}"
                data-hist-source-id="${escapeHtml(h.source_id || '')}"
                data-hist-id="${escapeHtml(String(h.id || ''))}"
                onclick="window.VelvetVault.removeHistoryItem(this.dataset.histSource, this.dataset.histSourceId, this.dataset.histId)"
              >
                <i class="fa-solid fa-trash-can text-xs"></i>
              </button>
            </div>
          `;
          groupList.appendChild(itemRow);
        });

        container.appendChild(groupList);
      });

      if (histPaginationContainer) {
        renderVaultPagination(
          histPaginationContainer,
          histCurrentPage,
          histTotalPages,
          histTotalItems,
          pageSize,
          (nextPage) => this.goToHistoryPage(nextPage),
          'Paginación de Historial'
        );
      }
    },

    goToHistoryPage(targetPage = 1) {
      const p = Math.max(1, parseInt(targetPage, 10) || 1);
      historyPage = p;
      const pData = window.VelvetPersonalData;
      if (pData && pData.isAuthenticated() && !historySearchQuery && !historyOnlyUnfinished) {
        pData.fetchHistory(p, { filter: historyFilterType, onlyUnfinished: historyOnlyUnfinished, search: historySearchQuery });
      } else {
        this.renderHistory();
      }
      const listEl = document.getElementById('vault-history-list');
      if (listEl && typeof listEl.scrollIntoView === 'function') {
        try { listEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
      }
    },

    loadMoreHistory() {
      this.goToHistoryPage(historyPage + 1);
    },

    removeHistoryItem(source, sourceId, id = null) {
      window.VelvetStore?.removeHistoryItem(source, sourceId, id);
      const cardKey = id || `${source}_${sourceId}`;
      const el = document.getElementById(`hist-item-${cardKey}`);
      if (el) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      }
      this.updateCounters();
    },

    clearHistoryByRange(range = 'all') {
      const confirmed = window.confirm(`¿Estás seguro de que deseas borrar ${range === 'today' ? 'el historial de hoy' : (range === 'week' ? 'el historial de los últimos 7 días' : 'todo el historial')}?`);
      if (confirmed) {
        window.VelvetStore?.clearHistoryByRange(range);
        this.renderHistory();
        this.updateCounters();
      }
    },

    togglePauseHistory(enabled) {
      window.VelvetStore?.updatePreference('pauseHistory', enabled);
    },

    // =======================================================================
    // 3. RENDERIZADO DE DETALLES DE CUENTA (/cuenta)
    // =======================================================================
    renderAccount() {
      const user = window.VelvetStore?.getCurrentUser() || window.VelvetPersonalData?.getCurrentUser();
      const prefs = window.VelvetStore?.getPreferences() || {};
      const isAuth = !!(user && (user.id || user.email || user.username));

      const guestCard = document.getElementById('vault-acc-guest-card');
      const userCard = document.getElementById('vault-acc-user-card');

      if (guestCard && userCard) {
        if (!isAuth) {
          guestCard.classList.remove('hidden');
          userCard.classList.add('hidden');
        } else {
          guestCard.classList.add('hidden');
          userCard.classList.remove('hidden');
        }
      }

      const usernameEl = document.getElementById('vault-acc-username');
      const emailEl = document.getElementById('vault-acc-email');
      const badgeEl = document.getElementById('vault-acc-badge');
      const registeredEl = document.getElementById('vault-acc-created');
      const vipKeyEl = document.getElementById('vault-acc-key');
      const editUserInput = document.getElementById('profile-edit-username');
      const avatarBox = document.getElementById('vault-acc-avatar-box') || document.getElementById('vault-profile-avatar-box');
      const avatarSvg = document.getElementById('vault-acc-avatar-svg');

      const uname = user?.username || (user?.email ? user.email.split('@')[0] : 'Usuario VIP');
      if (usernameEl) usernameEl.textContent = isAuth ? uname : 'Invitado';
      if (emailEl) emailEl.textContent = isAuth ? (user?.email || 'VIP Activo') : 'Sin iniciar sesión';
      if (editUserInput && !editUserInput.value && isAuth) editUserInput.value = uname;

      const userAvatar = user?.avatar || 'crown';
      const userBg = safeVaultAvatarBg(user?.avatarBg);
      if (avatarBox) {
        avatarBox.className = `w-16 h-16 rounded-2xl bg-gradient-to-tr ${userBg} flex items-center justify-center text-2xl text-white font-black shadow-[0_0_20px_rgba(255,45,149,0.35)] shrink-0 transition-all`;
      }
      if (avatarSvg) {
        avatarSvg.outerHTML = this.getAvatarSvg(userAvatar);
      }

      // Misma fuente que las pastillas: el total canónico, no un array distinto.
      const favState = window.VelvetPersonalData?.getFavoritesState?.();
      const histState = window.VelvetPersonalData?.getHistoryState?.();
      const saves = window.VelvetStore?.getGameSaves?.() || window.VelvetPersonalData?.getGameSaves?.() || [];
      const favCount = favState && typeof favState.total === 'number'
        ? favState.total
        : (window.VelvetPersonalData?.getFavorites?.() || []).length;
      const histCount = histState && typeof histState.total === 'number'
        ? histState.total
        : (window.VelvetPersonalData?.getHistory?.() || []).length;
      const favEl = document.getElementById('vault-stats-favs');
      const histEl = document.getElementById('vault-stats-hist');
      const gamesEl = document.getElementById('vault-stats-games');
      if (favEl) favEl.textContent = String(favCount);
      if (histEl) histEl.textContent = String(histCount);
      if (gamesEl) gamesEl.textContent = Array.isArray(saves) ? saves.length : 0;
      if (window.VelvetPersonalData?.updateAllCounters) window.VelvetPersonalData.updateAllCounters();

      const subInfo = window.VelvetStore?.getSubscriptionInfo?.() || { active: false, status: isAuth ? 'inactive' : 'guest' };
      const expiryEl = document.getElementById('vault-acc-expiry');

      if (badgeEl) {
        if (subInfo.status === 'suspended') {
          badgeEl.className = 'whitespace-nowrap shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-rose-500/20 text-rose-300 border border-rose-500/40';
          badgeEl.textContent = 'CUENTA SUSPENDIDA';
        } else if (subInfo.active) {
          badgeEl.className = 'whitespace-nowrap shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-pink-500/20 text-pink-300 border border-pink-500/40';
          if (subInfo.isAdmin) {
            badgeEl.textContent = 'ADMINISTRADOR';
          } else if (subInfo.isLifetime) {
            badgeEl.textContent = 'VIP PERMANENTE';
          } else if (subInfo.daysRemaining != null) {
            badgeEl.textContent = `VIP ACTIVO (${subInfo.daysRemaining}D)`;
          } else {
            badgeEl.textContent = 'MIEMBRO VIP';
          }
        } else if (isAuth && subInfo.status === 'expired') {
          badgeEl.className = 'whitespace-nowrap shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40';
          badgeEl.textContent = 'SUSCRIPCIÓN VENCIDA';
        } else if (isAuth) {
          badgeEl.className = 'whitespace-nowrap shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white/10 text-white/70 border border-white/20';
          badgeEl.textContent = 'CUENTA GRATUITA';
        } else {
          badgeEl.className = 'whitespace-nowrap shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white/10 text-white/50 border border-white/10';
          badgeEl.textContent = 'INVITADO';
        }
      }
      if (registeredEl) {
        const date = user?.created_at ? new Date(user.created_at).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Activo recientemente';
        registeredEl.textContent = isAuth ? `Miembro desde ${date}` : 'Navegación local';
      }
      if (expiryEl) {
        if (!isAuth) {
          expiryEl.className = 'text-[11px] text-lav/60 mt-0.5';
          expiryEl.textContent = 'Inicia sesión para gestionar tu suscripción';
        } else if (subInfo.status === 'suspended') {
          expiryEl.className = 'text-[11px] font-bold text-rose-400 mt-0.5';
          expiryEl.textContent = 'Acceso suspendido por el administrador';
        } else if (subInfo.isAdmin || subInfo.isLifetime) {
          expiryEl.className = 'text-[11px] font-bold text-emerald-300 mt-0.5';
          expiryEl.textContent = 'Acceso VIP permanente (sin vencimiento)';
        } else if (subInfo.active && subInfo.expiresAt) {
          const expFmt = new Date(subInfo.expiresAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' });
          expiryEl.className = 'text-[11px] font-bold text-emerald-300 mt-0.5';
          expiryEl.textContent = `Vence el ${expFmt} (${subInfo.daysRemaining} día${subInfo.daysRemaining === 1 ? '' : 's'} restante${subInfo.daysRemaining === 1 ? '' : 's'})`;
        } else if (subInfo.status === 'expired') {
          const expFmt = subInfo.expiresAt ? new Date(subInfo.expiresAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' }) : 'recientemente';
          expiryEl.className = 'text-[11px] font-bold text-amber-300 mt-0.5';
          expiryEl.textContent = `Tu suscripción venció el ${expFmt} — Canjea una nueva llave mensual`;
        } else {
          expiryEl.className = 'text-[11px] text-lav/70 mt-0.5';
          expiryEl.textContent = 'Sin suscripción activa — Canjea una llave VIP abajo';
        }
      }
      if (vipKeyEl) {
        vipKeyEl.textContent = isAuth ? (user?.registered_with_key || (user?.patron_status === 'active_patron' ? 'Patreon VIP' : 'Sin llave aún')) : '---';
      }

      // Sincronizar switches de preferencias con los valores de VelvetStore
      const prefQuality = document.getElementById('pref-default-quality');
      const prefAutoplay = document.getElementById('pref-autoplay-next');
      const prefAmbient = document.getElementById('pref-ambient-lighting');
      const prefMotion = document.getElementById('pref-reduce-motion');
      const prefDataSaver = document.getElementById('pref-data-saver');
      const prefPauseHist = document.getElementById('pref-pause-history');

      if (prefQuality) prefQuality.value = prefs.defaultQuality || 'auto';
      if (prefAutoplay) prefAutoplay.checked = !!prefs.autoplayNext;
      if (prefAmbient) prefAmbient.checked = !!prefs.ambientLighting;
      if (prefMotion) prefMotion.checked = !!prefs.reduceMotion;
      if (prefDataSaver) prefDataSaver.checked = !!prefs.dataSaver;
      if (prefPauseHist) prefPauseHist.checked = !!prefs.pauseHistory;
    },

    getAvatarSvg(iconName) {
      switch (iconName) {
        case 'gem':
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-purple-300 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 8.5l3.8 11.5h12.4L22 8.5 12 2zM5.5 8.7L12 4.3l6.5 4.4L12 20.3 5.5 8.7z"/></svg>';
        case 'bolt':
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-amber-400 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.08-.14L13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15L11 21z"/></svg>';
        case 'fire':
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-rose-400 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM12 20c-3.31 0-6-2.69-6-6 0-1.53.58-2.92 1.53-3.97.29 1.11 1.29 1.97 2.47 1.97 1.38 0 2.5-1.12 2.5-2.5 0-.46-.13-.88-.34-1.25.93.81 1.59 1.97 1.77 3.29.35-.38.57-.89.57-1.45 0-.32-.08-.63-.21-.9 1.94 1.41 3.19 3.65 3.19 6.21 0 3.31-2.69 6-6 6z"/></svg>';
        case 'gamepad':
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-emerald-400 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M15 7.5V2H9v5.5l3 3 3-3zM7.5 9H2v6h5.5l3-3-3-3zM9 16.5V22h6v-5.5l-3-3-3 3zm7.5-7.5l-3 3 3 3H22V9h-5.5z"/></svg>';
        case 'heart':
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-pink-500 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
        case 'crown':
        default:
          return '<svg id="vault-acc-avatar-svg" class="w-8 h-8 text-amber-300 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>';
      }
    },

    // Handlers de cambio de preferencias
    updateQualityPref(val) {
      window.VelvetStore?.updatePreference('defaultQuality', val);
    },

    togglePref(key, checked) {
      window.VelvetStore?.updatePreference(key, checked);
    },

    setVaultViewMode(mode) {
      window.VelvetStore?.updatePreference('vaultViewMode', mode);
      this.renderFavorites();
    },

    getPageSize() {
      return getVaultPageSize();
    },

    setFavFilter(type) {
      favFilterType = type;
      favPage = 1;
      if (window.VelvetPersonalData && window.VelvetPersonalData.isAuthenticated()) {
        window.VelvetPersonalData.fetchFavorites(1, { filter: favFilterType, sort: favSortMode, search: favSearchQuery });
      }
      this.renderFavorites();
    },

    setFavSort(mode) {
      favSortMode = mode;
      favPage = 1;
      this.renderFavorites();
    },

    setFavSearch(query) {
      favSearchQuery = query;
      favPage = 1;
      this.renderFavorites();
    },

    setHistoryFilter(type) {
      historyFilterType = type;
      historyPage = 1;
      if (window.VelvetPersonalData && window.VelvetPersonalData.isAuthenticated()) {
        window.VelvetPersonalData.fetchHistory(1, { filter: historyFilterType, onlyUnfinished: historyOnlyUnfinished, search: historySearchQuery });
      }
      this.renderHistory();
    },

    setHistorySearch(query) {
      historySearchQuery = query;
      historyPage = 1;
      this.renderHistory();
    },

    setHistoryOnlyUnfinished(val) {
      historyOnlyUnfinished = val;
      historyPage = 1;
      this.renderHistory();
    }
  };

  VelvetVault.init();
  window.VelvetVault = VelvetVault;
})(window);
