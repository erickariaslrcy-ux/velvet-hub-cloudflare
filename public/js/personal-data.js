/**
 * ============================================================================
 * VELVET HUB - MOTOR UNIFICADO DE DATOS PERSONALES (v3.2)
 * public/js/personal-data.js
 * 
 * ÚNICA FUENTE DE VERDAD PARA TODA LA APLICACIÓN:
 * - Favoritos, Historial, Continuar Leyendo, Progreso y Preferencias.
 * - Sincronización multi-dispositivo respaldada por PostgreSQL/Supabase.
 * - Paginación real adaptativa: máx 18 items/pág en PC y máx 12 en Android/móvil.
 * - Aislamiento estricto por cuenta (claves de caché con user_id).
 * - Migración idempotente de datos locales heredados (con respaldo 30 días).
 * - Concurrencia segura: AbortController y descartes de peticiones obsoletas.
 * - Throttling de progreso (15-30s / pausa / cierre con keepalive).
 * ============================================================================
 */

(function (window) {
  'use strict';

  const PERSONAL_PAGE_SIZE_DESKTOP = 18;
  const PERSONAL_PAGE_SIZE_MOBILE = 12;

  function getPersonalPageSize() {
    try {
      const isAndroidUa = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
      const isMobileViewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth < 768;
      return (isAndroidUa || isMobileViewport) ? PERSONAL_PAGE_SIZE_MOBILE : PERSONAL_PAGE_SIZE_DESKTOP;
    } catch (e) {
      return PERSONAL_PAGE_SIZE_DESKTOP;
    }
  }

  const PERSONAL_PAGE_SIZE = getPersonalPageSize();
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

  function parseStrictPositiveInt(val) {
    const s = String(val ?? '').trim();
    if (!/^\d{1,15}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  function cleanPersonalCachedTitle(raw) {
    return String(raw || '')
      .replace(/\{[^}]{1,90}\}/g, ' ')
      .replace(/[\[\(（【][^\]\)）】]{0,80}\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb|p|pics?|photos?|fotos?|imgs?|videos?)\b[^\]\)）】]{0,50}(?:[\]\)）】]|$)/gi, ' ')
      .replace(/[\[\(（【]\s*\d+\s*photo[^\])]*$/gi, ' ')
      .replace(/\]\s*\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\b(?:peso\s*:?\s*)?\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—|:·]+|[\s\-–—|:·]+$/g, '')
      .trim()
      .slice(0, 140);
  }

  function compactFavRecord(f) {
    if (!f || typeof f !== 'object') return null;
    const id = parseStrictPositiveInt(f.id || f.item_id);
    const hasId = id !== null;
    if (!hasId && !(f.source && f.source_id) && !(f.id || f.item_id)) return null;
    const out = {};
    if (hasId) {
      out.id = id;
      out.item_id = id;
    } else if (f.id || f.item_id) {
      out.id = String(f.id || f.item_id).slice(0, 120);
      out.item_id = String(f.item_id || f.id).slice(0, 120);
    }
    if (f.source) out.source = String(f.source).slice(0, 40);
    if (f.source_id != null && f.source_id !== '') out.source_id = String(f.source_id).slice(0, 80);
    if (f.media_type) out.media_type = String(f.media_type).slice(0, 16);
    if (f.title) out.title = cleanPersonalCachedTitle(f.title);
    if (f.cover_url) out.cover_url = String(f.cover_url).slice(0, 500);
    if (f.url) out.url = String(f.url).slice(0, 500);
    return out;
  }

  function compactHistRecord(h) {
    if (!h || typeof h !== 'object') return null;
    const id = parseStrictPositiveInt(h.id || h.item_id);
    const hasId = id !== null;
    if (!hasId && !(h.source && h.source_id) && !(h.id || h.item_id)) return null;
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
    } else if (h.id || h.item_id) {
      out.id = h.id || h.item_id;
      out.item_id = h.item_id || h.id;
    }
    if (h.source) out.source = String(h.source).slice(0, 40);
    if (h.source_id != null && h.source_id !== '') out.source_id = String(h.source_id).slice(0, 80);
    if (h.title) out.title = cleanPersonalCachedTitle(h.title);
    if (h.cover_url) out.cover_url = String(h.cover_url).slice(0, 500);
    if (h.url) out.url = String(h.url).slice(0, 500);
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
      'velvet_device_token',
      'velvet_favorites',
      'velvet_guest_favs',
      'velvet_fav_ids',
      'velvet_history',
      'velvet_guest_history',
      'velvet_guest_progress',
      'velvet_guest_data_cleared'
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
    getPersonalPageSize,

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
      _favState._pushedLocal = false;

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
      const hasCookie = typeof document !== 'undefined' && typeof document.cookie === 'string' && document.cookie.includes('velvet_auth_active=1');
      return !!(_currentUser && _currentUser.id && (token || refresh || hasCookie));
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
      const pageSize = getPersonalPageSize();
      _favState.pageSize = pageSize;
      _histState.pageSize = pageSize;

      const uid = _currentUser && _currentUser.id;
      const favKeys = uid
        ? [`velvet_usr_${uid}_favs`, `velvet_${uid}_favs`]
        : ['velvet_guest_favs', 'velvet_favorites', 'velvet_favs'];
      const histKeys = uid
        ? [`velvet_usr_${uid}_history`]
        : ['velvet_guest_history', 'velvet_history'];

      const cachedFavs = readLocalCache('favs', null);
      const favList = (Array.isArray(cachedFavs) && cachedFavs.length ? cachedFavs : this.readLegacyList(favKeys))
        .map(compactFavRecord)
        .filter(Boolean);
      if (favList.length) {
        _favState.items = favList;
        _favState.ids = favList.map(f => parseStrictPositiveInt(f.id)).filter(n => n !== null);
        _favState.refs = favList.filter(f => !parseStrictPositiveInt(f.id));
        const storedTotal = Number(readLocalCache('favs_total', favList.length));
        _favState.total = storedTotal > 0 ? storedTotal : favList.length;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        _favState.error = null;
      }

      const cachedHist = readLocalCache('history', null);
      const histList = (Array.isArray(cachedHist) && cachedHist.length ? cachedHist : this.readLegacyList(histKeys))
        .map(compactHistRecord)
        .filter(Boolean)
        .slice(0, 100);
      if (histList.length) {
        _histState.items = histList;
        const storedTotal = Number(readLocalCache('history_total', histList.length));
        _histState.total = storedTotal > 0 ? storedTotal : histList.length;
        _histState.totalPages = Math.max(1, Math.ceil(_histState.total / _histState.pageSize));
        _histState.error = null;
      }
    },

    publishCanonical(kind) {
      const isAuthedUser = !!(_currentUser && _currentUser.id);
      if (kind !== 'history') {
        const seenKeys = new Set();
        const compactFavs = [];
        const pushCompact = (raw) => {
          const slim = compactFavRecord(raw);
          if (!slim) return;
          const k = (slim.source && slim.source_id) ? `${slim.source}:${slim.source_id}` : String(slim.id || slim.item_id || '');
          if (!k || seenKeys.has(k)) return;
          seenKeys.add(k);
          compactFavs.push(slim);
        };
        (_favState.items || []).forEach(pushCompact);
        if (Array.isArray(_favState.ids)) {
          const byId = new Map((_favState.items || []).map(it => [String(it.id || it.item_id), it]));
          _favState.ids.forEach(id => pushCompact(byId.get(String(id)) || { id, item_id: id }));
        }
        (_favState.refs || []).forEach(pushCompact);

        writeLocalCache('favs', compactFavs);
        writeLocalCache('favs_total', Math.max(_favState.total || 0, compactFavs.length));
        if (!isAuthedUser) {
          try {
            const serialized = JSON.stringify(compactFavs);
            localStorage.setItem('velvet_favorites', serialized);
            localStorage.setItem('velvet_guest_favs', serialized);
            localStorage.setItem('velvet_favs', serialized);
            localStorage.setItem('velvet_fav_ids', serialized);
          } catch (e) {}
        }
      }
      if (kind !== 'favorites') {
        const compactHist = (_histState.items || []).map(compactHistRecord).filter(Boolean).slice(0, 50);
        writeLocalCache('history', compactHist);
        writeLocalCache('history_total', Math.max(_histState.total || 0, compactHist.length));
        if (!isAuthedUser) {
          try {
            localStorage.setItem('velvet_history', JSON.stringify(compactHist));
          } catch (e) {}
        }
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

      let serverIds = idData.ids.map(parseStrictPositiveInt).filter(n => n !== null);
      let refs = (Array.isArray(idData.refs) ? idData.refs : []).map(compactFavRecord).filter(Boolean);
      const localCompact = (_favState.items || []).map(compactFavRecord).filter(Boolean);
      const serverSet = new Set([
        ...serverIds.map(String),
        ...refs.map(r => (r.source && r.source_id) ? `${r.source}:${r.source_id}` : String(r.id || r.item_id || ''))
      ].filter(Boolean));
      const missing = localCompact.filter(f => {
        const numId = parseStrictPositiveInt(f.id || f.item_id);
        if (numId && serverSet.has(String(numId))) return false;
        const srcKey = (f.source && f.source_id) ? `${f.source}:${f.source_id}` : String(f.id || f.item_id || '');
        if (srcKey && serverSet.has(srcKey)) return false;
        return Boolean(numId || (f.source && f.source_id) || f.id || f.item_id);
      });
      const serverEmpty = serverIds.length === 0 && refs.length === 0;
      if ((serverEmpty && localCompact.length > 0) || missing.length > 0) {
        if (!_favState._pushedLocal) {
          const payloadSrc = serverEmpty ? localCompact : missing;
          const syncRes = await this.fetchAuthed('/api/user/favorites', {
            method: 'POST',
            body: JSON.stringify({
              items: payloadSrc.slice(0, 2000).map(f => ({
                id: f.id || f.item_id,
                item_id: f.id || f.item_id,
                source: f.source || '',
                source_id: f.source_id || '',
                media_type: f.media_type || '',
                title: f.title || '',
                cover_url: f.cover_url || '',
                url: f.url || ''
              }))
            })
          });
          if (syncRes && syncRes.ok) {
            _favState._pushedLocal = true;
            const again = await this.fetchAuthed('/api/user/favorites?ids=1', { signal });
            if (again && again.ok) {
              const againData = await again.json();
              if (againData && Array.isArray(againData.ids) && !againData.degraded) {
                serverIds = againData.ids.map(parseStrictPositiveInt).filter(n => n !== null);
                refs = (Array.isArray(againData.refs) ? againData.refs : []).map(compactFavRecord).filter(Boolean);
              }
            }
          }
        }
      }

      _favState.ids = serverIds;
      _favState.refs = refs.filter(ref => !parseStrictPositiveInt(ref.id));
      return 'ok';
    },

    async fetchFavorites(page = 1, options = {}) {
      const pageSize = getPersonalPageSize();
      _favState.pageSize = pageSize;

      if (!this.isAuthenticated()) {
        // Invitado: leer de caché de invitado con paginación adaptativa (18 PC / 12 Android)
        const guestFavs = readLocalCache('favs', []);
        const allGuestFavs = (Array.isArray(guestFavs) ? guestFavs : []).map(compactFavRecord).filter(Boolean);
        _favState.items = allGuestFavs;
        _favState.total = allGuestFavs.length;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / pageSize));
        _favState.page = Math.min(Math.max(1, parseInt(page, 10) || 1), _favState.totalPages);
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

      _favState.page = Math.max(1, parseInt(page, 10) || 1);
      if (options.filter) _favState.filter = options.filter;
      if (options.sort) _favState.sort = options.sort;
      if (options.search !== undefined) _favState.search = options.search;

      _favState.isLoading = true;
      _favState.error = null;
      this.updateSyncStatusText();
      window.dispatchEvent(new CustomEvent('velvet:favorites-loading', { detail: { page: _favState.page } }));

      try {
        const queryParams = new URLSearchParams({
          page: String(_favState.page),
          pageSize: String(_favState.pageSize)
        });
        if (_favState.filter !== 'all') {
          queryParams.set('type', _favState.filter);
        }

        // Petición directa a la página solicitada (18 PC / 12 Android), en paralelo con canonical IDs si aplica
        const [res, canonResult] = await Promise.all([
          this.fetchAuthed(`/api/user/favorites?${queryParams.toString()}`, {
            signal: _favState.controller.signal
          }),
          (_favState.filter === 'all' && _favState.page === 1 && (!_favState.ids || !_favState.ids.length))
            ? this._loadCanonicalFavoriteIds(_favState.controller.signal, currentReqId).catch(() => 'degraded')
            : Promise.resolve('ok')
        ]);

        // Ignorar respuesta si otra petición más nueva fue disparada
        if (currentReqId !== _favState.requestId) return;

        if (res.status === 401 || canonResult === 'auth') {
          _favState.isLoading = false;
          _favState.error = 'Sesión expirada';
          this.updateSyncStatusText();
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
          _lastSyncTimestamp = Date.now();
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          this.updateAllCounters();
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
                  items: localBefore.map(compactFavRecord).filter(f => f && (f.id || f.item_id)).slice(0, 2000)
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
          _lastSyncTimestamp = Date.now();
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          this.updateAllCounters();
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }

        _favState.items = serverItems.slice(0, _favState.pageSize);
        _favState.total = serverTotal;
        _favState.totalPages = data.totalPages || Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        _favState.page = Math.min(_favState.page, _favState.totalPages);
        _favState.isLoading = false;
        _favState.error = null;
        _lastSyncTimestamp = Date.now();

        this.publishCanonical('favorites');
        this.updateSyncStatusText();
        this.updateAllCounters();
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        return this.getFavoritesState();
      } catch (err) {
        if (err.name === 'AbortError') return; // Cancelación normal
        _favState.isLoading = false;
        if (_favState.items && _favState.items.length > 0) {
          _favState.error = null;
          _favState.total = Math.max(_favState.total, _favState.items.length);
          _lastSyncTimestamp = Date.now();
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          this.updateAllCounters();
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }
        this.hydrateCanonicalCache();
        if (_favState.items && _favState.items.length > 0) {
          _favState.error = null;
          _favState.isLoading = false;
          _lastSyncTimestamp = Date.now();
          this.publishCanonical('favorites');
          this.updateSyncStatusText();
          this.updateAllCounters();
          window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
          return this.getFavoritesState();
        }
        _favState.error = err.message || 'Error de conexión';
        this.updateSyncStatusText();
        window.dispatchEvent(new CustomEvent('velvet:favorites-error', { detail: { error: _favState.error, retry: () => this.fetchFavorites(page) } }));
        return this.getFavoritesState();
      }
    },

    async addFavorite(item) {
      if (!item) return false;
      const itemId = item.id || item.item_id || item.source_id || null;
      const hasSourcePair = Boolean(item.source && item.source_id);
      if (!itemId && !hasSourcePair) return false;

      // Optimistic UI: insertar arriba y subir contador
      const prevItems = [..._favState.items];
      const prevIds = Array.isArray(_favState.ids) ? [..._favState.ids] : _favState.ids;
      const prevRefs = Array.isArray(_favState.refs) ? [..._favState.refs] : [];
      const prevTotal = _favState.total;

      const optimisticItem = {
        id: itemId || `${item.source}:${item.source_id}`,
        item_id: itemId || `${item.source}:${item.source_id}`,
        title: item.title || 'Sin título',
        cover_url: item.cover_url || '/velvet_logo.png',
        media_type: item.media_type || 'comic',
        source: item.source || '',
        source_id: item.source_id || '',
        url: item.url || '',
        available: true,
        created_at: new Date().toISOString()
      };

      const matchesSame = (f) => {
        if (!f) return false;
        if (itemId && (String(f.id) === String(itemId) || String(f.item_id) === String(itemId))) return true;
        return hasSourcePair && f.source === item.source && String(f.source_id) === String(item.source_id);
      };

      const exists = _favState.items.some(matchesSame);
      if (!exists) {
        _favState.items.unshift(optimisticItem);
        const n = parseStrictPositiveInt(itemId);
        if (n) {
          _favState.ids = Array.isArray(_favState.ids) ? _favState.ids : [];
          if (!_favState.ids.some(id => String(id) === String(n))) _favState.ids.unshift(n);
        } else {
          _favState.refs = Array.isArray(_favState.refs) ? _favState.refs : [];
          if (!_favState.refs.some(matchesSame)) _favState.refs.unshift(compactFavRecord(optimisticItem) || optimisticItem);
        }
        _favState.total++;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        this.publishCanonical('favorites');
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
      }

      if (!this.isAuthenticated()) {
        writeLocalCache('favs', _favState.items.map(compactFavRecord).filter(Boolean));
        return true;
      }

      try {
        const res = await this.fetchAuthed('/api/user/favorites', {
          method: 'POST',
          body: JSON.stringify({
            id: item.id || item.item_id || null,
            item_id: item.item_id || item.id || null,
            source: item.source || '',
            source_id: item.source_id || '',
            media_type: item.media_type || 'video',
            title: item.title || '',
            cover_url: item.cover_url || '',
            url: item.url || ''
          })
        });
        if (!res || !res.ok) {
          throw new Error('No se pudo guardar el favorito');
        }
        this.publishCanonical('favorites');
        return true;
      } catch (err) {
        // Rollback optimista en caso de fallo
        _favState.items = prevItems;
        _favState.ids = prevIds;
        _favState.refs = prevRefs;
        _favState.total = prevTotal;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        this.publishCanonical('favorites');
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        window.dispatchEvent(new CustomEvent('velvet:toast', { detail: { message: 'Error al guardar favorito en tu cuenta', type: 'error' } }));
        return false;
      }
    },

    async removeFavorite(itemOrId) {
      if (!itemOrId) return null;
      const isObj = typeof itemOrId === 'object';
      const itemId = isObj ? (itemOrId.id || itemOrId.item_id || null) : itemOrId;
      const source = isObj ? (itemOrId.source || '') : '';
      const sourceId = isObj ? (itemOrId.source_id || '') : '';
      if (!itemId && !(source && sourceId)) return null;

      const prevItems = [..._favState.items];
      const prevIds = Array.isArray(_favState.ids) ? [..._favState.ids] : _favState.ids;
      const prevRefs = Array.isArray(_favState.refs) ? [..._favState.refs] : [];
      const prevTotal = _favState.total;

      const matchesTarget = (f) => {
        if (!f) return false;
        if (itemId && (String(f.id) === String(itemId) || String(f.item_id) === String(itemId))) return true;
        return Boolean(source && sourceId && f.source === source && String(f.source_id) === String(sourceId));
      };

      const removed = _favState.items.find(matchesTarget) || (isObj ? itemOrId : { id: itemId });
      _favState.items = _favState.items.filter(f => !matchesTarget(f));
      if (Array.isArray(_favState.ids) && itemId) {
        _favState.ids = _favState.ids.filter(id => String(id) !== String(itemId));
      }
      if (Array.isArray(_favState.refs)) {
        _favState.refs = _favState.refs.filter(r => !matchesTarget(r));
      }
      _favState.total = Math.max(0, _favState.total - 1);
      _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));

      this.publishCanonical('favorites');
      window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));

      if (!this.isAuthenticated()) {
        writeLocalCache('favs', _favState.items.map(compactFavRecord).filter(Boolean));
        return removed;
      }

      try {
        const qp = new URLSearchParams();
        if (itemId) qp.set('id', String(itemId));
        if (source) qp.set('source', String(source));
        if (sourceId) qp.set('source_id', String(sourceId));
        const res = await this.fetchAuthed(`/api/user/favorites?${qp.toString()}`, {
          method: 'DELETE'
        });
        if (!res || !res.ok) {
          throw new Error('Fallo al eliminar');
        }
        return removed;
      } catch (err) {
        // Rollback si falla la red
        _favState.items = prevItems;
        _favState.ids = prevIds;
        _favState.refs = prevRefs;
        _favState.total = prevTotal;
        _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));
        this.publishCanonical('favorites');
        window.dispatchEvent(new CustomEvent('velvet:favorites-updated', { detail: this.getFavoritesState() }));
        window.dispatchEvent(new CustomEvent('velvet:toast', { detail: { message: 'Error al quitar favorito en la nube', type: 'error' } }));
        return false;
      }
    },

    async removeFavoritesBatch(itemIds = []) {
      if (!itemIds || itemIds.length === 0) return;
      const idSet = new Set(itemIds.map(String));
      _favState.items = _favState.items.filter(f => !idSet.has(String(f.id)) && !idSet.has(String(f.item_id)));
      if (Array.isArray(_favState.ids)) {
        _favState.ids = _favState.ids.filter(id => !idSet.has(String(id)));
      }
      if (Array.isArray(_favState.refs)) {
        _favState.refs = _favState.refs.filter(r => !idSet.has(String(r.id)) && !idSet.has(String(r.item_id)));
      }
      _favState.total = Math.max(0, _favState.total - itemIds.length);
      _favState.totalPages = Math.max(1, Math.ceil(_favState.total / _favState.pageSize));

      this.publishCanonical('favorites');
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

    isFavorite(itemOrId, source = '', sourceId = '') {
      const isObj = itemOrId && typeof itemOrId === 'object';
      const itemId = isObj ? (itemOrId.id || itemOrId.item_id || '') : (itemOrId || '');
      const src = isObj ? (itemOrId.source || '') : (source || '');
      const srcId = isObj ? (itemOrId.source_id || '') : (sourceId || '');
      const sId = String(itemId || '');
      if (sId && Array.isArray(_favState.ids) && _favState.ids.some(id => String(id) === sId)) return true;
      const matchEntry = (f) => {
        if (!f) return false;
        if (sId && (String(f.id) === sId || String(f.item_id) === sId)) return true;
        return Boolean(src && srcId && f.source === src && String(f.source_id) === String(srcId));
      };
      if (Array.isArray(_favState.refs) && _favState.refs.some(matchEntry)) return true;
      return _favState.items.some(matchEntry);
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
      const pageSize = getPersonalPageSize();
      _histState.pageSize = pageSize;

      if (!this.isAuthenticated()) {
        const guestHist = readLocalCache('history', []);
        const guestHistList = (Array.isArray(guestHist) ? guestHist : []).map(compactHistRecord).filter(Boolean).slice(0, 100);
        _histState.items = guestHistList;
        _histState.total = guestHistList.length;
        _histState.totalPages = Math.max(1, Math.ceil(_histState.total / pageSize));
        _histState.page = Math.min(Math.max(1, parseInt(page, 10) || 1), _histState.totalPages);
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

      _histState.page = Math.max(1, parseInt(page, 10) || 1);
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
        _histState.items = serverItems.slice(0, _histState.pageSize);
        _histState.total = typeof data.total === 'number' ? data.total : _histState.items.length;
        _histState.totalPages = data.totalPages || Math.max(1, Math.ceil(_histState.total / _histState.pageSize));
        _histState.page = Math.min(_histState.page, _histState.totalPages);
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
          id: itemId,
          media_type: newEntry.media_type,
          position: pos,
          duration: dur,
          completed: comp,
          client_timestamp: now,
          source: item.source || '',
          source_id: item.source_id || '',
          title: item.title || '',
          cover_url: item.cover_url || '',
          url: item.url || ''
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
          id: topItem.id || topItem.item_id,
          media_type: topItem.media_type,
          position: topItem.position || 0,
          duration: topItem.duration || 0,
          completed: !!topItem.completed,
          client_timestamp: Date.now(),
          source: topItem.source || '',
          source_id: topItem.source_id || '',
          title: topItem.title || '',
          cover_url: topItem.cover_url || '',
          url: topItem.url || ''
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
      const favCount = String(Math.max(0, Number(_favState.total) || (_favState.items ? _favState.items.length : 0)));
      const histCount = String(Math.max(0, Number(_histState.total) || (_histState.items ? _histState.items.length : 0)));

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
      if (_favState.isLoading || _histState.isLoading) {
        el.innerHTML = '<span class="inline-flex items-center gap-1.5 text-pink-300"><i class="fa-solid fa-arrows-rotate animate-spin text-pink-400"></i> Sincronizando con la nube...</span>';
        return;
      }
      if (_lastSyncTimestamp) {
        const d = new Date(_lastSyncTimestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.innerHTML = `<span class="inline-flex items-center gap-1.5"><i class="fa-solid fa-cloud-check text-emerald-400"></i> Sincronizado hoy a las ${timeStr}</span>`;
      } else {
        el.innerHTML = '<span class="inline-flex items-center gap-1.5"><i class="fa-solid fa-cloud-arrow-up text-pink-400"></i> Sincronizado con la nube</span>';
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
