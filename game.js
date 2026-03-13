'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// NOVA STRIKE — game.js
// ═══════════════════════════════════════════════════════════════════════════════

// ── Difficulty scaling ────────────────────────────────────────────────────────
// Every value is a function of `level`. Tweak these to tune the curve.
const DIFF = {
  // Enemy count per normal wave (capped at 28)
  enemyCount:      (lvl) => Math.min(6 + lvl * 3, 28),

  // Enemy downward speed
  enemySpeed:      (lvl) => 0.38 + lvl * 0.12,

  // Enemy lateral drift amplitude
  enemyDrift:      (lvl) => Math.min(0.4 + lvl * 0.06, 1.2),

  // Minimum frames between enemy shots (lower = faster shooting)
  enemyShootMin:   (lvl) => Math.max(18, 80 - lvl * 7),

  // Random jitter added on top of min shoot cooldown
  enemyShootJitter:(lvl) => Math.max(10, 50 - lvl * 4),

  // Enemy bullet speed
  enemyBulletSpd:  (lvl) => Math.min(2.4 + lvl * 0.22, 6.5),

  // Tank HP (more HP at higher levels)
  tankHp:          (lvl) => 2 + Math.floor(lvl / 2),

  // Scout HP
  scoutHp:         (lvl) => lvl >= 4 ? 2 : 1,

  // Boss HP
  bossHp:          (lvl) => 18 + lvl * 6,

  // Boss movement speed
  bossSpeed:       (lvl) => Math.min(1.1 + lvl * 0.18, 4.0),

  // Boss shoot cooldown (lower = more shots)
  bossShootMin:    (lvl) => Math.max(14, 55 - lvl * 4),

  // Boss bullet speed
  bossBulletSpd:   (lvl) => Math.min(3.0 + lvl * 0.2, 6.0),

  // Which enemy types appear (more variety at higher levels)
  enemyTypes:      (lvl) => {
    if (lvl <= 2) return ['drone', 'drone', 'scout'];          // mostly drones
    if (lvl <= 4) return ['drone', 'scout', 'tank'];           // balanced
    if (lvl <= 7) return ['drone', 'scout', 'tank', 'tank'];   // tank-heavy
    return              ['scout', 'tank', 'tank', 'scout'];    // fast + tanky
  },

  // Powerup drop chance (bosses always drop one)
  powerupChance:   (lvl) => Math.min(0.10 + lvl * 0.015, 0.25),

  // Milliseconds between waves (gets slightly shorter)
  waveDelay:       (lvl) => Math.max(900, 1600 - lvl * 50),
};

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
ctx.imageSmoothingEnabled = false;

// Pre-render static grid once (big performance win — no per-frame stroke calls)
const gridCanvas = document.createElement('canvas');
gridCanvas.width = W; gridCanvas.height = H;
(function () {
  const g = gridCanvas.getContext('2d');
  g.strokeStyle = 'rgba(0,245,255,0.045)';
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
})();

// ── Game state ────────────────────────────────────────────────────────────────
let gameState = 'title'; // 'title' | 'playing' | 'paused' | 'gameover'
let score     = 0;
let hiScore   = parseInt(localStorage.getItem('novaHiScore') || '0');
let lives     = 3;
let level     = 1;
let wave      = 0;
let frameCount    = 0;
let animId        = null;
let waveScheduled = false;

// ── Input ─────────────────────────────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space')  e.preventDefault();
  if (e.code === 'Escape') {
    if (gameState === 'playing') pauseGame();
    else if (gameState === 'paused') resumeGame();
  }
  if (e.code === 'KeyF') toggleFullscreen();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });
document.getElementById('start-btn').addEventListener('click', startGame);

