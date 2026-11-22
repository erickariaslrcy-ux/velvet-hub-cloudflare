/**
 * Sesión del reproductor: un token monótono y un AbortController.
 * Cualquier callback de una carga vieja debe salir sin tocar src ni play().
 */
(function (root) {
  'use strict';

  function createVideoLoadGuard() {
    let token = 0;
    let active = false;
    let controller = null;

    return {
      start() {
        token += 1;
        active = true;
        if (controller) {
          try { controller.abort(); } catch (e) {}
        }
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        return {
          token: token,
          signal: controller ? controller.signal : null
        };
      },
      stop() {
        token += 1;
        active = false;
        if (controller) {
          try { controller.abort(); } catch (e) {}
          controller = null;
        }
        return token;
      },
      current() {
        return active ? token : 0;
      },
      matches(ticket) {
        return active && Number(ticket) === token && token !== 0;
      }
    };
  }

  function teardownVideoElement(video) {
    if (!video) return;
    // display:none no corta el audio. Silenciar antes de soltar el src
    // evita que un play() tardío deje el video sonando en otra página.
    try { video.muted = true; } catch (e) {}
    try { video.volume = 0; } catch (e) {}
    try { video.pause(); } catch (e) {}
    try { video.removeAttribute('src'); } catch (e) {}
    try { video.src = ''; } catch (e) {}
    let sources = [];
    try {
      if (typeof video.querySelectorAll === 'function') {
        sources = video.querySelectorAll('source') || [];
      }
    } catch (e) {}
    if (sources && typeof sources.forEach === 'function') {
      sources.forEach((node) => {
        try { node.remove(); } catch (e) {}
      });
    }
    try { video.poster = ''; } catch (e) {}
    try { video.load(); } catch (e) {}
  }

  function shouldApplyVideoResult(guard, ticket) {
    return !!(guard && guard.matches(ticket));
  }

  const api = { createVideoLoadGuard, teardownVideoElement, shouldApplyVideoResult };
  root.VelvetVideoSession = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
