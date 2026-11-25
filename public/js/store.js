/**
 * VELVET HUB - CENTRAL DATA STORE & PERSISTENCE ENGINE (v3.0)
 * 
 * Gestiona de manera atómica y sincronizada:
 * - Verificación de edad persistente (+18) en localStorage y cookies (30 días)
 * - Sesión de usuario, tokens Supabase y estado VIP / Patreon
 * - Preferencias de usuario versionadas (v2) aplicadas en tiempo real
 * - Historial y progreso de lectura/reproducción con soporte para pausa de privacidad
 * - Favoritos con sincronización en nube y optimización de memoria
 * - Microcopy centralizado en español
 */

(function (window) {
  'use strict';

  // =========================================================================
  // 1. CONSTANTES Y CONFIGURACIÓN POR DEFECTO
  // =========================================================================
  const PREFERENCES_KEY = 'velvet_preferences_v2';
  const AGE_KEY = 'velvet_age_verified';
  const TOKEN_KEY = 'velvet_token';
  const USER_KEY = 'velvet_user';
  const DEVICE_KEY = 'velvet_device_token';
  const REFRESH_KEY = 'velvet_refresh_token';
  const HISTORY_KEY = 'velvet_history';
  const PROGRESS_KEY = 'velvet_progress';
  const FAVORITES_KEY = 'velvet_favorites';

  function parseStrictStoreInt(val) {
    const s = String(val == null ? '' : val).trim();
    if (!/^\d{1,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  function cleanStoreTitle(raw) {
    const cleanChunk = (all, inner) => {
      const t = String(inner || '').trim();
      if (/(?:\([^)]+\)\s*)?\b(?:peso\b|aigirl\b|spanish|espa[nñ]ol|english|ai[\s\-]*translat(?:ed|ion)|machine[\s\-]*translat(?:ed|ion)|uncensored|sin\s*censura|decensored|mtl|dokiyuri|xasiat|buondua|misskon|4khd|pmvhaven|3hentai)\b/i.test(t)) return ' ';
      if (/\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb|p|pics?|photos?|fotos?|imgs?|videos?)\b/i.test(t)) return ' ';
      return all;
    };
    return String(raw || '')
      .replace(/\{[^}]{1,90}\}/g, ' ')
      .replace(/\[([^\[\]]{1,120})\]/g, cleanChunk)
      .replace(/[\(（【]([^\)）】]{1,120})[\)）】]/g, cleanChunk)
      .replace(/[\[\(（【]\s*\d+\s*photo[^\])]*$/gi, ' ')
      .replace(/\]\s*\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\b(?:ai[\s\-]*translat(?:ed|ion)|machine[\s\-]*translat(?:ed|ion)|traducido\s+(?:con|por)\s+ia)\b/gi, ' ')
      .replace(/\b(?:peso\s*:?\s*)?\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, '')
      .trim()
      .slice(0, 140);
  }

  function compactStoredFavorite(f) {
    if (!f || typeof f !== 'object') return null;
    const id = parseStrictStoreInt(f.id != null ? f.id : f.item_id);
    const hasId = id !== null;
    const rawStrId = String(f.id || f.item_id || f.source_id || '').trim();
    if (!hasId && !(f.source && f.source_id) && !rawStrId) return null;
    const out = {};
    if (hasId) {
      out.id = id;
      out.item_id = id;
    } else if (rawStrId) {
      out.id = rawStrId.slice(0, 80);
    }
    if (f.source) out.source = String(f.source).slice(0, 40);
    if (f.source_id != null && f.source_id !== '') out.source_id = String(f.source_id).slice(0, 80);
    if (f.media_type) out.media_type = String(f.media_type).slice(0, 16);
    if (f.title) out.title = cleanStoreTitle(f.title);
    return out;
  }

  function compactStoredHistory(h) {
    if (!h || typeof h !== 'object') return null;
    const id = parseStrictStoreInt(h.id != null ? h.id : h.item_id);
    const hasId = id !== null;
    const rawStrId = String(h.id || h.item_id || h.source_id || '').trim();
    if (!hasId && !(h.source && h.source_id) && !rawStrId) return null;
    const out = {
      media_type: String(h.media_type || '').slice(0, 16),
      position: Math.max(0, parseInt(h.position || h.page || h.currentTime || 0, 10) || 0),
      duration: Math.max(0, parseInt(h.duration || h.total || 0, 10) || 0),
      completed: !!h.completed,
      at: Number(h.at || 0) || 0
    };
    if (hasId) {
      out.id = id;
      out.item_id = id;
    } else if (rawStrId) {
      out.id = rawStrId.slice(0, 80);
    }
    if (h.source) out.source = String(h.source).slice(0, 40);
    if (h.source_id != null && h.source_id !== '') out.source_id = String(h.source_id).slice(0, 80);
    if (h.title) out.title = cleanStoreTitle(h.title);
    return out;
  }

  const DEFAULT_PREFERENCES = {
    version: 2,
    defaultQuality: 'auto',       // 'auto' | '1080p' | '720p' | '480p'
    autoplayNext: true,           // Auto-reproducir siguiente
    ambientLighting: true,        // Luces ambientales / glow
    reduceMotion: false,          // Reducción de animaciones
    dataSaver: false,             // Modo ahorro de datos (sin prefetch pesado)
    vaultViewMode: 'grid',        // 'grid' | 'list' para la Bóveda
    pauseHistory: false,          // Pausar registro en historial (privacidad)
    onlyUnfinishedHistory: false  // Filtro de historial: solo sin terminar
  };

  // Microcopy centralizado (Cero relleno publicitario, tono sobrio y premium)
  const TEXTS = {
    ageTitle: 'Verificación de Edad (+18)',
    ageDesc: 'Este portal ofrece cómics, videos y contenido explícito para adultos sin censura. Al continuar, certificas bajo juramento que tienes al menos 18 años (o la mayoría de edad en tu jurisdicción).',
    ageAccept: 'Soy mayor de 18 años &bull; Ingresar',
    ageDecline: 'Salir',
    vaultTitle: 'Mi Bóveda',
    vaultSubtitle: 'Tus favoritos e historial, sincronizados en la nube',
    favTab: 'Favoritos',
    histTab: 'Historial',
    accountTab: 'Cuenta',
    emptyFavTitle: 'Tu Bóveda está vacía',
    emptyFavDesc: 'Guarda tus videos y cómics favoritos pulsando el icono del corazón en cualquier tarjeta.',
    emptyHistTitle: 'Sin historial reciente',
    emptyHistDesc: 'Los videos y cómics que comiences a disfrutar aparecerán aquí organizados por fecha.',
    exploreBtn: 'Explorar Catálogo',
    deleteItem: 'Eliminar',
    undoBtn: 'Deshacer',
    clearedHistory: 'Historial eliminado',
    itemDeleted: 'Elemento quitado',
    prefSaved: 'Preferencia guardada',
    vipActive: 'Membresía VIP Ilimitada',
    vipPatreon: 'Vinculado con Patreon',
    vipFree: 'Cuenta Estándar',
    sessionClosed: 'Sesión cerrada correctamente'
  };

  // =========================================================================
  // 2. HELPER DE COOKIES (Cross-Tab Persistence)
  // =========================================================================
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
    return match ? decodeURIComponent(match[3]) : null;
  }

  function setCookie(name, val, maxAgeSecs = 2592000) {
    // 30 días por defecto, SameSite=Lax
    document.cookie = `${name}=${encodeURIComponent(val)}; max-age=${maxAgeSecs}; path=/; SameSite=Lax`;
  }

  function deleteCookie(name) {
    document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax`;
  }

  // =========================================================================
  // 3. MOTOR DEL STORE
  // =========================================================================
  const VelvetStore = {
    texts: TEXTS,

    // --- ACCESO A ESTADO GLOBAL ---
    getState() {
      return {
        preferences: this.getPreferences(),
        user: this.getCurrentUser(),
        favorites: this.getFavorites(),
        history: this.getHistory()
      };
    },

    // --- VERIFICACIÓN DE EDAD ---
    isAgeVerified() {
      try {
        const local = localStorage.getItem(AGE_KEY);
        const cookie = getCookie(AGE_KEY);
        return local === '1' || cookie === '1';
      } catch (e) {
        return false;
      }
    },

    setAgeVerified(verified = true) {
      try {
        if (verified) {
          localStorage.setItem(AGE_KEY, '1');
          setCookie(AGE_KEY, '1', 2592000); // 30 días
        } else {
          localStorage.removeItem(AGE_KEY);
          deleteCookie(AGE_KEY);
        }
      } catch (e) {}
    },

    // --- PREFERENCIAS VERSIONADAS ---
    getPreferences() {
      if (window.VelvetPersonalData) {
        return window.VelvetPersonalData.getPreferences();
      }
      try {
        const raw = localStorage.getItem(PREFERENCES_KEY);
        if (!raw) return { ...DEFAULT_PREFERENCES };
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== DEFAULT_PREFERENCES.version) {
          // Migración suave de versiones anteriores si aplica
          const merged = { ...DEFAULT_PREFERENCES, ...(parsed || {}) };
          merged.version = DEFAULT_PREFERENCES.version;
          localStorage.setItem(PREFERENCES_KEY, JSON.stringify(merged));
          return merged;
        }
        return parsed;
      } catch (e) {
        return { ...DEFAULT_PREFERENCES };
      }
    },

    setPreferences(newPrefs) {
      if (window.VelvetPersonalData) {
        window.VelvetPersonalData.setPreferences(newPrefs);
      }
      try {
        const current = this.getPreferences();
        const updated = { ...current, ...newPrefs, version: DEFAULT_PREFERENCES.version };
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated));
        this.applyPreferencesEffects(updated);
        window.dispatchEvent(new CustomEvent('velvet:preferences-changed', { detail: updated }));
        return updated;
      } catch (e) {
        return DEFAULT_PREFERENCES;
      }
    },

    updatePreference(key, value) {
      const prefs = this.getPreferences();
      prefs[key] = value;
      return this.setPreferences(prefs);
    },

    applyPreferencesEffects(prefs = null) {
      const p = prefs || this.getPreferences();
      const root = document.documentElement;
      
      // 1. Reducir movimiento
      if (p.reduceMotion) {
        root.classList.add('reduce-motion');
      } else {
        root.classList.remove('reduce-motion');
      }

      // 2. Luces ambientales (glow)
      if (p.ambientLighting) {
        root.classList.add('velvet-ambient-on');
      } else {
        root.classList.remove('velvet-ambient-on');
      }

      // 3. Ahorro de datos
      if (p.dataSaver) {
        root.classList.add('velvet-data-saver');
      } else {
        root.classList.remove('velvet-data-saver');
      }
    },

    // --- SESIÓN Y USUARIO ---
    getCurrentUser() {
      try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    // Alias usado por el login/registro/logout del shell. Antes no existía y
    // el inicio de sesión abortaba con TypeError después de guardar el token.
    setSession(user, token = null, refreshToken = null, expiresAt = null, deviceToken = null) {
      return this.setCurrentUser(user, token, refreshToken, deviceToken, expiresAt);
    },

    setCurrentUser(user, token = null, refreshToken = null, deviceToken = null, expiresAt = null) {
      if (window.VelvetPersonalData && typeof window.VelvetPersonalData.setSession === 'function') {
        return window.VelvetPersonalData.setSession(user, token, refreshToken, expiresAt, deviceToken);
      }
      try {
        if (user) {
          const userJson = JSON.stringify(user);
          localStorage.setItem(USER_KEY, userJson);
          localStorage.setItem('velvet_current_user', userJson);
          if (token && token !== 'velvet_token') {
            localStorage.setItem(TOKEN_KEY, token);
            localStorage.setItem('velvet_auth_token', token);
          }
          if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
          if (deviceToken) localStorage.setItem(DEVICE_KEY, deviceToken);
          if (expiresAt) localStorage.setItem('velvet_expires_at', String(expiresAt));
          setCookie('velvet_auth_active', '1', 2592000);
        } else {
          localStorage.removeItem(USER_KEY);
          localStorage.removeItem('velvet_current_user');
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem('velvet_auth_token');
          localStorage.removeItem(REFRESH_KEY);
          localStorage.removeItem('velvet_expires_at');
          localStorage.removeItem(DEVICE_KEY);
          deleteCookie('velvet_auth_active');
        }
        window.dispatchEvent(new CustomEvent('velvet:auth-changed', { detail: { user: user || null } }));
      } catch (e) {}
      return user || null;
    },

    getAuthToken() {
      try {
        if (window.VelvetPersonalData && typeof window.VelvetPersonalData.getAuthToken === 'function') {
          const live = window.VelvetPersonalData.getAuthToken();
          if (live) return live;
        }
        return localStorage.getItem('velvet_auth_token') || localStorage.getItem(TOKEN_KEY);
      } catch (e) {
        return null;
      }
    },

    getRefreshToken() {
      try {
        return localStorage.getItem(REFRESH_KEY);
      } catch (e) {
        return null;
      }
    },

    getDeviceToken() {
      try {
        return localStorage.getItem(DEVICE_KEY);
      } catch (e) {
        return null;
      }
    },

    getSubscriptionInfo() {
      const u = this.getCurrentUser();
      if (!u) {
        return { active: false, status: 'guest', isAdmin: false, isLifetime: false, expiresAt: null, daysRemaining: 0 };
      }
      const role = String(u.role || '').toLowerCase();
      const status = String(u.subscription_status || '').toLowerCase();
      const tier = String(u.tier || '').toLowerCase();
      const tierLevel = String(u.tier_level || '').toLowerCase();
      const isSuspended = Boolean(u.is_suspended === true || status === 'suspended');
      if (isSuspended) {
        return { active: false, status: 'suspended', isAdmin: false, isLifetime: false, expiresAt: u.subscription_expires_at || null, daysRemaining: 0 };
      }
      const isAdmin = role === 'admin' || tier === 'dueño' || tier === 'admin' || status === 'admin';
      const isLifetime = Boolean(u.is_lifetime === true);
      if (isAdmin || isLifetime) {
        return { active: true, status: isAdmin ? 'admin' : 'active', isAdmin, isLifetime, expiresAt: null, daysRemaining: null };
      }
      const expIso = u.subscription_expires_at || null;
      if (expIso) {
        const expMs = Date.parse(expIso);
        const nowMs = Date.now();
        if (!Number.isNaN(expMs)) {
          if (expMs <= nowMs) {
            return { active: false, status: 'expired', isAdmin: false, isLifetime: false, expiresAt: expIso, daysRemaining: 0 };
          }
          const daysRemaining = Math.max(1, Math.ceil((expMs - nowMs) / 86400000));
          return { active: true, status: 'active', isAdmin: false, isLifetime: false, expiresAt: expIso, daysRemaining };
        }
      }
      if (status === 'expired') {
        return { active: false, status: 'expired', isAdmin: false, isLifetime: false, expiresAt: expIso, daysRemaining: 0 };
      }
      if (status === 'inactive' || tierLevel === 'free' || u.has_active_subscription === false || u.is_pro === false) {
        return { active: false, status: status || 'inactive', isAdmin: false, isLifetime: false, expiresAt: expIso, daysRemaining: 0 };
      }
      const legacyActive =
        u.has_active_subscription === true ||
        u.is_pro === true ||
        u.is_vip === true ||
        tier === 'vip' ||
        tier === 'patreon';
      return {
        active: legacyActive,
        status: legacyActive ? 'active' : 'inactive',
        isAdmin: false,
        isLifetime: false,
        expiresAt: expIso,
        daysRemaining: null
      };
    },

    hasFullAccess() {
      return Boolean(this.getSubscriptionInfo().active);
    },

    // --- HISTORIAL Y PROGRESO ---
    getHistory() {
      if (window.VelvetPersonalData) {
        const hist = window.VelvetPersonalData.getHistoryState().items;
        if (hist && hist.length > 0) return hist;
      }
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },

    setHistory(hist) {
      try {
        const slim = (Array.isArray(hist) ? hist : []).map(compactStoredHistory).filter(Boolean).slice(0, 50);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(slim));
        window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: hist }));
      } catch (e) {}
    },

    getProgressMap() {
      try {
        const raw = localStorage.getItem(PROGRESS_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },

    setProgressMap(prog) {
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog || {}));
      } catch (e) {}
    },

    recordProgress(item, progressData) {
      if (window.VelvetPersonalData) {
        window.VelvetPersonalData.recordProgress(item, progressData);
      }
      const prefs = this.getPreferences();
      if (prefs.pauseHistory) {
        // Modo privacidad activo: no almacenar en historial
        return;
      }

      if (!item) return;
      const itemId = item.id ? String(item.id) : null;
      const sourceKey = (item.source && item.source_id) ? `${item.source}:${item.source_id}` : null;
      const progressKey = itemId || sourceKey;
      if (!progressKey) return;

      const progressMap = this.getProgressMap();
      progressMap[progressKey] = {
        ...progressData,
        at: Date.now()
      };
      if (sourceKey && itemId) {
        progressMap[sourceKey] = progressMap[progressKey];
      }
      this.setProgressMap(progressMap);

      // Actualizar lista ordenada de historial
      let hist = this.getHistory();
      hist = hist.filter((h) => {
        if (itemId && h.id && String(h.id) === itemId) return false;
        if (item.source && item.source_id && h.source === item.source && String(h.source_id) === String(item.source_id)) return false;
        return true;
      });

      const newEntry = {
        id: item.id || null,
        source: item.source || '',
        source_id: item.source_id || '',
        title: item.title || 'Sin título',
        cover_url: item.cover_url || '',
        url: item.url || '',
        media_type: item.media_type || (progressData.duration ? 'video' : 'comic'),
        page: progressData.page || 1,
        total: progressData.total || 1,
        currentTime: progressData.currentTime || 0,
        duration: progressData.duration || 0,
        completed: !!progressData.completed,
        at: Date.now()
      };

      hist.unshift(newEntry);
      if (hist.length > 80) hist = hist.slice(0, 80);
      this.setHistory(hist);

      // Sincronizar en la nube con Supabase si está autenticado
      const token = this.getAuthToken();
      if (token || this.getCurrentUser()) {
        try {
          const reqHeaders = { 'Content-Type': 'application/json' };
          if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
          fetch('/api/user/history', {
            method: 'POST',
            credentials: 'include',
            headers: reqHeaders,
            body: JSON.stringify({
              id: item.id || item.item_id || item.source_id || null,
              item_id: item.id || item.item_id || null,
              source: item.source || '',
              source_id: item.source_id || '',
              title: item.title || '',
              cover_url: item.cover_url || '',
              media_type: newEntry.media_type,
              position: newEntry.currentTime || newEntry.page || 0,
              duration: newEntry.duration || newEntry.total || 0,
              completed: !!newEntry.completed,
              client_timestamp: newEntry.at
            })
          }).catch(() => {});
        } catch (e) {}
      }
    },

    removeHistoryItem(source, sourceId, itemId = null) {
      let hist = this.getHistory();
      hist = hist.filter((h) => {
        if (itemId && h.id && String(h.id) === String(itemId)) return false;
        if (source && sourceId && h.source === source && String(h.source_id) === String(sourceId)) return false;
        return true;
      });
      this.setHistory(hist);

      const prog = this.getProgressMap();
      if (itemId) delete prog[String(itemId)];
      if (source && sourceId) delete prog[`${source}:${sourceId}`];
      this.setProgressMap(prog);

      // Sync backend deletion
      const token = this.getAuthToken();
      if (token || this.getCurrentUser()) {
        try {
          const qs = [];
          if (itemId) qs.push(`id=${encodeURIComponent(itemId)}`);
          if (source) qs.push(`source=${encodeURIComponent(source)}`);
          if (sourceId) qs.push(`source_id=${encodeURIComponent(sourceId)}`);
          const deleteUrl = `/api/user/history?${qs.join('&')}`;
          const reqHeaders = token ? { 'Authorization': `Bearer ${token}` } : {};
          fetch(deleteUrl, {
            method: 'DELETE',
            credentials: 'include',
            headers: reqHeaders
          }).catch(() => {});
        } catch (e) {}
      }
    },

    clearHistoryByRange(range = 'all') {
      const now = Date.now();
      const ONE_DAY = 86400000;
      const ONE_WEEK = ONE_DAY * 7;

      let hist = this.getHistory();
      if (range === 'today') {
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        hist = hist.filter((h) => (h.at || 0) < startOfDay);
      } else if (range === 'week') {
        const cutOff = now - ONE_WEEK;
        hist = hist.filter((h) => (h.at || 0) < cutOff);
      } else {
        hist = [];
      }

      this.setHistory(hist);
      if (range === 'all') {
        this.setProgressMap({});
      }

      const token = this.getAuthToken();
      if ((token || this.getCurrentUser()) && range === 'all') {
        try {
          fetch('/api/user/history?clear=all', {
            method: 'DELETE',
            credentials: 'include',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          }).catch(() => {});
        } catch (e) {}
      }
    },

    // --- FAVORITOS ---
    getFavorites() {
      if (window.VelvetPersonalData) {
        return window.VelvetPersonalData.getFavoritesState().items || [];
      }
      try {
        const u = this.getCurrentUser();
        const key = (u && u.id) ? `${FAVORITES_KEY}_${u.id}` : FAVORITES_KEY;
        const raw = localStorage.getItem(key) || ((!u || !u.id) ? (localStorage.getItem('velvet_guest_favs') || localStorage.getItem('velvet_favs')) : null);
        if (raw) return JSON.parse(raw);
        if (window.state && Array.isArray(window.state.favorites) && window.state.favorites.length > 0) {
          return window.state.favorites;
        }
        return [];
      } catch (e) {
        return [];
      }
    },

    setFavorites(favs) {
      try {
        const list = Array.isArray(favs) ? favs : [];
        const serialized = JSON.stringify(list.map(compactStoredFavorite).filter(Boolean));
        const u = this.getCurrentUser();
        if (u && u.id) {
          localStorage.setItem(`${FAVORITES_KEY}_${u.id}`, serialized);
        } else {
          localStorage.setItem(FAVORITES_KEY, serialized);
          localStorage.setItem('velvet_guest_favs', serialized);
          localStorage.setItem('velvet_favs', serialized);
          localStorage.setItem('velvet_fav_ids', serialized);
        }
        if (window.state) window.state.favorites = list;
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: list }));
      } catch (e) {}
    },

    isFavorite(source, sourceId, id = null) {
      const favs = this.getFavorites();
      return favs.some((f) => {
        if (id && f.id && String(f.id) === String(id)) return true;
        return f.source === source && String(f.source_id) === String(sourceId);
      });
    },

    addFavorite(item) {
      if (!item) return;
      if (window.VelvetPersonalData) {
        return window.VelvetPersonalData.addFavorite(item);
      }
      const favs = this.getFavorites();
      const exists = favs.some((f) => {
        if (item.id && f.id && String(f.id) === String(item.id)) return true;
        return f.source === item.source && String(f.source_id) === String(item.source_id);
      });
      if (exists) return;

      const newFav = {
        id: item.id || null,
        source: item.source || '',
        source_id: item.source_id || '',
        title: item.title || 'Sin título',
        cover_url: item.cover_url || '',
        url: item.url || '',
        media_type: item.media_type || 'comic',
        added_at: Date.now()
      };

      favs.unshift(newFav);
      this.setFavorites(favs);

      const token = this.getAuthToken();
      if (token || this.getCurrentUser()) {
        try {
          const reqHeaders = { 'Content-Type': 'application/json' };
          if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
          fetch('/api/user/favorites', {
            method: 'POST',
            credentials: 'include',
            headers: reqHeaders,
            body: JSON.stringify({
              id: item.id || null,
              item_id: item.id || null,
              source: item.source || '',
              source_id: item.source_id || '',
              title: item.title || '',
              cover_url: item.cover_url || '',
              media_type: item.media_type || 'comic'
            })
          }).catch(() => {});
        } catch (e) {}
      }
    },

    removeFavorite(source, sourceId, id = null) {
      if (window.VelvetPersonalData) {
        window.VelvetPersonalData.removeFavorite(id || sourceId, source, sourceId);
        return;
      }
      let favs = this.getFavorites();
      const removedItem = favs.find((f) => {
        if (id && f.id && String(f.id) === String(id)) return true;
        return f.source === source && String(f.source_id) === String(sourceId);
      });

      favs = favs.filter((f) => {
        if (id && f.id && String(f.id) === String(id)) return false;
        return !(f.source === source && String(f.source_id) === String(sourceId));
      });
      this.setFavorites(favs);

      const token = this.getAuthToken();
      if (token || this.getCurrentUser()) {
        try {
          const deleteUrl = id
            ? `/api/user/favorites/${encodeURIComponent(id)}`
            : `/api/user/favorites/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`;
          fetch(deleteUrl, {
            method: 'DELETE',
            credentials: 'include',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          }).catch(() => {});
        } catch (e) {}
      }
      return removedItem;
    }
  };

  // Inicialización de efectos de preferencias inmediatamente
  VelvetStore.applyPreferencesEffects();

  window.VelvetStore = VelvetStore;
})(window);
