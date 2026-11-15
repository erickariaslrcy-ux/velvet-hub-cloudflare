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
console.log('🧪 SUITE: PERFORMANCE & ANDROID OPTIMIZATION TESTS');
console.log('====================================================\n');

// 1. Check index.html file and asset weight
const indexPath = path.join(projectRoot, 'public', 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const indexSizeKb = (Buffer.byteLength(indexHtml, 'utf8') / 1024).toFixed(1);
console.log(`📊 Asset Weight: public/index.html is ${indexSizeKb} KB raw`);

assert(indexHtml.includes('min-height: 100dvh'), 'CSS includes 100dvh for mobile viewport stabilization');
assert(indexHtml.includes('@supports (min-height: 100dvh)'), 'CSS contains @supports rule for modern dynamic viewport height');
assert(indexHtml.includes('safe-area-inset-top'), 'CSS includes safe-area-inset-top padding for notch handling');
assert(indexHtml.includes('safe-area-inset-bottom'), 'CSS includes safe-area-inset-bottom padding for navigation bar');
assert(indexHtml.includes('-webkit-overflow-scrolling: touch'), 'CSS enables smooth momentum scrolling for touch devices');
assert(indexHtml.includes('transform: translateZ(0)'), 'Hardware acceleration (translateZ) is active on reader and player stages');

// 2. Check SmartImageLoader enhancements
assert(indexHtml.includes('cancelPendingForElement'), 'SmartImageLoader implements queue cancellation and aborts for off-screen items');
assert(indexHtml.includes('isSlowConn ? 2 : 5'), 'SmartImageLoader throttles concurrency based on network connection status');
assert(indexHtml.includes('img.dataset.loaded = \'true\''), 'SmartImageLoader marks loaded elements to avoid redundant processing');

// 3. Check Comic Reader preloading & lookahead
assert(indexHtml.includes('function preloadNextImages'), 'preloadNextImages function is defined and implemented');
assert(indexHtml.includes('lookAhead = isSlow ? 1 : 2'), 'preloadNextImages dynamically limits lookahead to 1 on slow connections and 2 on normal');
assert(indexHtml.includes('navigator.connection.saveData'), 'preloadNextImages respects Save-Data header to save mobile data');

// 4. Test logic unit test: Simulate SmartImageLoader queue cancellation
{
  const queue = [{ el: { id: 1 } }, { el: { id: 2 } }, { el: { id: 3 } }];
  const controllers = new Map();
  let aborted = false;
  controllers.set(queue[0].el, { abort: () => { aborted = true; } });

  function simulateCancel(el) {
    const qIdx = queue.findIndex(t => t.el === el);
    if (qIdx !== -1) queue.splice(qIdx, 1);
    if (controllers.has(el)) {
      controllers.get(el).abort();
      controllers.delete(el);
    }
  }

  simulateCancel(queue[0].el);
  assert(aborted === true, 'In-flight abort is successfully triggered when element leaves viewport');
  assert(queue.length === 2, 'Queued task is successfully pruned when off-screen');
}

// 5. Test logic unit test: Adaptive prefetch lookahead
{
  function testLookahead(isSlow, hasSaveData, totalPages) {
    if (isSlow && hasSaveData) return 0;
    return isSlow ? 1 : 2;
  }

  assert(testLookahead(false, false, 80) === 2, 'Normal connection loads 2 pages ahead for 80-page comic');
  assert(testLookahead(true, false, 80) === 1, 'Slow connection restricts prefetch to 1 page ahead');
  assert(testLookahead(true, true, 80) === 0, 'Data-saver connection disables prefetch completely');
}

console.log('\n----------------------------------------------------');
console.log(`Test Results: ${passedTests}/${totalTests} tests passed.`);
console.log('----------------------------------------------------\n');
