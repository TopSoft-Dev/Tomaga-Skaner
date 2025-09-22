(() => {
  const videoElement = document.getElementById('preview');
  const overlayCanvas = document.getElementById('overlay');
  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  const startStopBtn = document.getElementById('startStopBtn');
  const torchBtn = document.getElementById('torchBtn');
  const hint = document.getElementById('hint');
  const codeBox = document.getElementById('code');
  // usunięto ręczny wpis

  /** @type {MediaStream|null} */
  let mediaStream = null;
  /** @type {BarcodeDetector|null} */
  let nativeDetector = null;
  /** @type {ZXing.BrowserMultiFormatReader|null} */
  let zxingReader = null;
  /** @type {number|null} */
  let scanIntervalId = null;
  let lastResult = '';
  /** @type {MediaDeviceInfo[]} */
  let cameraDevices = [];
  let currentCameraIdx = 0;
  let isScanning = false;

  const hasNativeDetector = 'BarcodeDetector' in window;
  const supportedFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

  function setButtonsScanningState(scanning) {
    isScanning = scanning;
    startStopBtn.textContent = scanning ? 'Stop' : 'Start';
    startStopBtn.setAttribute('aria-label', scanning ? 'Stop skanowania' : 'Start skanowania');
    torchBtn.disabled = !scanning;
  }

  function setResult(resultText) {
    lastResult = resultText;
    codeBox.textContent = resultText || '—';
  }

  function updateCameraToggleLabel() {
    const total = cameraDevices.length;
    const idx = total ? (currentCameraIdx % total) + 1 : 0;
    cameraToggleBtn.textContent = 'Zmień kamerę';
    cameraToggleBtn.title = total ? `Zmień kamerę (${idx}/${total})` : 'Brak aparatu';
    cameraToggleBtn.disabled = total <= 1;
  }

  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraDevices = devices.filter(d => d.kind === 'videoinput');
      if (currentCameraIdx >= cameraDevices.length) currentCameraIdx = 0;
      updateCameraToggleLabel();
    } catch (err) {
      console.error(err);
    }
  }

  function drawOverlayBox() {
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = overlayCanvas;
    ctx.clearRect(0, 0, width, height);
    const boxWidth = width * 0.8;
    const boxHeight = height * 0.25;
    const x = (width - boxWidth) / 2;
    const y = (height - boxHeight) / 2;
    // maska przyciemniająca poza obszarem celu
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, width, y);
    ctx.fillRect(0, y + boxHeight, width, height - (y + boxHeight));
    ctx.fillRect(0, y, x, boxHeight);
    ctx.fillRect(x + boxWidth, y, width - (x + boxWidth), boxHeight);
    // ramka
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, boxWidth, boxHeight);
  }

  async function startCamera() {
    try {
      setResult('');
      const constraints = {
        audio: false,
        video: {
          facingMode: 'environment',
          deviceId: cameraDevices[currentCameraIdx]?.deviceId ? { exact: cameraDevices[currentCameraIdx].deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: 'continuous'
        }
      };
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoElement.srcObject = mediaStream;
      await videoElement.play();
      // Ustaw rozmiar canvasa równo z video
      const resizeOverlay = () => {
        overlayCanvas.width = videoElement.clientWidth;
        overlayCanvas.height = videoElement.clientHeight;
        drawOverlayBox();
      };
      resizeOverlay();
      new ResizeObserver(resizeOverlay).observe(videoElement);
      setButtonsScanningState(true);
      hint.textContent = 'Skieruj aparat na kod EAN. Staraj się wypełnić ramkę.';
      await startScanningLoop();
    } catch (err) {
      console.error('Błąd kamery:', err);
      hint.textContent = 'Nie można uruchomić kamery. Sprawdź uprawnienia.';
      setButtonsScanningState(false);
    }
  }

  async function stopCamera() {
    try {
      if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
      }
      if (zxingReader) {
        zxingReader.reset();
        zxingReader = null;
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }
    } finally {
      setButtonsScanningState(false);
    }
  }

  async function toggleTorch() {
    if (!mediaStream) return;
    const track = mediaStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    if (!capabilities.torch) return;
    const settings = track.getSettings();
    const newTorch = !settings.torch;
    await track.applyConstraints({ advanced: [{ torch: newTorch }] });
  }

  async function startScanningLoop() {
    if (hasNativeDetector && !nativeDetector) {
      try {
        nativeDetector = new window.BarcodeDetector({ formats: supportedFormats });
      } catch (_) {
        nativeDetector = null;
      }
    }

    // ZXing fallback
    if (!nativeDetector && !zxingReader) {
      zxingReader = new ZXing.BrowserMultiFormatReader();
    }

    const scan = async () => {
      if (!mediaStream) return;
      try {
        if (nativeDetector) {
          const results = await nativeDetector.detect(videoElement);
          if (results && results.length > 0) {
            const value = results[0].rawValue;
            if (value && value !== lastResult) {
              onDetected(value);
            }
          }
        } else if (zxingReader) {
          const result = await zxingReader.decodeOnceFromVideoElement(videoElement).catch(() => null);
          if (result && result.text && result.text !== lastResult) {
            onDetected(result.text);
          }
        }
      } catch (err) {
        // Ignoruj sporadyczne błędy, kontynuuj pętlę
      }
    };

    if (nativeDetector) {
      // szybka pętla na natywnym detektorze
      scanIntervalId = window.setInterval(scan, 200);
    } else if (zxingReader) {
      // dla ZXing wywołujemy cyklicznie aby nie blokować UI
      const zxingLoop = async () => {
        if (!mediaStream || !zxingReader) return;
        const result = await zxingReader.decodeOnceFromVideoElement(videoElement).catch(() => null);
        if (result && result.text && result.text !== lastResult) {
          onDetected(result.text);
        }
        if (mediaStream && zxingReader) requestAnimationFrame(zxingLoop);
      };
      requestAnimationFrame(zxingLoop);
    }
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      o.start();
      setTimeout(() => {
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
        o.stop(ctx.currentTime + 0.06);
        ctx.close();
      }, 60);
    } catch (_) {}
  }

  function onDetected(value) {
    // filtruj do cyfr i typowych długości EAN
    const onlyDigits = String(value).replace(/\D/g, '');
    if (onlyDigits.length < 8 || onlyDigits.length > 18) return;
    setResult(onlyDigits);
    playBeep();
    hint.textContent = 'Zeskanowano. Możesz skopiować lub udostępnić kod.';
  }

  startStopBtn.addEventListener('click', async () => {
    if (isScanning) {
      await stopCamera();
    } else {
      await startCamera();
    }
  });
  torchBtn.addEventListener('click', () => toggleTorch());
  cameraToggleBtn.addEventListener('click', async () => {
    if (cameraDevices.length === 0) return;
    currentCameraIdx = (currentCameraIdx + 1) % cameraDevices.length;
    updateCameraToggleLabel();
    // jeśli skanujemy, przełącz od razu
    if (mediaStream) {
      await stopCamera();
      await startCamera();
    }
  });
  // usunięto przyciski kopiuj/udostępnij/wyczyść
  // brak ręcznego wpisu

  window.addEventListener('pageshow', () => enumerateCameras());
  // Wymuś enumerację po przyznaniu uprawnień
  navigator.mediaDevices?.getUserMedia?.({ video: true, audio: false }).then(stream => {
    stream.getTracks().forEach(t => t.stop());
    enumerateCameras();
  }).catch(() => enumerateCameras());

  // Rejestracja Service Workera (PWA)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const base = window.location.pathname.replace(/\/[^/]*$/, '/');
      const swUrl = `${base}sw.js`;
      navigator.serviceWorker.register(swUrl).catch(() => {});
    });
  }
})();


