/**
 * MORBO HUB — MOTOR TIKTOK MULTIPANTALLA PRO (1-3 PANTALLAS) + FAVORITOS EXCLUSIVOS SHORTS (v5.0)
 * - 1, 2 o 3 pantallas simultáneas en escritorio/tablet sin duplicar clips entre pantallas.
 * - Comportamiento inteligente configurable:
 *   * Nav: 'focused' (solo pantalla enfocada) o 'sync' (todas las no fijadas juntas).
 *   * Audio: 'solo' (una sola a la vez), 'follow' (sigue al foco) o 'free' (cada pantalla libre).
 *   * Auto: 'lane' (cada pantalla independiente), 'sync' (espera a que todas acaben y cambia juntas) o 'off'.
 *   * Lock/Fijar (📌) independiente por pantalla + origen por pantalla (Para Ti / Favoritos / #tag).
 * - Corazón ♥ y Favoritos EXCLUSIVOS para VIP dentro de Shorts (sin mezclar con Mi Bóveda).
 * - Pantalla Limpia (Limpiar / H / Esc) aplicable a 1, 2 o 3 pantallas simultáneas.
 */
(function (window, document) {
  'use strict';

  const MUTE_KEY = 'velvet_shorts_muted_v1';
  const AUTO_NEXT_KEY = 'velvet_shorts_autonext_v1';
  const PRO_PREFS_KEY = 'velvet_shorts_pro_v1';
  const USER_CACHE_PREFIX = 'velvet_shorts_user_favs_v1_';
  const MAX_LANES = 3;

  function createLaneState(index) {
    return {
      index,
      el: null,
      trackEl: null,
      slides: [],
      activeIndex: 0,
      loading: false,
      locked: false,
      userPaused: false,
      muted: true,
      autoNext: false,
      cycleDone: false,
      feedMode: 'random', // 'random' | 'favorites'
      q: '', // override local opcional; vacío = usa state.q global
      consecSkips: 0,
      observer: null,
      nextTimer: 0
    };
  }

  const state = {
    mounted: false,
    focusedLane: 0,
    effectiveLanes: 1,
    proPrefs: {
      requestedLanes: 1,
      navMode: 'focused', // 'focused' | 'sync'
      audioMode: 'solo', // 'solo' | 'follow' | 'free'
      autoMode: 'lane' // 'lane' | 'sync' | 'off'
    },
    globalWantAudio: false,
    proMenuOpen: false,
    category: 'all',
    q: '',
    cleanMode: false,
    seenIds: [],
    likes: new Set(),
    favs: [],
    loadedUid: '',
    lastSyncWheelAt: 0,
    lanes: [createLaneState(0), createLaneState(1), createLaneState(2)]
  };

  function getMaxAllowedLanes() {
    const w = window.innerWidth || 1280;
    if (w < 768) return 1;
    if (w < 1100) return 2;
    return MAX_LANES;
  }

  function getAuthContext() {
    const store = window.VelvetStore;
    const pData = window.VelvetPersonalData;
    const user =
      (store && typeof store.getCurrentUser === 'function' ? store.getCurrentUser() : null) ||
      (pData && typeof pData.getUser === 'function' ? pData.getUser() : null);
    const hasAuth = pData && typeof pData.isAuthenticated === 'function' ? pData.isAuthenticated() : Boolean(user);
    const hasAccess = store && typeof store.hasFullAccess === 'function' ? Boolean(store.hasFullAccess()) : Boolean(user);
    return {
      user,
      uid: user && user.id ? String(user.id) : '',
      authed: Boolean(user && hasAuth),
      canSave: Boolean(user && hasAuth && hasAccess)
    };
  }

  function promptVipLogin(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message || 'Inicia sesión con tu cuenta VIP para guardar favoritos', 'info');
    }
    if (typeof window.openAuthModal === 'function') {
      window.openAuthModal('login');
    }
  }

  function loadProPrefs() {
    try {
      const m = localStorage.getItem(MUTE_KEY);
      const lane0Muted = m === null ? true : m === '1';
      state.lanes[0].muted = lane0Muted;
      state.globalWantAudio = !lane0Muted;
    } catch (e) {}
    try {
      const a = localStorage.getItem(AUTO_NEXT_KEY) === '1';
      state.lanes[0].autoNext = a;
    } catch (e) {}
    try {
      const raw = JSON.parse(localStorage.getItem(PRO_PREFS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        const req = Number(raw.requestedLanes);
        state.proPrefs.requestedLanes = (req === 2 || req === 3) ? req : 1;
        state.proPrefs.navMode = raw.navMode === 'sync' ? 'sync' : 'focused';
        state.proPrefs.audioMode = ['solo', 'follow', 'free'].includes(raw.audioMode) ? raw.audioMode : 'solo';
        state.proPrefs.autoMode = ['lane', 'sync', 'off'].includes(raw.autoMode) ? raw.autoMode : 'lane';
      }
    } catch (e) {}
  }

  function saveProPrefs() {
    try {
      localStorage.setItem(PRO_PREFS_KEY, JSON.stringify(state.proPrefs));
    } catch (e) {}
  }

  function bindLaneDomRefs() {
    for (let k = 0; k < MAX_LANES; k++) {
      const lane = state.lanes[k];
      lane.el = document.getElementById(`tt-lane-${k}`);
      lane.trackEl = document.getElementById(k === 0 ? 'tiktok-snap-track' : `tiktok-snap-track-${k}`);
    }
  }

  function getActiveLane() {
    return state.lanes[state.focusedLane] || state.lanes[0];
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  function writeScopedFavCache(uid, list) {
    if (!uid) return;
    try {
      const slim = (Array.isArray(list) ? list : []).slice(0, 500).map((f) => ({
        id: f.id,
        title: f.title || 'Clip',
        cover_url: f.cover_url || '',
        share_id: f.share_id || '',
        tags: Array.isArray(f.tags) ? f.tags.slice(0, 6) : [],
        artists: Array.isArray(f.artists) ? f.artists.slice(0, 2) : [],
        duration: f.duration ?? null,
        likes: Number(f.likes || 0),
        savedAt: f.savedAt || Date.now()
      }));
      localStorage.setItem(`${USER_CACHE_PREFIX}${uid}`, JSON.stringify(slim));
    } catch (e) {}
  }

  function readScopedFavCache(uid) {
    if (!uid) return [];
    try {
      const raw = JSON.parse(localStorage.getItem(`${USER_CACHE_PREFIX}${uid}`) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => x && x.id != null) : [];
    } catch (e) {
      return [];
    }
  }

  function normalizeShortFavRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rawSid = String(raw.source_id || raw.item_id || raw.id || '').replace(/^short:/i, '').trim();
    if (!/^\d{1,15}$/.test(rawSid)) return null;
    return {
      id: Number(rawSid),
      title: raw.title || 'Clip',
      cover_url: raw.cover_url || '',
      share_id: raw.share_id || '',
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      artists: Array.isArray(raw.artists) ? raw.artists : [],
      duration: raw.duration ?? null,
      likes: Number(raw.likes || 0),
      savedAt: raw.created_at ? new Date(raw.created_at).getTime() : (raw.savedAt || Date.now())
    };
  }

  function syncFavsUIAll() {
    const auth = getAuthContext();
    const count = auth.canSave ? state.favs.length : 0;
    const badge = document.getElementById('tt-favs-count');
    if (badge) {
      badge.textContent = auth.canSave ? String(count) : 'VIP';
    }
    const modalCount = document.getElementById('tt-favs-modal-count');
    if (modalCount) modalCount.textContent = String(count);

    const spreadBtn = document.getElementById('tt-favs-spread-all');
    if (spreadBtn) {
      const showSpread = state.effectiveLanes >= 2 && count >= 2;
      spreadBtn.classList.toggle('hidden', !showSpread);
      spreadBtn.classList.toggle('flex', showSpread);
    }

    for (let k = 0; k < MAX_LANES; k++) {
      const lane = state.lanes[k];
      if (!lane.trackEl) continue;
      lane.trackEl.querySelectorAll('.tt-slide').forEach((s) => {
        const idx = Number(s.dataset.idx);
        const sItem = lane.slides[idx];
        if (!sItem) return;
        const isLiked = auth.canSave && state.likes.has(String(sItem.id));
        const btn = s.querySelector('[data-tt-action="like"]');
        if (btn) {
          btn.classList.toggle('is-liked', isLiked);
          const cntEl = btn.querySelector('.tt-rail-txt');
          if (cntEl) cntEl.textContent = String(Number(sItem.likes || 0) + (isLiked ? 1 : 0));
        }
      });
    }
  }

  async function loadAccountFavorites(forceServer = false) {
    const auth = getAuthContext();
    if (!auth.canSave || !auth.uid) {
      state.loadedUid = '';
      state.favs = [];
      state.likes = new Set();
      let exitedAny = false;
      state.lanes.forEach((lane) => {
        if (lane.feedMode === 'favorites') {
          lane.feedMode = 'random';
          exitedAny = true;
          if (state.mounted && lane.index < state.effectiveLanes) fetchLaneBatch(lane, true);
        }
      });
      if (exitedAny) syncTopModeChips();
      closeFavoritesModal();
      syncFavsUIAll();
      return [];
    }

    if (state.loadedUid !== auth.uid) {
      state.loadedUid = auth.uid;
      const cached = readScopedFavCache(auth.uid);
      state.favs = cached;
      state.likes = new Set(cached.map((x) => String(x.id)));
      syncFavsUIAll();
    } else if (!forceServer) {
      syncFavsUIAll();
    }

    const pData = window.VelvetPersonalData;
    if (!pData || typeof pData.fetchAuthed !== 'function') return state.favs;

    try {
      const res = await pData.fetchAuthed('/api/user/favorites?type=short&page=1&pageSize=120');
      if (!res || !res.ok) return state.favs;
      const data = await res.json().catch(() => null);
      if (!data || data.degraded || !Array.isArray(data.items)) return state.favs;

      const latestAuth = getAuthContext();
      if (!latestAuth.canSave || latestAuth.uid !== auth.uid) return state.favs;

      const serverList = data.items
        .filter((x) => x && (x.media_type === 'short' || String(x.source || '').toLowerCase() === 'short'))
        .map(normalizeShortFavRecord)
        .filter(Boolean);

      state.favs = serverList;
      state.likes = new Set(serverList.map((x) => String(x.id)));
      writeScopedFavCache(auth.uid, serverList);
      syncFavsUIAll();

      const modal = document.getElementById('tt-favs-modal');
      if (modal && !modal.classList.contains('hidden')) {
        renderFavsGrid(state.favs);
      }
      return state.favs;
    } catch (e) {
      return state.favs;
    }
  }

  async function toggleHeartItem(item) {
    const auth = getAuthContext();
    if (!auth.authed) {
      promptVipLogin('Inicia sesión con tu cuenta VIP para guardar favoritos');
      return false;
    }
    if (!auth.canSave) {
      promptVipLogin('Solo las cuentas VIP activas pueden guardar favoritos');
      return false;
    }
    if (!item || item.id == null) return false;

    const cleanSid = String(item.source_id || item.id).replace(/^short:/i, '').trim();
    const exists = state.likes.has(cleanSid);
    const pData = window.VelvetPersonalData;

    const prevFavs = [...state.favs];
    const prevLikes = new Set(state.likes);

    if (exists) {
      state.likes.delete(cleanSid);
      state.favs = state.favs.filter((f) => String(f.id) !== cleanSid);
      if (typeof window.showToast === 'function') {
        window.showToast('Quitado de Tus Shorts Favoritos', 'info');
      }
    } else {
      state.likes.add(cleanSid);
      const record = {
        id: Number(cleanSid) || cleanSid,
        title: item.title || 'Clip',
        cover_url: item.cover_url || '',
        share_id: item.share_id || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
        artists: Array.isArray(item.artists) ? item.artists.slice(0, 2) : [],
        duration: item.duration ?? null,
        likes: Number(item.likes || 0),
        savedAt: Date.now()
      };
      state.favs = [record, ...state.favs.filter((f) => String(f.id) !== cleanSid)].slice(0, 500);
      if (typeof window.showToast === 'function') {
        window.showToast('Guardado en Tus Shorts Favoritos ♥', 'success');
      }
    }

    writeScopedFavCache(auth.uid, state.favs);
    syncFavsUIAll();
    const modal = document.getElementById('tt-favs-modal');
    if (modal && !modal.classList.contains('hidden')) {
      renderFavsGrid(state.favs);
    }

    if (pData && typeof pData.fetchAuthed === 'function') {
      try {
        let ok = false;
        if (exists) {
          const qp = new URLSearchParams({
            id: cleanSid,
            source: 'short',
            source_id: cleanSid
          });
          const res = await pData.fetchAuthed(`/api/user/favorites?${qp.toString()}`, { method: 'DELETE' });
          ok = Boolean(res && res.ok);
        } else {
          const res = await pData.fetchAuthed('/api/user/favorites', {
            method: 'POST',
            body: JSON.stringify({
              id: cleanSid,
              item_id: cleanSid,
              source: 'short',
              source_id: cleanSid,
              media_type: 'short',
              title: item.title || 'Short guardado',
              cover_url: '',
              url: ''
            })
          });
          ok = Boolean(res && res.ok);
        }
        if (!ok) throw new Error('sync_failed');
      } catch (err) {
        state.favs = prevFavs;
        state.likes = prevLikes;
        writeScopedFavCache(auth.uid, prevFavs);
        syncFavsUIAll();
        if (modal && !modal.classList.contains('hidden')) renderFavsGrid(state.favs);
        if (typeof window.showToast === 'function') {
          window.showToast('No se pudo guardar en tu cuenta, intenta de nuevo', 'error');
        }
        return false;
      }
    }
    return !exists;
  }

  function updateAmbientBackdrop(item) {
    if (window.innerWidth < 1024) return;
    const ambImg = document.getElementById('tt-ambient-img');
    if (!ambImg) return;
    if (!item || !item.cover_url) {
      ambImg.classList.remove('is-ready');
      return;
    }
    const targetSrc = item.cover_url;
    if (ambImg.dataset.src === targetSrc) return;
    ambImg.dataset.src = targetSrc;
    ambImg.classList.remove('is-ready');
    ambImg.onerror = () => ambImg.classList.remove('is-ready');
    ambImg.onload = () => ambImg.classList.add('is-ready');
    ambImg.src = targetSrc;
  }

  function applyStageGeometry(slide, lane = null) {
    if (!slide) return;
    const stage = slide.querySelector('.tt-stage');
    const vid = slide.querySelector('.tt-video');
    if (!stage || !vid) return;

    const eff = state.effectiveLanes;
    if (window.innerWidth < 768) {
      stage.style.width = '';
      return;
    }

    const vw = vid.videoWidth || 0;
    const vh = vid.videoHeight || 0;
    if (!vw || !vh) {
      stage.style.width = '';
      return;
    }

    const viewEl = document.getElementById('tiktok-feed-view');
    const trackH = lane && lane.trackEl ? lane.trackEl.clientHeight : 0;
    const fallbackH = ((viewEl && viewEl.clientHeight) || (window.innerHeight - (state.cleanMode ? 0 : 64))) - (state.cleanMode ? 8 : (eff >= 2 ? 72 : 16));
    const availH = Math.max(300, trackH > 200 ? trackH - (state.cleanMode ? 6 : 8) : fallbackH);
    const idealW = Math.round(availH * (vw / vh));

    if (eff === 1) {
      const maxW = Math.min(window.innerWidth * (state.cleanMode ? 0.94 : 0.88), 1280);
      const finalW = Math.max(340, Math.min(maxW, idealW));
      stage.style.width = `${finalW}px`;
    } else {
      const maxLaneW = lane && lane.trackEl && lane.trackEl.clientWidth > 120
        ? Math.max(220, lane.trackEl.clientWidth - 8)
        : Math.floor((window.innerWidth - 96) / eff);
      const finalW = Math.max(220, Math.min(maxLaneW, idealW));
      stage.style.width = `${finalW}px`;
    }
  }

  function syncTopModeChips() {
    const activeLane = getActiveLane();
    const statusChip = document.getElementById('tt-search-chip');
    const statusTxt = document.getElementById('tt-search-chip-label');
    if (statusChip && statusTxt) {
      if (state.q && activeLane.feedMode !== 'favorites') {
        statusTxt.textContent = state.q;
        statusChip.classList.remove('hidden');
      } else {
        statusChip.classList.add('hidden');
      }
    }
    const favModeChip = document.getElementById('tt-favs-mode-chip');
    if (favModeChip) {
      const anyFav = state.lanes.slice(0, state.effectiveLanes).some((l) => l.feedMode === 'favorites');
      favModeChip.classList.toggle('hidden', !anyFav);
    }
    syncProControlsUI();
    syncAllLaneHeaders();
    syncFavsUIAll();
  }

  function syncProControlsUI() {
    const eff = state.effectiveLanes;
    const { requestedLanes, navMode, audioMode, autoMode } = state.proPrefs;

    document.querySelectorAll('#tt-lanes-switcher [data-tt-lanes]').forEach((btn) => {
      const n = Number(btn.dataset.ttLanes);
      btn.classList.toggle('is-selected', n === requestedLanes || (n === eff && requestedLanes > getMaxAllowedLanes()));
    });

    const dock = document.getElementById('tt-pro-dock');
    if (dock) {
      dock.classList.toggle('is-open', eff >= 2);
    }

    const navBtn = document.getElementById('tt-nav-mode-btn');
    const navLbl = document.getElementById('tt-nav-mode-label');
    if (navBtn && navLbl) {
      navLbl.textContent = navMode === 'sync' ? 'Nav: Juntas' : 'Nav: Individual';
      navBtn.classList.toggle('is-sync', navMode === 'sync');
    }

    const audioBtn = document.getElementById('tt-audio-mode-btn');
    const audioLbl = document.getElementById('tt-audio-mode-label');
    if (audioBtn && audioLbl) {
      const map = { solo: 'Audio: Solo una', follow: 'Audio: Foco', free: 'Audio: Libre' };
      audioLbl.textContent = map[audioMode] || 'Audio: Solo una';
      audioBtn.classList.toggle('is-sync', audioMode !== 'free');
    }

    const autoBtn = document.getElementById('tt-auto-mode-btn');
    const autoLbl = document.getElementById('tt-auto-mode-label');
    if (autoBtn && autoLbl) {
      const map = { lane: 'Auto: Libre', sync: 'Auto: Juntas', off: 'Auto: Off' };
      autoLbl.textContent = map[autoMode] || 'Auto: Libre';
      autoBtn.classList.toggle('is-sync', autoMode === 'sync');
      autoBtn.classList.toggle('is-green', autoMode === 'lane');
    }

    document.querySelectorAll('#tt-pro-popover [data-tt-set-nav]').forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.ttSetNav === navMode);
    });
    document.querySelectorAll('#tt-pro-popover [data-tt-set-audio]').forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.ttSetAudio === audioMode);
    });
    document.querySelectorAll('#tt-pro-popover [data-tt-set-auto]').forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.ttSetAuto === autoMode);
    });

    const isSmart = navMode === 'focused' && audioMode === 'solo' && autoMode === 'lane';
    const isSync = navMode === 'sync' && audioMode === 'follow' && autoMode === 'sync';
    const isFree = navMode === 'focused' && audioMode === 'free' && autoMode === 'lane';
    document.querySelectorAll('#tt-pro-popover [data-tt-preset]').forEach((b) => {
      const p = b.dataset.ttPreset;
      b.classList.toggle('is-active', (p === 'smart' && isSmart) || (p === 'sync' && isSync) || (p === 'free' && isFree));
    });
  }

  function syncLaneHeader(lane) {
    if (!lane || !lane.el) return;
    const focused = lane.index === state.focusedLane;
    lane.el.classList.toggle('is-focused', focused);
    lane.el.classList.toggle('is-locked', lane.locked);

    const head = lane.el.querySelector('.tt-lane-head');
    if (!head) return;
    const badge = head.querySelector('.tt-lane-badge');
    if (badge) {
      if (state.proPrefs.autoMode === 'sync' && lane.cycleDone && !lane.locked) {
        badge.textContent = `#${lane.index + 1} · ✓ Listo`;
      } else if (focused) {
        badge.textContent = `#${lane.index + 1} · Activa`;
      } else {
        badge.textContent = `#${lane.index + 1}`;
      }
    }

    const srcBtn = head.querySelector('[data-tt-lane-source-btn]');
    if (srcBtn) {
      srcBtn.classList.toggle('is-fav', lane.feedMode === 'favorites');
      srcBtn.classList.toggle('is-wait', Boolean(lane.q));
      if (lane.feedMode === 'favorites') {
        srcBtn.textContent = '❤️ Favs';
      } else if (lane.q) {
        srcBtn.textContent = `#${lane.q.slice(0, 12)} ✕`;
      } else {
        srcBtn.textContent = '🎲 Para Ti';
      }
    }

    const lockBtn = head.querySelector('[data-tt-lane-lock-btn]');
    if (lockBtn) {
      lockBtn.classList.toggle('is-locked', lane.locked);
      lockBtn.title = lane.locked ? 'Soltar pantalla fijada (L)' : 'Fijar pantalla (L)';
    }
  }

  function syncAllLaneHeaders() {
    for (let k = 0; k < MAX_LANES; k++) {
      syncLaneHeader(state.lanes[k]);
    }
  }

  function syncCleanModeUI() {
    document.body.classList.toggle('tt-clean-mode', state.cleanMode);
    if (state.cleanMode) closeProPopover();
    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      if (!lane.trackEl) continue;
      lane.trackEl.querySelectorAll('[data-tt-action="clean"]').forEach((btn) => {
        btn.classList.toggle('is-on', state.cleanMode);
        const txt = btn.querySelector('.tt-rail-txt');
        if (txt) txt.textContent = state.cleanMode ? 'Ver UI' : 'Limpiar';
      });
    }
    const refreshGeo = () => {
      for (let k = 0; k < state.effectiveLanes; k++) {
        const lane = state.lanes[k];
        if (!lane.trackEl) continue;
        lane.trackEl.querySelectorAll('.tt-slide').forEach((s) => applyStageGeometry(s, lane));
      }
    };
    requestAnimationFrame(() => {
      refreshGeo();
      setTimeout(refreshGeo, 80);
    });
  }

  function toggleCleanMode(force) {
    const next = typeof force === 'boolean' ? force : !state.cleanMode;
    if (next === state.cleanMode) return;
    state.cleanMode = next;
    syncCleanModeUI();
    if (state.cleanMode && typeof window.showToast === 'function') {
      window.showToast('Pantalla limpia · Toca "Mostrar controles" arriba para volver', 'info');
    }
  }

  function getCurrentlyLoadedIds() {
    const out = new Set();
    for (let k = 0; k < MAX_LANES; k++) {
      state.lanes[k].slides.forEach((it) => {
        if (it && it.id != null) out.add(String(it.id));
      });
    }
    return out;
  }

  function buildExcludeParam(reset) {
    const loaded = getCurrentlyLoadedIds();
    const historySlice = reset ? [] : state.seenIds.slice(-300);
    const merged = Array.from(new Set([...historySlice, ...loaded])).slice(-380);
    return merged.join(',');
  }

  async function fetchLaneBatch(lane, reset = false) {
    if (!lane || lane.feedMode === 'favorites') return;
    if (lane.loading) return;
    lane.loading = true;

    const loaderEl = document.getElementById('tiktok-feed-loader');
    const isInitialZero = reset && lane.index === 0 && lane.slides.length === 0;
    if (isInitialZero && loaderEl) loaderEl.classList.remove('hidden');

    try {
      const effectiveQ = lane.q || state.q || '';
      let data = null;
      const canUsePrefetch =
        reset &&
        lane.index === 0 &&
        !effectiveQ &&
        (!state.category || state.category === 'all') &&
        window.__ttInitialBatchPromise;

      if (canUsePrefetch) {
        const pre = window.__ttInitialBatchPromise;
        window.__ttInitialBatchPromise = null;
        data = await pre.catch(() => null);
      }

      if (!data) {
        const excludeSlice = buildExcludeParam(reset && lane.index === 0);
        const clipToken = reset && lane.index === 0 ? (new URLSearchParams(window.location.search).get('c') || '') : '';
        const params = new URLSearchParams({
          limit: '12',
          category: state.category || 'all',
          q: effectiveQ,
          exclude: excludeSlice,
          _: `${Date.now()}_${lane.index}_${Math.random().toString(36).slice(2, 7)}`
        });
        if (clipToken && !effectiveQ) params.set('clip', clipToken);

        const res = await fetch('/api/shorts/random?' + params.toString(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      }

      const rawIncoming = Array.isArray(data.items) ? data.items : [];
      if (reset) {
        unloadLaneVideos(lane);
        lane.slides = [];
        lane.activeIndex = 0;
        lane.consecSkips = 0;
        lane.cycleDone = false;
        if (lane.trackEl) lane.trackEl.innerHTML = '';
      }

      const existingElsewhere = new Set();
      for (let k = 0; k < MAX_LANES; k++) {
        state.lanes[k].slides.forEach((s) => {
          if (s && s.id != null) existingElsewhere.add(String(s.id));
        });
      }

      const incoming = rawIncoming.filter((it) => {
        if (!it || it.id == null) return false;
        const sid = String(it.id);
        if (existingElsewhere.has(sid)) return false;
        existingElsewhere.add(sid);
        return true;
      });

      const finalIncoming = incoming.length > 0 ? incoming : rawIncoming;
      const emptyEl = document.getElementById('tiktok-empty-state');
      if (lane.index === 0 && finalIncoming.length === 0 && lane.slides.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }
      if (emptyEl && finalIncoming.length > 0) emptyEl.classList.add('hidden');

      const startIdx = lane.slides.length;
      lane.slides.push(...finalIncoming);
      finalIncoming.forEach((it) => {
        if (it.id != null) state.seenIds.push(String(it.id));
      });
      if (state.seenIds.length > 900) {
        state.seenIds = state.seenIds.slice(-600);
      }

      appendLaneSlideElements(lane, finalIncoming, startIdx);
      if (reset) {
        if (lane.trackEl) lane.trackEl.scrollTop = 0;
        activateLaneSlide(lane, 0);
      } else {
        syncLaneVideoWindow(lane, lane.activeIndex);
      }
    } catch (err) {
      console.warn(`[TikTokFeed] Error cargando aleatorios (pantalla ${lane.index + 1}):`, err);
    } finally {
      lane.loading = false;
      if (loaderEl && lane.index === 0) loaderEl.classList.add('hidden');
    }
  }

  function createSlideElement(lane, item, idx) {
    const slide = document.createElement('article');
    slide.className = 'tt-slide';
    slide.dataset.idx = String(idx);
    slide.dataset.lane = String(lane.index);

    const auth = getAuthContext();
    const isLiked = auth.canSave && state.likes.has(String(item.id));
    const tagsHtml = (item.tags || []).slice(0, 5).map((t) =>
      `<button type="button" data-tt-tag="${esc(t)}" class="tt-tag-chip">#${esc(t)}</button>`
    ).join('');
    const artist = (item.artists && item.artists[0]) ? `@${esc(item.artists[0])}` : '';
    const shouldLoop = state.proPrefs.autoMode === 'off' || (state.proPrefs.autoMode === 'lane' && !lane.autoNext);

    slide.innerHTML = `
      <div class="tt-stage">
        ${item.cover_url ? `<img class="tt-poster" src="${esc(item.cover_url)}" alt="" loading="eager" decoding="async" draggable="false" />` : ''}
        <video class="tt-video" playsinline controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture disableRemotePlayback oncontextmenu="return false;" ${shouldLoop ? 'loop' : ''} preload="none" ${lane.muted ? 'muted' : ''}></video>
        <div class="tt-tap-layer" data-tt-action="toggle-play"></div>
        <div class="tt-center-icon hidden"><i class="fa-solid fa-play"></i></div>
        <div class="tt-spinner hidden"><div class="video-buffering-ring w-10 h-10"></div></div>
        <div class="tt-gradient-bottom"></div>

        <div class="tt-info">
          ${artist ? `<div class="tt-meta-row"><span class="tt-artist">${artist}</span></div>` : ''}
          <h2 class="tt-title">${esc(item.title || 'Clip')}</h2>
          ${tagsHtml ? `<div class="tt-tags-wrap">${tagsHtml}</div>` : ''}
        </div>

        <div class="tt-rail">
          <button type="button" class="tt-rail-btn ${isLiked ? 'is-liked' : ''}" data-tt-action="like" title="Guardar en Tus Shorts Favoritos (VIP)">
            <span class="tt-rail-ico"><i class="fa-solid fa-heart"></i></span>
            <span class="tt-rail-txt">${Number(item.likes || 0) + (isLiked ? 1 : 0)}</span>
          </button>
          <button type="button" class="tt-rail-btn" data-tt-action="mute" title="Sonido en esta pantalla (M)">
            <span class="tt-rail-ico"><i class="fa-solid ${lane.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></span>
            <span class="tt-rail-txt">${lane.muted ? 'Mute' : 'Audio'}</span>
          </button>
          <button type="button" class="tt-rail-btn ${lane.autoNext ? 'is-on' : ''}" data-tt-action="autonext" title="Pasar solo al terminar">
            <span class="tt-rail-ico"><i class="fa-solid fa-forward-step"></i></span>
            <span class="tt-rail-txt">Auto</span>
          </button>
          <button type="button" class="tt-rail-btn ${state.cleanMode ? 'is-on' : ''}" data-tt-action="clean" title="Limpiar pantalla: oculta barra, títulos y botones">
            <span class="tt-rail-ico"><i class="fa-solid fa-eye-slash"></i></span>
            <span class="tt-rail-txt">${state.cleanMode ? 'Ver UI' : 'Limpiar'}</span>
          </button>
          <button type="button" class="tt-rail-btn" data-tt-action="copy" title="Compartir enlace de Morbo Hub">
            <span class="tt-rail-ico"><i class="fa-solid fa-share-nodes"></i></span>
            <span class="tt-rail-txt">Link</span>
          </button>
        </div>

        <div class="tt-progress-wrap" data-tt-action="seek" title="Adelantar / retroceder">
          <div class="tt-progress-bg">
            <div class="tt-progress-fill" style="width:0%"></div>
          </div>
          <span class="tt-time-badge">0:00</span>
        </div>
      </div>
    `;

    const vid = slide.querySelector('.tt-video');
    const spinner = slide.querySelector('.tt-spinner');
    const fill = slide.querySelector('.tt-progress-fill');
    const timeBadge = slide.querySelector('.tt-time-badge');
    const poster = slide.querySelector('.tt-poster');

    const clearWatchdog = () => {
      if (slide._ttWatchdog) {
        clearTimeout(slide._ttWatchdog);
        slide._ttWatchdog = 0;
      }
    };

    const promoteNextSlide = (myIdx) => {
      if (!lane.trackEl) return;
      const nextSlide = lane.trackEl.querySelector(`.tt-slide[data-idx="${myIdx + 1}"]`);
      const nextVid = nextSlide && nextSlide.querySelector('.tt-video');
      if (nextVid && nextVid.dataset.loadedSrc && nextVid.preload !== 'auto') {
        nextVid.preload = 'auto';
      }
    };

    const failAndAdvance = () => {
      clearWatchdog();
      slide.dataset.dead = '1';
      if (spinner) spinner.classList.add('hidden');
      if (poster) poster.classList.remove('is-hidden');
      const myIdx = Number(slide.dataset.idx);
      if (myIdx !== lane.activeIndex || !state.mounted || lane.index >= state.effectiveLanes) return;
      lane.consecSkips = (lane.consecSkips || 0) + 1;
      if (lane.consecSkips <= 3 && myIdx + 1 < lane.slides.length) {
        setTimeout(() => {
          if (state.mounted && lane.activeIndex === myIdx) {
            goToLaneSlide(lane, myIdx + 1);
          }
        }, 200);
      }
    };

    vid.addEventListener('loadedmetadata', () => applyStageGeometry(slide, lane));
    vid.addEventListener('loadeddata', () => {
      clearWatchdog();
      const myIdx = Number(slide.dataset.idx);
      if (myIdx === lane.activeIndex) promoteNextSlide(myIdx);
    });
    vid.addEventListener('waiting', () => {
      if (Number(slide.dataset.idx) === lane.activeIndex && spinner) spinner.classList.remove('hidden');
    });
    vid.addEventListener('playing', () => {
      clearWatchdog();
      lane.consecSkips = 0;
      delete slide.dataset.dead;
      if (spinner) spinner.classList.add('hidden');
      if (poster) poster.classList.add('is-hidden');
      const myIdx = Number(slide.dataset.idx);
      if (myIdx === lane.activeIndex) promoteNextSlide(myIdx);
    });
    vid.addEventListener('canplay', () => {
      clearWatchdog();
      if (spinner) spinner.classList.add('hidden');
    });
    vid.addEventListener('error', () => {
      if (!vid.dataset.loadedSrc) return;
      failAndAdvance();
    });
    vid.addEventListener('timeupdate', () => {
      if (!vid.duration || Number(slide.dataset.idx) !== lane.activeIndex) return;
      const pct = Math.min(100, (vid.currentTime / vid.duration) * 100);
      if (fill) fill.style.width = `${pct}%`;
      if (timeBadge) timeBadge.textContent = `${fmtTime(vid.currentTime)} / ${fmtTime(vid.duration)}`;
    });
    vid.addEventListener('ended', () => {
      if (Number(slide.dataset.idx) !== lane.activeIndex || !state.mounted || lane.index >= state.effectiveLanes) return;
      handleLaneVideoEnded(lane, vid);
    });

    return slide;
  }

  function handleLaneVideoEnded(lane, vid) {
    const mode = state.proPrefs.autoMode;
    if (mode === 'off') {
      vid.currentTime = 0;
      vid.play().catch(() => {});
      return;
    }

    if (mode === 'sync' && state.effectiveLanes >= 2) {
      if (lane.locked) {
        vid.currentTime = 0;
        vid.play().catch(() => {});
        return;
      }
      lane.cycleDone = true;
      syncLaneHeader(lane);

      const eligible = [];
      for (let k = 0; k < state.effectiveLanes; k++) {
        const l = state.lanes[k];
        if (!l.locked && !l.userPaused && l.slides.length > 0) {
          eligible.push(l);
        }
      }
      const allDone = eligible.length > 0 && eligible.every((l) => l.cycleDone);
      if (allDone) {
        for (let k = 0; k < MAX_LANES; k++) {
          state.lanes[k].cycleDone = false;
          syncLaneHeader(state.lanes[k]);
        }
        stepAllUnlocked(1);
      } else {
        // Bucle suave mientras las demás pantallas terminan su clip
        vid.currentTime = 0;
        vid.play().catch(() => {});
      }
      return;
    }

    // Modo 'lane' (cada pantalla independiente según su botón Auto)
    if (lane.autoNext) {
      if (lane.activeIndex + 1 < lane.slides.length) {
        goToLaneSlide(lane, lane.activeIndex + 1);
      } else if (lane.feedMode === 'favorites' && lane.slides.length > 0) {
        goToLaneSlide(lane, 0);
      }
    } else {
      vid.currentTime = 0;
      vid.play().catch(() => {});
    }
  }

  function appendLaneSlideElements(lane, items, startIdx) {
    if (!lane.trackEl) return;
    const frag = document.createDocumentFragment();
    items.forEach((item, offset) => {
      const slide = createSlideElement(lane, item, startIdx + offset);
      frag.appendChild(slide);
      if (lane.observer) lane.observer.observe(slide);
    });
    lane.trackEl.appendChild(frag);
  }

  function computeShouldLoop(lane) {
    if (state.proPrefs.autoMode === 'off') return true;
    if (state.proPrefs.autoMode === 'sync' && state.effectiveLanes >= 2) return false;
    return !lane.autoNext;
  }

  function attachVideoSource(lane, slide, item, preloadMode) {
    if (!slide || !item) return;
    const vid = slide.querySelector('.tt-video');
    if (!vid) return;
    const targetSrc = item.stream_url || '';
    if (!targetSrc) return;
    if (vid.dataset.loadedSrc !== targetSrc) {
      vid.src = targetSrc;
      vid.dataset.loadedSrc = targetSrc;
    }
    if (vid.preload !== preloadMode) vid.preload = preloadMode;
    vid.muted = lane.muted;
    vid.loop = computeShouldLoop(lane);
  }

  function detachVideoSource(slide) {
    if (!slide) return;
    if (slide._ttWatchdog) {
      clearTimeout(slide._ttWatchdog);
      slide._ttWatchdog = 0;
    }
    const vid = slide.querySelector('.tt-video');
    const poster = slide.querySelector('.tt-poster');
    const spinner = slide.querySelector('.tt-spinner');
    if (spinner) spinner.classList.add('hidden');
    if (poster) poster.classList.remove('is-hidden');
    if (vid && vid.dataset.loadedSrc) {
      try {
        vid.pause();
        vid.removeAttribute('src');
        delete vid.dataset.loadedSrc;
        vid.load();
      } catch (e) {}
    }
  }

  function unloadLaneVideos(lane) {
    if (!lane) return;
    if (lane.nextTimer) {
      clearTimeout(lane.nextTimer);
      lane.nextTimer = 0;
    }
    if (lane.trackEl) {
      lane.trackEl.querySelectorAll('.tt-slide').forEach(detachVideoSource);
    }
  }

  function unloadAllVideos() {
    for (let k = 0; k < MAX_LANES; k++) {
      unloadLaneVideos(state.lanes[k]);
    }
  }

  function syncLaneVideoWindow(lane, activeIdx) {
    if (!lane || !lane.trackEl) return;
    if (lane.nextTimer) {
      clearTimeout(lane.nextTimer);
      lane.nextTimer = 0;
    }
    if (!state.mounted || lane.index >= state.effectiveLanes) {
      unloadLaneVideos(lane);
      return;
    }

    const slides = lane.trackEl.querySelectorAll('.tt-slide');
    slides.forEach((slide) => {
      const idx = Number(slide.dataset.idx);
      const item = lane.slides[idx];
      if (!item) return;

      const poster = slide.querySelector('.tt-poster');
      if (poster && Math.abs(idx - activeIdx) <= 3) {
        if (!poster.getAttribute('src') && item.cover_url) {
          poster.setAttribute('src', item.cover_url);
        }
      } else if (poster && Math.abs(idx - activeIdx) > 4) {
        poster.removeAttribute('src');
      }

      if (idx === activeIdx) {
        if (slide.dataset.dead === '1' && (lane.consecSkips || 0) <= 3 && activeIdx + 1 < lane.slides.length) {
          setTimeout(() => { if (state.mounted && lane.activeIndex === activeIdx) goToLaneSlide(lane, activeIdx + 1); }, 120);
          return;
        }
        attachVideoSource(lane, slide, item, 'auto');
        applyStageGeometry(slide, lane);
        const vid = slide.querySelector('.tt-video');
        const centerIco = slide.querySelector('.tt-center-icon');
        if (vid && state.mounted) {
          vid.muted = lane.muted;
          vid.loop = computeShouldLoop(lane);
          if (slide._ttWatchdog) clearTimeout(slide._ttWatchdog);
          if (vid.readyState < 2 && !lane.userPaused) {
            slide._ttWatchdog = setTimeout(() => {
              slide._ttWatchdog = 0;
              if (!state.mounted || lane.activeIndex !== activeIdx || vid.readyState >= 2 || lane.userPaused) return;
              slide.dataset.dead = '1';
              lane.consecSkips = (lane.consecSkips || 0) + 1;
              if (lane.consecSkips <= 3 && activeIdx + 1 < lane.slides.length) {
                goToLaneSlide(lane, activeIdx + 1);
              }
            }, 6500);
          }
          if (lane.userPaused) {
            vid.pause();
            if (centerIco) centerIco.classList.remove('hidden');
          } else {
            if (centerIco) centerIco.classList.add('hidden');
            const p = vid.play();
            if (p && typeof p.catch === 'function') {
              p.catch(() => {
                vid.muted = true;
                lane.muted = true;
                syncLaneMuteIcons(lane);
                vid.play().catch(() => {});
              });
            }
          }
        }
      } else if (idx === activeIdx + 1) {
        if (slide._ttWatchdog) { clearTimeout(slide._ttWatchdog); slide._ttWatchdog = 0; }
        attachVideoSource(lane, slide, item, 'metadata');
        const vid = slide.querySelector('.tt-video');
        if (vid) vid.pause();
        lane.nextTimer = setTimeout(() => {
          if (state.mounted && lane.activeIndex === activeIdx && vid && vid.dataset.loadedSrc) {
            vid.preload = 'auto';
          }
        }, 250);
      } else if (idx === activeIdx + 2 || idx === activeIdx - 1) {
        if (slide._ttWatchdog) { clearTimeout(slide._ttWatchdog); slide._ttWatchdog = 0; }
        attachVideoSource(lane, slide, item, 'metadata');
        const vid = slide.querySelector('.tt-video');
        if (vid) vid.pause();
      } else {
        detachVideoSource(slide);
      }
    });
  }

  function activateLaneSlide(lane, idx) {
    if (!lane || idx < 0 || idx >= lane.slides.length) return;
    lane.activeIndex = idx;
    lane.cycleDone = false;
    lane.userPaused = false;
    syncLaneHeader(lane);
    if (lane.index === state.focusedLane) {
      updateAmbientBackdrop(lane.slides[idx]);
    }
    syncLaneVideoWindow(lane, idx);
    if (lane.feedMode !== 'favorites' && idx >= lane.slides.length - 5 && !lane.loading) {
      fetchLaneBatch(lane, false);
    }
  }

  function goToLaneSlide(lane, idx, instant = false) {
    if (!lane || !lane.trackEl || lane.slides.length === 0) return;
    let clamped = Math.max(0, Math.min(idx, lane.slides.length - 1));
    while (clamped < lane.slides.length - 1) {
      const cand = lane.trackEl.querySelector(`.tt-slide[data-idx="${clamped}"]`);
      if (!cand || cand.dataset.dead !== '1') break;
      clamped++;
    }
    const slide = lane.trackEl.querySelector(`.tt-slide[data-idx="${clamped}"]`);
    if (slide) {
      slide.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
      if (instant || clamped === lane.activeIndex) activateLaneSlide(lane, clamped);
    }
  }

  function stepAllUnlocked(delta) {
    let moved = 0;
    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      if (lane.locked || lane.slides.length === 0) continue;
      let target = lane.activeIndex + delta;
      if (lane.feedMode === 'favorites' && lane.slides.length > 0) {
        target = (target + lane.slides.length) % lane.slides.length;
      } else {
        target = Math.max(0, Math.min(target, lane.slides.length - 1));
      }
      if (target !== lane.activeIndex || (delta > 0 && lane.activeIndex === lane.slides.length - 1 && lane.feedMode !== 'favorites')) {
        goToLaneSlide(lane, target);
        moved++;
      }
    }
    return moved;
  }

  function setFocusedLane(idx) {
    if (idx < 0 || idx >= state.effectiveLanes) return;
    const changed = state.focusedLane !== idx;
    state.focusedLane = idx;
    syncAllLaneHeaders();
    const focused = state.lanes[idx];
    if (focused && focused.slides[focused.activeIndex]) {
      updateAmbientBackdrop(focused.slides[focused.activeIndex]);
    }
    if (changed && state.proPrefs.audioMode === 'follow' && state.globalWantAudio) {
      setLaneMuted(focused, false, true);
    }
  }

  function syncLaneMuteIcons(lane) {
    if (!lane) return;
    if (lane.index === 0) {
      try { localStorage.setItem(MUTE_KEY, lane.muted ? '1' : '0'); } catch (e) {}
    }
    if (lane.trackEl) {
      lane.trackEl.querySelectorAll('[data-tt-action="mute"]').forEach((btn) => {
        const ico = btn.querySelector('i');
        const txt = btn.querySelector('.tt-rail-txt');
        if (ico) ico.className = `fa-solid ${lane.muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
        if (txt) txt.textContent = lane.muted ? 'Mute' : 'Audio';
      });
      const activeSlide = lane.trackEl.querySelector(`.tt-slide[data-idx="${lane.activeIndex}"]`);
      const vid = activeSlide && activeSlide.querySelector('.tt-video');
      if (vid) vid.muted = lane.muted;
    }
  }

  function setLaneMuted(lane, nextMuted, quietFollow = false) {
    if (!lane) return;
    lane.muted = Boolean(nextMuted);
    if (!lane.muted) state.globalWantAudio = true;
    else if (!quietFollow && state.lanes.slice(0, state.effectiveLanes).every((l) => l.muted)) {
      state.globalWantAudio = false;
    }

    if (!lane.muted && (state.proPrefs.audioMode === 'solo' || state.proPrefs.audioMode === 'follow')) {
      for (let k = 0; k < MAX_LANES; k++) {
        if (k !== lane.index && !state.lanes[k].muted) {
          state.lanes[k].muted = true;
          syncLaneMuteIcons(state.lanes[k]);
        }
      }
    }
    syncLaneMuteIcons(lane);
  }

  function muteAllLanes() {
    state.globalWantAudio = false;
    for (let k = 0; k < MAX_LANES; k++) {
      state.lanes[k].muted = true;
      syncLaneMuteIcons(state.lanes[k]);
    }
    if (typeof window.showToast === 'function') {
      window.showToast('Todas las pantallas silenciadas', 'info');
    }
  }

  function syncLaneAutoIcons(lane) {
    if (!lane) return;
    if (lane.index === 0) {
      try { localStorage.setItem(AUTO_NEXT_KEY, lane.autoNext ? '1' : '0'); } catch (e) {}
    }
    if (lane.trackEl) {
      lane.trackEl.querySelectorAll('[data-tt-action="autonext"]').forEach((btn) => {
        btn.classList.toggle('is-on', lane.autoNext);
      });
      const activeSlide = lane.trackEl.querySelector(`.tt-slide[data-idx="${lane.activeIndex}"]`);
      const vid = activeSlide && activeSlide.querySelector('.tt-video');
      if (vid) vid.loop = computeShouldLoop(lane);
    }
  }

  function refreshAllVideoLoops() {
    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      lane.cycleDone = false;
      syncLaneHeader(lane);
      if (!lane.trackEl) continue;
      const activeSlide = lane.trackEl.querySelector(`.tt-slide[data-idx="${lane.activeIndex}"]`);
      const vid = activeSlide && activeSlide.querySelector('.tt-video');
      if (vid) vid.loop = computeShouldLoop(lane);
    }
  }

  function setRequestedLanes(count, silent = false) {
    const req = (count === 2 || count === 3) ? count : 1;
    state.proPrefs.requestedLanes = req;
    saveProPrefs();
    applyViewportLaneLayout();
    if (!silent && typeof window.showToast === 'function') {
      if (req > state.effectiveLanes) {
        window.showToast(`Tu pantalla admite hasta ${state.effectiveLanes} videos simultáneos`, 'info');
      } else if (state.effectiveLanes >= 2) {
        window.showToast(`${state.effectiveLanes} pantallas activas · Tocá o pulsá 1-${state.effectiveLanes} para enfocar`, 'success');
      } else {
        window.showToast('Vista de 1 pantalla restaurada', 'info');
      }
    }
  }

  function applyViewportLaneLayout() {
    bindLaneDomRefs();
    const maxAllowed = getMaxAllowedLanes();
    const eff = Math.min(state.proPrefs.requestedLanes, maxAllowed);
    const prevEff = state.effectiveLanes;
    state.effectiveLanes = eff;

    const stageEl = document.getElementById('tt-lanes-stage');
    if (stageEl) stageEl.dataset.lanes = String(eff);
    document.body.classList.toggle('tt-multi-active', eff >= 2);

    if (state.focusedLane >= eff) {
      state.focusedLane = eff - 1;
    }

    for (let k = 0; k < MAX_LANES; k++) {
      const lane = state.lanes[k];
      if (!lane.el) continue;
      const visible = k < eff;
      lane.el.classList.toggle('hidden', !visible);
      if (!visible) {
        unloadLaneVideos(lane);
      } else if (state.mounted) {
        setupLaneObserver(lane);
        if (lane.slides.length === 0) {
          fetchLaneBatch(lane, true);
        } else if (k >= prevEff || !lane.trackEl?.querySelector('.tt-video[src]')) {
          syncLaneVideoWindow(lane, lane.activeIndex);
        }
      }
    }

    syncTopModeChips();
    requestAnimationFrame(() => {
      for (let k = 0; k < eff; k++) {
        const lane = state.lanes[k];
        if (!lane.trackEl) continue;
        lane.trackEl.querySelectorAll('.tt-slide').forEach((s) => applyStageGeometry(s, lane));
      }
    });
  }

  function toggleLaneLock(laneIdx, force) {
    const lane = state.lanes[laneIdx];
    if (!lane) return;
    lane.locked = typeof force === 'boolean' ? force : !lane.locked;
    lane.cycleDone = false;
    syncLaneHeader(lane);
    if (typeof window.showToast === 'function') {
      window.showToast(
        lane.locked
          ? `📌 Pantalla #${lane.index + 1} fijada (no cambia al bajar juntas)`
          : `🔓 Pantalla #${lane.index + 1} desbloqueada`,
        'info'
      );
    }
  }

  function toggleLanePlayPause(lane, forcePause) {
    if (!lane || !lane.trackEl) return;
    const activeSlide = lane.trackEl.querySelector(`.tt-slide[data-idx="${lane.activeIndex}"]`);
    const vid = activeSlide && activeSlide.querySelector('.tt-video');
    const icon = activeSlide && activeSlide.querySelector('.tt-center-icon');
    if (!vid) return;
    const nextPause = typeof forcePause === 'boolean' ? forcePause : !vid.paused;
    lane.userPaused = nextPause;
    if (nextPause) {
      vid.pause();
      if (icon) icon.classList.remove('hidden');
    } else {
      vid.play().catch(() => {});
      if (icon) icon.classList.add('hidden');
    }
  }

  function togglePauseAllLanes() {
    let anyPlaying = false;
    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      const activeSlide = lane.trackEl?.querySelector(`.tt-slide[data-idx="${lane.activeIndex}"]`);
      const vid = activeSlide?.querySelector('.tt-video');
      if (vid && !vid.paused) {
        anyPlaying = true;
        break;
      }
    }
    const targetPause = anyPlaying;
    for (let k = 0; k < state.effectiveLanes; k++) {
      toggleLanePlayPause(state.lanes[k], targetPause);
    }
    if (typeof window.showToast === 'function') {
      window.showToast(targetPause ? '⏸ Todas las pantallas pausadas' : '▶ Todas las pantallas en reproducción', 'info');
    }
  }

  function shuffleUnlockedLanes() {
    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      if (lane.locked) continue;
      if (lane.feedMode === 'favorites') {
        launchFavoritesInLane(lane, null, true);
      } else {
        fetchLaneBatch(lane, true);
      }
    }
    if (typeof window.showToast === 'function') {
      window.showToast('🎲 Videos aleatorios renovados en pantallas libres', 'info');
    }
  }

  function setNavMode(mode) {
    state.proPrefs.navMode = mode === 'sync' ? 'sync' : 'focused';
    saveProPrefs();
    syncProControlsUI();
    if (typeof window.showToast === 'function') {
      window.showToast(
        state.proPrefs.navMode === 'sync'
          ? 'Nav Juntas: ↑/↓ y la rueda bajan todas las pantallas libres a la vez'
          : 'Nav Individual: cada pantalla baja independiente (↑/↓ mueve la enfocada)',
        'info'
      );
    }
  }

  function setAudioMode(mode) {
    state.proPrefs.audioMode = ['solo', 'follow', 'free'].includes(mode) ? mode : 'solo';
    saveProPrefs();
    if (state.proPrefs.audioMode === 'follow' && state.globalWantAudio) {
      setLaneMuted(getActiveLane(), false, true);
    } else if (state.proPrefs.audioMode === 'solo') {
      let kept = false;
      for (let k = 0; k < state.effectiveLanes; k++) {
        const idx = k === 0 ? state.focusedLane : (k === state.focusedLane ? 0 : k);
        const l = state.lanes[idx];
        if (!l.muted && !kept) kept = true;
        else if (!l.muted && kept) {
          l.muted = true;
          syncLaneMuteIcons(l);
        }
      }
    }
    syncProControlsUI();
    if (typeof window.showToast === 'function') {
      const msgs = {
        solo: 'Audio Solo una: al activar sonido en una pantalla se silencian las otras',
        follow: 'Audio Foco: el audio sigue automáticamente la pantalla que enfoques',
        free: 'Audio Libre: puedes escuchar varias pantallas al mismo tiempo'
      };
      window.showToast(msgs[state.proPrefs.audioMode], 'info');
    }
  }

  function setAutoMode(mode) {
    state.proPrefs.autoMode = ['lane', 'sync', 'off'].includes(mode) ? mode : 'lane';
    saveProPrefs();
    refreshAllVideoLoops();
    syncProControlsUI();
    if (typeof window.showToast === 'function') {
      const msgs = {
        lane: 'Auto Por pantalla: cada video avanza solo si su botón Auto está activo',
        sync: 'Auto Sincronizado: las pantallas cortas esperan a la más larga y cambian todas juntas',
        off: 'Auto Off: todos los clips repiten en bucle hasta que cambies manualmente'
      };
      window.showToast(msgs[state.proPrefs.autoMode], 'info');
    }
  }

  function applyProPreset(preset) {
    if (preset === 'sync') {
      state.proPrefs.navMode = 'sync';
      state.proPrefs.audioMode = 'follow';
      state.proPrefs.autoMode = 'sync';
      if (state.globalWantAudio) setLaneMuted(getActiveLane(), false, true);
    } else if (preset === 'free') {
      state.proPrefs.navMode = 'focused';
      state.proPrefs.audioMode = 'free';
      state.proPrefs.autoMode = 'lane';
    } else {
      state.proPrefs.navMode = 'focused';
      state.proPrefs.audioMode = 'solo';
      state.proPrefs.autoMode = 'lane';
    }
    saveProPrefs();
    refreshAllVideoLoops();
    syncProControlsUI();
    if (typeof window.showToast === 'function') {
      const labels = {
        smart: '🧠 Perfil Smart activado (Nav individual · Audio en 1 pantalla)',
        sync: '🔗 Perfil Sync Total activado (bajan y esperan juntas al acabar)',
        free: '🎛️ Perfil Todo Libre activado (cada pantalla 100% independiente)'
      };
      window.showToast(labels[preset] || 'Perfil aplicado', 'success');
    }
  }

  function toggleProPopover(force) {
    const pop = document.getElementById('tt-pro-popover');
    if (!pop) return;
    const next = typeof force === 'boolean' ? force : pop.classList.contains('hidden');
    state.proMenuOpen = next;
    pop.classList.toggle('hidden', !next);
    const btn = document.getElementById('tt-pro-menu-btn');
    if (btn) btn.classList.toggle('is-sync', next);
  }

  function closeProPopover() {
    toggleProPopover(false);
  }

  function renderFavsGrid(itemsList) {
    const grid = document.getElementById('tt-favs-grid');
    const emptyEl = document.getElementById('tt-favs-empty');
    const playAllBtn = document.getElementById('tt-favs-play-all');
    if (!grid) return;

    const list = Array.isArray(itemsList) ? itemsList : [];
    syncFavsUIAll();
    if (playAllBtn) playAllBtn.classList.toggle('hidden', list.length === 0);
    if (list.length === 0) {
      grid.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    grid.innerHTML = list.map((it) => `
      <div class="tt-fav-card group" data-tt-fav-play="${esc(it.id)}">
        ${it.cover_url ? `<img src="${esc(it.cover_url)}" alt="" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" loading="eager" draggable="false" />` : '<div class="w-full h-full bg-gradient-to-br from-pink-950/60 to-purple-950/70"></div>'}
        <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent pointer-events-none"></div>
        <button type="button" class="tt-fav-del" data-tt-fav-del="${esc(it.id)}" title="Quitar de Favoritos">
          <i class="fa-solid fa-trash-can"></i>
        </button>
        <div class="absolute inset-x-0 bottom-0 p-2.5 pointer-events-none">
          <p class="text-[11px] font-bold text-white line-clamp-2 leading-snug drop-shadow">${esc(it.title || 'Clip')}</p>
        </div>
      </div>
    `).join('');
  }

  async function openFavoritesModal() {
    const auth = getAuthContext();
    if (!auth.authed) {
      promptVipLogin('Inicia sesión con tu cuenta VIP para ver tus favoritos');
      return;
    }
    if (!auth.canSave) {
      promptVipLogin('Activa tu cuenta VIP para acceder a tus shorts favoritos');
      return;
    }

    closeProPopover();
    const modal = document.getElementById('tt-favs-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    await loadAccountFavorites(true);
    renderFavsGrid(state.favs);

    const ids = state.favs.map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 60);
    if (ids.length === 0) return;

    try {
      const res = await fetch('/api/shorts/batch?ids=' + ids.join(','), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const fresh = Array.isArray(data.items) ? data.items : [];
      if (fresh.length === 0) return;
      const freshById = new Map(fresh.map((x) => [String(x.id), x]));
      state.favs = state.favs.map((old) => {
        const f = freshById.get(String(old.id));
        return f ? { ...old, ...f, savedAt: old.savedAt || Date.now() } : old;
      });
      writeScopedFavCache(auth.uid, state.favs);
      if (!modal.classList.contains('hidden')) {
        renderFavsGrid(state.favs);
      }
    } catch (e) {}
  }

  function closeFavoritesModal() {
    const modal = document.getElementById('tt-favs-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function loadResolvedFavItems(startId = null) {
    const auth = getAuthContext();
    if (!auth.canSave) {
      promptVipLogin('Solo cuentas VIP activas pueden reproducir su lista de favoritos');
      return null;
    }
    if (state.favs.length === 0) {
      await loadAccountFavorites(true);
    }
    const ids = state.favs.map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 60);
    if (startId && !ids.includes(Number(startId))) {
      const numStart = Number(startId);
      if (Number.isFinite(numStart) && numStart > 0) ids.unshift(numStart);
    }
    if (ids.length === 0) {
      if (typeof window.showToast === 'function') window.showToast('Aún no tienes shorts guardados en tu cuenta', 'info');
      return null;
    }

    const res = await fetch('/api/shorts/batch?ids=' + ids.join(','), { cache: 'no-store' });
    const data = res.ok ? await res.json() : { items: [] };
    const items = Array.isArray(data.items) && data.items.length > 0 ? data.items : [];
    if (items.length === 0) {
      if (typeof window.showToast === 'function') window.showToast('No se pudieron cargar tus favoritos ahorita', 'error');
      return null;
    }
    return items;
  }

  async function launchFavoritesInLane(lane, startId = null, shuffle = false) {
    const targetLane = lane || getActiveLane();
    const loaderEl = document.getElementById('tiktok-feed-loader');
    closeFavoritesModal();
    if (loaderEl && targetLane.index === 0) loaderEl.classList.remove('hidden');

    try {
      const items = await loadResolvedFavItems(startId);
      if (!items) return;

      let ordered = items.slice();
      if (shuffle) {
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
      }

      targetLane.feedMode = 'favorites';
      targetLane.q = '';
      syncTopModeChips();
      unloadLaneVideos(targetLane);
      targetLane.slides = ordered;
      targetLane.activeIndex = 0;
      targetLane.consecSkips = 0;
      targetLane.cycleDone = false;
      if (targetLane.trackEl) targetLane.trackEl.innerHTML = '';

      const emptyEl = document.getElementById('tiktok-empty-state');
      if (emptyEl) emptyEl.classList.add('hidden');

      appendLaneSlideElements(targetLane, ordered, 0);
      let startIdx = 0;
      if (startId != null) {
        const found = ordered.findIndex((x) => String(x.id) === String(startId));
        if (found >= 0) startIdx = found;
      }
      goToLaneSlide(targetLane, startIdx, true);
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('Error cargando Favoritos', 'error');
    } finally {
      if (loaderEl && targetLane.index === 0) loaderEl.classList.add('hidden');
    }
  }

  async function spreadFavoritesAcrossLanes() {
    const items = await loadResolvedFavItems(null);
    if (!items || items.length === 0) return;
    closeFavoritesModal();

    const pool = items.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      if (lane.locked) continue;
      // Rotar el orden para que cada pantalla arranque con un favorito distinto
      const rotated = pool.map((_, idx) => pool[(idx + k) % pool.length]);
      lane.feedMode = 'favorites';
      lane.q = '';
      unloadLaneVideos(lane);
      lane.slides = rotated;
      lane.activeIndex = 0;
      lane.consecSkips = 0;
      lane.cycleDone = false;
      if (lane.trackEl) lane.trackEl.innerHTML = '';
      appendLaneSlideElements(lane, rotated, 0);
      goToLaneSlide(lane, 0, true);
    }
    syncTopModeChips();
    if (typeof window.showToast === 'function') {
      window.showToast('❤️ Favoritos repartidos en tus pantallas activas', 'success');
    }
  }

  function exitFavoritesMode(lane = null) {
    if (lane) {
      lane.feedMode = 'random';
      syncTopModeChips();
      fetchLaneBatch(lane, true);
      return;
    }
    for (let k = 0; k < state.effectiveLanes; k++) {
      const l = state.lanes[k];
      if (l.feedMode === 'favorites') {
        l.feedMode = 'random';
        fetchLaneBatch(l, true);
      }
    }
    syncTopModeChips();
  }

  function setupLaneObserver(lane) {
    if (!lane || !lane.trackEl || lane.observer) return;

    lane.observer = new IntersectionObserver(
      (entries) => {
        if (!state.mounted || lane.index >= state.effectiveLanes) return;
        let best = null;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            if (!best || entry.intersectionRatio > best.intersectionRatio) {
              best = entry;
            }
          }
        }
        if (best) {
          const idx = Number(best.target.dataset.idx);
          if (!Number.isNaN(idx) && idx !== lane.activeIndex) {
            activateLaneSlide(lane, idx);
          }
        }
      },
      { root: lane.trackEl, threshold: [0.6, 0.85] }
    );
  }

  function applyFilterAndReload({ category, q }) {
    if (category !== undefined) state.category = category || 'all';
    if (q !== undefined) state.q = String(q || '').trim();
    const sIn = document.getElementById('search-input');
    if (sIn) sIn.value = state.q;
    const cBtn = document.getElementById('clear-search-btn');
    if (cBtn) cBtn.classList.toggle('hidden', !state.q);

    for (let k = 0; k < state.effectiveLanes; k++) {
      const lane = state.lanes[k];
      if (lane.locked && state.effectiveLanes >= 2) continue;
      lane.feedMode = 'random';
      lane.q = '';
      fetchLaneBatch(lane, true);
    }
    syncTopModeChips();
  }

  function bindEvents() {
    const root = document.getElementById('tiktok-feed-view');
    if (!root || root.dataset.ttBound === '1') return;
    root.dataset.ttBound = '1';

    let lastTapAt = 0;
    let tapTimer = null;
    let resizeRaf = 0;

    window.addEventListener('resize', () => {
      if (!state.mounted || resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        applyViewportLaneLayout();
      });
    }, { passive: true });

    window.addEventListener('velvet:auth-changed', () => {
      loadAccountFavorites(true);
    });

    for (let k = 0; k < MAX_LANES; k++) {
      const lane = state.lanes[k];
      if (!lane.trackEl) continue;

      lane.trackEl.addEventListener('scroll', () => {
        if (!state.mounted || lane.loading || lane.feedMode === 'favorites' || lane.slides.length === 0 || lane.index >= state.effectiveLanes) return;
        const remainingPx = lane.trackEl.scrollHeight - (lane.trackEl.scrollTop + lane.trackEl.clientHeight);
        if (remainingPx < lane.trackEl.clientHeight * 3.5) {
          fetchLaneBatch(lane, false);
        }
      }, { passive: true });

      lane.trackEl.addEventListener('pointerdown', () => {
        if (state.mounted && lane.index < state.effectiveLanes) setFocusedLane(lane.index);
      }, { passive: true });
    }

    const stageEl = document.getElementById('tt-lanes-stage');
    if (stageEl) {
      stageEl.addEventListener('wheel', (e) => {
        if (!state.mounted || state.effectiveLanes < 2) return;
        if (state.proPrefs.navMode !== 'sync' && !e.shiftKey) return;
        if (Math.abs(e.deltaY) < 12) return;
        e.preventDefault();
        const now = Date.now();
        if (now - state.lastSyncWheelAt < 360) return;
        state.lastSyncWheelAt = now;
        stepAllUnlocked(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
    }

    root.addEventListener('click', (e) => {
      // Cerrar popover Pro si hace clic fuera
      const pop = document.getElementById('tt-pro-popover');
      if (state.proMenuOpen && pop && !e.target.closest('#tt-pro-popover') && !e.target.closest('[data-tt-action="toggle-pro-menu"]')) {
        closeProPopover();
      }

      const presetBtn = e.target.closest('[data-tt-preset]');
      if (presetBtn) {
        applyProPreset(presetBtn.dataset.ttPreset);
        return;
      }

      const navOpt = e.target.closest('[data-tt-set-nav]');
      if (navOpt) {
        setNavMode(navOpt.dataset.ttSetNav);
        return;
      }

      const audioOpt = e.target.closest('[data-tt-set-audio]');
      if (audioOpt) {
        setAudioMode(audioOpt.dataset.ttSetAudio);
        return;
      }

      const autoOpt = e.target.closest('[data-tt-set-auto]');
      if (autoOpt) {
        setAutoMode(autoOpt.dataset.ttSetAuto);
        return;
      }

      const laneAct = e.target.closest('[data-tt-lane-action]');
      if (laneAct) {
        const lIdx = Number(laneAct.dataset.lane);
        const lane = state.lanes[lIdx];
        const lAct = laneAct.dataset.ttLaneAction;
        if (!lane) return;
        setFocusedLane(lIdx);
        if (lAct === 'focus') {
          return;
        } else if (lAct === 'lock') {
          toggleLaneLock(lIdx);
          return;
        } else if (lAct === 'prev') {
          goToLaneSlide(lane, lane.activeIndex - 1);
          return;
        } else if (lAct === 'next') {
          goToLaneSlide(lane, lane.activeIndex + 1);
          return;
        } else if (lAct === 'source') {
          if (lane.feedMode === 'favorites') {
            exitFavoritesMode(lane);
          } else if (lane.q) {
            lane.q = '';
            syncTopModeChips();
            fetchLaneBatch(lane, true);
          } else {
            const auth = getAuthContext();
            if (!auth.canSave) {
              promptVipLogin('Inicia sesión VIP para reproducir tus Shorts Favoritos');
              return;
            }
            if (state.favs.length === 0) {
              openFavoritesModal();
            } else {
              launchFavoritesInLane(lane, null, true);
            }
          }
          return;
        }
      }

      const delBtn = e.target.closest('[data-tt-fav-del]');
      if (delBtn) {
        e.stopPropagation();
        toggleHeartItem({ id: delBtn.dataset.ttFavDel });
        return;
      }

      const playCard = e.target.closest('[data-tt-fav-play]');
      if (playCard) {
        launchFavoritesInLane(getActiveLane(), playCard.dataset.ttFavPlay, false);
        return;
      }

      const tagBtn = e.target.closest('[data-tt-tag]');
      if (tagBtn) {
        const slide = tagBtn.closest('.tt-slide');
        const laneIdx = slide ? Number(slide.dataset.lane) : state.focusedLane;
        const lane = state.lanes[laneIdx] || getActiveLane();
        const tag = tagBtn.dataset.ttTag || '';
        if (state.effectiveLanes >= 2 && state.proPrefs.navMode !== 'sync') {
          setFocusedLane(lane.index);
          lane.feedMode = 'random';
          lane.q = tag;
          syncTopModeChips();
          fetchLaneBatch(lane, true);
          if (typeof window.showToast === 'function') {
            window.showToast(`Pantalla #${lane.index + 1} filtrada por #${tag}`, 'info');
          }
        } else {
          applyFilterAndReload({ category: 'all', q: tag });
        }
        return;
      }

      const actEl = e.target.closest('[data-tt-action]');
      if (!actEl) return;
      const action = actEl.dataset.ttAction;

      if (action === 'set-lanes') {
        setRequestedLanes(Number(actEl.dataset.ttLanes));
        return;
      } else if (action === 'cycle-nav') {
        setNavMode(state.proPrefs.navMode === 'sync' ? 'focused' : 'sync');
        return;
      } else if (action === 'cycle-audio') {
        const order = ['solo', 'follow', 'free'];
        const next = order[(order.indexOf(state.proPrefs.audioMode) + 1) % order.length];
        setAudioMode(next);
        return;
      } else if (action === 'cycle-auto') {
        const order = ['lane', 'sync', 'off'];
        const next = order[(order.indexOf(state.proPrefs.autoMode) + 1) % order.length];
        setAutoMode(next);
        return;
      } else if (action === 'shuffle-all') {
        shuffleUnlockedLanes();
        return;
      } else if (action === 'toggle-pro-menu') {
        toggleProPopover();
        return;
      } else if (action === 'close-pro-menu') {
        closeProPopover();
        return;
      } else if (action === 'toggle-pause-all') {
        togglePauseAllLanes();
        return;
      } else if (action === 'mute-all') {
        muteAllLanes();
        return;
      } else if (action === 'unlock-all') {
        state.lanes.forEach((l) => { l.locked = false; });
        syncAllLaneHeaders();
        if (typeof window.showToast === 'function') window.showToast('🔓 Todas las pantallas desbloqueadas', 'info');
        return;
      }

      const slide = actEl.closest('.tt-slide');
      const laneIdx = slide ? Number(slide.dataset.lane) : state.focusedLane;
      const lane = state.lanes[laneIdx] || getActiveLane();
      if (slide) setFocusedLane(lane.index);
      const idx = slide ? Number(slide.dataset.idx) : lane.activeIndex;
      const item = lane.slides[idx];

      if (action === 'toggle-play' && slide) {
        const now = Date.now();
        if (now - lastTapAt < 260) {
          clearTimeout(tapTimer);
          lastTapAt = 0;
          if (item && (!getAuthContext().canSave || !state.likes.has(String(item.id)))) {
            toggleHeartItem(item);
          }
          return;
        }
        lastTapAt = now;
        tapTimer = setTimeout(() => {
          toggleLanePlayPause(lane);
        }, 230);
      } else if (action === 'like' && item) {
        toggleHeartItem(item);
      } else if (action === 'mute') {
        setLaneMuted(lane, !lane.muted);
      } else if (action === 'autonext') {
        lane.autoNext = !lane.autoNext;
        if (state.proPrefs.autoMode === 'off') {
          state.proPrefs.autoMode = 'lane';
          saveProPrefs();
          syncProControlsUI();
        }
        syncLaneAutoIcons(lane);
      } else if (action === 'clean') {
        toggleCleanMode();
      } else if (action === 'open-favs') {
        openFavoritesModal();
      } else if (action === 'close-favs') {
        closeFavoritesModal();
      } else if (action === 'play-all-favs') {
        launchFavoritesInLane(getActiveLane(), null, false);
      } else if (action === 'spread-favs') {
        spreadFavoritesAcrossLanes();
      } else if (action === 'exit-favs-mode') {
        exitFavoritesMode(null);
      } else if (action === 'copy' && item) {
        const shareUrl = item.share_id
          ? `${window.location.origin}/?c=${encodeURIComponent(item.share_id)}`
          : window.location.origin;
        navigator.clipboard?.writeText(shareUrl).then(() => {
          if (typeof window.showToast === 'function') window.showToast('Enlace de Morbo Hub copiado', 'success');
        }).catch(() => {});
      } else if (action === 'prev') {
        if (state.effectiveLanes >= 2 && state.proPrefs.navMode === 'sync') {
          stepAllUnlocked(-1);
        } else {
          goToLaneSlide(lane, lane.activeIndex - 1);
        }
      } else if (action === 'next') {
        if (state.effectiveLanes >= 2 && state.proPrefs.navMode === 'sync') {
          stepAllUnlocked(1);
        } else {
          goToLaneSlide(lane, lane.activeIndex + 1);
        }
      } else if (action === 'seek' && slide) {
        const vid = slide.querySelector('.tt-video');
        if (!vid || !vid.duration) return;
        const rect = actEl.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        vid.currentTime = ratio * vid.duration;
      } else if (action === 'clear-search') {
        applyFilterAndReload({ category: 'all', q: '' });
      }
    });
  }

  window.VelvetTikTokFeed = {
    mount() {
      loadProPrefs();
      bindLaneDomRefs();
      state.mounted = true;
      document.body.classList.add('tiktok-home-active');
      bindEvents();
      syncCleanModeUI();
      loadAccountFavorites(false);
      applyViewportLaneLayout();
    },
    unmount() {
      state.mounted = false;
      state.cleanMode = false;
      closeProPopover();
      document.body.classList.remove('tiktok-home-active');
      document.body.classList.remove('tt-clean-mode');
      document.body.classList.remove('tt-multi-active');
      closeFavoritesModal();
      unloadAllVideos();
    },
    reshuffle() {
      for (let k = 0; k < state.effectiveLanes; k++) {
        const lane = state.lanes[k];
        if (lane.locked && state.effectiveLanes >= 2) continue;
        lane.feedMode = 'random';
        fetchLaneBatch(lane, true);
      }
      syncTopModeChips();
    },
    setLanes(count) {
      setRequestedLanes(count);
    },
    openFavorites() {
      openFavoritesModal();
    },
    playSavedShortId(shortId) {
      launchFavoritesInLane(getActiveLane(), shortId, false);
    },
    toggleCleanMode(force) {
      toggleCleanMode(force);
    },
    setFilter(opts = {}) {
      applyFilterAndReload({
        category: opts.category !== undefined ? opts.category : state.category,
        q: opts.q !== undefined ? opts.q : state.q
      });
    },
    handleKeydown(e) {
      if (!state.mounted) return false;
      const modal = document.getElementById('tt-favs-modal');
      const modalOpen = modal && !modal.classList.contains('hidden');
      const kLow = String(e.key || '').toLowerCase();

      if (e.key === 'Escape') {
        if (state.proMenuOpen) {
          e.preventDefault();
          closeProPopover();
          return true;
        }
        if (modalOpen) {
          e.preventDefault();
          closeFavoritesModal();
          return true;
        }
        if (state.cleanMode) {
          e.preventDefault();
          toggleCleanMode(false);
          return true;
        }
      }

      if (modalOpen) return false;

      if (kLow === 'h') {
        e.preventDefault();
        toggleCleanMode();
        return true;
      }

      if (state.effectiveLanes >= 2 && (e.key === '1' || e.key === '2' || e.key === '3')) {
        const target = Number(e.key) - 1;
        if (target < state.effectiveLanes) {
          e.preventDefault();
          setFocusedLane(target);
          return true;
        }
      }

      if (state.effectiveLanes >= 2 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        setFocusedLane((state.focusedLane + dir + state.effectiveLanes) % state.effectiveLanes);
        return true;
      }

      if (e.key === 'ArrowDown' || kLow === 'j') {
        e.preventDefault();
        if (state.effectiveLanes >= 2 && (state.proPrefs.navMode === 'sync' || e.shiftKey)) {
          stepAllUnlocked(1);
        } else {
          const lane = getActiveLane();
          goToLaneSlide(lane, lane.activeIndex + 1);
        }
        return true;
      }

      if (e.key === 'ArrowUp' || kLow === 'k') {
        e.preventDefault();
        if (state.effectiveLanes >= 2 && (state.proPrefs.navMode === 'sync' || e.shiftKey)) {
          stepAllUnlocked(-1);
        } else {
          const lane = getActiveLane();
          goToLaneSlide(lane, lane.activeIndex - 1);
        }
        return true;
      }

      if (e.key === ' ') {
        e.preventDefault();
        if (state.effectiveLanes >= 2 && e.shiftKey) {
          togglePauseAllLanes();
        } else {
          toggleLanePlayPause(getActiveLane());
        }
        return true;
      }

      if (kLow === 'm') {
        e.preventDefault();
        if (state.effectiveLanes >= 2 && e.shiftKey) {
          muteAllLanes();
        } else {
          const lane = getActiveLane();
          setLaneMuted(lane, !lane.muted);
        }
        return true;
      }

      if (kLow === 'l' && state.effectiveLanes >= 2) {
        e.preventDefault();
        toggleLaneLock(state.focusedLane);
        return true;
      }

      if (kLow === 'r' && state.effectiveLanes >= 2) {
        e.preventDefault();
        shuffleUnlockedLanes();
        return true;
      }

      return false;
    },
    onAgeConfirmed() {
      if (!state.mounted) return;
      for (let k = 0; k < state.effectiveLanes; k++) {
        syncLaneVideoWindow(state.lanes[k], state.lanes[k].activeIndex);
      }
    }
  };
})(window, document);
