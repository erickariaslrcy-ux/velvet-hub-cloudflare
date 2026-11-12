"use client";

import { useEffect, useRef, useState } from "react";

interface VideoPlayerProps {
  src: string;
  poster?: string;
  title?: string;
}

declare global {
  interface Window {
    Hls?: any;
  }
}

export default function VideoPlayer({ src, poster, title }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [retryCount, setRetryCount] = useState<number>(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    setError(null);
    setIsLoading(true);

    let hlsInstance: any = null;
    let isDestroyed = false;

    const isM3u8 =
      src.includes(".m3u8") ||
      src.includes("media=hls") ||
      src.includes("format=m3u8") ||
      src.includes("/api/video/stream") ||
      src.includes("/api/media");

    const setupPlayer = () => {
      // 1. Si el navegador soporta HLS nativamente (Safari, iOS, Mac)
      if (video.canPlayType("application/vnd.apple.mpegurl") && isM3u8) {
        video.src = src;
        return;
      }

      // 2. Si no es M3U8 (MP4 estándar), reproducir directamente
      if (!isM3u8) {
        video.src = src;
        return;
      }

      // 3. Para navegadores basados en Chromium / Firefox que requieren HLS.js
      const attachHls = () => {
        if (isDestroyed || !videoRef.current) return;
        const Hls = window.Hls;
        if (!Hls || !Hls.isSupported()) {
          video.src = src;
          return;
        }

        hlsInstance = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
        });

        hlsInstance.loadSource(src);
        hlsInstance.attachMedia(videoRef.current);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoading(false);
        });

        hlsInstance.on(Hls.Events.ERROR, (_event: any, data: any) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                hlsInstance.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hlsInstance.recoverMediaError();
                break;
              default:
                hlsInstance.destroy();
                if (videoRef.current && !videoRef.current.src.includes(src)) {
                  videoRef.current.src = src;
                } else {
                  setError("No se pudo iniciar el stream. Haz clic en reintentar.");
                }
                break;
            }
          }
        });
      };

      if (window.Hls) {
        attachHls();
      } else {
        // Cargar HLS.js dinámicamente desde Cloudflare CDN (permitido en CSP)
        const scriptId = "hls-js-cdn";
        let script = document.getElementById(scriptId) as HTMLScriptElement | null;
        if (!script) {
          script = document.createElement("script");
          script.id = scriptId;
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.8/hls.min.js";
          script.async = true;
          script.onload = () => attachHls();
          script.onerror = () => {
            // Fallback directo al elemento video nativo
            video.src = src;
          };
          document.head.appendChild(script);
        } else {
          script.addEventListener("load", attachHls, { once: true });
        }
      }
    };

    setupPlayer();

    return () => {
      isDestroyed = true;
      if (hlsInstance) {
        hlsInstance.destroy();
      }
    };
  }, [src, retryCount]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16/9",
        background: "#000",
        borderRadius: "12px",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        poster={poster}
        crossOrigin="anonymous"
        onWaiting={() => setIsLoading(true)}
        onPlaying={() => setIsLoading(false)}
        onLoadedData={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          // Si falló y no es un reintento manual
          if (!error) {
            setError("Error al cargar la transmisión del video.");
          }
        }}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "#050308",
        }}
      />

      {/* Indicador de carga ultra-rápida */}
      {isLoading && !error && (
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(6px)",
            padding: "6px 12px",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "#fff",
            fontSize: "0.8rem",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              border: "2px solid #ff2d55",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
          <span>Cargando stream...</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Pantalla de error con reintento */}
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(5, 3, 8, 0.95)",
            backdropFilter: "blur(10px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            zIndex: 10,
          }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: 12 }}>⚡</div>
          <h4 style={{ color: "#fff", fontWeight: 700, margin: "0 0 8px 0" }}>
            Conexión con el servidor de video
          </h4>
          <p style={{ color: "rgba(255,255,255,0.7)", fontSize: "0.9rem", maxWidth: 420, margin: "0 0 16px 0" }}>
            {error}
          </p>
          <button
            onClick={() => {
              setError(null);
              setIsLoading(true);
              setRetryCount((c) => c + 1);
            }}
            style={{
              background: "linear-gradient(135deg, #ff2d55, #9333ea)",
              color: "#fff",
              border: "none",
              padding: "10px 24px",
              borderRadius: 999,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 4px 15px rgba(255,45,85,0.4)",
            }}
          >
            🔄 Reintentar Reproducción
          </button>
        </div>
      )}
    </div>
  );
}
