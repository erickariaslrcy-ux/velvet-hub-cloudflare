"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { imgSrc } from "@/lib/img";

interface ComicReaderProps {
  itemId: number;
  title: string;
  pageCount: number;
  chapterIdx?: number;
}

type ReadMode = "cascade" | "single" | "double";
type ViewWidth = "narrow" | "medium" | "wide" | "full";

export default function ComicReader({ itemId, title, pageCount, chapterIdx }: ComicReaderProps) {
  const [mode, setMode] = useState<ReadMode>("cascade");
  const [width, setWidth] = useState<ViewWidth>("medium");
  const [seamless, setSeamless] = useState<boolean>(true);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [showThumbnails, setShowThumbnails] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [loadedPages, setLoadedPages] = useState<Record<number, boolean>>({});
  const [errorPages, setErrorPages] = useState<Record<number, boolean>>({});
  const [retryKeys, setRetryKeys] = useState<Record<number, number>>({});
  const [isHudVisible, setIsHudVisible] = useState<boolean>(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollY = useRef<number>(0);
  const isInteractingRef = useRef<boolean>(false);
  const selectedThumbRef = useRef<HTMLButtonElement | null>(null);

  // Touch swipe refs for mobile gestures
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  // Auto-hide HUD logic
  const resetAutoHideTimer = useCallback((delay = 3200) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setIsHudVisible(true);
    if (isInteractingRef.current || showThumbnails) return;

    hideTimerRef.current = setTimeout(() => {
      if (!isInteractingRef.current && !showThumbnails) {
        setIsHudVisible(false);
      }
    }, delay);
  }, [showThumbnails]);

  const toggleHud = useCallback(() => {
    setIsHudVisible((prev) => {
      const next = !prev;
      if (next) resetAutoHideTimer(4000);
      else if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return next;
    });
  }, [resetAutoHideTimer]);

  // Initial timer on mount
  useEffect(() => {
    resetAutoHideTimer(4000);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [resetAutoHideTimer]);

  // User activity listeners: mouse move, touch, scroll
  useEffect(() => {
    const handleMouseMove = () => {
      resetAutoHideTimer(3200);
    };

    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const delta = currentScrollY - lastScrollY.current;

      // In cascade mode: compute progress and current visible page
      if (mode === "cascade") {
        const el = document.documentElement;
        const totalScroll = el.scrollHeight - el.clientHeight;
        if (totalScroll > 0) {
          const pct = Math.min(100, Math.max(0, (currentScrollY / totalScroll) * 100));
          setProgress(pct);
        }

        const scrollMiddle = window.scrollY + window.innerHeight / 3;
        for (let i = 0; i < pageRefs.current.length; i++) {
          const pageEl = pageRefs.current[i];
          if (pageEl) {
            const top = pageEl.offsetTop;
            const height = pageEl.offsetHeight;
            if (scrollMiddle >= top && scrollMiddle < top + height) {
              setCurrentPage(i + 1);
              break;
            }
          }
        }
      }

      // Hide HUD on rapid scroll down; reveal on scroll up
      if (delta > 35 && currentScrollY > 150) {
        setIsHudVisible(false);
      } else if (delta < -25) {
        resetAutoHideTimer(3200);
      }

      lastScrollY.current = currentScrollY;
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("scroll", handleScroll);
    };
  }, [mode, resetAutoHideTimer]);

  // Progress update for single / double mode
  useEffect(() => {
    if (mode !== "cascade") {
      setProgress((currentPage / Math.max(1, pageCount)) * 100);
    }
  }, [mode, currentPage, pageCount]);

  // Precarga ultra-rápida inicial de las primeras páginas al montar el lector
  useEffect(() => {
    const initialBatch = Math.min(pageCount, 8);
    for (let p = 1; p <= initialBatch; p++) {
      const img = new Image();
      img.decoding = "async";
      img.src = imgSrc(itemId, p, chapterIdx);
    }
  }, [itemId, pageCount, chapterIdx]);

  // Precarga proactiva continua adelantada según posición actual (Cascada, 1 Pág, Doble)
  useEffect(() => {
    const lookahead = mode === "cascade" ? 8 : 4;
    const start = currentPage;
    const end = Math.min(pageCount, start + lookahead);
    for (let p = start; p <= end; p++) {
      const img = new Image();
      img.decoding = "async";
      img.src = imgSrc(itemId, p, chapterIdx);
    }
    if (currentPage > 1) {
      const prevImg = new Image();
      prevImg.decoding = "async";
      prevImg.src = imgSrc(itemId, currentPage - 1, chapterIdx);
    }
  }, [currentPage, mode, itemId, pageCount, chapterIdx]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight" || e.key === "PageDown" || key === "d") {
        if (mode === "single") {
          e.preventDefault();
          nextPage();
        } else if (mode === "double") {
          e.preventDefault();
          nextDoublePage();
        }
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || key === "a") {
        if (mode === "single") {
          e.preventDefault();
          prevPage();
        } else if (mode === "double") {
          e.preventDefault();
          prevDoublePage();
        }
      } else if (key === "f") {
        e.preventDefault();
        toggleFullscreen();
      } else if (key === "h") {
        e.preventDefault();
        toggleHud();
      } else if (key === "m") {
        e.preventDefault();
        setMode((m) => (m === "cascade" ? "single" : m === "single" ? "double" : "cascade"));
        resetAutoHideTimer(3000);
      } else if (key === "t") {
        e.preventDefault();
        setShowThumbnails((v) => !v);
      } else if (e.key === "Home") {
        e.preventDefault();
        jumpToPage(1);
      } else if (e.key === "End") {
        e.preventDefault();
        jumpToPage(pageCount);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, currentPage, pageCount, toggleHud, resetAutoHideTimer]);

  // Scroll active thumbnail into view when opened or page changes
  useEffect(() => {
    if (showThumbnails && selectedThumbRef.current) {
      selectedThumbRef.current.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  }, [showThumbnails, currentPage]);

  const nextPage = () => {
    setCurrentPage((p) => Math.min(pageCount, p + 1));
    resetAutoHideTimer(2500);
  };

  const prevPage = () => {
    setCurrentPage((p) => Math.max(1, p - 1));
    resetAutoHideTimer(2500);
  };

  const nextDoublePage = () => {
    setCurrentPage((p) => Math.min(pageCount, p + 2));
    resetAutoHideTimer(2500);
  };

  const prevDoublePage = () => {
    setCurrentPage((p) => Math.max(1, p - 2));
    resetAutoHideTimer(2500);
  };

  const jumpToPage = (num: number) => {
    const target = Math.min(Math.max(1, num), pageCount);
    setCurrentPage(target);

    if (mode === "cascade") {
      const el = pageRefs.current[target - 1];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    resetAutoHideTimer(2500);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
    resetAutoHideTimer(3000);
  };

  const retryImage = (pageIdx: number) => {
    setErrorPages((prev) => ({ ...prev, [pageIdx]: false }));
    setRetryKeys((prev) => ({ ...prev, [pageIdx]: (prev[pageIdx] || 0) + 1 }));
  };

  // Touch swipe detection for mobile single page mode
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;

    // Detect horizontal swipe with minimal vertical drift
    if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      if (mode === "single") {
        if (deltaX < 0) {
          nextPage();
        } else {
          prevPage();
        }
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  // Ancho en píxeles según modo
  const widthClass = {
    narrow: "max-w-narrow",
    medium: "max-w-medium",
    wide: "max-w-wide",
    full: "max-w-full",
  }[width];

  return (
    <div className="pro-reader-wrapper" ref={containerRef}>
      {/* 1. Barra de progreso luminoso ultra-delgada superior */}
      <div className="reader-progress-track">
        <div className="reader-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* 2. Top Bar HUD (Header flotante con auto-ocultación) */}
      <header
        className={`reader-top-bar glass ${isHudVisible ? "hud-visible" : "hud-hidden"}`}
        onMouseEnter={() => {
          isInteractingRef.current = true;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={() => {
          isInteractingRef.current = false;
          resetAutoHideTimer(2000);
        }}
      >
        <div className="reader-top-inner">
          <div className="reader-top-left">
            <button
              className="reader-icon-btn back-btn"
              onClick={() => {
                const el = document.getElementById("top") || document.body;
                el.scrollIntoView({ behavior: "smooth" });
              }}
              title="Volver a los detalles del cómic"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              <span className="back-text">Volver</span>
            </button>

            <div className="reader-title-chip" title={title}>
              <span className="dot pulse" />
              <span className="title-text">{title}</span>
            </div>
          </div>

          <div className="reader-top-center">
            {/* Indicador y Selector rápido de página */}
            <div className="reader-page-picker">
              <span className="picker-label">Página</span>
              <select
                className="reader-page-select"
                value={currentPage}
                onChange={(e) => jumpToPage(Number(e.target.value))}
                onFocus={() => { isInteractingRef.current = true; }}
                onBlur={() => { isInteractingRef.current = false; resetAutoHideTimer(2000); }}
              >
                {Array.from({ length: pageCount }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1} / {pageCount}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="reader-top-right">
            {/* Botón de tira de miniaturas */}
            <button
              className={`reader-icon-btn ${showThumbnails ? "active" : ""}`}
              onClick={() => {
                setShowThumbnails((v) => !v);
                resetAutoHideTimer(4000);
              }}
              title="Ver miniaturas (T)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
              </svg>
              <span className="btn-label-desktop">Tira</span>
            </button>

            {/* Pantalla completa */}
            <button
              className="reader-icon-btn"
              onClick={toggleFullscreen}
              title="Pantalla completa (F)"
            >
              {isFullscreen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* 3. Bottom Dock HUD (Barra inferior con controles táctiles y slider) */}
      <footer
        className={`reader-bottom-dock glass ${isHudVisible ? "hud-visible" : "hud-hidden"}`}
        onMouseEnter={() => {
          isInteractingRef.current = true;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={() => {
          isInteractingRef.current = false;
          resetAutoHideTimer(2000);
        }}
      >
        <div className="reader-bottom-inner">
          {/* Fila 1: Scrubber slider para pasar páginas velozmente */}
          <div className="scrubber-row">
            <button
              className="scrubber-step-btn"
              onClick={mode === "double" ? prevDoublePage : prevPage}
              disabled={currentPage <= 1}
              title="Página anterior"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            <div className="scrubber-slider-wrap">
              <input
                type="range"
                min="1"
                max={pageCount}
                value={currentPage}
                onChange={(e) => jumpToPage(Number(e.target.value))}
                onMouseDown={() => { isInteractingRef.current = true; }}
                onMouseUp={() => { isInteractingRef.current = false; resetAutoHideTimer(2500); }}
                onTouchStart={() => { isInteractingRef.current = true; }}
                onTouchEnd={() => { isInteractingRef.current = false; resetAutoHideTimer(2500); }}
                className="scrubber-slider"
              />
              <div className="scrubber-info">
                <span>Pág <strong>{currentPage}</strong> de {pageCount}</span>
                <span className="scrubber-pct">{Math.round(progress)}%</span>
              </div>
            </div>

            <button
              className="scrubber-step-btn"
              onClick={mode === "double" ? nextDoublePage : nextPage}
              disabled={currentPage >= pageCount}
              title="Página siguiente"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>

          {/* Fila 2: Selectores de Modo de lectura y Opciones de visualización */}
          <div className="dock-actions-row">
            <div className="mode-segmented-control">
              <button
                className={`mode-seg-btn ${mode === "cascade" ? "active" : ""}`}
                onClick={() => { setMode("cascade"); resetAutoHideTimer(2500); }}
                title="Modo Cascada (Webtoon vertical continuo)"
              >
                📜 Cascada
              </button>
              <button
                className={`mode-seg-btn ${mode === "single" ? "active" : ""}`}
                onClick={() => { setMode("single"); resetAutoHideTimer(2500); }}
                title="Modo 1 Página (Pasa con deslizamiento táctil o flechas)"
              >
                📖 1 Pág
              </button>
              <button
                className={`mode-seg-btn ${mode === "double" ? "active" : ""} hide-mobile`}
                onClick={() => { setMode("double"); resetAutoHideTimer(2500); }}
                title="Modo Doble Página (Estilo Manga)"
              >
                📑 Doble
              </button>
            </div>

            {/* Controles para modo cascada */}
            {mode === "cascade" && (
              <div className="cascade-options-group">
                <button
                  className={`option-toggle-btn ${seamless ? "active" : ""}`}
                  onClick={() => setSeamless((v) => !v)}
                  title={seamless ? "Sin separación entre paneles" : "Con margen entre páginas"}
                >
                  {seamless ? "🔗 Continuo" : "🔲 Margen"}
                </button>

                <div className="width-segmented-control hide-mobile">
                  {(["narrow", "medium", "wide", "full"] as ViewWidth[]).map((w) => (
                    <button
                      key={w}
                      className={`width-seg-btn ${width === w ? "active" : ""}`}
                      onClick={() => setWidth(w)}
                    >
                      {w === "narrow" ? "680" : w === "medium" ? "880" : w === "wide" ? "1100" : "Max"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </footer>

      {/* 4. Mini-Chip Discreto Flotante (Visible sólo cuando el HUD está oculto) */}
      <button
        className={`reader-discreet-pill ${!isHudVisible ? "show" : "hide"}`}
        onClick={toggleHud}
        title="Toca para mostrar controles"
      >
        <span className="dot pulse" />
        <span>{currentPage} / {pageCount}</span>
      </button>

      {/* 5. Drawer inferior con Tira de Miniaturas */}
      {showThumbnails && (
        <div
          className="thumbnails-bottom-sheet glass"
          onMouseEnter={() => { isInteractingRef.current = true; }}
          onMouseLeave={() => { isInteractingRef.current = false; }}
        >
          <div className="thumbnails-sheet-header">
            <h4>Miniaturas ({pageCount} páginas)</h4>
            <button
              className="sheet-close-btn"
              onClick={() => setShowThumbnails(false)}
            >
              ✕
            </button>
          </div>
          <div className="thumbnails-scroll-lane">
            {Array.from({ length: pageCount }, (_, i) => {
              const pNum = i + 1;
              const isSelected = pNum === currentPage;
              return (
                <button
                  key={pNum}
                  ref={isSelected ? selectedThumbRef : null}
                  className={`thumb-card ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    jumpToPage(pNum);
                    if (mode !== "cascade") setShowThumbnails(false);
                  }}
                >
                  <img
                    src={imgSrc(itemId, pNum, chapterIdx)}
                    alt={`Pág ${pNum}`}
                    loading="lazy"
                  />
                  <span className="thumb-badge">{pNum}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 6. Canvas de Lectura Principal */}
      <div className={`reader-canvas ${widthClass} mode-${mode} ${seamless ? "seamless-flow" : "spaced-flow"}`}>
        {/* ================================================================= */}
        {/* MODO 1: CASCADA VERTICAL (WEBTOON)                                */}
        {/* ================================================================= */}
        {mode === "cascade" && (
          <div className="cascade-pages-flow" onClick={() => resetAutoHideTimer(3200)}>
            {Array.from({ length: pageCount }, (_, i) => {
              const pNum = i + 1;
              const hasError = errorPages[pNum];
              const retryKey = retryKeys[pNum] || 0;
              const src = `${imgSrc(itemId, pNum, chapterIdx)}${retryKey ? `&retry=${retryKey}` : ""}`;

              return (
                <div
                  key={`cascade-${chapterIdx}-${pNum}-${retryKey}`}
                  ref={(el) => {
                    pageRefs.current[i] = el;
                  }}
                  className="cascade-page-card"
                  id={`page-${pNum}`}
                >
                  {!seamless && <div className="page-ribbon-tag">Página {pNum}</div>}

                  {hasError ? (
                    <div className="image-error-card glass">
                      <p>⚠️ No se pudo cargar la página {pNum}</p>
                      <button
                        className="btn btn-primary btn-small"
                        onClick={(e) => {
                          e.stopPropagation();
                          retryImage(pNum);
                        }}
                      >
                        🔄 Reintentar
                      </button>
                    </div>
                  ) : (
                    <div className="reader-image-frame">
                      {!loadedPages[pNum] && (
                        <div className="reader-shimmer-placeholder">
                          <div className="shimmer-spinner" />
                          <span>Cargando pág {pNum}...</span>
                        </div>
                      )}
                      <img
                        src={src}
                        alt={`${title} - Página ${pNum}`}
                        loading={i < 5 ? "eager" : "lazy"}
                        decoding="async"
                        fetchPriority={i < 3 ? "high" : "auto"}
                        onLoad={() => setLoadedPages((p) => ({ ...p, [pNum]: true }))}
                        onError={() => setErrorPages((p) => ({ ...p, [pNum]: true }))}
                        className={`reader-image ${loadedPages[pNum] ? "loaded" : "loading"}`}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ================================================================= */}
        {/* MODO 2: PÁGINA INDIVIDUAL CON GESTOS TÁCTILES Y ZONAS DE CLIC     */}
        {/* ================================================================= */}
        {mode === "single" && (
          <div
            className="single-page-flow"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <div className="single-stage-container">
              {/* Zona de clic Izquierda: Página anterior (25% ancho) */}
              <div
                className="tap-zone zone-left"
                onClick={prevPage}
                title="Página anterior (Toque o flecha izquierda)"
              >
                <div className="tap-hint left">‹</div>
              </div>

              {/* Zona de clic Central: Alternar HUD (50% ancho) */}
              <div
                className="tap-zone zone-center"
                onClick={toggleHud}
                title="Toque central: Mostrar/Ocultar controles"
              />

              {/* Zona de clic Derecha: Página siguiente (25% ancho) */}
              <div
                className="tap-zone zone-right"
                onClick={nextPage}
                title="Página siguiente (Toque o flecha derecha)"
              >
                <div className="tap-hint right">›</div>
              </div>

              {errorPages[currentPage] ? (
                <div className="image-error-card glass">
                  <p>⚠️ Error al cargar la página {currentPage}</p>
                  <button
                    className="btn btn-primary"
                    onClick={() => retryImage(currentPage)}
                  >
                    🔄 Reintentar
                  </button>
                </div>
              ) : (
                <div className="single-image-box">
                  {!loadedPages[currentPage] && (
                    <div className="reader-shimmer-placeholder single-view">
                      <div className="shimmer-spinner" />
                      <span>Cargando página {currentPage}...</span>
                    </div>
                  )}
                  <img
                    key={`single-${currentPage}-${retryKeys[currentPage] || 0}`}
                    src={`${imgSrc(itemId, currentPage, chapterIdx)}${retryKeys[currentPage] ? `&retry=${retryKeys[currentPage]}` : ""}`}
                    alt={`${title} - Página ${currentPage}`}
                    decoding="async"
                    fetchPriority="high"
                    className={`reader-image single ${loadedPages[currentPage] ? "loaded" : "loading"}`}
                    onLoad={() => setLoadedPages((p) => ({ ...p, [currentPage]: true }))}
                    onError={() => setErrorPages((p) => ({ ...p, [currentPage]: true }))}
                  />
                </div>
              )}
            </div>

            {/* Barra de navegación inferior clásica para ratón */}
            <div className="single-mouse-nav">
              <button
                className="btn btn-secondary"
                disabled={currentPage <= 1}
                onClick={prevPage}
              >
                ← Anterior
              </button>
              <span className="single-counter-text">
                Página <strong>{currentPage}</strong> de {pageCount}
              </span>
              <button
                className="btn btn-primary"
                disabled={currentPage >= pageCount}
                onClick={nextPage}
              >
                Siguiente →
              </button>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* MODO 3: DOBLE PÁGINA (ESTILO MANGA PARA PANTALLAS AMPLIAS)        */}
        {/* ================================================================= */}
        {mode === "double" && (
          <div className="double-page-flow">
            <div className="double-images-grid">
              <div className="double-page-col" onClick={toggleHud}>
                <div className="page-ribbon-tag">Pág {currentPage}</div>
                <img
                  src={imgSrc(itemId, currentPage, chapterIdx)}
                  alt={`Página ${currentPage}`}
                  className="reader-image"
                  onError={() => setErrorPages((p) => ({ ...p, [currentPage]: true }))}
                />
              </div>

              {currentPage + 1 <= pageCount && (
                <div className="double-page-col" onClick={toggleHud}>
                  <div className="page-ribbon-tag">Pág {currentPage + 1}</div>
                  <img
                    src={imgSrc(itemId, currentPage + 1, chapterIdx)}
                    alt={`Página ${currentPage + 1}`}
                    className="reader-image"
                    onError={() => setErrorPages((p) => ({ ...p, [currentPage + 1]: true }))}
                  />
                </div>
              )}
            </div>

            <div className="single-mouse-nav">
              <button
                className="btn btn-secondary"
                disabled={currentPage <= 1}
                onClick={prevDoublePage}
              >
                ← Anteriores
              </button>
              <span className="single-counter-text">
                Páginas <strong>{currentPage}</strong> - <strong>{Math.min(pageCount, currentPage + 1)}</strong> de {pageCount}
              </span>
              <button
                className="btn btn-primary"
                disabled={currentPage >= pageCount - 1}
                onClick={nextDoublePage}
              >
                Siguientes →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Botón flotante para subir arriba */}
      <button
        className="scroll-to-top-btn glass"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        title="Subir arriba"
      >
        ▲
      </button>
    </div>
  );
}
