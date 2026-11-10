import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import FavButton from "@/components/FavButton";
import ComicReader from "@/components/ComicReader";
import VideoPlayer from "@/components/VideoPlayer";
import { getUser, isAdmin } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { imgSrc } from "@/lib/img";
import type { CatalogItem, Page } from "@/lib/types";

function encodeStealthToken(url: string, referer?: string): string {
  const jsonStr = JSON.stringify({ u: url, r: referer || "" });
  return Buffer.from(jsonStr).toString("base64url");
}

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cap?: string }>;
}) {
  const { id: rawId } = await params;
  const { cap } = await searchParams;
  const id = Number(rawId);
  if (!Number.isInteger(id)) notFound();

  const { supabase, user } = await getUser();
  const admin = await isAdmin();
  const { data } = await supabase.from("catalog").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const item = data as CatalogItem;

  const [{ data: fav }, rawItem] = await Promise.all([
    user
      ? supabase.from("favorites").select("item_id").eq("user_id", user.id).eq("item_id", id).maybeSingle()
      : Promise.resolve({ data: null }),
    createAdminClient().from("items").select("source,source_id,url,pages,video_sources").eq("id", id).maybeSingle(),
  ]);

  const orig = rawItem.data as { source: string; source_id: string; url: string; pages: Page[]; video_sources?: any[] } | null;
  const isVideo = item.media_type === "video";

  const hasChapters = (item.chapters || []).length > 0;
  const chapterIdx = hasChapters ? Math.min(Math.max(Number(cap) || 0, 0), item.chapters.length - 1) : undefined;
  const pageCount = hasChapters ? item.chapters[chapterIdx!].pages : item.page_total;

  const coverUrl = imgSrc(item.id);

  // Streaming de video si es tipo video
  let videoStreamUrl = "";
  const vSources = (orig?.video_sources && orig.video_sources.length > 0) ? orig.video_sources : (item.video_sources || []);
  if (isVideo && vSources && vSources.length > 0) {
    const primarySource = vSources[0];
    const rawVideoUrl = primarySource.url || primarySource.file;
    if (rawVideoUrl) {
      const stealthToken = encodeStealthToken(rawVideoUrl, orig?.url);
      videoStreamUrl = `/api/video/stream?t=${stealthToken}`;
    }
  }

  return (
    <>
      <Nav active="buscar" />

      {/* Fondo ambiental dinámico desenfocado */}
      <div className="hero-ambient-backdrop" style={{ backgroundImage: `url(${coverUrl})` }} />

      <main className="container item-page-container" id="top" style={{ paddingTop: 20, paddingBottom: 80 }}>
        {/* Barra superior de navegación / migajas de pan */}
        <div className="breadcrumb-row" style={{ marginBottom: 16 }}>
          <Link href={isVideo ? "/buscar?tipo=video" : "/buscar?tipo=comic"} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#ff2d55", fontWeight: 700, textDecoration: "none" }}>
            <span className="arrow">←</span> Volver a {isVideo ? "Videos XXX" : "Cómics & Mangas"}
          </Link>
        </div>

        {isVideo ? (
          /* ================================================================ */
          /* REPRODUCTOR DE VIDEO PRIVADO VIP                                 */
          /* ================================================================ */
          <div className="video-player-section" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="card glass" style={{ padding: 0, overflow: "hidden", borderRadius: 16, background: "#050508", border: "1px solid rgba(255,45,85,0.2)", boxShadow: "0 10px 40px rgba(0,0,0,0.8)" }}>
              {videoStreamUrl ? (
                <VideoPlayer
                  src={videoStreamUrl}
                  poster={coverUrl}
                  title={item.title}
                />
              ) : (
                <div style={{ padding: "60px 20px", textAlign: "center" }}>
                  <div style={{ fontSize: "3rem", marginBottom: 12 }}>🎬</div>
                  <h3 style={{ color: "#fff", fontWeight: 700 }}>Transmisión en Preparación</h3>
                  <p className="muted small" style={{ color: "rgba(255,255,255,0.6)" }}>
                    Conectando con el CDN privado en segundo plano para este título.
                  </p>
                </div>
              )}

              {/* Barra de Controles y Meta del Video */}
              <div style={{ padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="badge" style={{ background: "rgba(255,45,85,0.2)", color: "#ff4d6d", fontWeight: 800, padding: "4px 10px", borderRadius: 999, border: "1px solid rgba(255,45,85,0.4)" }}>
                    ● Transmisión Privada HD
                  </span>
                  <span className="badge" style={{ background: "rgba(147,51,234,0.2)", color: "#c084fc", fontWeight: 700, padding: "4px 10px", borderRadius: 999 }}>
                    SIN PUBLICIDAD
                  </span>
                  <span className="badge" style={{ background: "rgba(255,255,255,0.08)", color: "#fff", fontWeight: 800, padding: "4px 10px", borderRadius: 999 }}>
                    1080p Ultra HD
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <FavButton id={item.id} initial={!!fav} big />
                </div>
              </div>
            </div>

            {/* Información del Video */}
            <div className="card glass" style={{ padding: "24px", borderRadius: 16 }}>
              <h1 style={{ fontSize: "1.4rem", fontWeight: 800, color: "#fff", margin: "0 0 14px 0", lineHeight: 1.3 }}>
                {item.title}
              </h1>

              {item.tags && item.tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                  {item.tags.map((t) => (
                    <Link
                      key={t}
                      href={`/buscar?tipo=video&tag=${encodeURIComponent(t)}`}
                      className="tag-pill"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)", padding: "4px 12px", borderRadius: 999, fontSize: "0.8rem", textDecoration: "none" }}
                    >
                      #{t}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ================================================================ */
          /* DETALLE DE CÓMIC & LECTOR                                         */
          /* ================================================================ */
          <>
            <div className="detail-hero-card glass card">
              <div className="detail-cover-wrapper">
                <div className="cover-glow-shadow" style={{ backgroundImage: `url(${coverUrl})` }} />
                <img src={coverUrl} alt={item.title} className="detail-cover-img" />
              </div>

              <div className="detail-info-pane">
                <div className="detail-meta-pills">
                  <span className="badge badge-accent">Velvet VIP</span>
                  <span className="badge badge-subtle">Cómic Digital</span>
                  {pageCount > 0 && <span className="badge badge-ok">📑 {pageCount} páginas</span>}
                  {hasChapters && <span className="badge badge-subtle">{item.chapters.length} capítulos</span>}
                </div>

                <h1 className="detail-title">{item.title}</h1>

                {item.artists.length > 0 && (
                  <p className="detail-artist">
                    <span className="label">Artista:</span> {item.artists.join(", ")}
                  </p>
                )}

                {item.tags.length > 0 && (
                  <div className="detail-tags-wrap">
                    {item.tags.map((t) => (
                      <Link key={t} href={`/buscar?tipo=comic&tag=${encodeURIComponent(t)}`} className="tag-pill">
                        #{t}
                      </Link>
                    ))}
                  </div>
                )}

                <div className="detail-actions-row">
                  {pageCount > 0 && (
                    <a href="#reader-root" className="btn btn-primary btn-cta">
                      <span>📖</span> Comenzar a Leer
                    </a>
                  )}
                  <FavButton id={item.id} initial={!!fav} big />
                </div>

                {hasChapters && (
                  <div className="chapters-box">
                    <h3 className="chapters-title">Capítulos disponibles</h3>
                    <div className="chapters-grid">
                      {item.chapters.map((c, i) => (
                        <Link
                          key={i}
                          href={`/item/${item.id}?cap=${i}`}
                          className={`chapter-btn ${i === chapterIdx ? "active" : ""}`}
                        >
                          Capítulo {c.number} {c.title ? `· ${c.title}` : ""}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Zona del Lector Pro */}
            <div id="reader-root" className="reader-section">
              {pageCount > 0 ? (
                <ComicReader
                  itemId={item.id}
                  title={item.title}
                  pageCount={pageCount}
                  chapterIdx={chapterIdx}
                />
              ) : (
                <div className="empty-loading-card card glass">
                  <h2>Cómic Listo para Visualizar</h2>
                  <p className="muted small">
                    Explora las imágenes directamente a través de nuestro proxy acelerado.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}
