(() => {
  const videoElement = document.getElementById('preview');
  const overlayCanvas = document.getElementById('overlay');
  const cameraToggleBtn = document.getElementById('cameraToggleBtn');
  const torchBtn = document.getElementById('torchBtn');
  const hint = document.getElementById('hint');
  const codeBox = document.getElementById('code');
  const shareBtn = document.getElementById('shareBtn');
  const priceBtn = document.getElementById('priceBtn');
  const searchBtn = document.getElementById('searchBtn');
  const clearCodeBtn = document.getElementById('clearCodeBtn');
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
  let triedAutoStart = false;
  let scanTickerId = null;
  let isDecoding = false;

  const hasNativeDetector = 'BarcodeDetector' in window;
  const supportedFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

  function translateCameraError(err) {
    const name = (err && (err.name || err.code || err.message)) || '';
    const n = String(name).toLowerCase();
    if (n.includes('notallowed') || n.includes('permission')) return 'Błąd kamery: Nie nadano uprawnień';
    if (n.includes('notfound') || n.includes('devicesnotfound')) return 'Błąd kamery: Nie znaleziono kamery';
    if (n.includes('notreadable') || n.includes('trackstart')) return 'Błąd kamery: Kamera jest zajęta przez inną aplikację';
    if (n.includes('overconstrained')) return 'Błąd kamery: Brak kamery spełniającej wymagania';
    if (n.includes('security')) return 'Błąd kamery: Odmowa z powodów bezpieczeństwa (wymagane HTTPS)';
    if (n.includes('abort')) return 'Błąd kamery: Operacja przerwana';
    return 'Błąd kamery: Nieznany problem z dostępem do kamery';
  }

  function getOrCreateUserId() {
    try {
      const KEY = 'tomaga_user_id';
      let id = localStorage.getItem(KEY);
      if (!id) {
        id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('user-' + Math.random().toString(36).slice(2));
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (_) {
      return 'user-' + Math.random().toString(36).slice(2);
    }
  }

  function setButtonsScanningState(scanning) {
    isScanning = scanning;
    torchBtn.disabled = !scanning;
  }

  function setResult(resultText) {
    lastResult = resultText;
    codeBox.textContent = resultText || '—';
    const has = Boolean(resultText);
    if (shareBtn) shareBtn.disabled = !has || !('share' in navigator);
    if (priceBtn) priceBtn.disabled = !has;
    if (searchBtn) searchBtn.disabled = !has;
    if (clearCodeBtn) clearCodeBtn.disabled = !has;
    
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
      // Preferuj kamerę tylną (back/rear/environment) jako domyślną
      const lowerLabels = cameraDevices.map(d => (d.label || '').toLowerCase());
      const backIdx = lowerLabels.findIndex(l => /back|rear|environment|tyl|main|wide/.test(l));
      if (backIdx >= 0) {
        currentCameraIdx = backIdx;
      } else if (cameraDevices.length > 1) {
        // często ostatnia to tylna na mobile
        currentCameraIdx = cameraDevices.length - 1;
      } else if (currentCameraIdx >= cameraDevices.length) {
        currentCameraIdx = 0;
      }
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

  function showAim() {
    overlayCanvas.style.visibility = 'visible';
    overlayCanvas.classList.remove('inactive');
    overlayCanvas.classList.remove('hiding');
    overlayCanvas.classList.add('showing');
    setTimeout(() => overlayCanvas.classList.remove('showing'), 240);
  }

  function dimAim() {
    overlayCanvas.style.visibility = 'visible';
    overlayCanvas.classList.remove('showing');
    overlayCanvas.classList.remove('hiding');
    overlayCanvas.classList.add('inactive');
  }

  function getTargetRect() {
    const width = overlayCanvas.width;
    const height = overlayCanvas.height;
    const boxWidth = width * 0.8;
    const boxHeight = height * 0.25;
    const x = (width - boxWidth) / 2;
    const y = (height - boxHeight) / 2;
    return { x, y, width: boxWidth, height: boxHeight, cx: x + boxWidth / 2, cy: y + boxHeight / 2 };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  function rectDistance2(a, b) {
    // kwadrat dystansu między prostokątami (0 jeśli się przecinają)
    const dx = Math.max(b.x - (a.x + a.width), 0, a.x - (b.x + b.width));
    const dy = Math.max(b.y - (a.y + a.height), 0, a.y - (b.y + b.height));
    return dx * dx + dy * dy;
  }

  function inflateRect(r, pad) {
    return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
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
      showAim();
      setButtonsScanningState(true);
      hint.classList.remove('hint-warning');
      hint.classList.remove('hint-success');
      hint.textContent = 'Skieruj aparat na kod EAN. Staraj się wypełnić ramkę.';
      await startScanningLoop();
    } catch (err) {
      console.error('Błąd kamery:', err);
      hint.classList.add('hint-warning');
      hint.classList.remove('hint-success');
      hint.textContent = translateCameraError(err);
      setButtonsScanningState(false);
    }
  }

  async function stopCamera() {
    try {
      if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
      }
      if (scanTickerId) {
        clearInterval(scanTickerId);
        scanTickerId = null;
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

    const doScanOnce = async () => {
      if (!mediaStream || isDecoding) return;
      isDecoding = true;
      try {
        if (nativeDetector) {
          const results = await nativeDetector.detect(videoElement);
          if (results && results.length > 0) {
            if (results.length > 1) {
              hint.classList.add('hint-warning');
              hint.textContent = 'Wykryto wiele kodów, wyceluj dokładnie w ten co Cię interesuje';
            } else {
              hint.classList.remove('hint-warning');
              hint.textContent = 'Skieruj aparat na kod EAN. Staraj się wypełnić ramkę.';
            }
            const target = getTargetRect();
            if (results.length === 1) {
              // jeden kod – akceptuj bez względu na pozycję
              const only = results[0];
              if (only.rawValue) {
                const fmt = only.format || only.type;
                onDetected(only.rawValue, fmt);
              }
            } else {
              // wiele kodów – wybierz ten, który przecina się z ramką lub jest do niej najbliżej
              const ranked = results
                .map(r => {
                  const bb = r.boundingBox;
                  const dist2 = rectsIntersect(bb, target) ? 0 : rectDistance2(bb, target);
                  return { r, dist2 };
                })
                .sort((a, b) => a.dist2 - b.dist2);
              if (ranked.length > 0) {
                if (results.length > 1) {
                  hint.classList.add('hint-warning');
                  hint.textContent = 'Wykryto wiele kodów, wyceluj dokładnie w ten co Cię interesuje';
                } else {
                  hint.classList.remove('hint-warning');
                }
                const chosen = ranked[0].r;
                if (chosen.rawValue) {
                  const fmt = chosen.format || chosen.type;
                  onDetected(chosen.rawValue, fmt);
                }
              }
            }
          }
        } else if (zxingReader) {
          const result = await zxingReader.decodeOnceFromVideoElement(videoElement).catch(() => null);
          if (result && result.text) {
            // ZXing zwykle zwraca pojedynczy wynik; sprawdź, czy jest w pobliżu ramki (z marginesem)
            const pts = result.resultPoints || result.points || [];
            const target = getTargetRect();
            const padded = inflateRect(target, 20);
            let accept = true;
            if (pts.length) {
              const avg = pts.reduce((a, p) => ({ x: a.x + (p.x || p.getX?.() || 0), y: a.y + (p.y || p.getY?.() || 0) }), { x: 0, y: 0 });
              avg.x /= pts.length; avg.y /= pts.length;
              accept = avg.x >= padded.x && avg.x <= padded.x + padded.width && avg.y >= padded.y && avg.y <= padded.y + padded.height;
            }
            if (accept) {
              const fmt = result.barcodeFormat || result.format;
              onDetected(result.text, fmt);
            }
          }
        }
      } catch (_) {}
      finally { isDecoding = false; }
    };
    // Szybka pętla skanowania: natywny co 250ms, ZXing w pętli z oddechem klatki
    if (nativeDetector) {
      doScanOnce();
      scanIntervalId = window.setInterval(doScanOnce, 250);
    } else if (zxingReader) {
      const zxingLoop = async () => {
        if (!mediaStream || !zxingReader) return;
        await doScanOnce();
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
      o.type = 'square';
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      const now = ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.5, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      o.start(now);
      o.stop(now + 0.13);
      o.onended = () => { try { ctx.close(); } catch(_) {} };
    } catch (_) {}
  }

  function inferTypeFromDigits(digits) {
    if (digits.length === 13) return 'EAN-13';
    if (digits.length === 8) return 'EAN-8';
    if (digits.length === 12) return 'UPC-A';
    if (digits.length === 6) return 'UPC-E';
    return 'Kod kreskowy';
  }

  function onDetected(value, rawType) {
    // filtruj do cyfr i typowych długości EAN
    const onlyDigits = String(value).replace(/\D/g, '');
    if (onlyDigits.length < 8 || onlyDigits.length > 18) return;
    const isSame = onlyDigits === lastResult;
    setResult(onlyDigits);
    // typ kodu
    // usunięto wyświetlanie typu – przyciski zamiast
    if (!isSame) {
      const runFeedback = () => {
        playBeep();
        if (navigator.vibrate) { try { navigator.vibrate(80); } catch(_) {} }
        const wrapper = videoElement.parentElement;
        if (wrapper) {
          wrapper.classList.remove('flash-ok');
          void wrapper.offsetWidth;
          wrapper.classList.add('flash-ok');
          setTimeout(() => wrapper.classList.remove('flash-ok'), 300);
        }
      };
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => setTimeout(runFeedback, 60), { timeout: 150 });
      } else {
        setTimeout(runFeedback, 80);
      }
    }
    hint.classList.remove('hint-warning');
    hint.classList.add('hint-success');
    hint.textContent = 'Zeskanowano kod pomyślnie';
    // Po udanym skanie zatrzymaj dalsze skanowanie i przyciemnij celownik
    dimAim();
    if (scanTickerId) { clearInterval(scanTickerId); scanTickerId = null; }
    if (scanIntervalId) { clearInterval(scanIntervalId); scanIntervalId = null; }
  }

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

  async function autoStart() {
    if (triedAutoStart) return;
    triedAutoStart = true;
    await enumerateCameras();
    try {
      await startCamera();
    } catch (err) {
      hint.classList.add('hint-warning');
      hint.classList.remove('hint-success');
      hint.textContent = translateCameraError(err);
    }
  }
  window.addEventListener('pageshow', autoStart);
  window.addEventListener('load', autoStart);
  document.addEventListener('DOMContentLoaded', autoStart);

  // Akcje przycisków wyników
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      if (!lastResult || !navigator.share) return;
      try { await navigator.share({ title: 'Kod EAN', text: lastResult }); } catch(_) {}
    });
  }
  if (priceBtn) {
    priceBtn.addEventListener('click', async () => {
      if (!lastResult) return;
      try {
        hint.classList.remove('hint-success');
        hint.classList.remove('hint-warning');
        hint.textContent = 'Wysyłanie zapytania o cenę…';
        const userId = getOrCreateUserId();
        const { db } = await import('./firebase-init.js');
        const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
        // dokument o ID = userId, żeby nadpisywać i mieć 1 aktywne żądanie na użytkownika
        await setDoc(doc(db, 'requests', userId), {
          userId,
          ean: lastResult,
          requestedAt: serverTimestamp(),
          status: 'pending',
          // TTL: klient ustawia czas wygaśnięcia (np. 30 min) – skonfiguruj TTL w Firestore na polu expiresAt
          expiresAt: new Date(Date.now() + 30 * 60 * 1000)
        });
        hint.classList.add('hint-success');
        hint.textContent = 'Zeskanowano kod pomyślnie • Zapytanie o cenę wysłane';
      } catch (err) {
        console.error(err);
        hint.classList.add('hint-warning');
        hint.textContent = 'Błąd wysyłania zapytania o cenę';
      }
    });
  }
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      if (!lastResult) return;
      const url = `https://allegro.pl/listing?string=${encodeURIComponent(lastResult)}&order=qd`;
      window.open(url, '_blank', 'noopener');
    });
  }
  
  if (clearCodeBtn) {
    clearCodeBtn.addEventListener('click', async () => {
      setResult('');
      hint.classList.remove('hint-warning');
      hint.classList.remove('hint-success');
      hint.textContent = 'Skieruj aparat na kod EAN. Staraj się wypełnić ramkę.';
      showAim();
      // wznów skanowanie
      await startScanningLoop();
    });
  }

  // Rejestracja Service Workera (PWA)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const base = window.location.pathname.replace(/\/[^/]*$/, '/');
      const swUrl = `${base}sw.js`;
      navigator.serviceWorker.register(swUrl).catch(() => {});
    });
  }
})();



