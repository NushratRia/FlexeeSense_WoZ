/* FlexeeSense canvas-only MediaPipe Hands overlay.
   Default: OFF. The overlay is injected only into #canvas-surface and uses the webcam
   only after the user turns it on. Existing FlexeeSense code is not patched. */
(function () {
  'use strict';

  const CDN = {
    hands: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js',
    drawing: 'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js',
    camera: 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js'
  };

  const DEFAULT_OPACITY_PERCENT = 20;

  const state = {
    enabled: false,
    stream: null,
    hands: null,
    camera: null,
    loading: false,
    preloadPromise: null,
    raf: null,
    opacityPercent: clampOpacityPercent(localStorage.getItem('flexeesenseHandOpacityPercent') || localStorage.getItem('flexeesenseHandOpacity') || DEFAULT_OPACITY_PERCENT)
  };

  function clampOpacityPercent(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return DEFAULT_OPACITY_PERCENT;

    // Backward compatibility: older saved value was 0.05–1.00.
    if (n > 0 && n <= 1) return Math.round(n * 100);

    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function percentToOpacity(percent) {
    return String(clampOpacityPercent(percent) / 100);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') resolve();
        else {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        }
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.loaded = 'false';
      script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function loadMediaPipe() {
    if (!state.preloadPromise) {
      state.preloadPromise = Promise.all([
        loadScript(CDN.hands),
        loadScript(CDN.drawing),
        loadScript(CDN.camera)
      ]);
    }
    return state.preloadPromise;
  }

  function warmUpMediaPipe() {
    const run = () => loadMediaPipe().catch(err => console.warn('[hand_gestures] preload failed:', err));
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 300);
  }

  function el(id) { return document.getElementById(id); }

  function setStatus(message) {
    const status = el('hand-gesture-status');
    if (status) status.textContent = message;
  }

  function updateOpacityUI() {
    const video = el('hand-gesture-video');
    const slider = el('hand-gesture-opacity');
    const value = el('hand-gesture-opacity-value');
    const pct = clampOpacityPercent(state.opacityPercent);

    if (video) video.style.opacity = percentToOpacity(pct);
    if (slider) slider.value = String(pct);
    if (value) value.textContent = `${pct}%`;
  }

  function injectControls() {
    const toolbar = document.querySelector('.canvas-toolbar');
    if (toolbar && !el('hand-gesture-toggle')) {
      const btn = document.createElement('button');
      btn.className = 'ctool hand-gesture-toggle';
      btn.id = 'hand-gesture-toggle';
      btn.type = 'button';
      btn.title = 'Turn canvas webcam hand overlay on/off';
      btn.textContent = '🖐 Hands';
      btn.addEventListener('click', () => window.toggleCanvasHandGestures());
      toolbar.appendChild(btn);
    }
  }

  function injectOverlay() {
    const surface = el('canvas-surface');
    if (!surface || el('hand-gesture-layer')) return;

    const layer = document.createElement('div');
    layer.id = 'hand-gesture-layer';

    const video = document.createElement('video');
    video.id = 'hand-gesture-video';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    const canvas = document.createElement('canvas');
    canvas.id = 'hand-gesture-canvas';

    layer.appendChild(video);
    layer.appendChild(canvas);
    surface.appendChild(layer);

    const controls = document.createElement('div');
    controls.id = 'hand-gesture-controls';
    controls.innerHTML = `
      <span class="hg-label">Webcam opacity</span>
      <input id="hand-gesture-opacity" type="range" min="0" max="100" step="1" value="${clampOpacityPercent(state.opacityPercent)}">
      <span id="hand-gesture-opacity-value" class="hg-value">${clampOpacityPercent(state.opacityPercent)}%</span>
    `;
    surface.appendChild(controls);

    const status = document.createElement('div');
    status.id = 'hand-gesture-status';
    status.textContent = 'Hand overlay off';
    surface.appendChild(status);

    const opacity = el('hand-gesture-opacity');
    opacity.addEventListener('input', function () {
      state.opacityPercent = clampOpacityPercent(this.value);
      localStorage.setItem('flexeesenseHandOpacityPercent', String(state.opacityPercent));
      localStorage.removeItem('flexeesenseHandOpacity');
      updateOpacityUI();
    });

    updateOpacityUI();
  }

  function resizeHandCanvas() {
    const canvas = el('hand-gesture-canvas');
    const surface = el('canvas-surface');
    if (!canvas || !surface) return;

    const rect = surface.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.max(1, Math.round(rect.width * dpr));
    const nextH = Math.max(1, Math.round(rect.height * dpr));

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }
  }

  function clearHandCanvas() {
    const canvas = el('hand-gesture-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setVisualState(on) {
    const layer = el('hand-gesture-layer');
    const controls = el('hand-gesture-controls');
    const status = el('hand-gesture-status');
    const btn = el('hand-gesture-toggle');

    layer?.classList.toggle('hg-on', on);
    controls?.classList.toggle('hg-on', on);
    status?.classList.toggle('hg-on', on);
    btn?.classList.toggle('on', on);
    if (btn) btn.textContent = on ? '🖐 Hands On' : '🖐 Hands';
  }

  function drawHandResults(results) {
    const canvas = el('hand-gesture-canvas');
    if (!canvas) return;
    resizeHandCanvas();

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The video element is mirrored with CSS. Mirror the landmarks as well.
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);

    if (results.multiHandLandmarks && window.drawConnectors && window.drawLandmarks && window.HAND_CONNECTIONS) {
      for (const landmarks of results.multiHandLandmarks) {
        window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, {
          color: '#749bf9',
          lineWidth: 2
        });
        window.drawLandmarks(ctx, landmarks, {
          color: (data) => [4, 8, 12, 16, 20].includes(data.index) ? '#ac115f' : 'rgba(255,255,255,0)',
          radius: (data) => [4, 8, 12, 16, 20].includes(data.index) ? 4 : 1
        });
      }
      setStatus('Hand overlay on');
    } else {
      setStatus('Hand overlay on · show your hand');
    }

    ctx.restore();
  }

  async function start() {
    if (state.enabled || state.loading) return;
    state.loading = true;
    state.enabled = true;
    injectControls();
    injectOverlay();
    resizeHandCanvas();
    updateOpacityUI();
    setVisualState(true);
    setStatus('Starting hand overlay…');

    try {
      // Scripts are preloaded after page load, so this usually resolves immediately on click.
      await loadMediaPipe();

      const video = el('hand-gesture-video');
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        },
        audio: false
      });
      video.srcObject = state.stream;
      updateOpacityUI();

      // Let the video show immediately; landmarks can appear as soon as MediaPipe returns results.
      await video.play().catch(() => {});

      state.hands = new window.Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
      });
      state.hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      state.hands.onResults(drawHandResults);

      if (window.Camera) {
        state.camera = new window.Camera(video, {
          onFrame: async () => {
            if (state.enabled && state.hands && video.readyState >= 2) {
              await state.hands.send({ image: video });
            }
          },
          width: 640,
          height: 480
        });
        await state.camera.start();
      } else {
        const tick = async () => {
          if (!state.enabled || !state.hands) return;
          if (video.readyState >= 2) await state.hands.send({ image: video });
          state.raf = requestAnimationFrame(tick);
        };
        state.raf = requestAnimationFrame(tick);
      }

      setVisualState(true);
      setStatus('Hand overlay on · show your hand');
      window.addEventListener('resize', resizeHandCanvas);
    } catch (err) {
      console.error('[hand_gestures] startup failed:', err);
      stop();
      setStatus('Hand overlay failed: webcam or MediaPipe unavailable');
      if (typeof showToast === 'function') {
        showToast('Could not start hand overlay. Check webcam permission and internet access.', '#D4850A');
      } else {
        alert('Could not start hand overlay. Check webcam permission and internet access.');
      }
    } finally {
      state.loading = false;
    }
  }

  function stop() {
    state.enabled = false;
    setVisualState(false);
    clearHandCanvas();
    setStatus('Hand overlay off');

    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = null;
    }

    if (state.camera && typeof state.camera.stop === 'function') {
      try { state.camera.stop(); } catch (e) { /* ignore */ }
    }
    state.camera = null;

    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }

    const video = el('hand-gesture-video');
    if (video) video.srcObject = null;
    window.removeEventListener('resize', resizeHandCanvas);
  }

  window.toggleCanvasHandGestures = function () {
    if (state.enabled || state.loading) stop();
    else start();
  };

  window.canvasHandGesturesOff = stop;
  window.canvasHandGesturesOn = start;

  document.addEventListener('DOMContentLoaded', () => {
    injectControls();
    injectOverlay();
    setVisualState(false);
    warmUpMediaPipe();
  });
})();
