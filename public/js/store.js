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

    setCurrentUser(user, token = null, refreshToken = null, deviceToken = null) {
      try {
        if (user) {
          localStorage.setItem(USER_KEY, JSON.stringify(user));
          if (token) localStorage.setItem(TOKEN_KEY, token);
          if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
          if (deviceToken) localStorage.setItem(DEVICE_KEY, deviceToken);
          setCookie('velvet_auth_active', '1', 2592000);
        } else {
          localStorage.removeItem(USER_KEY);
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(REFRESH_KEY);
          deleteCookie('velvet_auth_active');
        }
        window.dispatchEvent(new CustomEvent('velvet:auth-changed', { detail: { user } }));
      } catch (e) {}
    },

    getAuthToken() {
      try {
        return localStorage.getItem(TOKEN_KEY);
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

    hasFullAccess() {
      const u = this.getCurrentUser();
      if (!u) return false;
      const tier = (u.tier || '').toLowerCase();
      const role = (u.role || '').toLowerCase();
      return (
        tier === 'vip' ||
        tier === 'patreon' ||
        tier === 'admin' ||
        role === 'admin' ||
        role === 'vip' ||
        u.is_vip === true
      );
    },

    // --- HISTORIAL Y PROGRESO ---
    getHistory() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },

    setHistory(hist) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(hist || []));
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
      if (token) {
        try {
          fetch('/api/user/history', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ item: newEntry })
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
      if (token) {
        try {
          const deleteUrl = itemId
            ? `/api/user/history?id=${itemId}`
            : `/api/user/history?source=${encodeURIComponent(source)}&source_id=${encodeURIComponent(sourceId)}`;
          fetch(deleteUrl, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
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
      if (token && range === 'all') {
        try {
          fetch('/api/user/history', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
          }).catch(() => {});
        } catch (e) {}
      }
    },

    // --- FAVORITOS ---
    getFavorites() {
      try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },

    setFavorites(favs) {
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs || []));
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: favs }));
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
      if (token) {
        try {
          fetch('/api/user/favorites', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(newFav)
          }).catch(() => {});
        } catch (e) {}
      }
    },

    removeFavorite(source, sourceId, id = null) {
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
      if (token) {
        try {
          const deleteUrl = id
            ? `/api/user/favorites/${id}`
            : `/api/user/favorites/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`;
          fetch(deleteUrl, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
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
