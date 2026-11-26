/**
 * MORBO HUB — MOTOR TIKTOK STEALTH + FAVORITOS VIP EN CUENTA + PANTALLA LIMPIA (v4.1)
 * - Ajuste automático limpio sin recorte.
 * - Corazón ♥ y Favoritos EXCLUSIVOS para usuarios logueados VIP (guardado en nube de su cuenta).
 * - Si un invitado o cuenta sin acceso intenta guardar/ver Favoritos, abre el login VIP.
 * - Modo "Limpiar" (Pantalla Limpia) con botón visible y táctil "Mostrar controles" para PC y Android.
 */
(function (window, document) {
  'use strict';

  const MUTE_KEY = 'velvet_shorts_muted_v1';
  const AUTO_NEXT_KEY = 'velvet_shorts_autonext_v1';
  const USER_CACHE_PREFIX = 'velvet_shorts_user_favs_v1_';

  const state = {
    mounted: false,
    slides: [],
    activeIndex: 0,
    loading: false,
    category: 'all',
    q: '',
    feedMode: 'random', // 'random' | 'favorites'
    cleanMode: false,
    muted: true,
    autoNext: false,
    seenIds: [],
    likes: new Set(),
    favs: [],
    loadedUid: '',
    consecSkips: 0,
    observer: null,
    nextTimer: 0
  };

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

  function loadLocalPlayerPrefs() {
    try {
      const m = localStorage.getItem(MUTE_KEY);
      state.muted = m === null ? true : m === '1';
    } catch (e) { state.muted = true; }
    try {
      state.autoNext = localStorage.getItem(AUTO_NEXT_KEY) === '1';
    } catch (e) { state.autoNext = false; }
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
      return Array.isArray(raw) ? raw.filter(x => x && x.id != null) : [];
    } catch (e) {
      return [];
    }
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

    document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach((s) => {
      const idx = Number(s.dataset.idx);
      const sItem = state.slides[idx];
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

  async function loadAccountFavorites(forceServer = false) {
    const auth = getAuthContext();
    if (!auth.canSave || !auth.uid) {
      state.loadedUid = '';
      state.favs = [];
      state.likes = new Set();
      if (state.feedMode === 'favorites') {
        state.feedMode = 'random';
        syncTopModeChips();
        fetchRandomBatch(true);
      }
      closeFavoritesModal();
      syncFavsUIAll();
      return [];
    }

    if (state.loadedUid !== auth.uid) {
      state.loadedUid = auth.uid;
      const cached = readScopedFavCache(auth.uid);
      state.favs = cached;
      state.likes = new Set(cached.map(x => String(x.id)));
      syncFavsUIAll();
    } else if (!forceServer) {
      syncFavsUIAll();
    }

    const pData = window.VelvetPersonalData;
    if (!pData || typeof pData.fetchAuthed !== 'function') return state.favs;

    try {
      const res = await pData.fetchAuthed('/api/user/favorites?type=short&page=1&pageSize=100');
      if (!res || !res.ok) return state.favs;
      const data = await res.json().catch(() => null);
      if (!data || data.degraded || !Array.isArray(data.items)) return state.favs;

      const latestAuth = getAuthContext();
      if (!latestAuth.canSave || latestAuth.uid !== auth.uid) return state.favs;

      const serverList = data.items
        .filter(x => x && (x.media_type === 'short' || String(x.source || '').toLowerCase() === 'short'))
        .map(normalizeShortFavRecord)
        .filter(Boolean);

      state.favs = serverList;
      state.likes = new Set(serverList.map(x => String(x.id)));
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

  function applyStageGeometry(slide) {
    if (!slide) return;
    const stage = slide.querySelector('.tt-stage');
    const vid = slide.querySelector('.tt-video');
    if (!stage || !vid) return;

    const vw = vid.videoWidth || 0;
    const vh = vid.videoHeight || 0;
    if (!vw || !vh) {
      stage.style.width = '';
      return;
    }

    if (window.innerWidth >= 1024) {
      const viewEl = document.getElementById('tiktok-feed-view');
      const vPad = state.cleanMode ? 8 : 16;
      const availH = Math.max(360, ((viewEl && viewEl.clientHeight) || (window.innerHeight - (state.cleanMode ? 0 : 64))) - vPad);
      const maxW = Math.min(window.innerWidth * (state.cleanMode ? 0.94 : 0.88), 1280);
      const idealW = Math.round(availH * (vw / vh));
      const finalW = Math.max(360, Math.min(maxW, idealW));
      stage.style.width = `${finalW}px`;
    } else {
      stage.style.width = '';
    }
  }

  function syncTopModeChips() {
    const statusChip = document.getElementById('tt-search-chip');
    const statusTxt = document.getElementById('tt-search-chip-label');
    if (statusChip && statusTxt) {
      if (state.q && state.feedMode !== 'favorites') {
        statusTxt.textContent = state.q;
        statusChip.classList.remove('hidden');
      } else {
        statusChip.classList.add('hidden');
      }
    }
    const favModeChip = document.getElementById('tt-favs-mode-chip');
    if (favModeChip) {
      favModeChip.classList.toggle('hidden', state.feedMode !== 'favorites');
    }
    syncFavsUIAll();
  }

  function syncCleanModeUI() {
    document.body.classList.toggle('tt-clean-mode', state.cleanMode);
    document.querySelectorAll('#tiktok-snap-track [data-tt-action="clean"]').forEach((btn) => {
      btn.classList.toggle('is-on', state.cleanMode);
      const txt = btn.querySelector('.tt-rail-txt');
      if (txt) txt.textContent = state.cleanMode ? 'Ver UI' : 'Limpiar';
    });
    const refreshGeo = () => {
      document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach(applyStageGeometry);
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
      state.favs = state.favs.filter(f => String(f.id) !== cleanSid);
      if (typeof window.showToast === 'function') {
        window.showToast('Quitado de Tus Favoritos', 'info');
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
      state.favs = [record, ...state.favs.filter(f => String(f.id) !== cleanSid)].slice(0, 500);
      if (typeof window.showToast === 'function') {
        window.showToast('Guardado en los Favoritos de tu cuenta ♥', 'success');
      }
    }

    writeScopedFavCache(auth.uid, state.favs);
    syncFavsUIAll();
    const modal = document.getElementById('tt-favs-modal');
    if (modal && !modal.classList.contains('hidden')) {
      renderFavsGrid(state.favs);
    }

    if (pData) {
      try {
        let ok = false;
        if (exists && typeof pData.removeFavorite === 'function') {
          const rm = await pData.removeFavorite({ id: `short:${cleanSid}`, item_id: cleanSid, source: 'short', source_id: cleanSid });
          ok = Boolean(rm);
        } else if (!exists && typeof pData.addFavorite === 'function') {
          ok = await pData.addFavorite({
            id: `short:${cleanSid}`,
            item_id: cleanSid,
            source: 'short',
            source_id: cleanSid,
            media_type: 'short',
            title: item.title || 'Short guardado',
            cover_url: item.cover_url || '',
            url: ''
          });
        }
        if (!ok) {
          throw new Error('sync_failed');
        }
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

  async function fetchRandomBatch(reset = false) {
    if (state.feedMode === 'favorites') return;
    if (state.loading) return;
    state.loading = true;

    const loaderEl = document.getElementById('tiktok-feed-loader');
    if (reset && loaderEl) loaderEl.classList.remove('hidden');

    try {
      let data = null;
      const canUsePrefetch = reset && !state.q && (!state.category || state.category === 'all') && window.__ttInitialBatchPromise;
      if (canUsePrefetch) {
        const pre = window.__ttInitialBatchPromise;
        window.__ttInitialBatchPromise = null;
        data = await pre.catch(() => null);
      }

      if (!data) {
        const excludeSlice = reset ? '' : state.seenIds.slice(-360).join(',');
        const clipToken = reset ? (new URLSearchParams(window.location.search).get('c') || '') : '';
        const params = new URLSearchParams({
          limit: '12',
          category: state.category || 'all',
          q: state.q || '',
          exclude: excludeSlice,
          _: String(Date.now()) + '_' + Math.random().toString(36).slice(2, 7)
        });
        if (clipToken && !state.q) params.set('clip', clipToken);

        const res = await fetch('/api/shorts/random?' + params.toString(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      }
      const incoming = Array.isArray(data.items) ? data.items : [];

      if (reset) {
        unloadAllVideos();
        state.slides = [];
        state.activeIndex = 0;
        state.consecSkips = 0;
        const track = document.getElementById('tiktok-snap-track');
        if (track) track.innerHTML = '';
      }

      const emptyEl = document.getElementById('tiktok-empty-state');
      if (incoming.length === 0 && state.slides.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }
      if (emptyEl) emptyEl.classList.add('hidden');

      const startIdx = state.slides.length;
      state.slides.push(...incoming);
      incoming.forEach((it) => {
        if (it.id != null) state.seenIds.push(String(it.id));
      });
      if (state.seenIds.length > 600) {
        state.seenIds = state.seenIds.slice(-400);
      }

      appendSlideElements(incoming, startIdx);
      if (reset) {
        const track = document.getElementById('tiktok-snap-track');
        if (track) track.scrollTop = 0;
        activateSlide(0);
      } else {
        syncVideoWindow(state.activeIndex);
      }
    } catch (err) {
      console.warn('[TikTokFeed] Error cargando aleatorios:', err);
    } finally {
      state.loading = false;
      if (loaderEl) loaderEl.classList.add('hidden');
    }
  }

  function createSlideElement(item, idx) {
    const slide = document.createElement('article');
    slide.className = 'tt-slide';
    slide.dataset.idx = String(idx);

    const auth = getAuthContext();
    const isLiked = auth.canSave && state.likes.has(String(item.id));
    const tagsHtml = (item.tags || []).slice(0, 5).map((t) =>
      `<button type="button" data-tt-tag="${esc(t)}" class="tt-tag-chip">#${esc(t)}</button>`
    ).join('');
    const artist = (item.artists && item.artists[0]) ? `@${esc(item.artists[0])}` : '';

    slide.innerHTML = `
      <div class="tt-stage">
        ${item.cover_url ? `<img class="tt-poster" src="${esc(item.cover_url)}" alt="" loading="eager" decoding="async" draggable="false" />` : ''}
        <video class="tt-video" playsinline controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture disableRemotePlayback oncontextmenu="return false;" loop preload="none" ${state.muted ? 'muted' : ''}></video>
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
          <button type="button" class="tt-rail-btn ${isLiked ? 'is-liked' : ''}" data-tt-action="like" title="Guardar en Favoritos de tu cuenta VIP">
            <span class="tt-rail-ico"><i class="fa-solid fa-heart"></i></span>
            <span class="tt-rail-txt">${Number(item.likes || 0) + (isLiked ? 1 : 0)}</span>
          </button>
          <button type="button" class="tt-rail-btn" data-tt-action="mute" title="Sonido (M)">
            <span class="tt-rail-ico"><i class="fa-solid ${state.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></span>
            <span class="tt-rail-txt">${state.muted ? 'Mute' : 'Audio'}</span>
          </button>
          <button type="button" class="tt-rail-btn ${state.autoNext ? 'is-on' : ''}" data-tt-action="autonext" title="Pasar solo al terminar">
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
      const nextSlide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${myIdx + 1}"]`);
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
      if (myIdx !== state.activeIndex || !state.mounted) return;
      state.consecSkips = (state.consecSkips || 0) + 1;
      if (state.consecSkips <= 3 && myIdx + 1 < state.slides.length) {
        setTimeout(() => {
          if (state.mounted && state.activeIndex === myIdx) {
            goToSlide(myIdx + 1);
          }
        }, 200);
      }
    };

    vid.addEventListener('loadedmetadata', () => applyStageGeometry(slide));
    vid.addEventListener('loadeddata', () => {
      clearWatchdog();
      const myIdx = Number(slide.dataset.idx);
      if (myIdx === state.activeIndex) promoteNextSlide(myIdx);
    });
    vid.addEventListener('waiting', () => {
      if (Number(slide.dataset.idx) === state.activeIndex && spinner) spinner.classList.remove('hidden');
    });
    vid.addEventListener('playing', () => {
      clearWatchdog();
      state.consecSkips = 0;
      delete slide.dataset.dead;
      if (spinner) spinner.classList.add('hidden');
      if (poster) poster.classList.add('is-hidden');
      const myIdx = Number(slide.dataset.idx);
      if (myIdx === state.activeIndex) promoteNextSlide(myIdx);
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
      if (!vid.duration || Number(slide.dataset.idx) !== state.activeIndex) return;
      const pct = Math.min(100, (vid.currentTime / vid.duration) * 100);
      if (fill) fill.style.width = `${pct}%`;
      if (timeBadge) timeBadge.textContent = `${fmtTime(vid.currentTime)} / ${fmtTime(vid.duration)}`;
    });
    vid.addEventListener('ended', () => {
      if (state.autoNext && Number(slide.dataset.idx) === state.activeIndex) {
        if (state.activeIndex + 1 < state.slides.length) {
          goToSlide(state.activeIndex + 1);
        } else if (state.feedMode === 'favorites' && state.slides.length > 0) {
          goToSlide(0);
        }
      }
    });

    return slide;
  }

  function appendSlideElements(items, startIdx) {
    const track = document.getElementById('tiktok-snap-track');
    if (!track) return;

    const frag = document.createDocumentFragment();
    items.forEach((item, offset) => {
      const slide = createSlideElement(item, startIdx + offset);
      frag.appendChild(slide);
      if (state.observer) state.observer.observe(slide);
    });
    track.appendChild(frag);
  }

  function attachVideoSource(slide, item, preloadMode) {
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
    vid.muted = state.muted;
    vid.loop = !state.autoNext;
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

  function unloadAllVideos() {
    if (state.nextTimer) {
      clearTimeout(state.nextTimer);
      state.nextTimer = 0;
    }
    document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach(detachVideoSource);
  }

  function syncVideoWindow(activeIdx) {
    if (state.nextTimer) {
      clearTimeout(state.nextTimer);
      state.nextTimer = 0;
    }
    const slides = document.querySelectorAll('#tiktok-snap-track .tt-slide');
    slides.forEach((slide) => {
      const idx = Number(slide.dataset.idx);
      const item = state.slides[idx];
      if (!item) return;

      const poster = slide.querySelector('.tt-poster');
      if (poster && Math.abs(idx - activeIdx) <= 4) {
        if (!poster.getAttribute('src') && item.cover_url) {
          poster.setAttribute('src', item.cover_url);
        }
      } else if (poster && Math.abs(idx - activeIdx) > 5) {
        poster.removeAttribute('src');
      }

      if (idx === activeIdx) {
        if (slide.dataset.dead === '1' && (state.consecSkips || 0) <= 3 && activeIdx + 1 < state.slides.length) {
          setTimeout(() => { if (state.mounted && state.activeIndex === activeIdx) goToSlide(activeIdx + 1); }, 120);
          return;
        }
        attachVideoSource(slide, item, 'auto');
        applyStageGeometry(slide);
        const vid = slide.querySelector('.tt-video');
        if (vid && state.mounted) {
          vid.muted = state.muted;
          vid.loop = !state.autoNext;
          if (slide._ttWatchdog) clearTimeout(slide._ttWatchdog);
          if (vid.readyState < 2) {
            slide._ttWatchdog = setTimeout(() => {
              slide._ttWatchdog = 0;
              if (!state.mounted || state.activeIndex !== activeIdx || vid.readyState >= 2) return;
              slide.dataset.dead = '1';
              state.consecSkips = (state.consecSkips || 0) + 1;
              if (state.consecSkips <= 3 && activeIdx + 1 < state.slides.length) {
                goToSlide(activeIdx + 1);
              }
            }, 6500);
          }
          const p = vid.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              vid.muted = true;
              state.muted = true;
              syncMuteIcons();
              vid.play().catch(() => {});
            });
          }
        }
      } else if (idx === activeIdx + 1) {
        if (slide._ttWatchdog) { clearTimeout(slide._ttWatchdog); slide._ttWatchdog = 0; }
        attachVideoSource(slide, item, 'metadata');
        const vid = slide.querySelector('.tt-video');
        if (vid) vid.pause();
        state.nextTimer = setTimeout(() => {
          if (state.mounted && state.activeIndex === activeIdx && vid && vid.dataset.loadedSrc) {
            vid.preload = 'auto';
          }
        }, 250);
      } else if (idx === activeIdx + 2 || idx === activeIdx - 1) {
        if (slide._ttWatchdog) { clearTimeout(slide._ttWatchdog); slide._ttWatchdog = 0; }
        attachVideoSource(slide, item, 'metadata');
        const vid = slide.querySelector('.tt-video');
        if (vid) vid.pause();
      } else {
        detachVideoSource(slide);
      }
    });
  }

  function activateSlide(idx) {
    if (idx < 0 || idx >= state.slides.length) return;
    state.activeIndex = idx;
    updateAmbientBackdrop(state.slides[idx]);
    syncVideoWindow(idx);
    if (state.feedMode !== 'favorites' && idx >= state.slides.length - 6 && !state.loading) {
      fetchRandomBatch(false);
    }
  }

  function goToSlide(idx, instant = false) {
    let clamped = Math.max(0, Math.min(idx, state.slides.length - 1));
    while (clamped < state.slides.length - 1) {
      const cand = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${clamped}"]`);
      if (!cand || cand.dataset.dead !== '1') break;
      clamped++;
    }
    const slide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${clamped}"]`);
    if (slide) {
      slide.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
      if (instant) activateSlide(clamped);
    }
  }

  function syncMuteIcons() {
    try { localStorage.setItem(MUTE_KEY, state.muted ? '1' : '0'); } catch (e) {}
    document.querySelectorAll('#tiktok-snap-track [data-tt-action="mute"]').forEach((btn) => {
      const ico = btn.querySelector('i');
      const txt = btn.querySelector('.tt-rail-txt');
      if (ico) ico.className = `fa-solid ${state.muted ? 'fa-volume-xmark' : 'fa-volume-high'}`;
      if (txt) txt.textContent = state.muted ? 'Mute' : 'Audio';
    });
    const activeSlide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${state.activeIndex}"]`);
    const vid = activeSlide && activeSlide.querySelector('.tt-video');
    if (vid) vid.muted = state.muted;
  }

  function syncAutoNextIcons() {
    try { localStorage.setItem(AUTO_NEXT_KEY, state.autoNext ? '1' : '0'); } catch (e) {}
    document.querySelectorAll('#tiktok-snap-track [data-tt-action="autonext"]').forEach((btn) => {
      btn.classList.toggle('is-on', state.autoNext);
    });
    const activeSlide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${state.activeIndex}"]`);
    const vid = activeSlide && activeSlide.querySelector('.tt-video');
    if (vid) vid.loop = !state.autoNext;
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

    const modal = document.getElementById('tt-favs-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    await loadAccountFavorites(true);
    renderFavsGrid(state.favs);

    const ids = state.favs.map(x => Number(x.id)).filter(n => Number.isFinite(n) && n > 0).slice(0, 60);
    if (ids.length === 0) return;

    try {
      const res = await fetch('/api/shorts/batch?ids=' + ids.join(','), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const fresh = Array.isArray(data.items) ? data.items : [];
      if (fresh.length === 0) return;
      const freshById = new Map(fresh.map(x => [String(x.id), x]));
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

  async function launchFavoritesFeed(startId = null) {
    const auth = getAuthContext();
    if (!auth.canSave) {
      promptVipLogin('Solo cuentas VIP activas pueden reproducir su lista de favoritos');
      return;
    }
    if (state.favs.length === 0) {
      await loadAccountFavorites(true);
    }
    const ids = state.favs.map(x => Number(x.id)).filter(n => Number.isFinite(n) && n > 0).slice(0, 60);
    if (startId && !ids.includes(Number(startId))) {
      const numStart = Number(startId);
      if (Number.isFinite(numStart) && numStart > 0) ids.unshift(numStart);
    }
    if (ids.length === 0) {
      if (typeof window.showToast === 'function') window.showToast('Aún no tienes shorts guardados en tu cuenta', 'info');
      return;
    }

    closeFavoritesModal();
    const loaderEl = document.getElementById('tiktok-feed-loader');
    if (loaderEl) loaderEl.classList.remove('hidden');

    try {
      const res = await fetch('/api/shorts/batch?ids=' + ids.join(','), { cache: 'no-store' });
      const data = res.ok ? await res.json() : { items: [] };
      const items = Array.isArray(data.items) && data.items.length > 0 ? data.items : [];
      if (items.length === 0) {
        if (typeof window.showToast === 'function') window.showToast('No se pudieron cargar tus favoritos ahorita', 'error');
        return;
      }

      state.feedMode = 'favorites';
      syncTopModeChips();
      unloadAllVideos();
      state.slides = items;
      state.activeIndex = 0;
      state.consecSkips = 0;
      const track = document.getElementById('tiktok-snap-track');
      if (track) track.innerHTML = '';

      const emptyEl = document.getElementById('tiktok-empty-state');
      if (emptyEl) emptyEl.classList.add('hidden');

      appendSlideElements(items, 0);
      let startIdx = 0;
      if (startId != null) {
        const found = items.findIndex(x => String(x.id) === String(startId));
        if (found >= 0) startIdx = found;
      }
      goToSlide(startIdx, true);
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('Error cargando Favoritos', 'error');
    } finally {
      if (loaderEl) loaderEl.classList.add('hidden');
    }
  }

  function exitFavoritesMode() {
    state.feedMode = 'random';
    syncTopModeChips();
    fetchRandomBatch(true);
  }

  function setupObserver() {
    const track = document.getElementById('tiktok-snap-track');
    if (!track || state.observer) return;

    state.observer = new IntersectionObserver(
      (entries) => {
        if (!state.mounted) return;
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
          if (!Number.isNaN(idx) && idx !== state.activeIndex) {
            activateSlide(idx);
          }
        }
      },
      { root: track, threshold: [0.6, 0.85] }
    );
  }

  function applyFilterAndReload({ category, q }) {
    state.feedMode = 'random';
    if (category !== undefined) state.category = category || 'all';
    if (q !== undefined) state.q = String(q || '').trim();
    const sIn = document.getElementById('search-input');
    if (sIn) sIn.value = state.q;
    const cBtn = document.getElementById('clear-search-btn');
    if (cBtn) cBtn.classList.toggle('hidden', !state.q);
    syncTopModeChips();
    fetchRandomBatch(true);
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
        document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach(applyStageGeometry);
      });
    }, { passive: true });

    window.addEventListener('velvet:auth-changed', () => {
      loadAccountFavorites(true);
    });

    window.addEventListener('velvet:favorites-updated', () => {
      const auth = getAuthContext();
      if (!auth.canSave) {
        syncFavsUIAll();
        return;
      }
      const pData = window.VelvetPersonalData;
      if (!pData || typeof pData.getFavorites !== 'function') return;
      const list = pData.getFavorites() || [];
      if (Array.isArray(list) && list.some(x => x && (x.media_type === 'short' || x.source === 'short'))) {
        loadAccountFavorites(true);
      }
    });

    const trackEl = document.getElementById('tiktok-snap-track');
    if (trackEl) {
      trackEl.addEventListener('scroll', () => {
        if (!state.mounted || state.loading || state.feedMode === 'favorites' || state.slides.length === 0) return;
        const remainingPx = trackEl.scrollHeight - (trackEl.scrollTop + trackEl.clientHeight);
        if (remainingPx < trackEl.clientHeight * 3.5) {
          fetchRandomBatch(false);
        }
      }, { passive: true });
    }

    root.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-tt-fav-del]');
      if (delBtn) {
        e.stopPropagation();
        const delId = delBtn.dataset.ttFavDel;
        toggleHeartItem({ id: delId });
        return;
      }

      const playCard = e.target.closest('[data-tt-fav-play]');
      if (playCard) {
        launchFavoritesFeed(playCard.dataset.ttFavPlay);
        return;
      }

      const tagBtn = e.target.closest('[data-tt-tag]');
      if (tagBtn) {
        applyFilterAndReload({ category: 'all', q: tagBtn.dataset.ttTag || '' });
        return;
      }

      const actEl = e.target.closest('[data-tt-action]');
      if (!actEl) return;
      const action = actEl.dataset.ttAction;
      const slide = actEl.closest('.tt-slide');
      const idx = slide ? Number(slide.dataset.idx) : state.activeIndex;
      const item = state.slides[idx];

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
          const vid = slide.querySelector('.tt-video');
          const icon = slide.querySelector('.tt-center-icon');
          if (!vid) return;
          if (vid.paused) {
            vid.play().catch(() => {});
            if (icon) icon.classList.add('hidden');
          } else {
            vid.pause();
            if (icon) icon.classList.remove('hidden');
          }
        }, 230);
      } else if (action === 'like' && item) {
        toggleHeartItem(item);
      } else if (action === 'mute') {
        state.muted = !state.muted;
        syncMuteIcons();
      } else if (action === 'autonext') {
        state.autoNext = !state.autoNext;
        syncAutoNextIcons();
      } else if (action === 'clean') {
        toggleCleanMode();
      } else if (action === 'open-favs') {
        openFavoritesModal();
      } else if (action === 'close-favs') {
        closeFavoritesModal();
      } else if (action === 'play-all-favs') {
        launchFavoritesFeed(null);
      } else if (action === 'exit-favs-mode') {
        exitFavoritesMode();
      } else if (action === 'copy' && item) {
        const shareUrl = item.share_id
          ? `${window.location.origin}/?c=${encodeURIComponent(item.share_id)}`
          : window.location.origin;
        navigator.clipboard?.writeText(shareUrl).then(() => {
          if (typeof window.showToast === 'function') window.showToast('Enlace de Morbo Hub copiado', 'success');
        }).catch(() => {});
      } else if (action === 'prev') {
        goToSlide(state.activeIndex - 1);
      } else if (action === 'next') {
        goToSlide(state.activeIndex + 1);
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
      loadLocalPlayerPrefs();
      state.mounted = true;
      document.body.classList.add('tiktok-home-active');
      setupObserver();
      bindEvents();
      syncTopModeChips();
      syncCleanModeUI();
      loadAccountFavorites(false);
      if (state.slides.length === 0) {
        fetchRandomBatch(true);
      } else {
        updateAmbientBackdrop(state.slides[state.activeIndex]);
        syncVideoWindow(state.activeIndex);
      }
    },
    unmount() {
      state.mounted = false;
      state.cleanMode = false;
      document.body.classList.remove('tiktok-home-active');
      document.body.classList.remove('tt-clean-mode');
      closeFavoritesModal();
      unloadAllVideos();
    },
    reshuffle() {
      state.feedMode = 'random';
      syncTopModeChips();
      fetchRandomBatch(true);
    },
    openFavorites() {
      openFavoritesModal();
    },
    playSavedShortId(shortId) {
      launchFavoritesFeed(shortId);
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
      if (e.key === 'Escape') {
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
      if (e.key.toLowerCase() === 'h' && !modalOpen) {
        e.preventDefault();
        toggleCleanMode();
        return true;
      }
      if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        goToSlide(state.activeIndex + 1);
        return true;
      }
      if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        goToSlide(state.activeIndex - 1);
        return true;
      }
      if (e.key === ' ') {
        e.preventDefault();
        const activeSlide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${state.activeIndex}"]`);
        const vid = activeSlide && activeSlide.querySelector('.tt-video');
        const icon = activeSlide && activeSlide.querySelector('.tt-center-icon');
        if (vid) {
          if (vid.paused) {
            vid.play().catch(() => {});
            if (icon) icon.classList.add('hidden');
          } else {
            vid.pause();
            if (icon) icon.classList.remove('hidden');
          }
        }
        return true;
      }
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        state.muted = !state.muted;
        syncMuteIcons();
        return true;
      }
      return false;
    },
    onAgeConfirmed() {
      if (state.mounted) syncVideoWindow(state.activeIndex);
    }
  };
})(window, document);
