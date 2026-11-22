/**
 * ============================================================================
 * VELVET HUB - MOTOR UNIFICADO DE DATOS PERSONALES (v3.2)
 * public/js/personal-data.js
 * 
 * ÚNICA FUENTE DE VERDAD PARA TODA LA APLICACIÓN:
 * - Favoritos, Historial, Continuar Leyendo, Progreso y Preferencias.
 * - Sincronización multi-dispositivo respaldada por PostgreSQL/Supabase.
 * - Paginación real de 24 en 24 items por página (PERSONAL_PAGE_SIZE = 24).
 * - Aislamiento estricto por cuenta (claves de caché con user_id).
 * - Migración idempotente de datos locales heredados (con respaldo 30 días).
 * - Concurrencia segura: AbortController y descartes de peticiones obsoletas.
 * - Throttling de progreso (15-30s / pausa / cierre con keepalive).
 * ============================================================================
 */

(function (window) {
  'use strict';

  const PERSONAL_PAGE_SIZE = 24;
  const BACKUP_PREFIX = 'velvet_backup_pre_migration_';
  const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

  const DEFAULT_PREFERENCES = {
    version: 2,
    defaultQuality: 'auto',       // 'auto' | '1080p' | '720p' | '480p'
    autoplayNext: true,
    ambientLighting: true,
    reduceMotion: false,
    dataSaver: false,
    vaultViewMode: 'grid',        // 'grid' | 'list'
    pauseHistory: false,          // Pausar registro en historial (privacidad)
    onlyUnfinishedHistory: false
  };

  // --------------------------------------------------------------------------
  // ESTADO PRIVADO CENTRALIZADO
  // --------------------------------------------------------------------------
  let _currentUser = null;
  let _token = null;
  let _refreshToken = null;
  let _expiresAt = null;
  let _deviceToken = null;
  let _refreshFlight = null;

  // Estado de Favoritos
  const _favState = {
    items: [],
    total: 0,
    page: 1,
    pageSize: PERSONAL_PAGE_SIZE,
    totalPages: 1,
    filter: 'all',
    sort: 'recent',
    search: '',
    isLoading: false,
    error: null,
    controller: null,
    requestId: 0,
    ids: null,
    refs: []
  };

  // Estado de Historial
  const _histState = {
    items: [],
    total: 0,
    page: 1,
    pageSize: PERSONAL_PAGE_SIZE,
    totalPages: 1,
    filter: 'all',
    onlyUnfinished: false,
    search: '',
    isLoading: false,
    error: null,
    controller: null,
    requestId: 0
  };

  // Estado de Preferencias y Sincronización
  let _preferences = { ...DEFAULT_PREFERENCES };
  let _lastSyncTimestamp = null;
  let _syncInProgress = false;

  // Mapa de Progreso de lectura/video en memoria
  const _progressMap = new Map();

  // Control de Throttle para guardado de progreso
  const _progressThrottle = new Map(); // itemId -> timestamp

  // --------------------------------------------------------------------------
  // HELPERS DE ALMACENAMIENTO Y CLAVES AISLADAS
  // --------------------------------------------------------------------------
  function getStorageKey(subKey) {
    if (_currentUser && _currentUser.id) {
      return `velvet_usr_${_currentUser.id}_${subKey}`;
    }
    return `velvet_guest_${subKey}`;
  }

  function readLocalCache(subKey, fallback = null) {
    try {
      const raw = localStorage.getItem(getStorageKey(subKey));
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeLocalCache(subKey, data) {
    try {
      localStorage.setItem(getStorageKey(subKey), JSON.stringify(data));
    } catch (e) {}
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function compactFavRecord(f) {
    if (!f || typeof f !== 'object') return null;
    const id = parseInt(f.id || f.item_id, 10);
    const hasId = Number.isInteger(id) && id > 0;
    if (!hasId && !(f.source && f.source_id)) return null;
    const out = {};
    if (hasId) {
      out.id = id;
      out.item_id = id;
    }
    if (f.source) out.source = String(f.source).slice(0, 40);
    if (f.source_id != null && f.source_id !== '') out.source_id = String(f.source_id).slice(0, 80);
    if (f.media_type) out.media_type = String(f.media_type).slice(0, 16);
    if (f.title) out.title = String(f.title).slice(0, 80);
    return out;
  }

  function compactHistRecord(h) {
    if (!h || typeof h !== 'object') return null;
    const id = parseInt(h.id || h.item_id, 10);
    const hasId = Number.isInteger(id) && id > 0;
    if (!hasId && !(h.source && h.source_id)) return null;
    const isVid = h.media_type === 'video';
    const pos = Math.max(0, parseInt(h.position || h.page || h.currentTime || 0, 10) || 0);
    const dur = Math.max(0, parseInt(h.duration || h.total || 0, 10) || 0);
    const out = {
      media_type: String(h.media_type || (isVid ? 'video' : 'comic')).slice(0, 16),
      position: pos,
      duration: dur,
      completed: !!h.completed,
      at: Number(h.at || h.client_timestamp || 0) || 0
    };
    if (hasId) {
      out.id = id;
      out.item_id = id;
    }
    if (h.source) out.source = String(h.source).slice(0, 40);
    if (h.source_id != null && h.source_id !== '') out.source_id = String(h.source_id).slice(0, 80);
    if (h.title) out.title = String(h.title).slice(0, 80);
    if (!isVid && pos) out.page = pos;
    if (!isVid && dur) out.total = dur;
    if (isVid && pos) out.currentTime = pos;
    return out;
  }

  function purgeBulkyLocalKeys() {
    try {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('vcache_') || k.startsWith('velvet_backup_pre_migration_')) drop.push(k);
      }
      drop.forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      purgeBulkyLocalKeys();
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function readJwtExpMs(token) {
    try {
      if (!token || token.indexOf('.') === -1) return null;
      const part = token.split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = JSON.parse(atob(padded));
      return json && json.exp ? json.exp * 1000 : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeExpiry(expiresAt, token) {
    const n = Number(expiresAt);
    if (Number.isFinite(n) && n > 0) {
      return n > 1e12 ? n : n * 1000;
    }
    return readJwtExpMs(token);
  }

  // El refresh token NO viaja en cada petición: reutilizarlo en paralelo
  // revoca toda la familia de sesión en Supabase (refresh token rotation).
  function getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const activeToken = currentAccessToken();
    if (activeToken) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }
    return headers;
  }

  function currentAccessToken() {
    const stored = safeGet('velvet_auth_token') || safeGet('velvet_token');
    const storedOk = stored && stored !== 'velvet_token' && stored !== 'null' && stored !== 'undefined' ? stored : null;
    const memOk = _token && _token !== 'velvet_token' && _token !== 'null' && _token !== 'undefined' ? _token : null;
    if (!memOk) {
      _token = storedOk;
      return storedOk;
    }
    if (!storedOk || memOk === storedOk) return memOk;
    const memExp = readJwtExpMs(memOk) || 0;
    const stExp = readJwtExpMs(storedOk) || 0;
    const best = stExp >= memExp ? storedOk : memOk;
    _token = best;
    return best;
  }

  function accessNeedsRefresh(token) {
    if (!token) return true;
    const exp = normalizeExpiry(_expiresAt, token);
    if (!exp) return false;
    return Date.now() > (exp - 60000);
  }

  function clearSessionKeys() {
    [
      'velvet_token',
      'velvet_auth_token',
      'velvet_refresh_token',
      'velvet_user',
      'velvet_current_user',
      'velvet_expires_at',
      'velvet_device_token'
    ].forEach(safeRemove);
    try {
      document.cookie = 'velvet_auth_active=; max-age=0; path=/; SameSite=Lax';
    } catch (e) {}
  }

  function writeSessionKeys(user, token, refreshToken, expiresAt, deviceToken) {
    const userJson = JSON.stringify(user);
    safeSet('velvet_user', userJson);
    safeSet('velvet_current_user', userJson);
    if (token) {
      safeSet('velvet_token', token);
      safeSet('velvet_auth_token', token);
    }
    if (refreshToken) safeSet('velvet_refresh_token', refreshToken);
    if (expiresAt) safeSet('velvet_expires_at', String(expiresAt));
    if (deviceToken) safeSet('velvet_device_token', deviceToken);
    try {
      document.cookie = 'velvet_auth_active=1; max-age=2592000; path=/; SameSite=Lax';
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // MOTOR DE SINCRONIZACIÓN Y DATOS PERSONALES
  // --------------------------------------------------------------------------
  const VelvetPersonalData = {
    PERSONAL_PAGE_SIZE,

    init() {
      this.restoreSessionFromStorage();
      this.hydrateCanonicalCache();
      this.loadCachedPreferences();
      this.cleanupOldBackups();
      this.updateAllCounters();

      // Sincronizar reconexión a Internet
      window.addEventListener('online', () => {
        if (_currentUser) {
          this.refreshAll();
        }
      });

      // Sincronizar cambios de sesión entre pestañas vía storage event
      window.addEventListener('storage', (e) => {
        if (!e.key || e.key.indexOf('velvet_') !== 0) return;
        if (e.key === 'velvet_token' || e.key === 'velvet_auth_token' || e.key === 'velvet_user' || e.key === 'velvet_current_user' || e.key === 'velvet_refresh_token' || e.key === 'velvet_expires_at') {
          const prevUserId = _currentUser?.id;
          this.restoreSessionFromStorage();
          const nextUserId = _currentUser?.id;
          if (prevUserId !== nextUserId) {
            this.handleSessionSwitched();
          }
        }
      });

      // Renovar el access token antes de que otras vistas disparen peticiones en paralelo
      this.ensureFreshAccessToken().catch(() => {});

      // Flujo de guardado pendiente antes de cerrar la ventana
      window.addEventListener('beforeunload', () => {
        this.flushPendingProgress();
      });
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flushPendingProgress();
        }
      });
    },

    // ------------------------------------------------------------------------
    // GESTIÓN DE SESIÓN
    // ------------------------------------------------------------------------
    restoreSessionFromStorage() {
      try {
        const storedToken = safeGet('velvet_auth_token') || safeGet('velvet_token');
        _token = storedToken && storedToken !== 'velvet_token' && storedToken !== 'null' && storedToken !== 'undefined' ? storedToken : null;
        _refreshToken = safeGet('velvet_refresh_token') || null;
        if (_refreshToken === 'null' || _refreshToken === 'undefined') _refreshToken = null;
        _deviceToken = safeGet('velvet_device_token') || null;
        const rawExp = safeGet('velvet_expires_at');
        _expiresAt = rawExp ? normalizeExpiry(rawExp, _token) : readJwtExpMs(_token);
        const rawUser = safeGet('velvet_current_user') || safeGet('velvet_user');
        _currentUser = rawUser ? JSON.parse(rawUser) : null;
        if (_currentUser && !_currentUser.id) _currentUser = null;
      } catch (e) {
        _currentUser = null;
        _token = null;
        _refreshToken = null;
        _expiresAt = null;
        _deviceToken = null;
      }
    },

    setSession(user, token = null, refreshToken = null, expiresAt = null, deviceToken = null) {
      if (!user) {
        this.clearSession();
        return null;
      }

      const prevId = _currentUser?.id || null;
      _currentUser = user;
      if (token && token !== 'velvet_token' && token !== 'null' && token !== 'undefined') {
        _token = token;
      }
      if (refreshToken && refreshToken !== 'null' && refreshToken !== 'undefined') {
        _refreshToken = refreshToken;
      }
      if (deviceToken) _deviceToken = deviceToken;
      const normalizedExp = normalizeExpiry(expiresAt, _token);
      if (normalizedExp) _expiresAt = normalizedExp;

      writeSessionKeys(_currentUser, _token, _refreshToken, _expiresAt, _deviceToken);

      if (String(prevId || '') !== String(_currentUser.id || '')) {
        this.handleSessionSwitched();
        this.migrateLocalDataToServer();
      }

      window.dispatchEvent(new CustomEvent('velvet:auth-changed', { detail: { user: _currentUser } }));
      window.dispatchEvent(new CustomEvent('velvet:session-ready', { detail: { user: _currentUser } }));
      return _currentUser;
    },

    clearSession() {
      const hadUser = !!_currentUser;
      _currentUser = null;
      _token = null;
      _refreshToken = null;
      _expiresAt = null;
      _deviceToken = null;
      clearSessionKeys();
      if (hadUser) this.handleSessionSwitched();
      window.dispatchEvent(new CustomEvent('velvet:auth-changed', { detail: { user: null } }));
    },

    handleSessionSwitched() {
      // Limpiar estado en memoria al cerrar sesión o cambiar de usuario
      _favState.items = [];
      _favState.ids = null;
      _favState.refs = [];
      _favState.total = 0;
      _favState.page = 1;
      _favState.totalPages = 1;
      _favState.error = null;

      _histState.items = [];
      _histState.total = 0;
      _histState.page = 1;
      _histState.totalPages = 1;
      _histState.error = null;

      _progressMap.clear();
      _progressThrottle.clear();

      this.loadCachedPreferences();
      if (_currentUser) this.hydrateCanonicalCache();
      this.updateAllCounters();

      if (_currentUser) {
        this.fetchFavorites(1);
        this.fetchHistory(1);
        this.fetchPreferences();
      } else {
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
      }
    },

    getCurrentUser() {
      return _currentUser;
    },

    getAuthToken() {
      return currentAccessToken();
    },

    isAuthenticated() {
      const token = currentAccessToken();
      const refresh = _refreshToken || safeGet('velvet_refresh_token');
      return !!(_currentUser && _currentUser.id && (token || refresh));
    },

    async refreshSession() {
      if (_refreshFlight) return _refreshFlight;
      const refreshToken = _refreshToken || safeGet('velvet_refresh_token');
      _refreshFlight = (async () => {
        try {
          const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {})
          });
          let data = {};
          try { data = await res.json(); } catch (e) {}
          if (res.status === 401 || res.status === 400) return false;
          if (!res.ok || !data || !data.token) return null;
          const nextUser = data.user || _currentUser;
          if (!nextUser || !nextUser.id) return false;
          this.setSession(
            nextUser,
            data.token,
            data.refresh_token || refreshToken,
            data.expires_at,
            data.device_token || _deviceToken
          );
          return true;
        } catch (e) {
          return null;
        } finally {
          _refreshFlight = null;
        }
      })();
      return _refreshFlight;
    },

    async ensureFreshAccessToken() {
      const token = currentAccessToken();
      const refresh = _refreshToken || safeGet('velvet_refresh_token');
      if (token && !accessNeedsRefresh(token)) return true;
      if (!refresh) return !!token;
      const result = await this.refreshSession();
      if (result === false) {
        this.clearSession();
        return false;
      }
      return !!currentAccessToken();
    },

    async fetchAuthed(url, options = {}) {
      await this.ensureFreshAccessToken();
      const buildHeaders = () => {
        const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
        delete headers['x-refresh-token'];
        return headers;
      };
      let res = await fetch(url, { ...options, headers: buildHeaders(), credentials: 'include' });
      if (res.status === 401 && this.isAuthenticated()) {
        const ok = await this.refreshSession();
        if (ok) {
          res = await fetch(url, { ...options, headers: buildHeaders(), credentials: 'include' });
        } else if (ok === false) {
          this.clearSession();
        }
      }
      return res;
    },

    // ------------------------------------------------------------------------
    // PREFERENCIAS DE USUARIO
    // ------------------------------------------------------------------------
    loadCachedPreferences() {
      const cached = readLocalCache('preferences', null);
      if (cached) {
        _preferences = { ...DEFAULT_PREFERENCES, ...cached };
      } else {
        try {
          const rawV2 = localStorage.getItem('velvet_preferences_v2');
          if (rawV2) {
            _preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(rawV2) };
          }
        } catch (e) {}
      }
      this.applyPreferencesEffects(_preferences);
    },

    getPreferences() {
      return { ..._preferences };
    },

    async fetchPreferences() {
      if (!this.isAuthenticated()) return _preferences;
      try {
        const res = await this.fetchAuthed('/api/user/preferences');
        if (res.ok) {
          const json = await res.json();
          if (json && json.data) {
            _preferences = { ...DEFAULT_PREFERENCES, ...json.data };
            writeLocalCache('preferences', _preferences);
            this.applyPreferencesEffects(_preferences);
            window.dispatchEvent(new CustomEvent('velvet:preferences-changed', { detail: _preferences }));
          }
        }
      } catch (e) {}
      return _preferences;
    },

    async setPreferences(newPrefs) {
      _preferences = { ..._preferences, ...newPrefs, version: DEFAULT_PREFERENCES.version };
      writeLocalCache('preferences', _preferences);
      try {
        localStorage.setItem('velvet_preferences_v2', JSON.stringify(_preferences));
      } catch (e) {}
      this.applyPreferencesEffects(_preferences);
      window.dispatchEvent(new CustomEvent('velvet:preferences-changed', { detail: _preferences }));

      if (this.isAuthenticated()) {
        try {
          await this.fetchAuthed('/api/user/preferences', {
            method: 'PUT',
            body: JSON.stringify({ data: _preferences, version: DEFAULT_PREFERENCES.version })
          });
        } catch (e) {}
      }
      return _preferences;
    },

    updatePreference(key, value) {
      const updated = { ..._preferences, [key]: value };
      return this.setPreferences(updated);
    },

    applyPreferencesEffects(prefs = null) {
      const p = prefs || _preferences;
      const root = document.documentElement;
      if (p.reduceMotion) root.classList.add('reduce-motion');
      else root.classList.remove('reduce-motion');

      if (p.ambientLighting) root.classList.add('velvet-ambient-on');
      else root.classList.remove('velvet-ambient-on');

      if (p.dataSaver) root.classList.add('velvet-data-saver');
      else root.classList.remove('velvet-data-saver');
    },

    // ------------------------------------------------------------------------
    // FUENTE ÚNICA: la misma lista alimenta pastillas, stats y la bóveda
    // ------------------------------------------------------------------------
    readLegacyList(keys) {
      for (const key of keys) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch (e) {}
      }
      return [];
    },

    hydrateCanonicalCache() {
      const uid = _currentUser && _currentUser.id;
      const favKeys = [];
      const histKeys = [];
      if (uid) {
        favKeys.push(`velvet_usr_${uid}_favs`, `velvet_${uid}_favs`);
        histKeys.push(`velvet_usr_${uid}_history`);
      }
      favKeys.push('velvet_favorites', 'velvet_guest_favs', 'velvet_favs');
      histKeys.push('velvet_history', 'velvet_guest_history');

      const cachedFavs = readLocalCache('favs', null);
      const favList = (Array.isArray(cachedFavs) && cachedFavs.length ? cachedFavs : this.readLegacyList(favKeys))
        .map(compactFavRecord)
        .filter(Boolean);
      if (favList.length) {
        _favState.items = favList;
        _favState.ids = favList.map(f => parseInt(f.id, 10)).filter(n => Number.isInteger(n) && n > 0);
        const storedTotal = Number(readLocalCache('favs_total', favList.length));
        _favState.total = storedTotal > 0 ? storedTotal : favList.length;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        _favState.error = null;
      }

      const cachedHist = readLocalCache('history', null);
      const histList = (Array.isArray(cachedHist) && cachedHist.length ? cachedHist : this.readLegacyList(histKeys))
        .map(compactHistRecord)
        .filter(Boolean)
        .slice(0, 50);
      if (histList.length) {
        _histState.items = histList;
        const storedTotal = Number(readLocalCache('history_total', histList.length));
        _histState.total = storedTotal > 0 ? storedTotal : histList.length;
        _histState.totalPages = Math.max(1, Math.ceil(_histState.total / _histState.pageSize));
        _histState.error = null;
      }
    },

    publishCanonical(kind) {
      if (kind !== 'history') {
        let compactFavs;
        if (Array.isArray(_favState.ids) && _favState.ids.length) {
          const byId = new Map((_favState.items || []).map(it => [String(it.id || it.item_id), it]));
          compactFavs = _favState.ids.map(id => compactFavRecord(byId.get(String(id)) || { id, item_id: id })).filter(Boolean);
          (_favState.refs || []).forEach(ref => {
            const slim = compactFavRecord(ref);
            if (slim && !slim.id) compactFavs.push(slim);
          });
        } else {
          compactFavs = (_favState.items || []).map(compactFavRecord).filter(Boolean);
        }
        writeLocalCache('favs', compactFavs);
        writeLocalCache('favs_total', compactFavs.length);
        try {
          const serialized = JSON.stringify(compactFavs);
          localStorage.setItem('velvet_favorites', serialized);
          localStorage.setItem('velvet_guest_favs', serialized);
          localStorage.setItem('velvet_favs', serialized);
          localStorage.setItem('velvet_fav_ids', serialized);
        } catch (e) {}
      }
      if (kind !== 'favorites') {
        const compactHist = (_histState.items || []).map(compactHistRecord).filter(Boolean).slice(0, 50);
        writeLocalCache('history', compactHist);
        writeLocalCache('history_total', compactHist.length);
        try {
          localStorage.setItem('velvet_history', JSON.stringify(compactHist));
        } catch (e) {}
      }
      this.updateAllCounters();
    },

    // ------------------------------------------------------------------------
    // FAVORITOS: FUENTE DE VERDAD CON PAGINACIÓN REAL
    // ------------------------------------------------------------------------
    getFavorites() {
      return [...(_favState.items || [])];
    },

    getFavoritesState() {
      return {
        items: [..._favState.items],
        total: _favState.total,
        page: _favState.page,
        pageSize: _favState.pageSize,
        totalPages: _favState.totalPages,
        filter: _favState.filter,
        sort: _favState.sort,
        search: _favState.search,
        isLoading: _favState.isLoading,
        error: _favState.error
      };
    },

    async _loadCanonicalFavoriteIds(signal, currentReqId) {
      const idRes = await this.fetchAuthed('/api/user/favorites?ids=1', { signal });
      if (currentReqId !== _favState.requestId) return 'stale';
      if (!idRes) return 'degraded';
      if (idRes.status === 401) return 'auth';
      if (!idRes.ok) return 'degraded';
      const idData = await idRes.json();
      if (!idData || idData.degraded || !Array.isArray(idData.ids)) return 'degraded';

      let serverIds = idData.ids.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0);
      const refs = (Array.isArray(idData.refs) ? idData.refs : []).map(compactFavRecord).filter(Boolean);
      const localCompact = (_favState.items || []).map(compactFavRecord).filter(Boolean);
      const serverSet = new Set(serverIds.map(String));
      const missing = localCompact.filter(f => f.id && !serverSet.has(String(f.id)));
      const serverEmpty = serverIds.length === 0 && refs.length === 0;
      if ((serverEmpty && localCompact.some(f => f.id)) || missing.length > 0) {
        if (!_favState._pushedLocal) {
          const payloadSrc = serverEmpty ? localCompact.filter(f => f.id) : missing;
          const syncRes = await this.fetchAuthed('/api/user/favorites', {
            method: 'POST',
            body: JSON.stringify({
              items: payloadSrc.slice(0, 2000).map(f => ({
                id: f.id,
                item_id: f.id,
                source: f.source || '',
                source_id: f.source_id || '',
                media_type: f.media_type || ''
              }))
            })
          });
          if (syncRes && syncRes.ok) {
            _favState._pushedLocal = true;
            const again = await this.fetchAuthed('/api/user/favorites?ids=1', { signal });
            if (again && again.ok) {
              const againData = await again.json();
              if (againData && Array.isArray(againData.ids) && !againData.degraded) {
                serverIds = againData.ids.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0);
              }
            }
          }
        }
      }

      const details = new Map();
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && page <= 8) {
        const res = await this.fetchAuthed(`/api/user/favorites?page=${page}&pageSize=50`, { signal });
        if (currentReqId !== _favState.requestId) return 'stale';
        if (!res || !res.ok) break;
        const data = await res.json();
        if (!data || data.degraded) break;
        totalPages = data.totalPages || 1;
        (data.items || []).forEach(it => {
          const n = parseInt(it.id || it.item_id, 10);
          if (n > 0) details.set(n, it);
        });
        page++;
      }

      _favState.ids = serverIds;
      _favState.refs = refs.filter(ref => !ref.id);
      _favState.items = serverIds.map(id => details.get(id) || { id, item_id: id });
      _favState.refs.forEach(ref => _favState.items.push(ref));
      _favState.total = _favState.items.length;
      _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
      return 'ok';
    },

    async fetchFavorites(page = 1, options = {}) {
      if (!this.isAuthenticated()) {
        // Invitado: leer de caché de invitado
        const guestFavs = readLocalCache('favs', []);
        _favState.items = (Array.isArray(guestFavs) ? guestFavs : []).map(compactFavRecord).filter(Boolean);
        _favState.total = _favState.items.length;
        _favState.page = 1;
        _favState.totalPages = 1;
        _favState.isLoading = false;
        _favState.error = null;
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        return this.getFavoritesState();
      }

      // Cancelar petición anterior en vuelo si existe
      if (_favState.controller) {
        _favState.controller.abort();
      }
      _favState.controller = new AbortController();
      const currentReqId = ++_favState.requestId;

      _favState.page = Math.max(1, page);
      if (options.filter) _favState.filter = options.filter;
      if (options.sort) _favState.sort = options.sort;
      if (options.search !== undefined) _favState.search = options.search;

      _favState.isLoading = true;
      _favState.error = null;
      window.dispatchEvent(new CustomEvent('velvet:favorites-loading', { detail: { page: _favState.page } }));

      try {
        if (_favState.filter === 'all' && _favState.page === 1) {
          const synced = await this._loadCanonicalFavoriteIds(_favState.controller.signal, currentReqId);
          if (currentReqId !== _favState.requestId) return;
          if (synced === 'auth') {
            _favState.isLoading = false;
            _favState.error = 'Sesión expirada';
            window.dispatchEvent(new CustomEvent('velvet:favorites-error', { detail: { error: _favState.error } }));
            return this.getFavoritesState();
          }
          if (synced === 'ok') {
            _favState.isLoading = false;
            _favState.error = null;
            this.publishCanonical('favorites');
            this.updateSyncStatusText();
            window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
            return this.getFavoritesState();
          }
        }

        const queryParams = new URLSearchParams({
          page: String(_favState.page),
          pageSize: String(_favState.pageSize)
        });
        if (_favState.filter !== 'all') {
          queryParams.set('type', _favState.filter);
        }

        const res = await this.fetchAuthed(`/api/user/favorites?${queryParams.toString()}`, {
          signal: _favState.controller.signal
        });

        // Ignorar respuesta si otra petición más nueva fue disparada
        if (currentReqId !== _favState.requestId) return;

        if (res.status === 401) {
          _favState.isLoading = false;
          _favState.error = 'Sesión expirada';
          window.dispatchEvent(new CustomEvent('velvet:favorites-error', { detail: { error: _favState.error } }));
          return this.getFavoritesState();
        }

        if (!res.ok) {
          throw new Error(`Error en el servidor (${res.status})`);
        }

        const data = await res.json();
        if (data && data.degraded && (!Array.isArray(data.items) || data.items.length === 0) && _favState.items.length > 0) {
          _favState.isLoading = false;
          _favState.error = null;
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }

        const serverItems = Array.isArray(data.items) ? data.items : [];
        const serverTotal = typeof data.total === 'number' ? data.total : serverItems.length;
        const localBefore = _favState.items.slice();

        if (serverTotal === 0 && localBefore.length > 0 && !data.degraded) {
          if (!_favState._pushedLocal) {
            _favState._pushedLocal = true;
            try {
              const syncRes = await this.fetchAuthed('/api/user/favorites', {
                method: 'POST',
                body: JSON.stringify({
                  items: localBefore.map(compactFavRecord).filter(f => f && f.id).slice(0, 2000)
                })
              });
              if (syncRes && syncRes.ok) {
                const again = await this.fetchFavorites(page);
                if (again && again.total > 0) return again;
              }
            } catch (syncErr) {}
          }
          _favState.items = localBefore;
          _favState.total = localBefore.length;
          _favState.totalPages = Math.max(1, Math.ceil(localBefore.length / _favState.pageSize));
          _favState.isLoading = false;
          _favState.error = null;
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }

        _favState.items = serverItems;
        _favState.total = serverTotal;
        _favState.totalPages = data.totalPages || Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        _favState.isLoading = false;
        _favState.error = null;

        this.publishCanonical('favorites');
        this.updateSyncStatusText();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        return this.getFavoritesState();
      } catch (err) {
        if (err.name === 'AbortError') return; // Cancelación normal
        _favState.isLoading = false;
        if (_favState.items && _favState.items.length > 0) {
          _favState.error = null;
          _favState.total = Math.max(_favState.total, _favState.items.length);
          this.publishCanonical('favorites');
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }
        this.hydrateCanonicalCache();
        if (_favState.items && _favState.items.length > 0) {
          _favState.error = null;
          _favState.isLoading = false;
          this.publishCanonical('favorites');
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }
        _favState.error = err.message || 'Error de conexión';
        window.dispatchEvent(new CustomEvent('velvet:favorites-error', { detail: { error: _favState.error, retry: () => this.fetchFavorites(page) } }));
        return this.getFavoritesState();
      }
    },

    async addFavorite(item) {
      if (!item) return;
      const itemId = item.id || item.item_id;
      if (!itemId) return;

      // Optimistic UI: insertar arriba y subir contador
      const prevItems = [..._favState.items];
      const prevTotal = _favState.total;

      const optimisticItem = {
        id: itemId,
        item_id: itemId,
        title: item.title || 'Sin título',
        cover_url: item.cover_url || '/velvet_logo.png',
        media_type: item.media_type || 'comic',
        source: item.source || '',
        source_id: item.source_id || '',
        url: item.url || '',
        available: true,
        created_at: new Date().toISOString()
      };

      const exists = _favState.items.some(f => String(f.id) === String(itemId) || String(f.item_id) === String(itemId));
      if (!exists) {
        _favState.items.unshift(optimisticItem);
        const n = parseInt(itemId, 10);
        if (Number.isInteger(n) && n > 0) {
          _favState.ids = Array.isArray(_favState.ids) ? _favState.ids : [];
          if (!_favState.ids.some(id => String(id) === String(n))) _favState.ids.unshift(n);
        }
        _favState.total++;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
      }

      if (!this.isAuthenticated()) {
        writeLocalCache('favs', _favState.items.map(compactFavRecord).filter(Boolean));
        return;
      }

      try {
        const res = await this.fetchAuthed('/api/user/favorites', {
          method: 'POST',
          body: JSON.stringify({
            id: itemId,
            item_id: itemId,
            source: item.source || '',
            source_id: item.source_id || '',
            media_type: item.media_type || 'video'
          })
        });
        if (!res.ok) {
          throw new Error('No se pudo guardar el favorito');
        }
      } catch (err) {
        // Rollback optimista en caso de fallo
        _favState.items = prevItems;
        _favState.total = prevTotal;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        window.dispatchEvent(new CustomEvent('velvet:toast', { detail: { message: 'Error al conectar con la Bóveda', type: 'error' } }));
      }
    },

    async removeFavorite(itemId) {
      if (!itemId) return null;
      const prevItems = [..._favState.items];
      const prevTotal = _favState.total;

      const removed = _favState.items.find(f => String(f.id) === String(itemId) || String(f.item_id) === String(itemId));
      _favState.items = _favState.items.filter(f => String(f.id) !== String(itemId) && String(f.item_id) !== String(itemId));
      if (Array.isArray(_favState.ids)) {
        _favState.ids = _favState.ids.filter(id => String(id) !== String(itemId));
      }
      _favState.total = Math.max(0, _favState.total - 1);
      _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));

      this.updateAllCounters();
      window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));

      if (!this.isAuthenticated()) {
        writeLocalCache('favs', _favState.items.map(compactFavRecord).filter(Boolean));
        return removed;
      }

      try {
        const res = await this.fetchAuthed(`/api/user/favorites?id=${encodeURIComponent(itemId)}`, {
          method: 'DELETE'
        });
        if (!res.ok) {
          throw new Error('Fallo al eliminar');
        }
      } catch (err) {
        // Rollback si falla la red
        _favState.items = prevItems;
        _favState.total = prevTotal;
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
      }

      return removed;
    },

    async removeFavoritesBatch(itemIds = []) {
      if (!itemIds || itemIds.length === 0) return;
      const idSet = new Set(itemIds.map(String));
      _favState.items = _favState.items.filter(f => !idSet.has(String(f.id)) && !idSet.has(String(f.item_id)));
      if (Array.isArray(_favState.ids)) {
        _favState.ids = _favState.ids.filter(id => !idSet.has(String(id)));
      }
      _favState.total = Math.max(0, _favState.total - itemIds.length);
      _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));

      this.updateAllCounters();
      window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));

      if (!this.isAuthenticated()) {
        writeLocalCache('favs', _favState.items.map(compactFavRecord).filter(Boolean));
        return;
      }

      // Eliminar en paralelo
      await Promise.all(itemIds.map(id => {
        return this.fetchAuthed(`/api/user/favorites?id=${encodeURIComponent(id)}`, {
          method: 'DELETE'
        }).catch(() => {});
      }));
    },

    isFavorite(itemId) {
      if (!itemId) return false;
      const sId = String(itemId);
      if (Array.isArray(_favState.ids) && _favState.ids.some(id => String(id) === sId)) return true;
      return _favState.items.some(f => String(f.id) === sId || String(f.item_id) === sId);
    },

    // ------------------------------------------------------------------------
    // HISTORIAL Y PROGRESO: CONCURRENCIA Y THROTTLING
    // ------------------------------------------------------------------------
    getHistory() {
      return [...(_histState.items || [])];
    },

    getGameSaves() {
      try {
        const prefs = this.getPreferences() || {};
        const savesMap = prefs.game_saves || {};
        return Object.values(savesMap);
      } catch (e) {
        return [];
      }
    },

    getHistoryState() {
      return {
        items: [..._histState.items],
        total: _histState.total,
        page: _histState.page,
        pageSize: _histState.pageSize,
        totalPages: _histState.totalPages,
        filter: _histState.filter,
        onlyUnfinished: _histState.onlyUnfinished,
        search: _histState.search,
        isLoading: _histState.isLoading,
        error: _histState.error
      };
    },

    async fetchHistory(page = 1, options = {}) {
      if (!this.isAuthenticated()) {
        const guestHist = readLocalCache('history', []);
        _histState.items = (Array.isArray(guestHist) ? guestHist : []).map(compactHistRecord).filter(Boolean).slice(0, 50);
        _histState.total = _histState.items.length;
        _histState.page = 1;
        _histState.totalPages = 1;
        _histState.isLoading = false;
        _histState.error = null;
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
        return this.getHistoryState();
      }

      if (_histState.controller) {
        _histState.controller.abort();
      }
      _histState.controller = new AbortController();
      const currentReqId = ++_histState.requestId;

      _histState.page = Math.max(1, page);
      if (options.filter) _histState.filter = options.filter;
      if (options.onlyUnfinished !== undefined) _histState.onlyUnfinished = options.onlyUnfinished;
      if (options.search !== undefined) _histState.search = options.search;

      _histState.isLoading = true;
      _histState.error = null;
      window.dispatchEvent(new CustomEvent('velvet:history-loading', { detail: { page: _histState.page } }));

      try {
        const queryParams = new URLSearchParams({
          page: String(_histState.page),
          pageSize: String(_histState.pageSize)
        });
        if (_histState.filter !== 'all') {
          queryParams.set('type', _histState.filter);
        }

        const res = await this.fetchAuthed(`/api/user/history?${queryParams.toString()}`, {
          signal: _histState.controller.signal
        });

        if (currentReqId !== _histState.requestId) return;

        if (res.status === 401) {
          _histState.isLoading = false;
          _histState.error = 'Sesión expirada';
          window.dispatchEvent(new CustomEvent('velvet:history-error', { detail: { error: _histState.error } }));
          return this.getHistoryState();
        }

        if (!res.ok) throw new Error(`Error en el servidor (${res.status})`);

        const data = await res.json();
        if (data && data.degraded && (!Array.isArray(data.items) || data.items.length === 0) && _histState.items.length > 0) {
          _histState.isLoading = false;
          _histState.error = null;
          this.publishCanonical('history');
          window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
          return this.getHistoryState();
        }
        let serverItems = Array.isArray(data.items) ? data.items : [];
        if (_histState.page === 1 && _histState.filter === 'all' && !data.degraded) {
          const byId = new Map(serverItems.map(h => [String(h.item_id || h.id), h]));
          const localSlim = (_histState.items || []).map(compactHistRecord).filter(Boolean);
          const toPush = localSlim.filter(h => {
            const n = parseInt(h.id || h.item_id, 10);
            if (!Number.isInteger(n) || n <= 0) return false;
            const cur = byId.get(String(n));
            if (!cur) return true;
            return (h.at || 0) > (Number(cur.at) || 0);
          });
          if (toPush.length > 0 && !_histState._pushedLocal) {
            const syncRes = await this.fetchAuthed('/api/user/history', {
              method: 'POST',
              body: JSON.stringify({ items: toPush.slice(0, 100) })
            });
            if (syncRes && syncRes.ok) {
              _histState._pushedLocal = true;
              const again = await this.fetchAuthed(`/api/user/history?${queryParams.toString()}`, {
                signal: _histState.controller.signal
              });
              if (currentReqId !== _histState.requestId) return;
              if (again && again.ok) {
                const againData = await again.json();
                if (againData && !againData.degraded && Array.isArray(againData.items)) serverItems = againData.items;
              }
            }
          }
        }
        _histState.items = serverItems;
        _histState.total = typeof data.total === 'number' ? data.total : _histState.items.length;
        _histState.totalPages = data.totalPages || Math.max(1, Math.ceil(_histState.total / _histState.pageSize));
        _histState.isLoading = false;
        _histState.error = null;

        writeLocalCache('hist_total', _histState.total);
        _lastSyncTimestamp = Date.now();
        this.publishCanonical('history');

        this.updateAllCounters();
        this.updateSyncStatusText();
        window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
        return this.getHistoryState();
      } catch (err) {
        if (err.name === 'AbortError') return;
        _histState.isLoading = false;
        if (_histState.items && _histState.items.length > 0) {
          _histState.error = null;
          _histState.total = Math.max(_histState.total, _histState.items.length);
          this.publishCanonical('history');
          window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
          return this.getHistoryState();
        }
        _histState.error = err.message || 'Error de conexión';
        window.dispatchEvent(new CustomEvent('velvet:history-error', { detail: { error: _histState.error, retry: () => this.fetchHistory(page) } }));
        return this.getHistoryState();
      }
    },

    recordProgress(item, progressData = {}, forceImmediate = false) {
      if (!item) return;
      if (_preferences.pauseHistory) {
        // Privacidad activa: descartar silenciosamente
        return;
      }

      const itemId = item.id || item.item_id;
      if (!itemId) return;

      const sId = String(itemId);
      const now = Date.now();

      // Throttling: máximo 1 petición cada 20 segundos para un mismo item,
      // salvo que sea una pausa, cambio de capítulo o cierre forzado.
      const lastSent = _progressThrottle.get(sId) || 0;
      const isThrottled = (now - lastSent) < 20000;

      const pos = Math.max(0, parseInt(progressData.position ?? progressData.page ?? progressData.currentTime ?? 0, 10));
      const dur = Math.max(0, parseInt(progressData.duration ?? progressData.total ?? 0, 10));
      const comp = Boolean(progressData.completed);

      // Actualizar memoria inmediata
      _progressMap.set(sId, { position: pos, duration: dur, completed: comp, at: now });

      // Actualizar primer item en lista de historial en memoria si está visible
      const existingIdx = _histState.items.findIndex(h => String(h.id) === sId || String(h.item_id) === sId);
      const newEntry = {
        id: itemId,
        item_id: itemId,
        title: item.title || 'Sin título',
        cover_url: item.cover_url || '/velvet_logo.png',
        media_type: item.media_type || (dur > 0 && pos > 10 ? 'video' : 'comic'),
        source: item.source || '',
        source_id: item.source_id || '',
        url: item.url || '',
        position: pos,
        duration: dur,
        completed: comp,
        last_activity: new Date(now).toISOString(),
        at: now,
        available: true
      };

      if (existingIdx !== -1) {
        _histState.items.splice(existingIdx, 1);
      }
      _histState.items.unshift(newEntry);
      if (_histState.items.length > 50) _histState.items.pop();

      // Disparar evento para la fila "Continuar Leyendo" del home
      window.dispatchEvent(new CustomEvent('velvet:continue-shelf-updated', { detail: this.getContinueShelfItems() }));

      if (!this.isAuthenticated()) {
        writeLocalCache('history', _histState.items.map(compactHistRecord).filter(Boolean));
        return;
      }

      if (!forceImmediate && isThrottled && !comp) {
        return;
      }

      _progressThrottle.set(sId, now);

      // Envío asíncrono seguro
      this.fetchAuthed('/api/user/history', {
        method: 'POST',
        body: JSON.stringify({
          item_id: itemId,
          media_type: newEntry.media_type,
          position: pos,
          duration: dur,
          completed: comp,
          client_timestamp: now
        })
      }).catch(() => {});
    },

    flushPendingProgress() {
      // Usar fetch keepalive para enviar datos antes del cierre de pestaña
      if (!this.isAuthenticated() || _preferences.pauseHistory) return;
      if (_histState.items.length === 0) return;

      const topItem = _histState.items[0];
      if (!topItem) return;

      try {
        const payload = JSON.stringify({
          item_id: topItem.id || topItem.item_id,
          media_type: topItem.media_type,
          position: topItem.position || 0,
          duration: topItem.duration || 0,
          completed: !!topItem.completed,
          client_timestamp: Date.now()
        });

        fetch('/api/user/history', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: payload,
          keepalive: true,
          credentials: 'include'
        }).catch(() => {});
      } catch (e) {}
    },

    async removeHistoryItem(itemId) {
      if (!itemId) return;
      const sId = String(itemId);
      _histState.items = _histState.items.filter(h => String(h.id) !== sId && String(h.item_id) !== sId);
      _histState.total = Math.max(0, _histState.total - 1);
      _progressMap.delete(sId);

      this.updateAllCounters();
      window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
      window.dispatchEvent(new CustomEvent('velvet:continue-shelf-updated', { detail: this.getContinueShelfItems() }));

      if (!this.isAuthenticated()) {
        writeLocalCache('history', _histState.items.map(compactHistRecord).filter(Boolean));
        return;
      }

      try {
        await this.fetchAuthed(`/api/user/history?id=${encodeURIComponent(itemId)}`, {
          method: 'DELETE'
        });
      } catch (e) {}
    },

    async clearAllHistory() {
      _histState.items = [];
      _histState.total = 0;
      _histState.page = 1;
      _histState.totalPages = 1;
      _progressMap.clear();

      this.updateAllCounters();
      window.dispatchEvent(new CustomEvent('velvet:history-updated', { detail: this.getHistoryState() }));
      window.dispatchEvent(new CustomEvent('velvet:continue-shelf-updated', { detail: [] }));

      if (!this.isAuthenticated()) {
        writeLocalCache('history', []);
        return;
      }

      try {
        await this.fetchAuthed('/api/user/history?clear=all', {
          method: 'DELETE'
        });
      } catch (e) {}
    },

    getContinueShelfItems() {
      // Devuelve los primeros 8 elementos no terminados para el carrusel de Home
      return _histState.items
        .filter(it => !it.completed)
        .slice(0, 8);
    },

    // ------------------------------------------------------------------------
    // MIGRACIÓN IDEMPOTENTE DESDE LOCALSTORAGE A POSTGRESQL
    // ------------------------------------------------------------------------
    async migrateLocalDataToServer() {
      if (!this.isAuthenticated()) return;
      const uid = _currentUser.id;
      const migrationFlag = `velvet_migrated_${uid}`;
      if (localStorage.getItem(migrationFlag)) return;

      try {
        // 1. Recopilar datos heredados del navegador
        let legacyFavs = [];
        let legacyHist = [];

        try {
          const rawFavs = localStorage.getItem('velvet_favorites') || localStorage.getItem('velvet_guest_favs');
          if (rawFavs) legacyFavs = JSON.parse(rawFavs);
        } catch (e) {}

        try {
          const rawHist = localStorage.getItem('velvet_history') || localStorage.getItem('velvet_guest_history');
          if (rawHist) legacyHist = JSON.parse(rawHist);
        } catch (e) {}

        legacyFavs = (Array.isArray(legacyFavs) ? legacyFavs : []).map(compactFavRecord).filter(Boolean);
        legacyHist = (Array.isArray(legacyHist) ? legacyHist : []).map(compactHistRecord).filter(Boolean);

        // Si no hay datos locales, marcar como completado directamente
        if (legacyFavs.length === 0 && legacyHist.length === 0) {
          localStorage.setItem(migrationFlag, String(Date.now()));
          return;
        }

        // 2. Crear respaldo local preventivo por 30 días
        const backupKey = `${BACKUP_PREFIX}${Date.now()}`;
        const backupPayload = {
          userId: uid,
          createdAt: Date.now(),
          expiresAt: Date.now() + BACKUP_RETENTION_MS,
          favorites: legacyFavs,
          history: legacyHist,
          preferences: _preferences
        };
        localStorage.setItem(backupKey, JSON.stringify(backupPayload));

        // 3. Enviar a Supabase mediante endpoints batch
        if (legacyFavs.length > 0) {
          await this.fetchAuthed('/api/user/favorites', {
            method: 'POST',
            body: JSON.stringify({ items: legacyFavs })
          }).catch(() => {});
        }

        if (legacyHist.length > 0) {
          await this.fetchAuthed('/api/user/history', {
            method: 'POST',
            body: JSON.stringify({ items: legacyHist })
          }).catch(() => {});
        }

        localStorage.setItem(migrationFlag, String(Date.now()));

        window.dispatchEvent(new CustomEvent('velvet:toast', {
          detail: {
            message: `Sincronizados ${legacyFavs.length} favoritos y ${legacyHist.length} registros de historial con tu cuenta.`,
            type: 'success'
          }
        }));

        // Refrescar datos reales
        this.fetchFavorites(1);
        this.fetchHistory(1);
      } catch (err) {
        console.warn('[VelvetData] Error en migración local:', err);
      }
    },

    cleanupOldBackups() {
      try {
        const now = Date.now();
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(BACKUP_PREFIX)) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const b = JSON.parse(raw);
              if (b.expiresAt && now > b.expiresAt) {
                localStorage.removeItem(key);
              }
            }
          }
        }
      } catch (e) {}
    },

    // ------------------------------------------------------------------------
    // ACTUALIZACIÓN UNIFICADA DE CONTADORES EN LA UI
    // ------------------------------------------------------------------------
    updateAllCounters() {
      const favCount = String(Math.max(0, Number(_favState.total) || 0));
      const histCount = String(Math.max(0, Number(_histState.total) || 0));

      // Menú de usuario (dropdown en global header)
      const dropFavCount = document.getElementById('dropdown-fav-count');
      if (dropFavCount) dropFavCount.textContent = favCount;

      const modalFavBadge = document.getElementById('vault-fav-badge-count');
      if (modalFavBadge) modalFavBadge.textContent = favCount;

      // Badges laterales y móviles de la Bóveda (/boveda/favoritos)
      document.querySelectorAll('.vault-fav-counter').forEach(el => {
        el.textContent = favCount;
      });

      document.querySelectorAll('.vault-hist-counter').forEach(el => {
        el.textContent = histCount;
      });

      const statsFav = document.getElementById('vault-stats-favs');
      const statsHist = document.getElementById('vault-stats-hist');
      if (statsFav) statsFav.textContent = favCount;
      if (statsHist) statsHist.textContent = histCount;

      // Sincronizar window.state para módulos heredados
      if (window.state) {
        if (Array.isArray(_favState.ids) && _favState.ids.length) {
          const byId = new Map((_favState.items || []).map(it => [String(it.id || it.item_id), it]));
          window.state.favorites = _favState.ids.map(id => byId.get(String(id)) || { id, item_id: id });
        } else {
          window.state.favorites = _favState.items;
        }
        window.state.history = _histState.items;
      }
    },

    updateSyncStatusText() {
      const el = document.getElementById('vault-sync-status-text') || document.querySelector('.vault-sync-text');
      if (!el) return;
      if (_lastSyncTimestamp) {
        const d = new Date(_lastSyncTimestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.textContent = `Sincronizado hoy a las ${timeStr}`;
      } else {
        el.textContent = 'Sincronizado con la nube';
      }
    },

    async refreshAll() {
      await Promise.all([
        this.fetchFavorites(_favState.page),
        this.fetchHistory(_histState.page),
        this.fetchPreferences()
      ]);
    }
  };

  // Inicializar singleton
  VelvetPersonalData.init();
  window.VelvetPersonalData = VelvetPersonalData;

})(typeof window !== 'undefined' ? window : this);
