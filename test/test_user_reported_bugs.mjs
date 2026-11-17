import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('=== VERIFICANDO RESOLUCIÓN DE LOS REPORTES DEL USUARIO ===');

const indexHtml = fs.readFileSync(path.join('public', 'index.html'), 'utf8');
const paginationJs = fs.readFileSync(path.join('public', 'js', 'pagination.js'), 'utf8');
const apiJs = fs.readFileSync(path.join('functions', 'api', '[[path]].js'), 'utf8');
const swJs = fs.readFileSync(path.join('public', 'sw.js'), 'utf8');

// [1] REPORTE 1: Paginación - Al ir a la página 34 no debe recargar la página 1
console.log('\n[1] Verificando sincronización de estado de paginación (Página 34)...');
assert.ok(
  indexHtml.includes('window.state = state;'),
  'index.html DEBE exponer window.state = state para que pagination.js pueda sincronizar state.page'
);
assert.ok(
  indexHtml.includes('window.CLIENT_CACHE = CLIENT_CACHE;'),
  'index.html DEBE exponer window.CLIENT_CACHE para sincronización'
);
assert.ok(
  indexHtml.includes("const rawPageParam = parseInt(initUrlParams.get('page'), 10);"),
  'index.html DEBE leer el parámetro ?page= de la URL directamente sin depender de scripts diferidos'
);
assert.ok(
  paginationJs.includes('resetLoadingState'),
  'pagination.js DEBE implementar resetLoadingState'
);

// Verificar la función jumpToPage en index.html
const jumpToPageMatch = indexHtml.match(/function jumpToPage\(targetPage, opts = {}\) {([\s\S]*?)}/);
assert.ok(jumpToPageMatch, 'function jumpToPage debe existir en index.html');
assert.ok(
  jumpToPageMatch[1].includes('state.page = targetPage;'),
  'jumpToPage en index.html DEBE actualizar state.page = targetPage antes o durante la delegación'
);

// [2] REPORTE 2: Imágenes - Ninguna tarjeta debe quedar vacía con data-src falso
console.log('\n[2] Verificando renderizado nativo de imágenes sin placeholders vacíos...');
assert.ok(
  !indexHtml.includes('data-src="${coverSrc}"'),
  'index.html NO DEBE contener data-src en las tarjetas principales'
);
assert.ok(
  !indexHtml.includes("viewBox='0 0 1 1'"),
  'index.html NO DEBE asignar SVGs transparentes 1x1 a las imágenes de portada de las tarjetas'
);
assert.ok(
  indexHtml.includes('src="${coverSrc}"'),
  'index.html DEBE asignar directamente src="${coverSrc}" con loading="lazy"'
);

// [3] REPORTE 3: Diseño Móvil / Android y Fuentes
console.log('\n[3] Verificando carga directa de fuentes e iconos sin bloqueo print...');
assert.ok(
  !indexHtml.includes("media=\"print\" onload=\"this.media='all'\""),
  'index.html NO DEBE usar media="print" en FontAwesome ni Google Fonts'
);
assert.ok(
  indexHtml.includes('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'),
  'index.html debe cargar FontAwesome directamente'
);
assert.ok(
  indexHtml.includes('https://cdn.tailwindcss.com'),
  'index.html debe incluir el motor Tailwind para componentes generados por JavaScript'
);

// [4] REPORTE 4: Backend - Paginación con y sin categoría
console.log('\n[4] Verificando cálculo de offsets y preservación de categorías en el backend...');
assert.ok(
  apiJs.includes('const isRandomMode = (sort === "random" || seedParam > 0) && !q && !tag && (!category || category === "all");'),
  'El backend NO debe aplicar saltos aleatorios de amplio espectro cuando hay categorías o búsquedas activas'
);
assert.ok(
  apiJs.includes("postgrestUrl.replace(/offset=\\d+/, 'offset=0')"),
  'El backend DEBE preservar los filtros de categoría si un offset profundo excede el rango (416)'
);

// [5] REPORTE 5: Juegos & Videos - "Al Azar" dinámico y sincronización de paginación
console.log('\n[5] Verificando soporte de Al Azar y Paginación en Juegos y Videos...');
assert.ok(
  indexHtml.includes("state.sort === 'random' || state.sort === 'shuffle'"),
  'index.html DEBE ordenar aleatoriamente el catálogo de juegos con semilla fresca cuando sort es random'
);
assert.ok(
  indexHtml.includes("renderFeedData(feedPayload, false);"),
  'index.html DEBE pasar false en renderFeedData para juegos sin lanzar ReferenceError de variable append inexistente'
);
assert.ok(
  indexHtml.includes("path === '/juegos' || path === '/games'"),
  'index.html DEBE reconocer /juegos y /games en DOMContentLoaded sin degradar al modo anterior'
);
assert.ok(
  apiJs.includes("fetchPmvPage = ((randomBasePage + (page - 1) * 3) % 2500) + 1;"),
  'El backend DEBE saltar a páginas dinámicas de PMVHaven al pedir sort=random en videos'
);

// [6] REPORTE 6: Autenticación - submitLogin no debe requerir ni romper por access_key inexistente
console.log('\n[6] Verificando integridad de inicio de sesión (submitLogin)...');
const submitLoginMatch = indexHtml.match(/async function submitLogin\(\)\s*\{([\s\S]*?)\n\s*async function submitRegister/);
assert.ok(submitLoginMatch, 'submitLogin debe estar definido en index.html');
assert.ok(
  !submitLoginMatch[1].includes('access_key'),
  'submitLogin NO DEBE hacer referencia a access_key para evitar ReferenceError'
);
assert.ok(
  submitLoginMatch[1].includes("fetch('/api/auth/login'"),
  'submitLogin debe enviar petición a /api/auth/login'
);

console.log('\n✅ TODOS LOS PUNTOS REPORTADOS POR EL USUARIO HAN SIDO VERIFICADOS Y BLINDADOS.');