// ── Parallax star field ───────────────────────────────────────────────────────
const starLayers = [
  { stars: [], speed: 0.3, size: 1,   count: 50, color: 'rgba(255,255,255,0.28)' },
  { stars: [], speed: 0.7, size: 1.5, count: 28, color: 'rgba(255,255,255,0.55)' },
  { stars: [], speed: 1.4, size: 2,   count: 14, color: 'rgba(200,240,255,0.85)' },
];
starLayers.forEach(l => {
  for (let i = 0; i < l.count; i++) l.stars.push({ x: Math.random() * W, y: Math.random() * H });
});

// ── Player ────────────────────────────────────────────────────────────────────
const player = {
  x: W / 2, y: H - 70,
  w: 28, h: 28,
  speed: 4.5,
  shootCooldown: 0,
  shootRate: 12,
  invincible: 0,
};

// ── Entity arrays ─────────────────────────────────────────────────────────────
let bullets      = [];
let enemyBullets = [];
let enemies      = [];
let particles    = [];
let powerups     = [];
let shockwaves   = [];
let messages     = [];

const MAX_PARTICLES  = 100;
const MAX_SHOCKWAVES = 6;

// ── Pixel sprite definitions ──────────────────────────────────────────────────
const SPRITE_DEFS = {
  player: [
    [0,0,0,0,1,1,0,0,0,0],
    [0,0,0,1,1,1,1,0,0,0],
    [0,0,1,1,1,1,1,1,0,0],
    [0,1,1,2,1,1,2,1,1,0],
    [1,1,1,1,2,2,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1],
    [0,1,1,1,1,1,1,1,1,0],
    [0,0,1,1,0,0,1,1,0,0],
    [0,0,1,1,0,0,1,1,0,0],
    [0,0,0,1,0,0,1,0,0,0],
  ],
  drone: [
    [0,1,0,1,0,1,0],
    [1,1,1,1,1,1,1],
    [0,1,2,2,2,1,0],
    [1,1,2,3,2,1,1],
    [0,1,2,2,2,1,0],
    [1,1,1,1,1,1,1],
    [0,1,0,1,0,1,0],
  ],
  tank: [
    [0,0,1,1,1,0,0],
    [0,1,1,1,1,1,0],
    [1,1,2,2,2,1,1],
    [1,1,2,3,2,1,1],
    [1,1,2,2,2,1,1],
    [1,1,1,1,1,1,1],
    [0,1,1,1,1,1,0],
    [0,0,1,0,1,0,0],
  ],
  scout: [
    [0,0,1,0,0],
    [0,1,1,1,0],
    [1,2,3,2,1],
    [0,1,1,1,0],
    [1,0,0,0,1],
  ],
  boss: [
    [0,0,1,1,1,1,1,1,0,0],
    [0,1,1,2,1,1,2,1,1,0],
    [1,1,2,2,2,2,2,2,1,1],
    [1,2,2,3,3,3,3,2,2,1],
    [1,2,3,3,4,4,3,3,2,1],
    [1,2,2,3,3,3,3,2,2,1],
    [1,1,2,2,2,2,2,2,1,1],
    [0,1,1,2,1,1,2,1,1,0],
    [0,0,1,1,1,1,1,1,0,0],
    [1,0,0,1,0,0,1,0,0,1],
  ],
};

// Build each sprite into a cached offscreen canvas (drawn once, reused every frame)
function buildSprite(key, palette) {
  const grid = SPRITE_DEFS[key];
  const P = 2;
  const rows = grid.length, cols = grid[0].length;
  const oc  = document.createElement('canvas');
  oc.width  = cols * P;
  oc.height = rows * P;
  const c = oc.getContext('2d');
  grid.forEach((row, ry) =>
    row.forEach((v, rx) => {
      if (!palette[v]) return;
      c.fillStyle = palette[v];
      c.fillRect(rx * P, ry * P, P, P);
    })
  );
  return oc;
}

const SPR = {
  player: buildSprite('player', { 1: '#00f5ff', 2: '#ffffff' }),
  drone:  buildSprite('drone',  { 1: '#ff006e', 2: '#ff69b4', 3: '#ffffff' }),
  tank:   buildSprite('tank',   { 1: '#ff8800', 2: '#ffcc00', 3: '#ffffff' }),
  scout:  buildSprite('scout',  { 1: '#cc00ff', 2: '#ff00ff', 3: '#ffffff' }),
  boss:   buildSprite('boss',   { 1: '#ff2200', 2: '#ff8800', 3: '#ffffff', 4: '#ffff00' }),
};

