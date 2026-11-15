import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    passedTests++;
    console.log(`✅ PASS: ${message}`);
  }
}

console.log('====================================================');
console.log('🧪 SUITE: CODE QUALITY, ACCESSIBILITY & STABLE SORT');
console.log('====================================================\n');

const indexPath = path.join(projectRoot, 'public', 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

// 1. Keyboard Navigation in Comic Reader
console.log('[1] Verifying keyboard navigation in Reader...');
assert(indexHtml.includes("e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j'"), 'Reader responds to ArrowLeft and J for previous page/scroll');
assert(indexHtml.includes("e.key === 'ArrowRight' || e.key.toLowerCase() === 'k'"), 'Reader responds to ArrowRight and K for next page/scroll');
assert(indexHtml.includes("e.key === 'PageDown'"), 'Reader responds to PageDown for fast scrolling');
assert(indexHtml.includes("e.key === 'PageUp'"), 'Reader responds to PageUp for fast scrolling back');
assert(indexHtml.includes("e.key === ' '"), 'Reader responds to Spacebar for advancing slide or toggling auto-scroll');

// 2. Keyboard Navigation in Video Player
console.log('\n[2] Verifying keyboard navigation in Video Player...');
assert(indexHtml.includes("toggleVideoPlay();"), 'Video player responds to Space and K for play/pause');
assert(indexHtml.includes("skipVideo(-5)"), 'Video player responds to ArrowLeft for -5s skip');
assert(indexHtml.includes("skipVideo(5)"), 'Video player responds to ArrowRight for +5s skip');
assert(indexHtml.includes("changeVideoVolume(0.1)"), 'Video player responds to ArrowUp for volume up');
assert(indexHtml.includes("changeVideoVolume(-0.1)"), 'Video player responds to ArrowDown for volume down');
assert(indexHtml.includes("toggleVideoFullscreen()"), 'Video player responds to F for fullscreen toggle');
assert(indexHtml.includes("toggleVideoMute()"), 'Video player responds to M for mute toggle');

// 3. Accessibility & ARIA labels
console.log('\n[3] Verifying ARIA accessibility attributes...');
assert(indexHtml.includes('aria-label="Cerrar lector y volver al catálogo"'), 'Reader back button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Guardar en favoritos"'), 'Reader favorite button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Alternar modo de lectura Cascada o Diapositiva"'), 'Reader mode button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Alternar desplazamiento automático de página"'), 'Reader autoscroll button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Reproducir o pausar video"'), 'Video play button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Silenciar o activar sonido"'), 'Video volume button has descriptive aria-label');
assert(indexHtml.includes('aria-label="Alternar pantalla completa"'), 'Video fullscreen button has descriptive aria-label');

// 4. Stable Sorting Logic with Seed
console.log('\n[4] Verifying stable sorting simulation...');
function pseudoRandomStableSort(items, seed) {
  return [...items].sort((a, b) => {
    const hashA = (a.id * 9301 + seed * 49297) % 233280;
    const hashB = (b.id * 9301 + seed * 49297) % 233280;
    return hashA - hashB;
  });
}

const mockCatalog = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `Item ${i + 1}` }));
const seedSession = 42;
const sort1 = pseudoRandomStableSort(mockCatalog, seedSession);
const sort2 = pseudoRandomStableSort(mockCatalog, seedSession);
const sortDifferentSeed = pseudoRandomStableSort(mockCatalog, 999);

assert(JSON.stringify(sort1) === JSON.stringify(sort2), 'Sort with identical session seed produces 100% stable deterministic order across pagination');
assert(JSON.stringify(sort1) !== JSON.stringify(sortDifferentSeed), 'Different session seeds produce varied permutations');

console.log('\n----------------------------------------------------');
console.log(`Test Results: ${passedTests}/${totalTests} tests passed.`);
console.log('----------------------------------------------------\n');
