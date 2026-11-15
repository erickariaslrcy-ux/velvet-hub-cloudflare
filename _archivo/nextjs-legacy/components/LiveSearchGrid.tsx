"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import FavButton from "./FavButton";
import { imgSrc } from "@/lib/img";
import { itemMatchesQuery } from "@/lib/search";
import type { CardItem } from "@/lib/types";

interface LiveSearchGridProps {
  initialItems: CardItem[];
  initialTotal: number;
  initialFavs: number[];
  q: string;
  admin?: boolean;
  realSourceMap?: Record<string, string>;
  isRandomFeed?: boolean;
}

export default function LiveSearchGrid({
  initialItems,
  initialTotal,
  initialFavs,
  q,
  admin,
  realSourceMap = {},
  isRandomFeed = false,
}: LiveSearchGridProps) {
  const [items, setItems] = useState<CardItem[]>(initialItems);
  const [favSet, setFavSet] = useState<Set<number>>(() => new Set(initialFavs));
  const [isSearching, setIsSearching] = useState<boolean>(!!q.trim());
  const [searchDone, setSearchDone] = useState<boolean>(false);
  const [isLoadingRandom, setIsLoadingRandom] = useState<boolean>(false);

  // Sincronizar cuando cambien initialItems al navegar
  useEffect(() => {
    setItems(initialItems);
    setFavSet(new Set(initialFavs));
    setSearchDone(false);
  }, [initialItems, initialFavs]);

  // Búsqueda en vivo: sólo cuando hay término de búsqueda q
  useEffect(() => {
    if (!q.trim()) {
      setIsSearching(false);
      setSearchDone(false);
      return;
    }

    let isMounted = true;
    setIsSearching(true);
    setSearchDone(false);

    fetch(`/api/live-search?q=${encodeURIComponent(q.trim())}`)
      .then((res) => {
        if (!res.ok) throw new Error("Error en búsqueda");
        return res.json();
      })
      .then((data) => {
        if (!isMounted) return;
        setIsSearching(false);
        setSearchDone(true);

        if (data.ok && Array.isArray(data.items)) {
          // Filtrado estricto: descartar cualquier resultado que no contenga la búsqueda
          const incoming: CardItem[] = data.items.filter((it: CardItem) =>
            itemMatchesQuery(it, q)
          );

          setItems((prev) => {
            const combined = [...incoming, ...prev];
            const seenIds = new Set<number>();
            const seenTitles = new Set<string>();
            const strictlyMatching: CardItem[] = [];

            for (const item of combined) {
              const cleanT = item.title.toLowerCase().trim();
              if (
                !seenIds.has(item.id) &&
                !seenTitles.has(cleanT) &&
                itemMatchesQuery(item, q)
              ) {
                seenIds.add(item.id);
                seenTitles.add(cleanT);
                strictlyMatching.push(item);
              }
            }

            return strictlyMatching;
          });
        }
      })
      .catch((err) => {
        console.error("[LiveSearchGrid] Error:", err);
        if (isMounted) {
          setIsSearching(false);
          setSearchDone(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [q]);

  // Cargar 20 nuevos cómics aleatorios del pool
  const handleLoadNewRandom = async () => {
    setIsLoadingRandom(true);
    try {
      const res = await fetch("/api/random-items");
      if (!res.ok) throw new Error("Error obteniendo cómics al azar");
      const data = await res.json();
      if (data.ok && Array.isArray(data.items)) {
        setItems(data.items);
        const topEl = document.getElementById("catalog-top");
        if (topEl) {
          topEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    } catch (err) {
      console.error("[LiveSearchGrid] Error cargando aleatorios:", err);
    } finally {
      setIsLoadingRandom(false);
    }
  };

  const totalDisplay = items.length;

  return (
    <div className="live-search-container">
      {/* Barra de estado limpia y profesional */}
      <div className="search-status-bar glass card">
        <div className="status-count">
          <span className="count-number">{totalDisplay.toLocaleString("es")}</span>
          <span className="count-label">
            {isRandomFeed
              ? "cómics recomendados al azar"
              : `resultados para “${q}”`}
          </span>
        </div>

        {/* Acciones en la barra de estado */}
        <div className="status-actions">
          {isRandomFeed && (
            <button
              className="btn btn-secondary btn-small"
              onClick={handleLoadNewRandom}
              disabled={isLoadingRandom}
            >
              🎲 {isLoadingRandom ? "Cargando..." : "Cambiar por otros 20"}
            </button>
          )}

          {q && (
            <div className="status-indicator">
              {isSearching ? (
                <div className="status-pill searching">
                  <span className="spinner-icon">⚡</span>
                  <span>Buscando cómics para <strong>&ldquo;{q}&rdquo;</strong>...</span>
                </div>
              ) : searchDone ? (
                <div className="status-pill success">
                  <span>✓</span>
                  <span>{totalDisplay} cómics encontrados</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Pantalla de carga inicial durante búsqueda */}
      {isSearching && items.length === 0 ? (
        <div className="search-skeleton-box card glass">
          <div className="skeleton-icon pulse">🔍 ⚡</div>
          <h3>Buscando cómics de &ldquo;{q}&rdquo;...</h3>
          <p className="muted small">
            Explorando los títulos disponibles en el catálogo en tiempo real.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-catalog card glass">
          <div className="empty-icon">📂</div>
          <h3>No se encontraron cómics para &ldquo;{q}&rdquo;</h3>
          <p className="muted small">
            Intenta buscar con otra palabra clave, nombre de personaje o término general.
          </p>
        </div>
      ) : (
        <>
          {/* Grilla de Cómics */}
          <div className="grid">
            {items.map((it) => (
              <div key={it.id} className="item-card glass">
                <Link href={`/item/${it.id}`} className="card-link-wrapper">
                  <div className="card-cover-box">
                    {it.has_cover ? (
                      <img
                        src={imgSrc(it.id)}
                        alt={it.title}
                        loading="lazy"
                        className="card-cover-img"
                      />
                    ) : (
                      <div className="card-cover-placeholder">
                        <span>📖</span>
                      </div>
                    )}

                    <div className="card-top-badges">
                      {it.page_count > 0 && (
                        <span className="badge badge-pages">
                          📑 {it.page_count}p
                        </span>
                      )}
                    </div>

                    <div className="card-gradient-overlay" />
                  </div>

                  <div className="card-body">
                    <h3 className="card-title" title={it.title}>
                      {it.title}
                    </h3>

                    <div className="card-footer-meta">
                      <span className="badge badge-source">
                        {it.media_type === "manga" ? "Manga" : "Cómic"}
                      </span>
                      {it.source_label && (
                        <span className="badge badge-subtle">
                          {it.source_label}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>

                <div className="card-fav-anchor">
                  <FavButton id={it.id} initial={favSet.has(it.id)} />
                </div>
              </div>
            ))}
          </div>

          {/* Botón inferior para cargar otros 20 al azar en el feed principal */}
          {isRandomFeed && (
            <div className="random-refresh-bottom">
              <button
                className="btn btn-primary btn-cta btn-random-load"
                onClick={handleLoadNewRandom}
                disabled={isLoadingRandom}
              >
                {isLoadingRandom ? (
                  <span>⏳ Obteniendo otros 20 cómics...</span>
                ) : (
                  <span>🎲 Cargar otros 20 cómics al azar</span>
                )}
              </button>
              <p className="muted small text-center" style={{ marginTop: 8 }}>
                Explora títulos diferentes de nuestro catálogo dinámico con cada clic.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
