(() => {
  const videoElement = document.getElementById('preview');
  const overlayCanvas = document.getElementById('overlay');
  const cameraSelect = document.getElementById('cameraSelect');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const torchBtn = document.getElementById('torchBtn');
  const hint = document.getElementById('hint');
  const codeBox = document.getElementById('code');
  const copyBtn = document.getElementById('copyBtn');
  const shareBtn = document.getElementById('shareBtn');
  const clearBtn = document.getElementById('clearBtn');
  const manualInput = document.getElementById('manualInput');
  const setManualBtn = document.getElementById('setManualBtn');

  /** @type {MediaStream|null} */
  let mediaStream = null;
  /** @type {BarcodeDetector|null} */
  let nativeDetector = null;
  /** @type {ZXing.BrowserMultiFormatReader|null} */
  let zxingReader = null;
  /** @type {number|null} */
  let scanIntervalId = null;
  let lastResult = '';

  const hasNativeDetector = 'BarcodeDetector' in window;
  const supportedFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

  function setButtonsScanningState(isScanning) {
    startBtn.disabled = isScanning;
    stopBtn.disabled = !isScanning;
    torchBtn.disabled = !isScanning;
  }

  function setResult(resultText) {
    lastResult = resultText;
    codeBox.textContent = resultText || '—';
    const hasResult = Boolean(resultText);
    copyBtn.disabled = !hasResult;
    shareBtn.disabled = !hasResult || !('share' in navigator);
    clearBtn.disabled = !hasResult;
  }

  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      cameraSelect.innerHTML = '';
      for (const device of videoInputs) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Kamera ${cameraSelect.length + 1}`;
        cameraSelect.appendChild(option);
      }
      if (videoInputs.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Brak kamery';
        cameraSelect.appendChild(option);
      }
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
    const boxHeight = height * 0.3;
    const x = (width - boxWidth) / 2;
    const y = (height - boxHeight) / 2;
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
          deviceId: cameraSelect.value ? { exact: cameraSelect.value } : undefined,
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

  startBtn.addEventListener('click', () => startCamera());
  stopBtn.addEventListener('click', () => stopCamera());
  torchBtn.addEventListener('click', () => toggleTorch());
  copyBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(lastResult);
      hint.textContent = 'Skopiowano do schowka.';
    } catch (_) {
      hint.textContent = 'Nie udało się skopiować.';
    }
  });
  shareBtn.addEventListener('click', async () => {
    if (!lastResult || !navigator.share) return;
    try {
      await navigator.share({ title: 'Kod EAN', text: lastResult });
    } catch (_) {}
  });
  clearBtn.addEventListener('click', () => {
    setResult('');
    hint.textContent = 'Wyczyść – zeskanuj ponownie.';
  });
  setManualBtn.addEventListener('click', () => {
    const v = manualInput.value.trim();
    const only = v.replace(/\D/g, '');
    if (only) onDetected(only);
  });

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