// ── Draw functions ────────────────────────────────────────────────────────────

function drawPlayer(x, y, inv) {
  if (inv > 0 && Math.floor(frameCount / 4) % 2 === 0) return;
  const cx = Math.floor(x), cy = Math.floor(y);
  const flen = Math.sin(frameCount * 0.4) * 3 + 7;
  ctx.fillStyle = '#ff6b00'; ctx.fillRect(cx - 5, cy + 12, 10, flen);
  ctx.fillStyle = '#ffdd00'; ctx.fillRect(cx - 3, cy + 12, 6,  flen * 0.6);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - 1, cy + 12, 2,  3);
  ctx.drawImage(SPR.player, cx - SPR.player.width / 2, cy - SPR.player.height / 2);
}

function drawEnemy(e) {
  const cx = Math.floor(e.x), cy = Math.floor(e.y);
  const sp = SPR[e.type];

  // Boss HP bar
  if (e.type === 'boss') {
    const bw = 80, bh = 5, bx = cx - 40, by = cy - 38;
    ctx.fillStyle = '#330000';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = e.hp > e.maxHp * 0.5 ? '#ff2200' : '#ff8800';
    ctx.fillRect(bx, by, bw * (e.hp / e.maxHp), bh);
    ctx.strokeStyle = '#ff4400'; ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
  }

  if (sp) ctx.drawImage(sp, cx - sp.width / 2, cy - sp.height / 2);

  // Hit flash overlay
  if (e.hitFlash > 0) {
    ctx.globalAlpha = (e.hitFlash / 10) * 0.5;
    ctx.fillStyle = '#ffffff';
    const hw = sp ? sp.width  / 2 : 14;
    const hh = sp ? sp.height / 2 : 14;
    ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.globalAlpha = 1;
  }
}

