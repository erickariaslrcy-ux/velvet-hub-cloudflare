// Carga de portadas a prueba de abortos, caché y colas trabadas.
// Las tarjetas nacen en opacity-0 y solo se revelan en onload. Si la imagen
// ya está en caché, el evento load a veces no vuelve a dispararse y el
// skeleton se queda para siempre. Este módulo decide reveal / retry / fallback.
(function (root) {
  const SLOW_TYPES = ["slow-2g", "2g", "3g"];

  function coverWatchdogMs(nav) {
    const conn = nav && nav.connection;
    const slow = !!(conn && (conn.saveData || SLOW_TYPES.indexOf(conn.effectiveType) !== -1));
    return slow ? 20000 : 20000;
  }

  function coverLoadDecision(state) {
    const retries = state.retries || 0;
    const watchdogMs = state.watchdogMs || 8000;
    const elapsedMs = state.elapsedMs || 0;
    if (state.settled) return "done";
    if (state.failed) return retries < 1 ? "retry" : "fallback";
    if (state.complete && state.naturalWidth > 0) return "reveal";
    if (state.complete && !(state.naturalWidth > 0)) return retries < 1 ? "retry" : "fallback";
    if (elapsedMs >= watchdogMs) return retries < 1 ? "retry" : "fallback";
    return "wait";
  }

  function stripResizeParams(url) {
    if (!url || url.indexOf("data:") === 0) return url || "";
    try {
      const u = new URL(url, "https://velvet.local");
      u.searchParams.delete("w");
      u.searchParams.delete("q");
      u.searchParams.delete("fmt");
      u.searchParams.delete("retry");
      if (/^https?:\/\//i.test(url)) return u.href;
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  function revealCover(img, instant) {
    if (!img || img.dataset.coverSettled === "1") return;
    img.dataset.coverSettled = "1";
    if (instant && img.style) img.style.transition = "none";
    if (img.classList) {
      img.classList.remove("opacity-0");
      img.classList.add("opacity-100");
      img.classList.add("is-loaded");
    }
    if (instant && img.style) {
      void img.offsetWidth;
      img.style.transition = "";
    }
    const parent = img.parentElement;
    const nodes = [];
    if (parent && parent.querySelectorAll) {
      parent.querySelectorAll(".skeleton-shimmer, .velvet-skeleton, .velvet-logo-ph").forEach((sk) => nodes.push(sk));
    } else if (img.previousElementSibling) {
      nodes.push(img.previousElementSibling);
    }
    nodes.forEach((sk) => {
      if (!sk || !sk.classList) return;
      if (!(sk.classList.contains("skeleton-shimmer") || sk.classList.contains("velvet-skeleton") || sk.classList.contains("velvet-logo-ph"))) return;
      if (instant) {
        try { sk.remove(); } catch (e) {}
      } else if (sk.style) {
        sk.style.opacity = "0";
        setTimeout(() => { try { sk.remove(); } catch (e) {} }, 220);
      }
    });
  }

  function bindCover(img, onFallback, watchdogMs) {
    if (!img || img.dataset.coverWatch === "1") return;
    img.dataset.coverWatch = "1";
    const original = img.getAttribute("src") || "";
    const type = img.dataset.mediaType || "comic";
    let retries = 0;
    let settled = false;
    let suppressError = false;
    let watchGen = 0;

    const fallback = () => {
      if (settled) return;
      settled = true;
      img.dataset.coverFinal = "1";
      if (typeof onFallback === "function") onFallback(img, type);
      revealCover(img, true);
    };

    const armWatchdog = () => {
      const gen = ++watchGen;
      setTimeout(() => {
        if (gen !== watchGen || settled || img.dataset.coverSettled === "1") return;
        apply({
          failed: false,
          complete: !!img.complete,
          naturalWidth: img.naturalWidth || 0,
          elapsedMs: watchdogMs
        });
      }, watchdogMs);
    };

    const retry = () => {
      retries += 1;
      if (!(original && original.indexOf("data:") !== 0)) return false;
      const plain = stripResizeParams(original);
      const cf = img.dataset.coverFallback || "";
      let next = "";
      if (cf && !img.dataset.fallbackUsed && cf !== img.src) {
        img.dataset.fallbackUsed = "1";
        next = cf;
      } else if (plain && plain !== original && plain !== img.src) {
        next = plain;
      } else {
        const sep = original.indexOf("?") === -1 ? "?" : "&";
        next = original + sep + "retry=" + retries;
      }
      suppressError = true;
      img.src = next;
      const failedNow = !!(img.complete && !(img.naturalWidth > 0));
      suppressError = false;
      armWatchdog();
      if (failedNow) apply({ failed: true, complete: true, naturalWidth: 0, elapsedMs: 0 });
      return true;
    };

    const apply = (snapshot) => {
      if (settled) return;
      const decision = coverLoadDecision({
        settled: false,
        failed: !!snapshot.failed,
        complete: snapshot.complete != null ? !!snapshot.complete : !!img.complete,
        naturalWidth: snapshot.naturalWidth != null ? snapshot.naturalWidth : (img.naturalWidth || 0),
        elapsedMs: snapshot.elapsedMs || 0,
        retries,
        watchdogMs
      });
      if (decision === "reveal") {
        settled = true;
        revealCover(img, !!snapshot.instant);
        return;
      }
      if (decision === "retry") {
        if (retry()) return;
        fallback();
        return;
      }
      if (decision === "fallback") fallback();
    };

    img.addEventListener("load", () => {
      apply({ failed: false, complete: true, naturalWidth: img.naturalWidth || 0, elapsedMs: 0, instant: false });
    });
    img.addEventListener("error", () => {
      if (suppressError || settled) return;
      apply({ failed: true, complete: true, naturalWidth: 0, elapsedMs: 0 });
    });

    if (img.complete) {
      apply({
        failed: !(img.naturalWidth > 0),
        complete: true,
        naturalWidth: img.naturalWidth || 0,
        elapsedMs: img.naturalWidth > 0 ? 0 : watchdogMs,
        instant: img.naturalWidth > 0
      });
    }

    armWatchdog();
  }

  function settleCoverImages(rootEl, onFallback) {
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
    const nav = (typeof navigator !== "undefined") ? navigator : (root.navigator || null);
    const watchdogMs = coverWatchdogMs(nav);
    const imgs = rootEl.querySelectorAll("img.card-cover-img");
    for (let i = 0; i < imgs.length; i++) bindCover(imgs[i], onFallback, watchdogMs);
  }

  const api = { coverLoadDecision, coverWatchdogMs, settleCoverImages, stripResizeParams };
  root.VelvetCovers = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
