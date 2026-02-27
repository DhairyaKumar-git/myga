import { useEffect, useRef, useState, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const LOGICAL_WIDTH = 400;
const LOGICAL_HEIGHT = 600;
const GRAVITY = 1800; // px/s²
const FLAP_VELOCITY = -440; // px/s (upward) - slightly reduced sensitivity
const PIPE_SPEED = 180; // px/s
const PIPE_INTERVAL = 1.8; // seconds
const PIPE_GAP = 155; // px between top and bottom pipe
const PIPE_WIDTH = 64;
const PIPE_MIN_HEIGHT = 60;
const GROUND_HEIGHT = 80;
const BIRD_RADIUS = 18;
const BIRD_HITBOX = 13; // smaller than visual
const MAX_ROTATION_DOWN = 1.1; // rad (~63deg nose-down)
const MAX_ROTATION_UP = -0.4; // rad (~23deg nose-up)
const ROTATION_SPEED_DOWN = 4.5; // rad/s

// Wing animation frames per second
const WING_FPS = 12;

// Cloud layers: [speed multiplier, y-range, size range, count]
const CLOUD_LAYERS = [
  { speedMult: 0.15, count: 4, yMin: 40, yMax: 200, sizeMin: 50, sizeMax: 90 },
  { speedMult: 0.28, count: 5, yMin: 80, yMax: 250, sizeMin: 35, sizeMax: 65 },
];

// ─── Types ───────────────────────────────────────────────────────────────────
type GameState = "IDLE" | "PLAYING" | "GAME_OVER" | "AD";

interface Pipe {
  x: number;
  topHeight: number; // height of top pipe from top of canvas
  passed: boolean;
}

interface Cloud {
  x: number;
  y: number;
  size: number;
  layer: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
  color: string;
}

interface GameRef {
  state: GameState;
  birdY: number;
  birdVY: number;
  birdRotation: number;
  wingFrame: number;
  wingTimer: number;
  pipes: Pipe[];
  clouds: Cloud[];
  particles: Particle[];
  score: number;
  pipeTimer: number;
  groundOffset: number;
  idleBobTime: number;
  animFrame: number;
  lastTime: number;
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
}

// ─── Color palette ────────────────────────────────────────────────────────────
const COLORS = {
  skyTop: "#4FC3F7",
  skyBottom: "#FFE082",
  horizonMid: "#FFB74D",
  cloudWhite: "rgba(255,255,255,0.92)",
  cloudShadow: "rgba(220,220,255,0.4)",
  pipeBody: "#66BB6A",
  pipeBodySide: "#43A047",
  pipeCap: "#2E7D32",
  pipeCapSide: "#1B5E20",
  pipeHighlight: "rgba(255,255,255,0.25)",
  pipeShadow: "rgba(0,0,0,0.18)",
  birdYellow: "#FFE000",
  birdYellowDark: "#E65C00",
  birdBelly: "#FFFDE7",
  birdWing: "#FFB300",
  birdEyeWhite: "#FFFFFF",
  birdPupil: "#0D1B6E",
  birdBeak: "#FF5500",
  groundTop: "#8BC34A",
  groundStripe: "#7CB342",
  groundBody: "#795548",
  groundBodyDark: "#5D4037",
  particleColors: ["#FF5252", "#FFAB40", "#FFD740", "#69F0AE", "#40C4FF"],
};

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function drawSky(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const grad = ctx.createLinearGradient(0, 0, 0, h - GROUND_HEIGHT);
  grad.addColorStop(0, COLORS.skyTop);
  grad.addColorStop(0.5, COLORS.horizonMid);
  grad.addColorStop(1, COLORS.skyBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h - GROUND_HEIGHT);
}

function drawSunrise(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Sun glow near horizon
  const sunY = h - GROUND_HEIGHT - 20;
  const sunX = w * 0.75;
  const sunGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 80);
  sunGrad.addColorStop(0, "rgba(255,240,100,0.85)");
  sunGrad.addColorStop(0.3, "rgba(255,200,50,0.4)");
  sunGrad.addColorStop(1, "rgba(255,180,0,0)");
  ctx.fillStyle = sunGrad;
  ctx.fillRect(0, 0, w, h - GROUND_HEIGHT);
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const draw = (alpha: number, offsetY: number) => {
    ctx.beginPath();
    ctx.arc(x, y + offsetY, size * 0.5, 0, Math.PI * 2);
    ctx.arc(x + size * 0.4, y - size * 0.05 + offsetY, size * 0.38, 0, Math.PI * 2);
    ctx.arc(x - size * 0.35, y + size * 0.05 + offsetY, size * 0.33, 0, Math.PI * 2);
    ctx.arc(x + size * 0.72, y + size * 0.08 + offsetY, size * 0.28, 0, Math.PI * 2);
    ctx.arc(x - size * 0.6, y + size * 0.12 + offsetY, size * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = alpha < 1 ? COLORS.cloudShadow : COLORS.cloudWhite;
    ctx.fill();
  };
  draw(0.4, 4); // shadow
  draw(1, 0);   // body
}

function drawClouds(ctx: CanvasRenderingContext2D, clouds: Cloud[]) {
  for (const c of clouds) {
    drawCloud(ctx, c.x, c.y, c.size);
  }
}

function drawPipePair(
  ctx: CanvasRenderingContext2D,
  pipe: Pipe,
  groundY: number
) {
  const x = pipe.x;
  const topH = pipe.topHeight;
  const bottomY = topH + PIPE_GAP;
  const bottomH = groundY - bottomY;
  const capH = 22;
  const capOverhang = 6;

  // Draw a single pipe segment (top or bottom)
  function drawSegment(px: number, py: number, pw: number, ph: number, capBottom: boolean) {
    if (ph <= 0) return;

    // Main pipe body with gradient
    const grad = ctx.createLinearGradient(px, 0, px + pw, 0);
    grad.addColorStop(0, COLORS.pipeBodySide);
    grad.addColorStop(0.2, COLORS.pipeBody);
    grad.addColorStop(0.55, "#81C784");
    grad.addColorStop(0.8, COLORS.pipeBody);
    grad.addColorStop(1, COLORS.pipeBodySide);
    ctx.fillStyle = grad;

    // Body rounded at far end
    const r = 5;
    ctx.beginPath();
    if (capBottom) {
      // Top pipe: rounded at top
      ctx.moveTo(px + r, py);
      ctx.lineTo(px + pw - r, py);
      ctx.quadraticCurveTo(px + pw, py, px + pw, py + r);
      ctx.lineTo(px + pw, py + ph);
      ctx.lineTo(px, py + ph);
      ctx.lineTo(px, py + r);
      ctx.quadraticCurveTo(px, py, px + r, py);
    } else {
      // Bottom pipe: rounded at bottom
      ctx.moveTo(px, py);
      ctx.lineTo(px + pw, py);
      ctx.lineTo(px + pw, py + ph - r);
      ctx.quadraticCurveTo(px + pw, py + ph, px + pw - r, py + ph);
      ctx.lineTo(px + r, py + ph);
      ctx.quadraticCurveTo(px, py + ph, px, py + ph - r);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();

    // Pipe highlight stripe
    ctx.fillStyle = COLORS.pipeHighlight;
    ctx.fillRect(px + pw * 0.15, py, pw * 0.12, ph);

    // Cap
    const capX = px - capOverhang;
    const capW = pw + capOverhang * 2;
    const capY = capBottom ? py + ph - capH : py;

    const capGrad = ctx.createLinearGradient(capX, 0, capX + capW, 0);
    capGrad.addColorStop(0, COLORS.pipeCapSide);
    capGrad.addColorStop(0.18, COLORS.pipeCap);
    capGrad.addColorStop(0.5, "#4CAF50");
    capGrad.addColorStop(0.8, COLORS.pipeCap);
    capGrad.addColorStop(1, COLORS.pipeCapSide);
    ctx.fillStyle = capGrad;

    const cr = 6;
    ctx.beginPath();
    if (capBottom) {
      // Cap at bottom of top pipe
      ctx.moveTo(capX + cr, capY);
      ctx.lineTo(capX + capW - cr, capY);
      ctx.quadraticCurveTo(capX + capW, capY, capX + capW, capY + cr);
      ctx.lineTo(capX + capW, capY + capH - cr);
      ctx.quadraticCurveTo(capX + capW, capY + capH, capX + capW - cr, capY + capH);
      ctx.lineTo(capX + cr, capY + capH);
      ctx.quadraticCurveTo(capX, capY + capH, capX, capY + capH - cr);
      ctx.lineTo(capX, capY + cr);
      ctx.quadraticCurveTo(capX, capY, capX + cr, capY);
    } else {
      // Cap at top of bottom pipe
      ctx.moveTo(capX + cr, capY);
      ctx.lineTo(capX + capW - cr, capY);
      ctx.quadraticCurveTo(capX + capW, capY, capX + capW, capY + cr);
      ctx.lineTo(capX + capW, capY + capH);
      ctx.lineTo(capX, capY + capH);
      ctx.lineTo(capX, capY + cr);
      ctx.quadraticCurveTo(capX, capY, capX + cr, capY);
    }
    ctx.closePath();
    ctx.fill();

    // Cap highlight
    ctx.fillStyle = COLORS.pipeHighlight;
    ctx.fillRect(capX + capW * 0.12, capY + 2, capW * 0.1, capH - 4);

    // Drop shadow on right
    ctx.fillStyle = COLORS.pipeShadow;
    ctx.fillRect(px + pw - 10, py, 10, ph);
  }

  // Top pipe
  drawSegment(x, 0, PIPE_WIDTH, topH, true);
  // Bottom pipe
  drawSegment(x, bottomY, PIPE_WIDTH, bottomH, false);
}

function drawBird(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  rotation: number,
  wingFrame: number
) {
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(rotation);

  const r = BIRD_RADIUS;

  // Wing (behind body)
  const wingAngle = [-0.5, 0.1, 0.5][wingFrame % 3];
  ctx.save();
  ctx.rotate(wingAngle);
  ctx.fillStyle = COLORS.birdWing;
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, r * 0.1, r * 0.65, r * 0.35, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Body
  const bodyGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.04, 0, 0, r * 1.1);
  bodyGrad.addColorStop(0, "#FFFF80");
  bodyGrad.addColorStop(0.25, "#FFE000");
  bodyGrad.addColorStop(0.7, "#FFC000");
  bodyGrad.addColorStop(1, COLORS.birdYellowDark);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Belly highlight
  ctx.fillStyle = COLORS.birdBelly;
  ctx.beginPath();
  ctx.ellipse(r * 0.1, r * 0.25, r * 0.45, r * 0.3, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Eye white
  ctx.fillStyle = COLORS.birdEyeWhite;
  ctx.beginPath();
  ctx.arc(r * 0.35, -r * 0.18, r * 0.34, 0, Math.PI * 2);
  ctx.fill();

  // Pupil
  ctx.fillStyle = COLORS.birdPupil;
  ctx.beginPath();
  ctx.arc(r * 0.42, -r * 0.15, r * 0.17, 0, Math.PI * 2);
  ctx.fill();

  // Eye shine
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(r * 0.47, -r * 0.22, r * 0.07, 0, Math.PI * 2);
  ctx.fill();

  // Beak
  ctx.fillStyle = COLORS.birdBeak;
  ctx.beginPath();
  ctx.moveTo(r * 0.55, -r * 0.05);
  ctx.lineTo(r * 1.05, r * 0.08);
  ctx.lineTo(r * 0.55, r * 0.25);
  ctx.closePath();
  ctx.fill();

  // Beak line
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(r * 0.55, r * 0.1);
  ctx.lineTo(r * 1.0, r * 0.1);
  ctx.stroke();

  ctx.restore();
}

function drawGround(ctx: CanvasRenderingContext2D, w: number, h: number, offset: number) {
  const groundY = h - GROUND_HEIGHT;

  // Grass top strip
  ctx.fillStyle = COLORS.groundTop;
  ctx.fillRect(0, groundY, w, 18);

  // Darker stripe
  ctx.fillStyle = COLORS.groundStripe;
  ctx.fillRect(0, groundY + 6, w, 6);

  // Brown body
  const dirtGrad = ctx.createLinearGradient(0, groundY + 18, 0, h);
  dirtGrad.addColorStop(0, COLORS.groundBody);
  dirtGrad.addColorStop(1, COLORS.groundBodyDark);
  ctx.fillStyle = dirtGrad;
  ctx.fillRect(0, groundY + 18, w, GROUND_HEIGHT - 18);

  // Scrolling dirt stripes
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  const stripeW = 40;
  const stripeGap = 60;
  const totalStride = stripeW + stripeGap;
  const startX = -(offset % totalStride);
  for (let sx = startX; sx < w + stripeW; sx += totalStride) {
    ctx.fillRect(sx, groundY + 22, stripeW, 8);
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]) {
  particles.forEach((p) => {
    const alpha = p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius * alpha, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function spawnParticles(x: number, y: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < 18; i++) {
    const angle = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5) * 0.5;
    const speed = 80 + Math.random() * 200;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 60,
      life: 0.8 + Math.random() * 0.4,
      maxLife: 0.8 + Math.random() * 0.4,
      radius: 4 + Math.random() * 5,
      color: COLORS.particleColors[Math.floor(Math.random() * COLORS.particleColors.length)],
    });
  }
  return particles;
}

function initClouds(): Cloud[] {
  const clouds: Cloud[] = [];
  CLOUD_LAYERS.forEach((layer, li) => {
    for (let i = 0; i < layer.count; i++) {
      clouds.push({
        x: Math.random() * LOGICAL_WIDTH,
        y: layer.yMin + Math.random() * (layer.yMax - layer.yMin),
        size: layer.sizeMin + Math.random() * (layer.sizeMax - layer.sizeMin),
        layer: li,
      });
    }
  });
  return clouds;
}

function randomPipeHeight(): number {
  return PIPE_MIN_HEIGHT + Math.random() * (LOGICAL_HEIGHT - GROUND_HEIGHT - PIPE_GAP - PIPE_MIN_HEIGHT * 2);
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FlappyBird() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameRef>({
    state: "IDLE",
    birdY: LOGICAL_HEIGHT / 2,
    birdVY: 0,
    birdRotation: 0,
    wingFrame: 0,
    wingTimer: 0,
    pipes: [],
    clouds: initClouds(),
    particles: [],
    score: 0,
    pipeTimer: 0,
    groundOffset: 0,
    idleBobTime: 0,
    animFrame: 0,
    lastTime: 0,
    scale: 1,
    canvasWidth: LOGICAL_WIDTH,
    canvasHeight: LOGICAL_HEIGHT,
  });

  const [uiState, setUiState] = useState<GameState>("AD");
  const [adSecondsLeft, setAdSecondsLeft] = useState(10);
  const [showSkip, setShowSkip] = useState(false);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(() => {
    try {
      return parseInt(localStorage.getItem("flappy-best") ?? "0", 10) || 0;
    } catch {
      return 0;
    }
  });

  const bestScoreRef = useRef(bestScore);
  bestScoreRef.current = bestScore;

  // Handle flap
  const flap = useCallback(() => {
    const g = gameRef.current;
    if (g.state === "IDLE") {
      g.state = "PLAYING";
      g.birdVY = FLAP_VELOCITY;
      g.birdRotation = MAX_ROTATION_UP;
      g.pipeTimer = 0;
      g.pipes = [];
      g.score = 0;
      setUiState("PLAYING");
      setScore(0);
    } else if (g.state === "PLAYING") {
      g.birdVY = FLAP_VELOCITY;
      g.birdRotation = MAX_ROTATION_UP;
    }
  }, []);

  const restart = useCallback(() => {
    const g = gameRef.current;
    g.state = "IDLE";
    g.birdY = LOGICAL_HEIGHT / 2;
    g.birdVY = 0;
    g.birdRotation = 0;
    g.pipes = [];
    g.particles = [];
    g.score = 0;
    g.pipeTimer = 0;
    g.groundOffset = 0;
    g.idleBobTime = 0;
    setUiState("IDLE");
    setScore(0);
  }, []);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize handler
    function resize() {
      if (!canvas) return;
      const parent = canvas.parentElement;
      const vw = parent ? parent.clientWidth : window.innerWidth;
      const vh = parent ? parent.clientHeight : window.innerHeight;
      const scale = Math.min(vw / LOGICAL_WIDTH, vh / LOGICAL_HEIGHT);
      canvas.width = vw;
      canvas.height = vh;
      const g = gameRef.current;
      g.scale = scale;
      g.canvasWidth = vw;
      g.canvasHeight = vh;
    }
    resize();
    window.addEventListener("resize", resize);

    // Input
    function handleKey(e: KeyboardEvent) {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        flap();
      }
      if (e.code === "Enter" && gameRef.current.state === "GAME_OVER") {
        restart();
      }
    }

    function handlePointer(e: MouseEvent | TouchEvent) {
      e.preventDefault();
      const g = gameRef.current;
      if (g.state === "GAME_OVER") return;
      flap();
    }

    window.addEventListener("keydown", handleKey);
    canvas.addEventListener("mousedown", handlePointer, { passive: false });
    canvas.addEventListener("touchstart", handlePointer, { passive: false });

    // Main loop
    function loop(timestamp: number) {
      const g = gameRef.current;
      if (!ctx || !canvas) return;

      const rawDt = g.lastTime === 0 ? 0.016 : (timestamp - g.lastTime) / 1000;
      const dt = Math.min(rawDt, 0.05); // cap at 50ms
      g.lastTime = timestamp;

      const scale = g.scale;
      const cw = g.canvasWidth;
      const ch = g.canvasHeight;

      // Offset to center logical world
      const offsetX = (cw - LOGICAL_WIDTH * scale) / 2;
      const offsetY = (ch - LOGICAL_HEIGHT * scale) / 2;

      // Clear
      ctx.clearRect(0, 0, cw, ch);

      // Draw letterbox background
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, cw, ch);

      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Clip to logical world
      ctx.beginPath();
      ctx.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      ctx.clip();

      const groundY = LOGICAL_HEIGHT - GROUND_HEIGHT;
      const birdX = LOGICAL_WIDTH * 0.28;

      // ── Update ──────────────────────────────────────────────────────────

      // Wing animation always runs
      g.wingTimer += dt;
      if (g.wingTimer >= 1 / WING_FPS) {
        g.wingTimer = 0;
        g.wingFrame = (g.wingFrame + 1) % 3;
      }

      // Cloud scrolling always runs
      g.clouds.forEach((c) => {
        const layer = CLOUD_LAYERS[c.layer];
        c.x -= PIPE_SPEED * layer.speedMult * dt;
        if (c.x + c.size * 1.5 < 0) {
          c.x = LOGICAL_WIDTH + c.size * 0.5;
          c.y =
            layer.yMin + Math.random() * (layer.yMax - layer.yMin);
          c.size =
            layer.sizeMin + Math.random() * (layer.sizeMax - layer.sizeMin);
        }
      });

      if (g.state === "IDLE") {
        // Bob animation
        g.idleBobTime += dt;
        g.birdY = LOGICAL_HEIGHT / 2 + Math.sin(g.idleBobTime * 2.5) * 12;
        g.birdVY = 0;
        // Ground scrolling at slow pace
        g.groundOffset += PIPE_SPEED * 0.25 * dt;
      } else if (g.state === "PLAYING") {
        // Physics
        g.birdVY += GRAVITY * dt;
        g.birdY += g.birdVY * dt;

        // Rotation: nose up on flap, gradually nose down when falling
        if (g.birdVY < 0) {
          g.birdRotation = MAX_ROTATION_UP;
        } else {
          g.birdRotation = Math.min(
            g.birdRotation + ROTATION_SPEED_DOWN * dt,
            MAX_ROTATION_DOWN
          );
        }

        // Pipe spawning
        g.pipeTimer += dt;
        if (g.pipeTimer >= PIPE_INTERVAL) {
          g.pipeTimer = 0;
          g.pipes.push({
            x: LOGICAL_WIDTH + 10,
            topHeight: randomPipeHeight(),
            passed: false,
          });
        }

        // Move pipes + score
        for (let i = g.pipes.length - 1; i >= 0; i--) {
          g.pipes[i].x -= PIPE_SPEED * dt;
          if (!g.pipes[i].passed && g.pipes[i].x + PIPE_WIDTH < birdX) {
            g.pipes[i].passed = true;
            g.score += 1;
            setScore(g.score);
          }
          if (g.pipes[i].x + PIPE_WIDTH < -20) {
            g.pipes.splice(i, 1);
          }
        }

        // Ground scroll
        g.groundOffset += PIPE_SPEED * dt;

        // Collision detection
        let hit = false;

        // Ground and ceiling
        if (g.birdY + BIRD_HITBOX >= groundY || g.birdY - BIRD_HITBOX <= 0) {
          hit = true;
        }

        // Pipes
        for (const pipe of g.pipes) {
          const inX =
            birdX + BIRD_HITBOX > pipe.x &&
            birdX - BIRD_HITBOX < pipe.x + PIPE_WIDTH;
          if (inX) {
            if (
              g.birdY - BIRD_HITBOX < pipe.topHeight ||
              g.birdY + BIRD_HITBOX > pipe.topHeight + PIPE_GAP
            ) {
              hit = true;
              break;
            }
          }
        }

        if (hit) {
          // Update best score
          if (g.score > bestScoreRef.current) {
            const newBest = g.score;
            setBestScore(newBest);
            bestScoreRef.current = newBest;
            try {
              localStorage.setItem("flappy-best", String(newBest));
            } catch {
              // ignore
            }
          }
          // Spawn particles
          g.particles = spawnParticles(birdX, g.birdY);
          g.state = "GAME_OVER";
          setUiState("GAME_OVER");
        }
      } else if (g.state === "GAME_OVER") {
        // Bird falls
        g.birdVY += GRAVITY * dt * 0.5;
        g.birdY = Math.min(g.birdY + g.birdVY * dt, groundY - BIRD_RADIUS);
        g.birdRotation = Math.min(g.birdRotation + ROTATION_SPEED_DOWN * dt, Math.PI * 0.6);
      }

      // Update particles
      for (let i = g.particles.length - 1; i >= 0; i--) {
        const p = g.particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 300 * dt;
        p.life -= dt;
        if (p.life <= 0) g.particles.splice(i, 1);
      }

      // ── Draw ────────────────────────────────────────────────────────────

      drawSky(ctx, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      drawSunrise(ctx, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      drawClouds(ctx, g.clouds);

      for (const pipe of g.pipes) {
        drawPipePair(ctx, pipe, groundY);
      }

      drawGround(ctx, LOGICAL_WIDTH, LOGICAL_HEIGHT, g.groundOffset);

      drawBird(ctx, birdX, g.birdY, g.birdRotation, g.wingFrame);
      drawParticles(ctx, g.particles);

      // Score is shown as HTML overlay (see JSX)

      ctx.restore();

      g.animFrame = requestAnimationFrame(loop);
    }

    gameRef.current.lastTime = 0;
    gameRef.current.animFrame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(gameRef.current.animFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", handleKey);
      canvas.removeEventListener("mousedown", handlePointer);
      canvas.removeEventListener("touchstart", handlePointer);
    };
  }, [flap, restart]);

  // Push AdSense ad when overlay is shown
  useEffect(() => {
    if (uiState !== "AD") return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.adsbygoogle = w.adsbygoogle || [];
      w.adsbygoogle.push({});
    } catch {
      // ignore if AdSense not loaded
    }
  }, [uiState]);

  // Ad countdown effect
  useEffect(() => {
    if (uiState !== "AD") return;
    setAdSecondsLeft(10);
    setShowSkip(false);
    const interval = setInterval(() => {
      setAdSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setUiState("IDLE");
          return 0;
        }
        if (prev === 6) setShowSkip(true); // show skip at 5s remaining
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [uiState]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        position: "fixed",
        inset: 0,
        background: "#1a1a2e",
      }}
    >
      {/* Game Area */}
      <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>

      {/* Pre-game Ad Overlay */}
      {uiState === "AD" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(10,10,30,0.88)",
            backdropFilter: "blur(4px)",
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "20px",
          }}
        >
          {/* Ad label */}
          <div
            style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: "11px",
              fontWeight: 800,
              color: "rgba(255,255,255,0.5)",
              textTransform: "uppercase",
              letterSpacing: "2px",
            }}
          >
            Advertisement
          </div>

          {/* Google AdSense Ad Unit */}
          <div style={{ width: "300px", height: "250px" }}>
            <ins
              className="adsbygoogle"
              style={{ display: "block", width: "300px", height: "250px" }}
              data-ad-client="ca-pub-4185952637955440"
              data-ad-slot="auto"
              data-ad-format="auto"
              data-full-width-responsive="false"
            />
          </div>

          {/* Countdown + skip row */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <div
              style={{
                fontFamily: "'Nunito', sans-serif",
                fontSize: "14px",
                fontWeight: 700,
                color: "rgba(255,255,255,0.6)",
              }}
            >
              Game starts in {adSecondsLeft}s
            </div>
            {showSkip && (
              <button
                type="button"
                onClick={() => setUiState("IDLE")}
                style={{
                  fontFamily: "'Nunito', sans-serif",
                  fontSize: "13px",
                  fontWeight: 800,
                  color: "#fff",
                  background: "rgba(255,255,255,0.15)",
                  border: "1.5px solid rgba(255,255,255,0.3)",
                  borderRadius: "50px",
                  padding: "8px 24px",
                  cursor: "pointer",
                  letterSpacing: "0.5px",
                }}
              >
                Skip Ad &rarr;
              </button>
            )}
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: "pointer",
        }}
      />

      {/* Live Score Overlay - shown during play */}
      {uiState === "PLAYING" && (
        <div
          style={{
            position: "absolute",
            top: "16px",
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              fontFamily: "'Fredoka One', cursive",
              fontSize: "clamp(32px, 7vw, 52px)",
              color: "#FFFFFF",
              textShadow: "0 3px 0 rgba(0,0,0,0.4), 0 0 20px rgba(255,220,0,0.3)",
              lineHeight: 1,
            }}
          >
            {score}
          </div>
        </div>
      )}

      {/* Start Screen */}
      {uiState === "IDLE" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(255,255,255,0.18)",
              backdropFilter: "blur(12px)",
              borderRadius: "24px",
              border: "2px solid rgba(255,255,255,0.5)",
              padding: "32px 48px",
              textAlign: "center",
              boxShadow: "0 8px 40px rgba(0,0,0,0.25), 0 2px 0 rgba(255,255,255,0.3) inset",
              animation: "floatIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both",
            }}
          >
            <div
              style={{
                fontFamily: "'Fredoka One', cursive",
                fontSize: "clamp(36px, 8vw, 52px)",
                color: "#FFF",
                textShadow: "0 3px 0 rgba(0,0,0,0.25), 0 6px 20px rgba(255,150,0,0.4)",
                letterSpacing: "1px",
                marginBottom: "6px",
              }}
            >
              🐦 Flappy Bird
            </div>
            {bestScore > 0 && (
              <div
                style={{
                  fontFamily: "'Nunito', sans-serif",
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "rgba(255,230,100,0.95)",
                  marginBottom: "20px",
                  letterSpacing: "0.5px",
                }}
              >
                Best: {bestScore}
              </div>
            )}
            <div
              style={{
                fontFamily: "'Nunito', sans-serif",
                fontSize: "clamp(14px, 3.5vw, 18px)",
                fontWeight: 700,
                color: "rgba(255,255,255,0.9)",
                marginTop: bestScore === 0 ? "20px" : "0",
                padding: "10px 20px",
                background: "rgba(255,200,50,0.25)",
                borderRadius: "12px",
                border: "1.5px solid rgba(255,220,80,0.5)",
              }}
            >
              Tap · Click · Space to Start
            </div>
          </div>
        </div>
      )}

      {/* Game Over Screen */}
      {uiState === "GAME_OVER" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(255,255,255,0.18)",
              backdropFilter: "blur(14px)",
              borderRadius: "24px",
              border: "2px solid rgba(255,255,255,0.5)",
              padding: "32px 48px",
              textAlign: "center",
              boxShadow: "0 8px 40px rgba(0,0,0,0.3), 0 2px 0 rgba(255,255,255,0.3) inset",
              minWidth: "260px",
              animation: "floatIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both",
            }}
          >
            <div
              style={{
                fontFamily: "'Fredoka One', cursive",
                fontSize: "clamp(28px, 7vw, 42px)",
                color: "#FF5252",
                textShadow: "0 3px 0 rgba(0,0,0,0.3)",
                marginBottom: "16px",
              }}
            >
              Game Over
            </div>

            {/* Score row */}
            <div style={{ display: "flex", justifyContent: "space-around", gap: "24px", marginBottom: "24px" }}>
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: "11px",
                    fontWeight: 800,
                    color: "rgba(255,255,255,0.7)",
                    textTransform: "uppercase",
                    letterSpacing: "1.5px",
                    marginBottom: "4px",
                  }}
                >
                  Score
                </div>
                <div
                  style={{
                    fontFamily: "'Fredoka One', cursive",
                    fontSize: "clamp(32px, 7vw, 44px)",
                    color: "#FFD700",
                    textShadow: "0 2px 0 rgba(0,0,0,0.25)",
                    lineHeight: 1,
                  }}
                >
                  {score}
                </div>
              </div>
              <div
                style={{
                  width: "1.5px",
                  background: "rgba(255,255,255,0.2)",
                  borderRadius: "2px",
                }}
              />
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: "11px",
                    fontWeight: 800,
                    color: "rgba(255,255,255,0.7)",
                    textTransform: "uppercase",
                    letterSpacing: "1.5px",
                    marginBottom: "4px",
                  }}
                >
                  Best
                </div>
                <div
                  style={{
                    fontFamily: "'Fredoka One', cursive",
                    fontSize: "clamp(32px, 7vw, 44px)",
                    color: score >= bestScore ? "#69F0AE" : "#FFD700",
                    textShadow: "0 2px 0 rgba(0,0,0,0.25)",
                    lineHeight: 1,
                  }}
                >
                  {bestScore}
                </div>
              </div>
            </div>

            {score > 0 && score >= bestScore && (
              <div
                style={{
                  fontFamily: "'Nunito', sans-serif",
                  fontSize: "13px",
                  fontWeight: 800,
                  color: "#69F0AE",
                  marginBottom: "16px",
                  textShadow: "0 0 12px rgba(105,240,174,0.6)",
                  letterSpacing: "0.5px",
                }}
              >
                🏆 New Best Score!
              </div>
            )}

            <button
              type="button"
              onClick={restart}
              style={{
                pointerEvents: "auto",
                fontFamily: "'Fredoka One', cursive",
                fontSize: "20px",
                color: "#1a1a2e",
                background: "linear-gradient(135deg, #FFD700, #FF8C00)",
                border: "none",
                borderRadius: "50px",
                padding: "12px 40px",
                cursor: "pointer",
                boxShadow: "0 4px 0 rgba(0,0,0,0.25), 0 8px 20px rgba(255,180,0,0.4)",
                transform: "translateY(0)",
                transition: "transform 0.1s, box-shadow 0.1s",
                letterSpacing: "0.5px",
              }}
              onMouseDown={(e) => {
                (e.target as HTMLButtonElement).style.transform = "translateY(2px)";
                (e.target as HTMLButtonElement).style.boxShadow =
                  "0 2px 0 rgba(0,0,0,0.25), 0 4px 12px rgba(255,180,0,0.4)";
              }}
              onMouseUp={(e) => {
                (e.target as HTMLButtonElement).style.transform = "translateY(0)";
                (e.target as HTMLButtonElement).style.boxShadow =
                  "0 4px 0 rgba(0,0,0,0.25), 0 8px 20px rgba(255,180,0,0.4)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLButtonElement).style.transform = "translateY(0)";
                (e.target as HTMLButtonElement).style.boxShadow =
                  "0 4px 0 rgba(0,0,0,0.25), 0 8px 20px rgba(255,180,0,0.4)";
              }}
            >
              Play Again
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: "'Nunito', sans-serif",
          fontSize: "11px",
          fontWeight: 600,
          color: "rgba(255,255,255,0.45)",
          pointerEvents: "none",
        }}
      >
        © 2026. Built with ❤️ using{" "}
        <a
          href="https://caffeine.ai"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "rgba(255,220,100,0.6)",
            textDecoration: "none",
            pointerEvents: "auto",
          }}
        >
          caffeine.ai
        </a>
      </div>

      <style>{`
        @keyframes floatIn {
          from { opacity: 0; transform: scale(0.85) translateY(20px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
      </div>
    </div>
  );
}
