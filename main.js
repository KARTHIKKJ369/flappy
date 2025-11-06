(() => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const imgUpload = document.getElementById('imgUpload');
  const hitUpload = document.getElementById('hitUpload');
  const flapUpload = document.getElementById('flapUpload');
  const flapVolInput = document.getElementById('flapVol');

  // Game config
  const CFG = {
    gravity: 0.5,
    flap: -8.8,
    pipeGap: 160,
    pipeWidth: 70,
    pipeSpeed: 2.6,
    spawnEvery: 1500, // ms
    maxFallSpeed: 14,
    playerSize: 48,
    ground: 20
  };

  // State
  let state = 'menu'; // menu | running | paused | gameover
  let pipes = [];
  let lastTime = 0;
  let spawnTimer = 0;
  let score = 0;
  let best = Number(localStorage.getItem('ff_best') || 0);

  // Player
  const player = {
    x: canvas.width * 0.25,
    y: canvas.height * 0.5,
    vy: 0,
    w: CFG.playerSize,
    h: CFG.playerSize,
    angle: 0
  };

  // Assets: Image
  let playerImg = null;
  let playerImgURL = null;
  let playerImgReady = false;

  // Audio elements (reusable, preloaded)
  let flapAudioSrc = null;
  let flapAudioEl = null;
  let hitAudioSrc = null;
  let hitAudioEl = null;
  let userInteracted = false;

  // Prime audio on first user gesture (fixes deploy/iOS autoplay issues)
  function primeAudio(el) {
    if (!el) return;
    try {
      const prev = el.volume;
      el.volume = 0;
      el.muted = true; // extra safety
      el.play().then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
        el.volume = prev;
      }).catch(() => {
        // ignore; will still be allowed after this gesture in most browsers
        el.muted = false;
        el.volume = prev;
      });
    } catch {}
  }
  function unlockAudioOnce() {
    if (userInteracted) return;
    userInteracted = true;
    primeAudio(flapAudioEl);
    primeAudio(hitAudioEl);
  }
  window.addEventListener('pointerdown', unlockAudioOnce, { once: true, capture: true });
  window.addEventListener('keydown', unlockAudioOnce, { once: true, capture: true });

  function stopFlapSound() {
    if (flapStopTimerId) {
      clearTimeout(flapStopTimerId);
      flapStopTimerId = null;
    }
    if (flapAudioEl) {
      try {
        flapAudioEl.pause();
        flapAudioEl.currentTime = 0;
      } catch {}
    }
  }

  function resetGame() {
    pipes = [];
    spawnTimer = 0;
    score = 0;
    player.y = canvas.height * 0.5;
    player.vy = 0;
    player.angle = 0;
    setScore(0);
  }

  function setScore(v) {
    score = v;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      localStorage.setItem('ff_best', String(best));
    }
  }

  function startGame() {
    if (state === 'running') return;
    userInteracted = true;
    if (state === 'menu' || state === 'gameover') resetGame();
    state = 'running';
    startBtn.disabled = true;
    pauseBtn.disabled = false;
  }

  function pauseGame() {
    if (state !== 'running') return;
    state = 'paused';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopFlapSound(); // ensure no lingering flap audio
  }

  function restartGame() {
    state = 'menu';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopFlapSound(); // ensure no lingering flap audio
    resetGame();
  }

  function gameOver() {
    state = 'gameover';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopFlapSound(); // ensure no lingering flap audio
    // Use preloaded collision audio if available
    if (userInteracted && (hitAudioEl || hitAudioSrc)) {
      const el = hitAudioEl || new Audio(hitAudioSrc);
      try {
        el.currentTime = 0;
        el.volume = 1;
        el.play().catch(() => {});
      } catch {}
    }
  }

  function flap() {
    if (state !== 'running') return;
    player.vy = CFG.flap;

    // Play flap sound with cooldown; let it end naturally if short, cap if long
    const now = performance.now();
    if (userInteracted && flapAudioEl && now - lastFlapSfxAt >= FLAP_SFX_COOLDOWN) {
      lastFlapSfxAt = now;
      stopFlapSound(); // reset before replay
      try {
        flapAudioEl.loop = false;
        flapAudioEl.currentTime = 0;

        // Use UI volume if present
        const volPct = (typeof flapVolInput !== 'undefined' && flapVolInput) ? Number(flapVolInput.value) : 100;
        flapAudioEl.volume = Math.max(0, Math.min(1, volPct / 100));

        flapAudioEl.play().catch(() => {});

        // Determine cap: if duration known, don't cut early unless it's longer than the cap
        const durMs = isFinite(flapAudioEl.duration) && !isNaN(flapAudioEl.duration)
          ? flapAudioEl.duration * 1000
          : Infinity;
        const capMs = Math.min(FLAP_SFX_MAXLEN, durMs);
        if (capMs !== Infinity) {
          flapStopTimerId = setTimeout(() => stopFlapSound(), capMs);
        } else {
          // Unknown duration; apply safety cap
          flapStopTimerId = setTimeout(() => stopFlapSound(), FLAP_SFX_MAXLEN);
        }
      } catch {}
    }
  }

  // Pipes
  function spawnPipe() {
    const margin = 60;
    const gap = CFG.pipeGap;
    const maxTop = canvas.height - CFG.ground - margin - gap;
    const topHeight = Math.floor(Math.random() * (maxTop - margin) + margin);
    pipes.push({
      x: canvas.width + 10,
      top: topHeight,
      bottom: topHeight + gap,
      w: CFG.pipeWidth,
      passed: false
    });
  }

  function update(dt) {
    // Physics
    player.vy += CFG.gravity;
    if (player.vy > CFG.maxFallSpeed) player.vy = CFG.maxFallSpeed;
    player.y += player.vy;

    // Tilt based on vy
    player.angle = Math.max(Math.min((player.vy / CFG.maxFallSpeed) * 0.8, 0.9), -0.45);

    // Pipes
    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= CFG.pipeSpeed;
      // Scoring
      if (!p.passed && p.x + p.w < player.x) {
        p.passed = true;
        setScore(score + 1);
      }
      // Remove off-screen
      if (p.x + p.w < -10) {
        pipes.splice(i, 1);
      }
    }

    // Spawn
    spawnTimer += dt;
    if (spawnTimer >= CFG.spawnEvery) {
      spawnTimer = 0;
      spawnPipe();
    }

    // Collisions
    const px = player.x - player.w / 2;
    const py = player.y - player.h / 2;
    const pr = { x: px, y: py, w: player.w, h: player.h };

    for (const p of pipes) {
      const topRect = { x: p.x, y: 0, w: p.w, h: p.top };
      const botRect = { x: p.x, y: p.bottom, w: p.w, h: canvas.height - p.bottom - CFG.ground };
      if (rectOverlap(pr, topRect) || rectOverlap(pr, botRect)) {
        gameOver();
        return;
      }
    }

    // Ground / Ceiling
    if (py < 0 || py + player.h > canvas.height - CFG.ground) {
      gameOver();
    }
  }

  function rectOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function draw() {
    // Sky gradient already from CSS; draw in-canvas details
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Distant clouds
    drawClouds();

    // Pipes
    for (const p of pipes) drawPipe(p);

    // Ground
    drawGround();

    // Player
    drawPlayer();

    // HUD overlay for paused/gameover
    if (state === 'paused' || state === 'menu') {
      drawOverlay(state === 'menu' ? 'Tap/Press Start' : 'Paused');
    } else if (state === 'gameover') {
      drawOverlay('Game Over - Press Start');
    }

    // Score (big, centered)
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(score), canvas.width / 2 + 2, 98 + 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(score), canvas.width / 2, 98);
  }

  function drawPipe(p) {
    const grdTop = ctx.createLinearGradient(0, 0, 0, p.top);
    grdTop.addColorStop(0, '#3ea34f');
    grdTop.addColorStop(1, '#2b7d3b');

    const grdBot = ctx.createLinearGradient(0, p.bottom, 0, canvas.height);
    grdBot.addColorStop(0, '#3ea34f');
    grdBot.addColorStop(1, '#2b7d3b');

    // Top
    ctx.fillStyle = grdTop;
    ctx.fillRect(p.x, 0, p.w, p.top);
    // Bottom
    ctx.fillStyle = grdBot;
    ctx.fillRect(p.x, p.bottom, p.w, canvas.height - p.bottom - CFG.ground);

    // Pipe lips
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(p.x - 2, p.top - 10, p.w + 4, 10);
    ctx.fillRect(p.x - 2, p.bottom, p.w + 4, 10);
  }

  function drawGround() {
    const y = canvas.height - CFG.ground;
    ctx.fillStyle = '#6b4f2a';
    ctx.fillRect(0, y, canvas.width, CFG.ground);
    // stripes
    ctx.fillStyle = '#8f6a3a';
    for (let x = 0; x < canvas.width; x += 16) {
      ctx.fillRect(x, y, 8, 4);
    }
  }

  function drawPlayer() {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);

    const w = player.w;
    const h = player.h;

    if (playerImgReady) {
      // Draw uploaded image with a soft outline
      roundImage(ctx, playerImg, -w / 2, -h / 2, w, h, 10);
    } else {
      // Fallback: simple circle with emoji face
      const r = Math.min(w, h) / 2;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // eyes
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(-8, -6, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(8, -6, 3, 0, Math.PI * 2); ctx.fill();
      // smile
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 2, 10, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    }

    ctx.restore();
  }

  function drawOverlay(text) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('Click/Touch to flap', canvas.width / 2, canvas.height / 2 + 26);
  }

  function drawClouds() {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const t = (performance.now() / 4000) % 1;
    for (let i = 0; i < 3; i++) {
      const x = ((i * 200 + t * canvas.width) % (canvas.width + 220)) - 220;
      cloudAt(x, 80 + i * 40, 1 + i * 0.2);
    }
  }

  function cloudAt(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.arc(18, -6, 16, 0, Math.PI * 2);
    ctx.arc(36, 0, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function roundImage(ctx, img, x, y, w, h, r = 8) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    // outline
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  // Upload handlers
  imgUpload.addEventListener('change', () => {
    const file = imgUpload.files && imgUpload.files[0];
    if (!file) return;
    if (playerImgURL) URL.revokeObjectURL(playerImgURL);
    playerImgURL = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      playerImg = img;
      playerImgReady = true;
    };
    img.onerror = () => {
      playerImg = null;
      playerImgReady = false;
    };
    img.src = playerImgURL;
  });

  flapUpload.addEventListener('change', () => {
    const file = flapUpload.files && flapUpload.files[0];
    if (!file) return;
    if (flapAudioSrc) URL.revokeObjectURL(flapAudioSrc);
    flapAudioSrc = URL.createObjectURL(file);
    flapAudioEl = new Audio(flapAudioSrc);
    flapAudioEl.loop = false;
    flapAudioEl.preload = 'auto';
    try { flapAudioEl.load(); } catch {}
    flapAudioEl.addEventListener('ended', () => {
      if (flapStopTimerId) { clearTimeout(flapStopTimerId); flapStopTimerId = null; }
    });
    if (userInteracted) primeAudio(flapAudioEl);
  });

  hitUpload.addEventListener('change', () => {
    const file = hitUpload.files && hitUpload.files[0];
    if (!file) return;
    if (hitAudioSrc) URL.revokeObjectURL(hitAudioSrc);
    hitAudioSrc = URL.createObjectURL(file);
    hitAudioEl = new Audio(hitAudioSrc);
    hitAudioEl.loop = false;
    hitAudioEl.preload = 'auto';
    try { hitAudioEl.load(); } catch {}
    if (userInteracted) primeAudio(hitAudioEl);
  });

  // Controls
  startBtn.addEventListener('click', startGame);
  pauseBtn.addEventListener('click', pauseGame);
  restartBtn.addEventListener('click', restartGame);

  // Input: keyboard
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return; // prevent auto-repeat causing continuous flaps/sound
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      if (state === 'menu' || state === 'gameover') startGame();
      flap();
    } else if (e.code === 'KeyP') {
      if (state === 'running') pauseGame(); else if (state === 'paused') startGame();
    }
  });

  // Input: pointer/touch on canvas
  const flapFromPointer = () => {
    if (state === 'menu' || state === 'gameover') startGame();
    flap();
  };
  canvas.addEventListener('mousedown', flapFromPointer);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flapFromPointer(); }, { passive: false });

  // Resize (keep internal resolution constant; CSS scales)
  window.addEventListener('resize', () => {
    // no-op; canvas is CSS-scaled for simplicity
  });

  // Init UI
  bestEl.textContent = String(best);
  startBtn.disabled = false;
  pauseBtn.disabled = true;

  // Main loop
  function loop(ts) {
    const dt = Math.min(34, ts - lastTime || 16.67);
    lastTime = ts;

    if (state === 'running') update(dt);
    draw();

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