function drawBullet(b) {
  ctx.fillStyle = b.color;
  if (b.isEnemy) {
    ctx.fillRect(b.x - 3, b.y, 6, 10);
  } else {
    ctx.fillRect(b.x - 2, b.y - 8, 4, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(b.x - 1, b.y - 6, 2, 4);
  }
}

function drawParticle(p) {
  ctx.globalAlpha = p.life / p.maxLife;
  ctx.fillStyle   = p.color;
  const s = Math.max(1, p.size * (p.life / p.maxLife));
  ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
  ctx.globalAlpha = 1;
}

function drawShockwave(s) {
  ctx.globalAlpha  = (s.life / s.maxLife) * 0.55;
  ctx.strokeStyle  = s.color;
  ctx.lineWidth    = 2;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.radius * (1 - s.life / s.maxLife), 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPowerup(p) {
  const by = p.y + Math.sin(frameCount * 0.1) * 3;
  ctx.strokeStyle = p.color; ctx.lineWidth = 2;
  ctx.strokeRect(p.x - 10, by - 10, 20, 20);
  ctx.fillStyle = p.color;
  ctx.fillText(p.icon, p.x, by);
}

// ── Wave spawning ─────────────────────────────────────────────────────────────
function spawnWave() {
  waveScheduled = false;
  wave++;
  const isBoss = wave % 5 === 0;

  if (isBoss) {
    const hp = DIFF.bossHp(level);
    enemies.push({
      x: W / 2, y: 80,
      vx: DIFF.bossSpeed(level) * (Math.random() < 0.5 ? 1 : -1),
      vy: 0,
      type: 'boss',
      hp, maxHp: hp,
      shootCooldown: 55,
      hitFlash: 0,
      score: 500 + level * 200,
    });
    addMessage(`⚠  BOSS INCOMING — LVL ${level}  ⚠`, '#ff2200');
  } else {
    const count = DIFF.enemyCount(level);
    const types = DIFF.enemyTypes(level);
    const cols  = Math.min(count, 8);
    const rows  = Math.ceil(count / cols);
    let n = 0;
    for (let r = 0; r < rows && n < count; r++) {
      for (let c = 0; c < cols && n < count; c++, n++) {
        const type = types[Math.floor(Math.random() * types.length)];
        const hp   = type === 'tank'  ? DIFF.tankHp(level)
                   : type === 'scout' ? DIFF.scoutHp(level)
                   : 1;
        enemies.push({
          x: 50 + c * (W - 100) / Math.max(cols - 1, 1),
          y: 40 + r * 40,
          vx: (Math.random() - 0.5) * (0.6 + level * 0.04),
          vy: DIFF.enemySpeed(level),
          type, hp, maxHp: hp,
          shootCooldown: DIFF.enemyShootMin(level) + Math.random() * DIFF.enemyShootJitter(level),
          hitFlash: 0,
          wobble: Math.random() * Math.PI * 2,
          score: type === 'tank' ? 150 : type === 'scout' ? 200 : 100,
        });
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function explode(x, y, color, count = 12, big = false) {
  const n = Math.min(count, MAX_PARTICLES - particles.length);
  for (let i = 0; i < n; i++) {
    const a   = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const spd = (big ? 1.5 : 0.8) + Math.random() * (big ? 3.5 : 2);
    particles.push({
      x, y,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      size: big ? 2 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2),
      color: Math.random() < 0.35 ? '#ffffff' : color,
      life: 18 + Math.random() * 22, maxLife: 40,
    });
  }
  if (shockwaves.length < MAX_SHOCKWAVES)
    shockwaves.push({ x, y, radius: big ? 80 : 50, life: 16, maxLife: 16, color });
}

function addMessage(text, color = '#ffff00') {
  if (messages.length < 3)
    messages.push({ text, color, life: 120, maxLife: 120, y: H / 2 });
}

function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function updateHUD() {
  document.getElementById('score-val').textContent    = String(score).padStart(6, '0');
  document.getElementById('hi-val').textContent       = String(hiScore).padStart(6, '0');
  document.getElementById('level-display').textContent = 'LVL ' + String(level).padStart(2, '0');
  const lc = document.getElementById('lives-icons');
  lc.innerHTML = '';
  for (let i = 0; i < lives; i++) {
    const d = document.createElement('div');
    d.className = 'life-icon';
    lc.appendChild(d);
  }
}

// ── Main update ───────────────────────────────────────────────────────────────
function update() {
  frameCount++;

  // ── Player movement ──
  if ((keys['ArrowLeft']  || keys['KeyA']) && player.x > player.w / 2)      player.x -= player.speed;
  if ((keys['ArrowRight'] || keys['KeyD']) && player.x < W - player.w / 2)  player.x += player.speed;
  if ((keys['ArrowUp']    || keys['KeyW']) && player.y > player.h / 2)      player.y -= player.speed * 0.7;
  if ((keys['ArrowDown']  || keys['KeyS']) && player.y < H - player.h / 2)  player.y += player.speed * 0.7;

  // ── Player shoot ──
  if (player.shootCooldown > 0) player.shootCooldown--;
  if ((keys['Space'] || keys['KeyZ']) && player.shootCooldown === 0) {
    player.shootCooldown = player.shootRate;
    bullets.push({ x: player.x, y: player.y - 14, vy: -9, color: '#00f5ff', isEnemy: false, dmg: 1 });
  }
  if (player.invincible > 0) player.invincible--;

  // ── Player bullets vs enemies ──
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.y += b.vy;
    if (b.y < -20) { bullets.splice(i, 1); continue; }
    let hit = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e  = enemies[j];
      const ew = e.type === 'boss' ? 28 : 14;
      if (rectsOverlap(b.x - 3, b.y - 8, 6, 14, e.x - ew, e.y - ew, ew * 2, ew * 2)) {
        e.hp -= b.dmg;
        e.hitFlash = 7;
        explode(b.x, b.y, '#ffffff', 4);
        if (e.hp <= 0) {
          const big = e.type === 'boss';
          const col = e.type === 'drone'  ? '#ff006e'
                    : e.type === 'tank'   ? '#ff8800'
                    : e.type === 'scout'  ? '#cc00ff'
                    : '#ff2200';
          explode(e.x, e.y, col, big ? 24 : 12, big);
          if (big) addMessage(`BOSS DESTROYED! +${e.score}`, '#ffff00');
          score += e.score;
          if (score > hiScore) hiScore = score;
          updateHUD();
          if (Math.random() < (big ? 1 : DIFF.powerupChance(level))) spawnPowerup(e.x, e.y);
          enemies.splice(j, 1);
        }
        hit = true;
        break;
      }
    }
    if (hit) bullets.splice(i, 1);
  }

  // ── Enemy bullets vs player ──
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx; b.y += b.vy;
    if (b.y > H + 20 || b.y < -20 || b.x < -20 || b.x > W + 20) { enemyBullets.splice(i, 1); continue; }
    if (player.invincible <= 0) {
      const pw = player.w * 0.6;
      if (rectsOverlap(b.x - 3, b.y - 3, 6, 10, player.x - pw / 2, player.y - pw / 2, pw, pw)) {
        hitPlayer();
        explode(b.x, b.y, '#ff4400', 7);
        enemyBullets.splice(i, 1);
      }
    }
  }

  // ── Enemy update ──
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.hitFlash > 0) e.hitFlash--;

    if (e.type === 'boss') {
      // Boss moves horizontally, bobs vertically; speeds up when low HP
      const hpRatio  = e.hp / e.maxHp;
      const speedMod = hpRatio < 0.4 ? 1.6 : hpRatio < 0.7 ? 1.25 : 1;
      e.x += e.vx * speedMod;
      e.y  = 80 + Math.sin(frameCount * 0.025) * 18;
      if (e.x < 50 || e.x > W - 50) e.vx *= -1;

      e.shootCooldown--;
      if (e.shootCooldown <= 0) {
        e.shootCooldown = DIFF.bossShootMin(level);
        const spd = DIFF.bossBulletSpd(level);

        // Phase 1: 3-way spread
        // Phase 2 (<50% HP): 5-way spread
        // Phase 3 (<25% HP): 5-way + aimed shot
        const arcs = hpRatio < 0.5
          ? [-0.55, -0.27, 0, 0.27, 0.55]
          : [-0.35,  0,    0.35];
        arcs.forEach(a => {
          const ang = Math.PI / 2 + a;
          enemyBullets.push({ x: e.x, y: e.y + 24, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, color: '#ff4400', isEnemy: true });
        });

        // Aimed shot in phase 3
        if (hpRatio < 0.25) {
          const aimed = Math.atan2(player.y - e.y, player.x - e.x);
          enemyBullets.push({ x: e.x, y: e.y + 24, vx: Math.cos(aimed) * spd, vy: Math.sin(aimed) * spd, color: '#ffff00', isEnemy: true });
        }
      }

    } else {
      // Normal enemies: wobble side-to-side, move down
      e.wobble += 0.03;
      e.x += e.vx + Math.sin(e.wobble) * DIFF.enemyDrift(level);
      e.y += e.vy;
      if (e.x < 20 || e.x > W - 20) e.vx *= -1;

      // Passed the bottom — player loses a shield
      if (e.y > H + 30) { hitPlayer(); enemies.splice(i, 1); continue; }

      // Shoot at player
      e.shootCooldown--;
      if (e.shootCooldown <= 0) {
        e.shootCooldown = DIFF.enemyShootMin(level) + Math.random() * DIFF.enemyShootJitter(level);
        const ang = Math.atan2(player.y - e.y, player.x - e.x);
        const spd = DIFF.enemyBulletSpd(level);
        enemyBullets.push({ x: e.x, y: e.y + 10, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, color: '#ff3300', isEnemy: true });

        // Tanks fire a double-shot at higher levels
        if (e.type === 'tank' && level >= 3) {
          setTimeout(() => {
            if (gameState !== 'playing') return;
            const a2 = Math.atan2(player.y - e.y, player.x - e.x);
            enemyBullets.push({ x: e.x, y: e.y + 10, vx: Math.cos(a2) * spd, vy: Math.sin(a2) * spd, color: '#ff6600', isEnemy: true });
          }, 200);
        }
      }

      // Body collision with player
      if (player.invincible <= 0) {
        if (rectsOverlap(player.x - 11, player.y - 11, 22, 22, e.x - 12, e.y - 12, 24, 24)) {
          hitPlayer();
          explode(e.x, e.y, '#ff4400', 14, true);
          enemies.splice(i, 1);
          continue;
        }
      }
    }
  }

  // ── Wave clear check ──
  if (enemies.length === 0 && gameState === 'playing' && !waveScheduled) {
    waveScheduled = true;
    score += wave * 75;
    if (wave % 5 === 0) level++;
    updateHUD();
    addMessage(wave % 5 === 0 ? `LEVEL ${level} — GOOD LUCK!` : 'WAVE CLEAR!', '#39ff14');
    setTimeout(spawnWave, DIFF.waveDelay(level));
  }

  // ── Particles ──
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 0.94; p.vy *= 0.94;
    if (--p.life <= 0) particles.splice(i, 1);
  }

  // ── Shockwaves ──
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    if (--shockwaves[i].life <= 0) shockwaves.splice(i, 1);
  }

  // ── Powerups ──
  for (let i = powerups.length - 1; i >= 0; i--) {
    const p = powerups[i];
    p.y += 1.2;
    if (p.y > H + 20) { powerups.splice(i, 1); continue; }
    const pw = player.w;
    if (rectsOverlap(p.x - 10, p.y - 10, 20, 20, player.x - pw / 2, player.y - pw / 2, pw, pw)) {
      applyPowerup(p);
      powerups.splice(i, 1);
    }
  }

  // ── Star scroll ──
  starLayers.forEach(l => l.stars.forEach(s => {
    s.y += l.speed;
    if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
  }));

  // ── Messages ──
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; m.life--; m.y -= 0.3;
    if (m.life <= 0) messages.splice(i, 1);
  }
}

