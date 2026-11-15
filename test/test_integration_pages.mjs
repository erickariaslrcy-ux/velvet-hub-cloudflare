import assert from "node:assert/strict";
import http from "node:http";
import { onRequest } from "../functions/api/[[path]].js";

console.log("====================================================");
console.log("🧪 SUITE: REAL INTEGRATION TESTS (PAGES & MEDIA)");
console.log("====================================================");

// Generador de datos simulados realistas para PostgREST
function generateMockItems(mediaType, count = 200) {
  const items = [];
  for (let i = 1; i <= count; i++) {
    const isVideo = mediaType === "video";
    const isGallery = mediaType === "gallery";
    items.push({
      id: (mediaType === "comic" ? 100000 : (isVideo ? 200000 : 370000)) + i,
      source: isVideo ? "pmvhaven" : (isGallery ? "buondua" : "comics18"),
      source_id: `src_${mediaType}_${i}`,
      title: `${mediaType.toUpperCase()} Volume #${i} - Edición Coleccionista`,
      cover_url: `https://comics18.org/covers/${mediaType}_${i}.webp`,
      media_type: mediaType,
      tags: [mediaType, "hd", "popular", `tag_${(i % 5) + 1}`],
      artists: [`Artista ${(i % 10) + 1}`],
      page_count: isVideo ? 0 : 25 + (i % 30),
      pages: isVideo ? [] : [
        { index: 1, image_url: `https://comics18.org/pages/${mediaType}_${i}_p1.webp` },
        { index: 2, image_url: `https://comics18.org/pages/${mediaType}_${i}_p2.webp` }
      ],
      video_sources: isVideo ? [
        { quality: "1080p HD", url: `https://pmvhaven.com/videos/stream_${i}.mp4`, format: "mp4" }
      ] : [],
      status: "active",
      real_people: false
    });
  }
  return items;
}

const mockDatabases = {
  comic: generateMockItems("comic", 200),
  video: generateMockItems("video", 200),
  gallery: generateMockItems("gallery", 200)
};

// Servidor Mock de Supabase PostgREST
let server;
let serverPort;

function startMockSupabaseServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${serverPort || 3000}`);

      // Simulación de endpoint de almacenamiento / medios upstream para probar /api/media
      if (parsedUrl.pathname.startsWith("/covers/") || parsedUrl.pathname.startsWith("/videos/")) {
        res.writeHead(200, {
          "Content-Type": "image/webp",
          "Content-Length": "12",
          "Cache-Control": "public, max-age=86400"
        });
        res.end("IMAGE_BINARY");
        return;
      }

      // Simulación de PostgREST /rest/v1/items
      if (parsedUrl.pathname === "/rest/v1/items") {
        const query = parsedUrl.searchParams;
        const limit = parseInt(query.get("limit") || "24", 10);
        const offset = parseInt(query.get("offset") || "0", 10);

        let mediaType = "comic";
        if (query.get("media_type") === "eq.video") mediaType = "video";
        else if (query.get("media_type") === "eq.gallery") mediaType = "gallery";

        const dataset = mockDatabases[mediaType] || [];
        const total = dataset.length;

        // Corte exacto paginado
        const sliced = dataset.slice(offset, offset + limit);
        const endRange = Math.min(offset + limit - 1, total - 1);

        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Range": `${offset}-${endRange}/${total}`
        });
        res.end(JSON.stringify(sliced));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });
  });
}

async function runIntegrationSuite() {
  await startMockSupabaseServer();
  console.log(`✓ Servidor PostgREST simulado iniciado en http://127.0.0.1:${serverPort}`);

  const MEDIA_SECRET = "super_secret_media_key_for_integration_testing_2026_xyz";
  const mockEnv = {
    SUPABASE_URL: `http://127.0.0.1:${serverPort}`,
    SUPABASE_ANON_KEY: "mock_anon_key_for_test",
    MEDIA_SECRET: MEDIA_SECRET,
    ENABLE_PMVHAVEN_LIVE: "false"
  };

  const mediaTypes = ["comic", "video", "gallery"];
  const pageSize = 12;
  const targetPages = [1, 2, 3, 10, 17]; // 200 items / 12 = 17 páginas (la última página tiene 8 items)

  for (const mType of mediaTypes) {
    console.log(`\n--- Probando catálogo para media_type='${mType}' (200 elementos totales) ---`);
    const seenIds = new Set();
    const collectedPerType = [];

    for (const p of targetPages) {
      const requestUrl = `https://morbohub.pages.dev/api/items?media_type=${mType}&page=${p}&page_size=${pageSize}`;
      const context = {
        request: new Request(requestUrl, {
          method: "GET",
          headers: {
            "origin": "https://morbohub.pages.dev",
            "accept": "application/json"
          }
        }),
        env: mockEnv,
        params: {},
        waitUntil: () => {}
      };

      const response = await onRequest(context);
      assert.equal(response.status, 200, `La respuesta para ${mType} p=${p} debe ser 200 OK`);

      const data = await response.json();

      // Verificación de estructura devuelta
      assert.equal(data.total, 200, `Total debe ser 200 para ${mType}`);
      assert.equal(data.total_pages, 17, `Total páginas debe ser 17 (ceil(200/12))`);
      assert.equal(data.page, p, `Página devuelta debe coincidir con ${p}`);
      assert.equal(data.page_size, pageSize, `Tamaño de página debe ser ${pageSize}`);

      // Comprobar elementos devueltos
      const expectedCount = (p === 17) ? 8 : pageSize; // Última página: 200 - (16 * 12) = 8
      assert.equal(
        data.items.length,
        expectedCount,
        `Página ${p} de ${mType} debe devolver exactamente ${expectedCount} elementos (recibidos: ${data.items.length})`
      );

      // Comprobar que todos los elementos tienen cover_url con token HMAC firmado
      for (const item of data.items) {
        assert.ok(item.cover_url.startsWith("/api/media?t="), `Cover URL debe estar firmada: ${item.cover_url}`);
        const token = item.cover_url.replace("/api/media?t=", "");
        assert.ok(token.includes("."), "El token debe contener payload y firma HMAC");

        // Detección de duplicados entre páginas
        assert.ok(!seenIds.has(item.id), `¡ERROR! ID duplicado detectado: ${item.id} en página ${p}`);
        seenIds.add(item.id);
        collectedPerType.push(item.id);
      }

      console.log(`  ✓ Página ${p.toString().padStart(2, " ")}: ${data.items.length} items recibidos | total=${data.total} | total_pages=${data.total_pages}`);
    }

    assert.equal(
      seenIds.size,
      4 * pageSize + 8, // 12 + 12 + 12 + 12 + 8 = 56 items únicos muestreados
      `Deben existir exactamente 56 items únicos sin duplicados para ${mType}`
    );
    console.log(`✓ media_type='${mType}': 0 duplicados detectados a lo largo de las páginas 1, 2, 3, 10 y 17.`);
  }

  // 4. Verificación de desreferenciación y streaming en /api/media con Web Crypto
  console.log("\n--- Probando resolución y seguridad de /api/media con Web Crypto ---");

  // Mock de fetch para el recurso upstream legítimo
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : (input?.url || "");
    if (urlStr.includes("comics18.org/covers/comic_1.webp")) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": "4",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }
    return originalFetch(input, init);
  };

  // Obtener un token real generado en la primera página
  const catalogReq = new Request(`https://morbohub.pages.dev/api/items?media_type=comic&page=1&page_size=1`, {
    headers: { "origin": "https://morbohub.pages.dev" }
  });
  const catRes = await onRequest({ request: catalogReq, env: mockEnv, params: {}, waitUntil: () => {} });
  const catData = await catRes.json();
  const validMediaRoute = catData.items[0].cover_url; // Ej: /api/media?t=...

  // Test 4.1: Token válido firmado es aceptado por /api/media
  const mediaReq = new Request(`https://morbohub.pages.dev${validMediaRoute}`, {
    method: "GET",
    headers: { "origin": "https://morbohub.pages.dev" }
  });
  const mediaRes = await onRequest({ request: mediaReq, env: mockEnv, params: {}, waitUntil: () => {} });
  assert.equal(mediaRes.status, 200, "Media con token válido firmado debe responder 200");
  assert.ok(mediaRes.headers.get("access-control-allow-origin"), "Media debe permitir CORS para navegadores y reproductores");

  // Test 4.2: Token alterado es rechazado con 403
  const [validPayload, validSig] = validMediaRoute.split("=")[1].split(".");
  const badSig = validSig.replace(/^./, validSig[0] === "a" ? "b" : "a");
  const tamperedMediaReq = new Request(`https://morbohub.pages.dev/api/media?t=${validPayload}.${badSig}`, {
    method: "GET",
    headers: { "origin": "https://morbohub.pages.dev" }
  });
  const tamperedRes = await onRequest({ request: tamperedMediaReq, env: mockEnv, params: {}, waitUntil: () => {} });
  assert.equal(tamperedRes.status, 403, "Token con firma alterada debe recibir 403 Forbidden");

  // Test 4.3: Token XOR legado sin firma es rechazado con 403
  const legacyXorReq = new Request(`https://morbohub.pages.dev/api/media?t=legacy_xor_token_without_dot`, {
    method: "GET",
    headers: { "origin": "https://morbohub.pages.dev" }
  });
  const legacyRes = await onRequest({ request: legacyXorReq, env: mockEnv, params: {}, waitUntil: () => {} });
  assert.equal(legacyRes.status, 403, "Token XOR legado debe recibir 403 Forbidden sin procesarse");

  // Test 4.4: Destino no permitido por lista blanca es rechazado con 403
  // Firmar una URL maliciosa externa para probar SSRF
  const badHostPayload = Buffer.from(JSON.stringify({ u: "https://evil-hacker.com/malware.exe", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(MEDIA_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const badSigBuf = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(badHostPayload));
  const badHostSig = Array.from(new Uint8Array(badSigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const badHostReq = new Request(`https://morbohub.pages.dev/api/media?t=${badHostPayload}.${badHostSig}`, {
    method: "GET",
    headers: { "origin": "https://morbohub.pages.dev" }
  });
  const badHostRes = await onRequest({ request: badHostReq, env: mockEnv, params: {}, waitUntil: () => {} });
  assert.equal(badHostRes.status, 403, "Destino no autorizado por lista blanca debe recibir 403");

  console.log("✓ /api/media verificado: token válido aceptado, tokens alterados/XOR/SSRF rechazados con 403.");

  // Restaurar fetch original y cerrar servidor mock
  globalThis.fetch = originalFetch;
  server.close();
  console.log("\n====================================================");
  console.log("✅ TODAS LAS PRUEBAS DE INTEGRACIÓN PASARON EXITOSAMENTE");
  console.log("====================================================");
}

runIntegrationSuite().catch(err => {
  console.error("❌ FALLO EN PRUEBA DE INTEGRACIÓN:", err);
  if (server) server.close();
  process.exit(1);
});
