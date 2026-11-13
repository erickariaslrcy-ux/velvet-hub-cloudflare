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
  const HISTORY_CHUNK_SIZE = 48;

  let favFilterType = 'all';
  let favSortMode = 'recent';
  let favSearchQuery = '';
  let isMultiSelectMode = false;
  const selectedFavIds = new Set();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

      window.addEventListener('velvet:history-updated', () => {
        this.updateCounters();
        if (currentTab === 'history') this.renderHistory();
      });
    },

    mount(tab = 'favorites') {
      currentTab = tab;
      const root = document.getElementById('view-vault');
      if (!root) return;

      // Asegurar visibilidad del contenedor de la Bóveda y ocultar el resto
      document.querySelectorAll('.velvet-view').forEach((el) => {
        if (el.id === 'view-vault') el.classList.remove('hidden');
        else el.classList.add('hidden');
      });

      this.updateTabsUI(tab);
      this.updateCounters();

      if (tab === 'favorites') {
        this.renderFavorites();
      } else if (tab === 'history') {
        this.renderHistory();
      } else if (tab === 'account') {
        this.renderAccount();
      }
    },

    updateTabsUI(tab) {
      ['favorites', 'history', 'account'].forEach((t) => {
        const desktopBtn = document.getElementById(`vault-sidebar-tab-${t}`);
        const mobileBtn = document.getElementById(`vault-mobile-tab-${t}`);
        const contentPanel = document.getElementById(`vault-panel-${t}`);

        const isActive = t === tab;
        if (desktopBtn) {
          if (isActive) {
            desktopBtn.className = 'w-full px-4 py-3 rounded-2xl bg-gradient-to-r from-pink-500/20 to-purple-500/10 border border-pink-500/40 text-white font-bold flex items-center justify-between text-xs transition-all shadow-sm';
          } else {
            desktopBtn.className = 'w-full px-4 py-3 rounded-2xl hover:bg-white/[0.04] text-lav/70 hover:text-white font-medium flex items-center justify-between text-xs transition-all border border-transparent';
          }
        }

        if (mobileBtn) {
          if (isActive) {
            mobileBtn.className = 'px-4 py-2.5 rounded-full bg-pink-500 text-white font-black text-xs shrink-0 shadow-md';
          } else {
            mobileBtn.className = 'px-4 py-2.5 rounded-full bg-white/[0.05] text-lav/70 font-semibold text-xs shrink-0 hover:text-white';
          }
        }

        if (contentPanel) {
          if (isActive) contentPanel.classList.remove('hidden');
          else contentPanel.classList.add('hidden');
        }
      });
    },

    updateCounters() {
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
      if (!container) return;

      let favs = window.VelvetStore?.getFavorites() || [];

      // Filtro por tipo
      if (favFilterType !== 'all') {
        favs = favs.filter((f) => {
          const type = f.media_type || (f.video_sources?.length ? 'video' : 'comic');
          return type === favFilterType;
        });
      }

      // Filtro por búsqueda
      if (favSearchQuery) {
        const q = favSearchQuery.toLowerCase();
        favs = favs.filter((f) => (f.title || '').toLowerCase().includes(q));
      }

      // Ordenación
      if (favSortMode === 'az') {
        favs = favs.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else {
        favs = favs.slice().sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
      }

      if (favs.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');
      container.classList.remove('hidden');

      const prefs = window.VelvetStore?.getPreferences() || {};
      const isGrid = prefs.vaultViewMode !== 'list';

      if (isGrid) {
        container.className = 'grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 sm:gap-5';
      } else {
        container.className = 'space-y-2.5';
      }

      container.innerHTML = '';

      favs.forEach((it) => {
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
          card.className = 'group flex flex-col bg-[#0e071c] border border-purple-500/20 hover:border-pink-500/60 rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(255,45,149,0.25)] transition-all relative';
          card.innerHTML = `
            <div class="relative aspect-[3/4] w-full overflow-hidden bg-black select-none">
              <img src="${coverSrc}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" onerror="this.src='/velvet_logo.png'" />
              
              <!-- Checkbox multi-select si está activo -->
              ${isMultiSelectMode ? `
                <div class="absolute top-2 left-2 z-20" onclick="event.preventDefault(); event.stopPropagation();">
                  <input type="checkbox" class="w-4 h-4 rounded accent-pink-500 cursor-pointer fav-select-cb" data-fav-id="${itemId}" ${selectedFavIds.has(itemId) ? 'checked' : ''} onchange="window.VelvetVault.toggleSelectFav('${itemId}')">
                </div>
              ` : ''}

              <!-- Badge tipo -->
              <span class="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/85 text-[9px] font-black uppercase text-pink-300 border border-pink-500/30">
                ${badgeText}
              </span>

              <!-- Botón quitar favorito -->
              <button
                type="button"
                class="absolute bottom-2 right-2 w-7 h-7 rounded-lg bg-black/90 hover:bg-rose-600 text-lav hover:text-white flex items-center justify-center text-xs transition-all shadow-md cursor-pointer border border-white/10"
                title="Quitar de favoritos"
                onclick="event.preventDefault(); event.stopPropagation(); window.VelvetVault.removeFavoriteItem('${it.source}', '${it.source_id}', '${it.id || ''}')"
              >
                <i class="fa-solid fa-trash-can text-[11px]"></i>
              </button>
            </div>
            <div class="p-2.5 flex-1 flex flex-col justify-between">
              <h4 class="text-xs font-bold text-white group-hover:text-pink-300 transition-colors line-clamp-2 leading-snug">
                ${escapeHtml(it.title || 'Sin título')}
              </h4>
            </div>
          `;
          container.appendChild(card);
        } else {
          // Modo lista
          const row = document.createElement('a');
          row.href = itemUrl;
          row.id = `fav-card-${itemId}`;
          row.className = 'group p-2.5 rounded-2xl bg-[#0e071c] border border-purple-500/20 hover:border-pink-500/60 flex items-center justify-between gap-3 transition-all';
          row.innerHTML = `
            <div class="flex items-center gap-3 overflow-hidden flex-1">
              ${isMultiSelectMode ? `
                <input type="checkbox" class="w-4 h-4 rounded accent-pink-500 cursor-pointer shrink-0" data-fav-id="${itemId}" ${selectedFavIds.has(itemId) ? 'checked' : ''} onclick="event.stopPropagation();" onchange="window.VelvetVault.toggleSelectFav('${itemId}')">
              ` : ''}
              <div class="w-12 h-12 rounded-xl bg-black overflow-hidden shrink-0 border border-purple-500/30">
                <img src="${coverSrc}" class="w-full h-full object-cover" loading="lazy" onerror="this.src='/velvet_logo.png'" />
              </div>
              <div class="truncate">
                <span class="text-xs font-bold text-white truncate block group-hover:text-pink-300">${escapeHtml(it.title || 'Sin título')}</span>
                <span class="text-[10px] text-lav/70 font-mono">${badgeText}</span>
              </div>
            </div>
            <button
              type="button"
              class="p-2 text-lav/60 hover:text-rose-400 transition-colors cursor-pointer shrink-0"
              title="Quitar de favoritos"
              onclick="event.preventDefault(); event.stopPropagation(); window.VelvetVault.removeFavoriteItem('${it.source}', '${it.source_id}', '${it.id || ''}')"
            >
              <i class="fa-solid fa-trash-can text-sm"></i>
            </button>
          `;
          container.appendChild(row);
        }
      });
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

      let hist = window.VelvetStore?.getHistory() || [];
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
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');
      container.classList.remove('hidden');

      // Limitar a los primeros N elementos para virtualización / chunking (máx ~48 nodos)
      const slicedItems = hist.slice(0, historyPage * HISTORY_CHUNK_SIZE);
      const groups = groupHistoryByDate(slicedItems);

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
                  ${escapeHtml(h.title || 'Sin título')}
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
                onclick="window.VelvetVault.removeHistoryItem('${h.source}', '${h.source_id}', '${h.id || ''}')"
              >
                <i class="fa-solid fa-trash-can text-xs"></i>
              </button>
            </div>
          `;
          groupList.appendChild(itemRow);
        });

        container.appendChild(groupList);
      });

      // Botón "Cargar más" si hay más de 48 elementos
      if (hist.length > slicedItems.length) {
        const loadMoreBox = document.createElement('div');
        loadMoreBox.className = 'py-4 text-center';
        loadMoreBox.innerHTML = `
          <button onclick="window.VelvetVault.loadMoreHistory()" class="px-5 py-2.5 rounded-full bg-white/[0.06] hover:bg-white/[0.1] text-xs font-bold text-lav hover:text-white border border-purple-500/20 transition-all cursor-pointer">
            Cargar elementos anteriores (${hist.length - slicedItems.length} restantes)
          </button>
        `;
        container.appendChild(loadMoreBox);
      }
    },

    loadMoreHistory() {
      historyPage++;
      this.renderHistory();
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
      const user = window.VelvetStore?.getCurrentUser();
      const prefs = window.VelvetStore?.getPreferences() || {};

      const usernameEl = document.getElementById('vault-acc-username');
      const badgeEl = document.getElementById('vault-acc-badge');
      const registeredEl = document.getElementById('vault-acc-created');
      const vipKeyEl = document.getElementById('vault-acc-key');

      if (usernameEl) usernameEl.textContent = user?.username || 'Invitado VIP';
      if (badgeEl) {
        if (window.VelvetStore?.hasFullAccess()) {
          badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-pink-500/20 text-pink-300 border border-pink-500/40';
          badgeEl.textContent = user?.role === 'admin' ? 'ADMINISTRADOR' : 'MIEMBRO VIP ILIMITADO';
        } else {
          badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-white/10 text-white/70 border border-white/20';
          badgeEl.textContent = 'CUENTA ESTÁNDAR';
        }
      }
      if (registeredEl) {
        const date = user?.created_at ? new Date(user.created_at).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Activo recientemente';
        registeredEl.textContent = date;
      }
      if (vipKeyEl) {
        vipKeyEl.textContent = user?.registered_with_key || 'Llave Maestra';
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

    setFavFilter(type) {
      favFilterType = type;
      this.renderFavorites();
    },

    setFavSort(mode) {
      favSortMode = mode;
      this.renderFavorites();
    },

    setFavSearch(query) {
      favSearchQuery = query;
      this.renderFavorites();
    },

    setHistoryFilter(type) {
      historyFilterType = type;
      historyPage = 1;
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