// ── Player hit ────────────────────────────────────────────────────────────────
function hitPlayer() {
  if (player.invincible > 0) return;
  lives--;
  player.invincible = 110;
  explode(player.x, player.y, '#00f5ff', 18, true);
  updateHUD();
  if (lives <= 0) setTimeout(gameOver, 350);
}

// ── Powerups ──────────────────────────────────────────────────────────────────
function spawnPowerup(x, y) {
  const types = [
    { type: 'shield', color: '#00ff88', icon: 'S' },
    { type: 'rapid',  color: '#ffff00', icon: 'R' },
    { type: 'bomb',   color: '#ff4400', icon: 'B' },
  ];
  powerups.push({ x, y, ...types[Math.floor(Math.random() * types.length)] });
}

function applyPowerup(p) {
  if (p.type === 'shield') {
    lives = Math.min(5, lives + 1);
    addMessage('+1 SHIELD', '#00ff88');
  } else if (p.type === 'rapid') {
    player.shootRate = 5;
    addMessage('RAPID FIRE!', '#ffff00');
    setTimeout(() => { player.shootRate = 12; }, 5000);
  } else if (p.type === 'bomb') {
    enemies.forEach(e => {
      explode(e.x, e.y, e.type === 'boss' ? '#ff2200' : '#ff8800', 14, e.type === 'boss');
      score += e.score;
    });
    enemies = [];
    addMessage('MEGA BOMB!', '#ff4400');
  }
  updateHUD();
  explode(p.x, p.y, p.color, 12);
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw() {
  // Background
  ctx.fillStyle = '#020008';
  ctx.fillRect(0, 0, W, H);

  // Pre-rendered grid (single drawImage — no per-frame stroke calls)
  ctx.drawImage(gridCanvas, 0, 0);

  // Stars (batched per layer)
  starLayers.forEach(l => {
    ctx.fillStyle = l.color;
    l.stars.forEach(s => ctx.fillRect(s.x, s.y, l.size, l.size));
  });

  // FX
  shockwaves.forEach(drawShockwave);
  particles.forEach(drawParticle);

  // Powerups
  if (powerups.length) {
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = '9px "Press Start 2P"';
    powerups.forEach(drawPowerup);
  }

  // Game objects
  enemyBullets.forEach(drawBullet);
  bullets.forEach(drawBullet);
  enemies.forEach(drawEnemy);

  if (gameState === 'playing' || gameState === 'paused')
    drawPlayer(player.x, player.y, player.invincible);

  // Screen messages
  if (messages.length) {
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = '10px "Press Start 2P"';
    messages.forEach(m => {
      ctx.globalAlpha = Math.min(1, m.life / 30);
      ctx.fillStyle   = m.color;
      ctx.fillText(m.text, W / 2, m.y);
    });
    ctx.globalAlpha = 1;
  }

  if (gameState === 'paused') {
    ctx.fillStyle = 'rgba(0,0,10,0.45)';
    ctx.fillRect(0, 0, W, H);
  }
}

// ── Game loop (single RAF — never duplicated) ─────────────────────────────────
function loop() {
  if (gameState === 'playing') update();
  draw();
  animId = requestAnimationFrame(loop);
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function startGame() {
  score = 0; lives = 3; level = 1; wave = 0; waveScheduled = false;
  bullets = []; enemyBullets = []; enemies = [];
  particles = []; powerups = []; shockwaves = []; messages = [];
  player.x = W / 2; player.y = H - 70;
  player.invincible = 0; player.shootCooldown = 0; player.shootRate = 12;
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('start-btn').onclick = startGame;
  gameState = 'playing';
  updateHUD();
  spawnWave();
  if (!animId) loop();
}

function pauseGame() {
  gameState = 'paused';
  showOverlay('PAUSED', 'PRESS ESC TO RESUME', '', 'RESUME');
  document.getElementById('start-btn').onclick = resumeGame;
}

function resumeGame() {
  document.getElementById('overlay').classList.add('hidden');
  gameState = 'playing';
  document.getElementById('start-btn').onclick = startGame;
}

function gameOver() {
  gameState = 'gameover';
  if (score > hiScore) { hiScore = score; localStorage.setItem('novaHiScore', hiScore); }
  showOverlay(
    'GAME OVER',
    '— MISSION FAILED —',
    `SCORE: ${String(score).padStart(6, '0')}\nWAVE: ${wave}  /  LVL: ${level}`,
    'TRY AGAIN'
  );
  document.getElementById('start-btn').onclick = startGame;
}

function showOverlay(title, subtitle, extra, btn) {
  document.getElementById('overlay-title').textContent   = title;
  document.getElementById('overlay-subtitle').textContent = subtitle;
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('start-btn').textContent = '► ' + btn;
  const el = document.getElementById('overlay-extra');
  el.innerHTML = extra ? `<div id="game-over-score">${extra.replace(/\n/g, '<br>')}</div>` : '';
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// ── Overlay star dots (decorative) ───────────────────────────────────────────
(function () {
  const container = document.getElementById('stars-bg');
  for (let i = 0; i < 55; i++) {
    const s = document.createElement('div');
    s.className = 'star-dot';
    s.style.left  = Math.random() * 100 + '%';
    s.style.top   = Math.random() * 100 + '%';
    s.style.setProperty('--d',     (1.5 + Math.random() * 3) + 's');
    s.style.setProperty('--delay', (Math.random() * 3) + 's');
    container.appendChild(s);
  }
})();

// ── Boot ──────────────────────────────────────────────────────────────────────
updateHUD();
loop();
