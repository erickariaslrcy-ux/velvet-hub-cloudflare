import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

console.log("=== REPRODUCTOR: TOKEN, TEARDOWN Y SIN AUDIO FANTASMA ===");

const sessionPath = path.join("public", "js", "video-session.js");
const source = fs.readFileSync(sessionPath, "utf8");
const indexHtml = fs.readFileSync(path.join("public", "index.html"), "utf8");

const sandbox = {
  AbortController,
  module: { exports: {} }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const { createVideoLoadGuard, teardownVideoElement, shouldApplyVideoResult } = sandbox.VelvetVideoSession;

const guard = createVideoLoadGuard();
const first = guard.start();
assert.equal(first.token, 1);
assert.equal(guard.matches(first.token), true);
assert.equal(first.signal.aborted, false);

let ghostPlayed = false;
let ghostSrc = "";
const video = {
  src: "https://cdn.example/video-a.mp4",
  poster: "https://cdn.example/a.jpg",
  currentTime: 12,
  pauseCalled: false,
  loaded: false,
  removedSources: 0,
  pause() { this.pauseCalled = true; },
  removeAttribute(name) { if (name === "src") this.src = ""; },
  querySelectorAll(sel) {
    assert.equal(sel, "source");
    return [{
      remove: () => { video.removedSources += 1; }
    }];
  },
  load() { this.loaded = true; },
  play() { ghostPlayed = true; }
};

const lateFromA = () => {
  if (!shouldApplyVideoResult(guard, first.token)) return;
  video.src = "https://cdn.example/video-a.mp4";
  ghostSrc = video.src;
  video.play();
};

const second = guard.start();
teardownVideoElement(video);
lateFromA();

assert.notEqual(second.token, first.token);
assert.equal(first.signal.aborted, true, "Abrir otro video aborta la carga anterior");
assert.equal(guard.matches(first.token), false);
assert.equal(guard.matches(second.token), true);
assert.equal(ghostPlayed, false, "El callback viejo no puede llamar a play()");
assert.equal(ghostSrc, "");
assert.equal(video.pauseCalled, true);
assert.equal(video.src, "");
assert.equal(video.poster, "");
assert.equal(video.removedSources, 1);
assert.equal(video.loaded, true, "load() vacía el frame anterior");

const closed = guard.stop();
assert.equal(second.signal.aborted, true);
assert.equal(guard.matches(second.token), false);
assert.equal(guard.matches(closed), false);
const afterLeave = () => {
  if (!guard.matches(second.token)) return;
  video.src = "https://cdn.example/video-a.mp4";
  video.play();
};
afterLeave();
assert.equal(video.src, "");
assert.equal(ghostPlayed, false, "Salir del reproductor no deja audio en segundo plano");

assert.ok(indexHtml.includes("let videoLoadToken = 0"));
assert.ok(indexHtml.includes("videoGuard.start()"));
assert.ok(indexHtml.includes("videoGuard.stop()"));
assert.ok(indexHtml.includes("hardResetVideoElement"));
assert.ok(indexHtml.includes("lockVideoControls"));
assert.ok(indexHtml.includes("readyState < 2") || indexHtml.includes("readyState >= 2"));
assert.ok(indexHtml.includes("video-controls-locked"));
assert.ok(indexHtml.includes("/js/video-session.js"));
assert.ok(!indexHtml.includes("Cargando experiencia"));
const metaStart = indexHtml.indexOf('id="video-meta-duration"');
const metaEnd = indexHtml.indexOf('id="video-qualities-buttons"');
assert.ok(metaStart > 0 && metaEnd > metaStart);
assert.ok(!indexHtml.slice(metaStart, metaEnd).includes("2257"));
assert.ok(!indexHtml.includes("compliance2257"));
assert.ok(!indexHtml.includes("portal-transition-curtain"));
assert.ok(!indexHtml.includes("Accediendo a"));
assert.ok(!indexHtml.includes("Portal de Cosplay"));
assert.ok(!indexHtml.includes("Páginas al azar"));
assert.ok(!indexHtml.includes('onclick="shuffleCurrentFeed()"'));
assert.ok(indexHtml.includes('id="reader-stage-title"'));
assert.ok(indexHtml.includes("function applyReaderCopy"));
assert.ok(indexHtml.includes("Galería completada"));
assert.ok(indexHtml.includes("Pase automático"));
assert.ok(indexHtml.includes("¡Has completado este cómic!"));
assert.ok(!indexHtml.includes("4.8k"));
assert.ok(!indexHtml.includes("2.3k"));
assert.ok(!indexHtml.includes('id="reader-zoom-btn-bottom"'));
assert.ok(indexHtml.includes("toggleReaderZoomLevel({ x: touch.clientX, y: touch.clientY })"));
assert.ok(indexHtml.includes("setReaderZoom(2, focal"));

console.log("✓ El token impide el audio fantasma y el frame del video anterior.");
