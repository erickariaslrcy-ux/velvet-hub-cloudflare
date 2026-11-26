/**
 * MORBO HUB — MOTOR TIKTOK TURBO DIRECT-CDN + ULTRA-LIGERO (v3.4)
 * - Ajuste automático ("Auto", 0% recorte) + opción persistente "Llenar".
 * - Streaming directo CDN (86% del catálogo) en Chrome C++ nativo sin saltos de
 *   proxy + fallback automático a /api/shorts/stream/{id} cuando se requiera.
 * - Ventana estricta: solo el video activo descarga (`preload="auto"`) para no
 *   competir ancho de banda; el siguiente solo lee encabezado (`preload="metadata"`).
 */
(function (window, document) {
  'use strict';

  const LIKES_KEY = 'velvet_shorts_likes_v1';
  const MUTE_KEY = 'velvet_shorts_muted_v1';
  const AUTO_NEXT_KEY = 'velvet_shorts_autonext_v1';
  const FIT_KEY = 'velvet_shorts_fit_v1';

  const state = {
    mounted: false,
    slides: [],
    activeIndex: 0,
    loading: false,
    category: 'all',
    q: '',
    muted: true,
    autoNext: false,
    fitMode: 'auto',
    seenIds: [],
    likes: new Set(),
    observer: null
  };

  function loadLocalPrefs() {
    try {
      const savedLikes = JSON.parse(localStorage.getItem(LIKES_KEY) || '[]');
      if (Array.isArray(savedLikes)) state.likes = new Set(savedLikes.map(String));
    } catch (e) {}
    try {
      const m = localStorage.getItem(MUTE_KEY);
      state.muted = m === null ? true : m === '1';
    } catch (e) { state.muted = true; }
    try {
      state.autoNext = localStorage.getItem(AUTO_NEXT_KEY) === '1';
    } catch (e) { state.autoNext = false; }
    try {
      const f = localStorage.getItem(FIT_KEY);
      state.fitMode = f === 'fill' ? 'fill' : 'auto';
    } catch (e) { state.fitMode = 'auto'; }
  }

  function saveLikes() {
    try {
      localStorage.setItem(LIKES_KEY, JSON.stringify(Array.from(state.likes).slice(-500)));
    } catch (e) {}
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
    ambImg.dataset.fb = '';
    ambImg.classList.remove('is-ready');
    ambImg.onerror = () => {
      if (!ambImg.dataset.fb && item.cover_fallback && item.cover_fallback !== targetSrc) {
        ambImg.dataset.fb = '1';
        ambImg.src = item.cover_fallback;
      } else {
        ambImg.classList.remove('is-ready');
      }
    };
    ambImg.onload = () => {
      ambImg.classList.add('is-ready');
    };
    ambImg.src = targetSrc;
  }

  function applyStageGeometry(slide) {
    if (!slide) return;
    const stage = slide.querySelector('.tt-stage');
    const vid = slide.querySelector('.tt-video');
    if (!stage) return;

    const isFill = state.fitMode === 'fill';
    stage.classList.toggle('is-fill', isFill);

    const vw = (vid && vid.videoWidth) || Number(stage.dataset.vw || 0);
    const vh = (vid && vid.videoHeight) || Number(stage.dataset.vh || 0);
    if (vw > 0 && vh > 0) {
      stage.dataset.vw = String(vw);
      stage.dataset.vh = String(vh);
      stage.classList.toggle('is-wide', vw > vh * 1.06);
    }

    if (window.innerWidth < 1024 || isFill) {
      stage.style.width = '';
      return;
    }

    if (vw > 0 && vh > 0) {
      const track = document.getElementById('tiktok-snap-track');
      const availH = Math.max(360, (track ? track.clientHeight : window.innerHeight - 64) - 16);
      const maxW = Math.min(Math.floor(window.innerWidth * 0.88), 1300);
      const idealW = Math.round(availH * (vw / vh));
      const finalW = Math.max(360, Math.min(maxW, idealW));
      stage.style.width = `${finalW}px`;
    } else {
      stage.style.width = '';
    }
  }

  function syncFitModeAll() {
    try { localStorage.setItem(FIT_KEY, state.fitMode); } catch (e) {}
    const isFill = state.fitMode === 'fill';
    document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach(applyStageGeometry);
    document.querySelectorAll('#tiktok-snap-track [data-tt-action="fit"]').forEach((btn) => {
      btn.classList.toggle('is-on', isFill);
      const txt = btn.querySelector('.tt-rail-txt');
      if (txt) txt.textContent = isFill ? 'Llenar' : 'Auto';
    });
  }

  function syncSearchChipUI() {
    const statusChip = document.getElementById('tt-search-chip');
    const statusTxt = document.getElementById('tt-search-chip-label');
    if (statusChip && statusTxt) {
      if (state.q) {
        statusTxt.textContent = state.q;
        statusChip.classList.remove('hidden');
      } else {
        statusChip.classList.add('hidden');
      }
    }
  }

  async function fetchRandomBatch(reset = false) {
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

    const isLiked = state.likes.has(String(item.id));
    const isFill = state.fitMode === 'fill';
    const tagsHtml = (item.tags || []).slice(0, 5).map((t) =>
      `<button type="button" data-tt-tag="${esc(t)}" class="tt-tag-chip">#${esc(t)}</button>`
    ).join('');
    const artist = (item.artists && item.artists[0]) ? `@${esc(item.artists[0])}` : '';

    slide.innerHTML = `
      <div class="tt-stage ${isFill ? 'is-fill' : ''}">
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
          <button type="button" class="tt-rail-btn ${isLiked ? 'is-liked' : ''}" data-tt-action="like" title="Me gusta">
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
          <button type="button" class="tt-rail-btn ${isFill ? 'is-on' : ''}" data-tt-action="fit" title="Cambiar entre ajuste automático sin recorte o pantalla llena">
            <span class="tt-rail-ico"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></span>
            <span class="tt-rail-txt">${isFill ? 'Llenar' : 'Auto'}</span>
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
    vid.addEventListener('loadeddata', () => clearWatchdog());
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
      if (myIdx === state.activeIndex) {
        const nextSlide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${myIdx + 1}"]`);
        const nextVid = nextSlide && nextSlide.querySelector('.tt-video');
        if (nextVid && nextVid.dataset.loadedSrc && nextVid.preload === 'metadata') {
          nextVid.preload = 'auto';
        }
      }
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
        goToSlide(state.activeIndex + 1);
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
    document.querySelectorAll('#tiktok-snap-track .tt-slide').forEach(detachVideoSource);
  }

  function syncVideoWindow(activeIdx) {
    const slides = document.querySelectorAll('#tiktok-snap-track .tt-slide');
    slides.forEach((slide) => {
      const idx = Number(slide.dataset.idx);
      const item = state.slides[idx];
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
    if (idx >= state.slides.length - 6 && !state.loading) {
      fetchRandomBatch(false);
    }
  }

  function goToSlide(idx) {
    let clamped = Math.max(0, Math.min(idx, state.slides.length - 1));
    while (clamped < state.slides.length - 1) {
      const cand = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${clamped}"]`);
      if (!cand || cand.dataset.dead !== '1') break;
      clamped++;
    }
    const slide = document.querySelector(`#tiktok-snap-track .tt-slide[data-idx="${clamped}"]`);
    if (slide) {
      slide.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (category !== undefined) state.category = category || 'all';
    if (q !== undefined) state.q = String(q || '').trim();
    const sIn = document.getElementById('search-input');
    if (sIn) sIn.value = state.q;
    const cBtn = document.getElementById('clear-search-btn');
    if (cBtn) cBtn.classList.toggle('hidden', !state.q);
    syncSearchChipUI();
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
        syncFitModeAll();
      });
    }, { passive: true });

    const trackEl = document.getElementById('tiktok-snap-track');
    if (trackEl) {
      trackEl.addEventListener('scroll', () => {
        if (!state.mounted || state.loading || state.slides.length === 0) return;
        const remainingPx = trackEl.scrollHeight - (trackEl.scrollTop + trackEl.clientHeight);
        if (remainingPx < trackEl.clientHeight * 3.5) {
          fetchRandomBatch(false);
        }
      }, { passive: true });
    }

    root.addEventListener('click', (e) => {
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
          const likeBtn = slide.querySelector('[data-tt-action="like"]');
          if (likeBtn && item && !state.likes.has(String(item.id))) likeBtn.click();
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
        const key = String(item.id);
        const liked = state.likes.has(key);
        if (liked) state.likes.delete(key);
        else state.likes.add(key);
        saveLikes();
        actEl.classList.toggle('is-liked', !liked);
        const cntEl = actEl.querySelector('.tt-rail-txt');
        if (cntEl) cntEl.textContent = String(Number(item.likes || 0) + (!liked ? 1 : 0));
      } else if (action === 'mute') {
        state.muted = !state.muted;
        syncMuteIcons();
      } else if (action === 'autonext') {
        state.autoNext = !state.autoNext;
        syncAutoNextIcons();
      } else if (action === 'fit') {
        state.fitMode = state.fitMode === 'fill' ? 'auto' : 'fill';
        syncFitModeAll();
        if (typeof window.showToast === 'function') {
          window.showToast(
            state.fitMode === 'fill'
              ? 'Modo Llenar: cubre todo el cuadro'
              : 'Ajuste Automático: video completo sin recortes',
            'info'
          );
        }
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
      loadLocalPrefs();
      state.mounted = true;
      document.body.classList.add('tiktok-home-active');
      setupObserver();
      bindEvents();
      syncSearchChipUI();
      if (state.slides.length === 0) {
        fetchRandomBatch(true);
      } else {
        updateAmbientBackdrop(state.slides[state.activeIndex]);
        syncVideoWindow(state.activeIndex);
      }
    },
    unmount() {
      state.mounted = false;
      document.body.classList.remove('tiktok-home-active');
      unloadAllVideos();
    },
    reshuffle() {
      fetchRandomBatch(true);
    },
    setFilter(opts = {}) {
      applyFilterAndReload({
        category: opts.category !== undefined ? opts.category : state.category,
        q: opts.q !== undefined ? opts.q : state.q
      });
    },
    handleKeydown(e) {
      if (!state.mounted) return false;
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
