import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// One renderer, one scene, one hand tracker. The four artwork forms are only
// different particle targets inside this single system.

const SHAPES = [
  {
    id: "rose",
    name: "红玫瑰",
    src: "./assets/targets/rose.png",
    accent: [1.0, 0.22, 0.27],
    glow: 0xff9aa4,
    rotates: true,
    model3d: "./assets/models/rose.glb",
    caption: "The Boundary of Letting Go",
    captionColors: ["#ffe1c6", "#ff546f", "#ffd09a"],
  },
  {
    id: "man_flower",
    name: "男人拿花",
    src: "./assets/targets/man_flower.png",
    accent: [0.52, 0.77, 1.0],
    glow: 0x9fd6ff,
    rotates: false,
  },
  {
    id: "rapeseed",
    name: "黄色油菜花",
    src: "./assets/targets/rapeseed.png",
    accent: [1.0, 0.79, 0.22],
    glow: 0xffdc73,
    rotates: true,
    model3d: "./assets/models/rapeseed.glb",
    caption: "Where Souls Agree",
    captionColors: ["#fff3b8", "#ffbc18", "#fff8d9"],
  },
  {
    id: "couple",
    name: "后背拥抱",
    src: "./assets/targets/couple.png",
    accent: [1.0, 0.67, 0.32],
    glow: 0xffc27d,
    rotates: false,
  },
];

const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";
const SAMPLING_HEIGHT = 230;
const ALPHA_CUTOFF = 0.36;
const FORM_BLEND_MS = 620;

const $ = (id) => document.getElementById(id);
const dom = {
  experience: $("experience"),
  video: $("webcam"),
  canvas: $("scene"),
  rigCanvas: $("handRig"),
  debugCanvas: $("handDebug"),
  gate: $("gate"),
  gateMessage: $("gateMessage"),
  gateButton: $("gateButton"),
  modelIndex: $("modelIndex"),
  modelName: $("modelName"),
  hint: $("hint"),
  notice: $("notice"),
  debugReadout: $("debugReadout"),
};

const state = {
  cameraReady: false,
  cameraStarting: false,
  cameraError: false,
  assetsReady: false,
  assetError: false,
  trackerReady: false,
  trackerStarting: false,
  trackerFailed: false,
  inView: false,
  cameraStream: null,
  trackerPromise: null,
  leftPresent: false,
  rightPresent: false,
  leftSeenOnce: false,
  leftOpen: false,
  holoWanted: false,
  holoPresence: 0,
  lastLeftAt: 0,
  lastRightAt: 0,
  leftRawOpenness: 0,
  rightRawOpenness: 0,
  leftAnchorScreen: new THREE.Vector2(0, 0),
  leftAnchorInitialized: false,
  rightPhase: null,
  rightHighFrames: 0,
  rightLowFrames: 0,
  dispersion: 0,
  dispersionTarget: 0,
  burstAge: 99,
  burst: 0,
  burstActive: false,
  rightRigPositions: null,
  rightRigTarget: null,
  rightRigAlpha: 0,
  lastRightRigAt: 0,
  adaptiveOpacity: 1.08,
  adaptiveOpacityTarget: 1.08,
  lastDetectionAt: -Infinity,
  detectionFrame: 0,
  detectionErrors: 0,
  currentShape: 0,
  modelLabelTimer: 0,
  debugLastDraw: 0,
  fps: 0,
  fpsFrames: 0,
  fpsAt: 0,
};

const morph = {
  active: false,
  from: 0,
  to: 0,
  start: 0,
  progress: 0,
};


/* --------------------------------------------------------------------------
   small math helpers
-------------------------------------------------------------------------- */

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};


function distance(a, b) {
  return Math.hypot(
    (a.x - b.x) || 0,
    (a.y - b.y) || 0,
    (a.z - b.z) || 0
  );
}

function normalizeVector(v) {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(value, timestamp) {
    if (!Number.isFinite(value)) return this.xPrev ?? 0;
    if (this.tPrev === null) {
      this.tPrev = timestamp;
      this.xPrev = value;
      return value;
    }
    let dt = timestamp - this.tPrev;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.12);
    const dx = (value - this.xPrev) / dt;
    this.dxPrev += (dx - this.dxPrev) * this.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    this.xPrev += (value - this.xPrev) * this.alpha(cutoff, dt);
    this.tPrev = timestamp;
    return this.xPrev;
  }
}

const filters = {
  leftPalmX: new OneEuroFilter(0.9, 0.22, 1.0),
  leftPalmY: new OneEuroFilter(0.9, 0.22, 1.0),
};

/* --------------------------------------------------------------------------
   WebGL scene
-------------------------------------------------------------------------- */

let renderer;
let scene;
let camera;
let anchor;
let inner;
let particleUniforms;
let particleGeometry;
let particlePoints;
let imageHalo;
let cubeGroup;
let captionRoot;
let captionUniforms;
const captionSystems = [];
let flower3DGroup;
let flower3DEntries = [];
let cubeEdgeMaterial;
let cubeEdgeGlowMaterial;
let flowerPlaneGroup;
let portraitPlaneGroup;
let shapePlanes = [];
let glowTexture;
let cubeAccentMaterials = [];
let scanRing;
let scanRingMaterial;
const holo = {
  cubeSize: 0,
  imageOpacity: 0.91,
};

const contentRotation = new THREE.Matrix4();

const viewport = {
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: 1,
  cameraDistance: 1000,
  fov: 36,
};

const positions = [];
let shapeSamples = null;
let particleCount = 0;
let shapeLayouts = [];

function initScene() {
  THREE.ColorManagement.enabled = false;

  try {
    renderer = new THREE.WebGLRenderer({
      canvas: dom.canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
  } catch (error) {
    setGateError("当前浏览器无法创建 WebGL。请开启硬件加速，或改用 Safari / Chrome。");
    state.assetError = true;
    throw error;
  }

  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment(renderer);
  scene.environment = pmrem.fromScene(roomEnvironment, 0.04).texture;
  pmrem.dispose();
  roomEnvironment.dispose?.();

  const hemi = new THREE.HemisphereLight(0xd9f5ff, 0x151a20, 0.55);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
  keyLight.position.set(-2.2, 3.2, 2.8);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x63d5ff, 1.1);
  rimLight.position.set(2.4, 1.4, -2.0);
  scene.add(rimLight);

  const warmFill = new THREE.DirectionalLight(0xffd5b8, 0.5);
  warmFill.position.set(0.2, -1.5, 2.2);
  scene.add(warmFill);
  camera = new THREE.PerspectiveCamera(viewport.fov, 1, 1, 100000);
  camera.position.set(0, 0, 1000);

  anchor = new THREE.Group();
  inner = new THREE.Group();
  flower3DGroup = new THREE.Group();
  flower3DGroup.name = "flower-3d";
  inner.add(flower3DGroup);
  anchor.add(inner);
  scene.add(anchor);

  glowTexture = createGlowTexture();

  imageHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
  );
  imageHalo.position.z = -20;
  imageHalo.renderOrder = 1;
  anchor.add(imageHalo);

  buildHologramCube();
  buildCaptionParticles();
  updateViewport();
  anchor.visible = false;
  window.addEventListener("resize", handleResize, { passive: true });
  window.addEventListener("orientationchange", handleResize, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      state.lastDetectionAt = -Infinity;
    }
  });

  rigCtx = dom.rigCanvas.getContext("2d");
  if (rigCtx) rigCtx.imageSmoothingEnabled = true;

  const debugCtx = dom.debugCanvas.getContext("2d");
  if (debugCtx) debugCtx.imageSmoothingEnabled = true;
  document.body.classList.toggle("show-debug", DEBUG);
}

function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 1, 64, 64, 62);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.14, "rgba(255,255,255,0.7)");
  gradient.addColorStop(0.44, "rgba(255,255,255,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function currentDpr() {
  return Math.min(window.devicePixelRatio || 1, window.innerWidth < 760 ? 1.65 : 2);
}

/* --------------------------------------------------------------------------
   Particle caption text: English art titles
-------------------------------------------------------------------------- */

const CAPTION_VERTEX_SHADER = /* glsl */ `
  uniform float uDisperse;
  uniform float uBurst;
  uniform float uPresence;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uCameraDistance;
  uniform float uPointScale;
  uniform float uSpread;

  attribute vec3 aBurst;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = smoothstep(
      aSeed * 0.16,
      aSeed * 0.16 + 0.84,
      clamp(uDisperse, 0.0, 1.0)
    );

    vec3 radial = normalize(vec3(position.x, position.y + 0.36, position.z) + vec3(0.0001, 0.0, 0.0));
    vec3 direction = normalize(mix(aBurst, radial, 0.55) + vec3(0.0, 0.1, 0.0));
    vec3 p = position;
    p += direction * uSpread * d * (0.24 + aSeed * 0.72);
    p += direction * uSpread * uBurst * (0.2 + aSeed * 0.52);
    p.y += uSpread * d * (0.04 + aSeed * 0.1);

    float clock = uTime * 0.8 + aSeed * 6.28318530718;
    p.x += sin(clock * 1.1 + aSeed * 4.0) * uSpread * 0.07 * d;
    p.z += cos(clock * 0.82 + aSeed * 3.0) * uSpread * 0.1 * d;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float depthScale = uCameraDistance / max(2.0, -mv.z);
    gl_PointSize = aSize * uPointScale * uPixelRatio * depthScale;
    gl_PointSize *= 1.0 + d * 0.35 + uBurst * 0.35;
    gl_PointSize = min(gl_PointSize, 18.0 * uPixelRatio);

    vColor = aColor;
    float twinkle = 0.92 + 0.08 * sin(uTime * 1.25 + aSeed * 27.0);
    // At rest the luminous calligraphy plate carries the glyph; the particles
    // stay subtle, then take over completely during the burst.
    vAlpha = aAlpha * uPresence * twinkle * (1.0 - d * 0.22) * mix(0.16, 1.0, d);
  }
`;

const CAPTION_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float radius = length(c) * 2.0;
    if (radius > 1.0) discard;
    float halo = pow(max(0.0, 1.0 - radius), 2.0);
    float core = smoothstep(0.42, 0.01, radius);
    vec3 color = vColor * (0.88 + core * 0.8) + vec3(core * 0.05);
    gl_FragColor = vec4(color, halo * vAlpha);
  }
`;

function createCaptionCanvas(shape) {
  const width = 2600;
  const height = 440;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const font = 'italic 240px "Instrument Serif", Georgia, serif';
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(shape.caption);
  const textWidth = Math.min(metrics.width, width * 0.88);
  let fontSize = 240;
  if (metrics.width > width * 0.88) {
    fontSize = Math.floor(240 * (width * 0.88) / metrics.width);
    ctx.font = `italic ${fontSize}px "Instrument Serif", Georgia, serif`;
  }

  const startX = (width - textWidth) * 0.5;
  const centerY = height * 0.4;
  const gradient = ctx.createLinearGradient(startX, 0, startX + textWidth, 0);
  gradient.addColorStop(0, shape.captionColors[0]);
  gradient.addColorStop(0.5, shape.captionColors[1]);
  gradient.addColorStop(1, shape.captionColors[2]);
  ctx.fillStyle = gradient;
  ctx.shadowColor = shape.captionColors[1];
  ctx.shadowBlur = 20;
  ctx.fillText(shape.caption, width * 0.5, centerY);

  ctx.shadowBlur = 0;
  const lineY = height * 0.69;
  const lineStart = startX + textWidth * 0.12;
  const lineEnd = startX + textWidth * 0.88;
  const lineGradient = ctx.createLinearGradient(lineStart, 0, lineEnd, 0);
  lineGradient.addColorStop(0, "rgba(255,255,255,0)");
  lineGradient.addColorStop(0.2, shape.captionColors[0]);
  lineGradient.addColorStop(0.5, shape.captionColors[2]);
  lineGradient.addColorStop(0.8, shape.captionColors[0]);
  lineGradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.strokeStyle = lineGradient;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(lineStart, lineY);
  ctx.lineTo(lineEnd, lineY);
  ctx.stroke();

  for (const x of [lineStart, lineEnd]) {
    ctx.save();
    ctx.translate(x, lineY);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = shape.captionColors[2];
    ctx.fillRect(-3.2, -3.2, 6.4, 6.4);
    ctx.restore();
  }

  return { canvas, ctx, width, height };
}

function createCaptionGeometry(shape, themeIndex) {
  const surface = createCaptionCanvas(shape);
  if (!surface) return null;
  const { ctx, width, height } = surface;
  const pixels = ctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return null;

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const targetWidth = themeIndex === 0 ? 0.84 : 0.76;
  const targetHeight = targetWidth * (boxHeight / boxWidth);
  const centerY = -0.44 + targetHeight * 0.5;

  const cropped = document.createElement("canvas");
  cropped.width = boxWidth;
  cropped.height = boxHeight;
  const croppedCtx = cropped.getContext("2d");
  croppedCtx.drawImage(surface.canvas, minX, minY, boxWidth, boxHeight, 0, 0, boxWidth, boxHeight);
  const texture = new THREE.CanvasTexture(cropped);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const candidates = [];
  for (let y = minY; y <= maxY; y += 2) {
    for (let x = minX; x <= maxX; x += 2) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      if (alpha < 0.28) continue;
      candidates.push({
        u: (x - minX) / Math.max(1, boxWidth - 1),
        v: (y - minY) / Math.max(1, boxHeight - 1),
        r: pixels[offset] / 255,
        g: pixels[offset + 1] / 255,
        b: pixels[offset + 2] / 255,
        a: alpha,
      });
    }
  }
  if (!candidates.length) return null;

  const count = Math.min(candidates.length, 12000);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const bursts = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const seeds = new Float32Array(count);
  const random = mulberry32(0x7d3ea1 + themeIndex * 7717);

  for (let i = 0; i < count; i += 1) {
    const index = count === candidates.length
      ? i
      : Math.floor(random() * candidates.length);
    const point = candidates[index];
    const jitterU = (random() - 0.5) * 0.0025;
    const jitterV = (random() - 0.5) * 0.004;
    const u = clamp(point.u + jitterU);
    const v = clamp(point.v + jitterV);

    positions[i * 3] = (u - 0.5) * targetWidth;
    positions[i * 3 + 1] = centerY + (0.5 - v) * targetHeight;
    positions[i * 3 + 2] = (random() - 0.5) * 0.012;

    colors[i * 3] = clamp(point.r * 1.02 + 0.02);
    colors[i * 3 + 1] = clamp(point.g * 1.02 + 0.02);
    colors[i * 3 + 2] = clamp(point.b * 1.02 + 0.02);

    const theta = random() * Math.PI * 2;
    const z = random() * 2 - 1;
    const planar = Math.sqrt(Math.max(0, 1 - z * z));
    bursts[i * 3] = Math.cos(theta) * planar;
    bursts[i * 3 + 1] = z;
    bursts[i * 3 + 2] = Math.sin(theta) * planar;
    seeds[i] = random();
    sizes[i] = 1.35 + Math.pow(random(), 1.6) * 1.55;
    alphas[i] = 0.68 + point.a * 0.32;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aBurst", new THREE.BufferAttribute(bursts, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setDrawRange(0, count);
  return { geometry, count, texture, targetWidth, targetHeight, centerY };
}

async function buildCaptionParticles() {
  try {
    await document.fonts.load('italic 240px "Instrument Serif"');
  } catch (error) {
    console.warn("[Holo] caption serif fallback", error);
  }

  captionRoot = new THREE.Group();
  captionRoot.name = "caption-particles";
  anchor.add(captionRoot);

  captionUniforms = {
    uDisperse: { value: 0 },
    uBurst: { value: 0 },
    uPresence: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: viewport.dpr },
    uCameraDistance: { value: viewport.cameraDistance },
    uPointScale: { value: 1 },
    uSpread: { value: 0.38 },
  };

  SHAPES.forEach((shape, index) => {
    if (!shape.caption) return;
    const data = createCaptionGeometry(shape, index);
    if (!data) return;
    const material = new THREE.ShaderMaterial({
      uniforms: captionUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: CAPTION_VERTEX_SHADER,
      fragmentShader: CAPTION_FRAGMENT_SHADER,
    });
    const points = new THREE.Points(data.geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    points.visible = false;
    captionRoot.add(points);

    const planeMaterial = new THREE.MeshBasicMaterial({
      map: data.texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMaterial);
    plane.scale.set(data.targetWidth, data.targetHeight, 1);
    plane.position.set(0, data.centerY, -0.002);
    plane.renderOrder = 4;
    plane.visible = false;
    captionRoot.add(plane);

    captionSystems.push({ index, points, plane, count: data.count });
  });

  captionRoot.scale.setScalar(holo.cubeSize || 1);
  captionUniforms.uPointScale.value = (holo.cubeSize || 374) / 374;
  updateCaptionParticles();
}

function updateCaptionParticles() {
  if (!captionSystems.length) return;
  const planeFade = 1 - smoothstep(0.04, 0.46, state.dispersion);
  for (const system of captionSystems) {
    const active =
      system.index === state.currentShape &&
      state.holoPresence > 0.01;
    system.points.visible = active;
    if (system.plane) {
      const opacity = state.holoPresence * planeFade * 0.88;
      system.plane.visible = active && opacity > 0.004;
      system.plane.material.opacity = opacity;
    }
  }
}

/* --------------------------------------------------------------------------
   Fixed hologram stage: wireframe cube + floor light
-------------------------------------------------------------------------- */

function buildHologramCube() {
  cubeGroup = new THREE.Group();
  cubeGroup.name = "hologram-cube";
  cubeAccentMaterials = [];

  const edgeMaterial = new THREE.MeshBasicMaterial({
    color: 0xaeefff,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const edgeGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0x37b9dc,
    transparent: true,
    opacity: 0.06,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  cubeEdgeMaterial = edgeMaterial;
  cubeEdgeGlowMaterial = edgeGlowMaterial;

  const half = 0.5;
  const corners = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));

  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const up = new THREE.Vector3(0, 1, 0);
  const gap = 0.075;
  const segmentLength = (1 - gap) * 0.5;

  for (const [a, b] of edges) {
    const start = corners[a];
    const end = corners[b];
    const fullDirection = new THREE.Vector3().subVectors(end, start);
    const direction = fullDirection.clone().normalize();
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);

    for (const side of [0, 1]) {
      const segmentStart = side === 0
        ? start.clone()
        : end.clone().addScaledVector(direction, -segmentLength);
      const segmentCenter = segmentStart.clone().addScaledVector(direction, segmentLength * 0.5);

      const edge = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0029, 0.0029, segmentLength, 5, 1, false),
        edgeMaterial
      );
      edge.position.copy(segmentCenter);
      edge.quaternion.copy(quaternion);
      edge.renderOrder = 9;
      cubeGroup.add(edge);

      const glow = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, segmentLength, 5, 1, false),
        edgeGlowMaterial
      );
      glow.position.copy(segmentCenter);
      glow.quaternion.copy(quaternion);
      glow.renderOrder = 8;
      cubeGroup.add(glow);
    }

    const midpointHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xc8f7ff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    midpointHalo.position.copy(midpoint);
    midpointHalo.scale.set(0.045, 0.045, 1);
    midpointHalo.renderOrder = 9;
    midpointHalo.material.userData.baseOpacity = 0.5;
    cubeGroup.add(midpointHalo);
    cubeAccentMaterials.push(midpointHalo.material);
  }

  const innerCageMaterial = new THREE.LineBasicMaterial({
    color: 0x6fdaf2,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const innerCage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.82, 0.82, 0.82)),
    innerCageMaterial
  );
  innerCage.rotation.y = Math.PI * 0.25;
  innerCage.renderOrder = 6;
  innerCage.material.userData.baseOpacity = 0.14;
  cubeAccentMaterials.push(innerCage.material);
  cubeGroup.add(innerCage);

  for (const corner of corners) {
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xbcecff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    halo.position.copy(corner);
    halo.scale.set(0.085, 0.085, 1);
    halo.renderOrder = 9;
    halo.material.userData.baseOpacity = 0.3;
    cubeAccentMaterials.push(halo.material);
    cubeGroup.add(halo);

    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0xf4fdff,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    core.position.copy(corner);
    core.scale.set(0.026, 0.026, 1);
    core.renderOrder = 10;
    core.material.userData.baseOpacity = 0.92;
    cubeAccentMaterials.push(core.material);
    cubeGroup.add(core);
  }

  scanRingMaterial = new THREE.LineBasicMaterial({
    color: 0xc7f7ff,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const scanPoints = [
    new THREE.Vector3(-0.47, 0, -0.47),
    new THREE.Vector3(0.47, 0, -0.47),
    new THREE.Vector3(0.47, 0, 0.47),
    new THREE.Vector3(-0.47, 0, 0.47),
  ];
  scanRing = new THREE.Group();
  const scanPlaneMaterial = new THREE.MeshBasicMaterial({
    color: 0x50c8e8,
    transparent: true,
    opacity: 0.035,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  scanPlaneMaterial.userData.baseOpacity = 0.035;
  cubeAccentMaterials.push(scanPlaneMaterial);
  const scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), scanPlaneMaterial);
  scanPlane.rotation.x = -Math.PI / 2;
  scanPlane.renderOrder = 5;
  scanRing.add(scanPlane);
  const scanLine = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(scanPoints),
    scanRingMaterial
  );
  scanLine.renderOrder = 7;
  scanRing.add(scanLine);
  cubeGroup.add(scanRing);

  inner.add(cubeGroup);
}

/* --------------------------------------------------------------------------
   Burst timing (particles only)
-------------------------------------------------------------------------- */

function triggerBurst() {
  state.burstActive = true;
  state.burstAge = 0;
  state.burst = 0;
}

function updateBurst(dt) {
  if (!state.burstActive) return;
  state.burstAge += dt;
  const age = state.burstAge;
  const attack = smoothstep(0, 0.16, age);
  const decay = Math.exp(-Math.max(0, age - 0.16) * 1.45);
  state.burst = attack * decay;
  if (age > 2.4) {
    state.burstActive = false;
    state.burst = 0;
  }
}

function computeHologramFrame() {
  if (!anchor) return;

  const landscape = viewport.width >= 760;
  holo.cubeSize = clamp(
    Math.min(
      viewport.height * (landscape ? 0.52 : 0.46),
      viewport.width * (landscape ? 0.4 : 0.72)
    ),
    220,
    640
  );
  const cubeSize = holo.cubeSize;
  if (cubeGroup) cubeGroup.scale.setScalar(cubeSize);

  if (!state.leftSeenOnce) {
    state.leftAnchorScreen.set(viewport.width * 0.3, viewport.height * 0.5);
    if (!state.leftAnchorInitialized) {
      anchor.position.set(
        state.leftAnchorScreen.x - viewport.width * 0.5,
        viewport.height * 0.5 - state.leftAnchorScreen.y,
        0
      );
      state.leftAnchorInitialized = true;
    }
  }

  const maxWidth = cubeSize * 0.92;
  const maxHeight = cubeSize * 0.92;
  shapeLayouts = SHAPES.map((shape, index) => {
    const aspect = shapeSamples?.[index]?.aspect || 1;
    let height = maxHeight;
    let width = height * aspect;
    if (width > maxWidth) {
      width = maxWidth;
      height = width / aspect;
    }
    return { width, height };
  });

  if (shapePlanes.length) {
    shapePlanes.forEach((plane, index) => {
      plane.scale.set(shapeLayouts[index].width, shapeLayouts[index].height, 1);
    });
  }

  if (imageHalo) {
    imageHalo.position.z = -cubeSize * 0.06;
  }

  if (particleUniforms) {
    particleUniforms.uBurstSpread.value = cubeSize * 0.36;
    particleUniforms.uPointScale.value = clamp(cubeSize / 360, 0.82, 1.25);
  }

  if (captionRoot) {
    captionRoot.scale.setScalar(cubeSize);
  }
  if (captionUniforms) {
    captionUniforms.uPointScale.value = cubeSize / 374;
    captionUniforms.uSpread.value = 0.38;
  }
  updateFlower3DTransforms();
  if (particleGeometry) updateLayoutPositions();
}


function updateViewport() {
  viewport.width = Math.max(1, window.innerWidth);
  viewport.height = Math.max(1, window.innerHeight);
  viewport.dpr = currentDpr();
  viewport.cameraDistance =
    viewport.height / (2 * Math.tan(THREE.MathUtils.degToRad(viewport.fov / 2)));

  if (!renderer || !camera) return;

  renderer.setPixelRatio(viewport.dpr);
  renderer.setSize(viewport.width, viewport.height, false);
  camera.aspect = viewport.width / viewport.height;
  camera.position.set(0, 0, viewport.cameraDistance);
  camera.near = 1;
  camera.far = viewport.cameraDistance * 3;
  camera.updateProjectionMatrix();

  if (particleUniforms) {
    particleUniforms.uPixelRatio.value = viewport.dpr;
    particleUniforms.uCameraDistance.value = viewport.cameraDistance;
    particleUniforms.uPointScale.value = clamp(
      Math.min(viewport.width, viewport.height) / 700,
      0.86,
      1.32
    );
  }

  resizeRigCanvas();
  resizeDebugCanvas();
  computeHologramFrame();
}

function handleResize() {
  updateViewport();
}

/* --------------------------------------------------------------------------
   3D flower models (reuse the original GLB assets)
-------------------------------------------------------------------------- */

function uniqueMaterials(root) {
  const seen = new Set();
  const materials = [];
  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (material && !seen.has(material)) {
        seen.add(material);
        materials.push(material);
      }
    }
  });
  return materials;
}

function isVesselMaterial(material) {
  const name = material?.name || "";
  return /glass|water/i.test(name);
}

async function loadFlower3DModels() {
  const loader = new GLTFLoader();
  const configs = SHAPES
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape }) => Boolean(shape.model3d));

  await Promise.all(configs.map(async ({ shape, index }) => {
    try {
      const gltf = await loader.loadAsync(shape.model3d);
      const model = gltf.scene;
      const wrapper = new THREE.Group();
      wrapper.name = `flower-3d-${shape.id}`;

      if (index === 2) {
        model.traverse((object) => {
          if (!object.isMesh) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          if (materials.length && materials.every(isVesselMaterial)) {
            object.visible = false;
          }
        });
      }

      const materials = uniqueMaterials(model);
      for (const material of materials) {
        if (index === 0) {
          const name = material.name || "";
          if (/rose/i.test(name) && material.color) {
            const color = /inner/i.test(name)
              ? 0x4c0007
              : /mid/i.test(name)
                ? 0x7f0816
                : 0xab1a2b;
            material.color.setHex(color);
            if (material.emissive) {
              material.emissive.setHex(0x2a0307);
              material.emissiveIntensity = 0.45;
            }
          }
        }
        material.envMapIntensity = 0.65;
        material.transparent = true;
        material.userData.baseOpacity = material.opacity ?? 1;
        material.userData.baseDepthWrite = material.depthWrite !== false;
        material.depthWrite = true;
        material.needsUpdate = true;
      }

      wrapper.add(model);
      wrapper.updateMatrixWorld(true);

      // Compute the bounds from visible geometry only. The rapeseed GLB's
      // glass/water meshes are hidden above, so they must not define the size.
      const box = new THREE.Box3();
      const meshBox = new THREE.Box3();
      model.traverse((object) => {
        if (!object.isMesh || !object.visible || !object.geometry) return;
        object.updateWorldMatrix(true, false);
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        meshBox.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
        box.union(meshBox);
      });
      if (box.isEmpty()) box.setFromObject(wrapper);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const height = Math.max(0.0001, size.y);

      for (const material of materials) {
        material.opacity = 0;
      }
      wrapper.visible = false;
      flower3DGroup.add(wrapper);

      flower3DEntries.push({
        index,
        shape,
        wrapper,
        materials,
        center,
        height,
        loaded: true,
      });

      updateFlower3DTransforms();
      console.info(`[Holo] 3D flower ready: ${shape.id}`);
    } catch (error) {
      console.warn(`[Holo] Could not load 3D ${shape.id}; image fallback stays active.`, error);
    }
  }));
}

function findFlower3D(index) {
  return flower3DEntries.find((entry) => entry.index === index && entry.loaded);
}

function updateFlower3DTransforms() {
  const targetHeight = holo.cubeSize * 0.64;
  const verticalCenter = holo.cubeSize * 0.1;
  for (const entry of flower3DEntries) {
    const scale = targetHeight / entry.height;
    entry.wrapper.scale.setScalar(scale);
    entry.wrapper.position.set(
      -entry.center.x * scale,
      verticalCenter - entry.center.y * scale,
      -entry.center.z * scale
    );
  }
}

function updateFlower3DModels() {
  const activeIndex = state.currentShape;
  const assembled = 1 - smoothstep(0.02, 0.4, state.dispersion);
  const baseFade = assembled * state.holoPresence;

  for (const entry of flower3DEntries) {
    const active = entry.index === activeIndex;
    const opacity = active ? baseFade : 0;
    entry.wrapper.visible = opacity > 0.004;
    for (const material of entry.materials) {
      material.opacity = (material.userData.baseOpacity ?? 1) * opacity;
      material.depthWrite = opacity > 0.96 ? material.userData.baseDepthWrite : false;
    }
  }
}

/* --------------------------------------------------------------------------
   Four image forms -> four equal-sized particle target sets
-------------------------------------------------------------------------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
      } catch {
        // An already-decoded image is fine.
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error(`无法读取目标图片：${src}`));
    image.src = src;
  });
}

function sampleImage(image) {
  const sampleHeight = SAMPLING_HEIGHT;
  const sampleWidth = Math.max(1, Math.round((image.width / image.height) * sampleHeight));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const candidates = [];

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (y * sampleWidth + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      if (alpha < ALPHA_CUTOFF) continue;
      candidates.push({
        u: (x + 0.5) / sampleWidth,
        v: (y + 0.5) / sampleHeight,
        r: pixels[offset] / 255,
        g: pixels[offset + 1] / 255,
        b: pixels[offset + 2] / 255,
        a: alpha,
      });
    }
  }

  return {
    image,
    width: sampleWidth,
    height: sampleHeight,
    aspect: image.width / image.height,
    candidates,
  };
}

function materializeShape(sample, count, seed) {
  const random = mulberry32(seed);
  const source = sample.candidates;
  if (!source.length) throw new Error("目标图片没有可采样的不透明像素。");

  const u = new Float32Array(count);
  const v = new Float32Array(count);
  const r = new Float32Array(count);
  const g = new Float32Array(count);
  const b = new Float32Array(count);
  const jitterX = 1.05 / sample.width;
  const jitterY = 1.05 / sample.height;

  for (let i = 0; i < count; i += 1) {
    let point;
    let copy = false;
    if (i < source.length) {
      point = source[i];
    } else {
      point = source[Math.floor(random() * source.length)];
      copy = true;
    }
    u[i] = clamp(point.u + (copy || random() < 0.72 ? (random() - 0.5) * jitterX : 0));
    v[i] = clamp(point.v + (copy || random() < 0.72 ? (random() - 0.5) * jitterY : 0));
    r[i] = clamp(point.r + (random() - 0.5) * 0.02);
    g[i] = clamp(point.g + (random() - 0.5) * 0.02);
    b[i] = clamp(point.b + (random() - 0.5) * 0.02);
  }

  return { u, v, r, g, b, aspect: sample.aspect };
}

async function setupParticles() {
  const images = await Promise.all(SHAPES.map((shape) => loadImage(shape.src)));
  const samples = images.map(sampleImage);
  const allCounts = samples.map((sample) => sample.candidates.length);
  particleCount = Math.max(...allCounts);

  if (!particleCount) throw new Error("四张目标图都没有可采样的像素。");

  shapeSamples = samples.map((sample, index) =>
    materializeShape(sample, particleCount, 0x51f15e + index * 977)
  );

  const random = mulberry32(0xa4d1c7);
  const sizes = new Float32Array(particleCount);
  const alphas = new Float32Array(particleCount);
  const seeds = new Float32Array(particleCount);
  const bursts = new Float32Array(particleCount * 3);
  const colors = SHAPES.map(() => new Float32Array(particleCount * 3));
  positions.push(
    new Float32Array(particleCount * 3),
    new Float32Array(particleCount * 3),
    new Float32Array(particleCount * 3),
    new Float32Array(particleCount * 3)
  );

  for (let i = 0; i < particleCount; i += 1) {
    seeds[i] = random();
    sizes[i] = 1.35 + Math.pow(random(), 1.75) * 2.35;
    alphas[i] = 0.76 + random() * 0.24;

    const theta = random() * Math.PI * 2;
    const cosPhi = random() * 2 - 1;
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    let bx = Math.cos(theta) * sinPhi;
    let by = cosPhi;
    let bz = Math.sin(theta) * sinPhi;
    by += 0.36;
    const burstLength = Math.hypot(bx, by, bz) || 1;
    bursts[i * 3] = bx / burstLength;
    bursts[i * 3 + 1] = by / burstLength;
    bursts[i * 3 + 2] = bz / burstLength;

  }

  for (let shapeIndex = 0; shapeIndex < SHAPES.length; shapeIndex += 1) {
    const shape = SHAPES[shapeIndex];
    const sample = shapeSamples[shapeIndex];
    const color = colors[shapeIndex];
    const accent = shape.accent;
    for (let i = 0; i < particleCount; i += 1) {
      const lifted = liftColor(sample.r[i], sample.g[i], sample.b[i], accent);
      color[i * 3] = lifted[0];
      color[i * 3 + 1] = lifted[1];
      color[i * 3 + 2] = lifted[2];
    }
  }

  computeHologramFrame();
  updateLayoutPositions();

  particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions[0], 3).setUsage(THREE.DynamicDrawUsage));
  particleGeometry.setAttribute("aPosB", new THREE.BufferAttribute(positions[1], 3).setUsage(THREE.DynamicDrawUsage));
  particleGeometry.setAttribute("aPosC", new THREE.BufferAttribute(positions[2], 3).setUsage(THREE.DynamicDrawUsage));
  particleGeometry.setAttribute("aPosD", new THREE.BufferAttribute(positions[3], 3).setUsage(THREE.DynamicDrawUsage));
  particleGeometry.setAttribute("aColorA", new THREE.BufferAttribute(colors[0], 3));
  particleGeometry.setAttribute("aColorB", new THREE.BufferAttribute(colors[1], 3));
  particleGeometry.setAttribute("aColorC", new THREE.BufferAttribute(colors[2], 3));
  particleGeometry.setAttribute("aColorD", new THREE.BufferAttribute(colors[3], 3));
  particleGeometry.setAttribute("aBurst", new THREE.BufferAttribute(bursts, 3));
  particleGeometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  particleGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
  particleGeometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  particleGeometry.setDrawRange(0, particleCount);

  particleUniforms = {
    uDisperse: { value: state.dispersion },
    uBurst: { value: 0 },
    uPresence: { value: 0 },
    uContentSpin: { value: 0 },
    uContentRotation: { value: new THREE.Matrix3() },
    uMorph: { value: 1 },
    uFrom: { value: new THREE.Vector4(1, 0, 0, 0) },
    uTo: { value: new THREE.Vector4(1, 0, 0, 0) },
    uTime: { value: 0 },
    uPixelRatio: { value: viewport.dpr },
    uCameraDistance: { value: viewport.cameraDistance },
    uPointScale: { value: clamp(holo.cubeSize / 360, 0.82, 1.25) },
    uBurstSpread: { value: holo.cubeSize * 0.36 },
    uAdaptive: { value: state.adaptiveOpacity },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: particleUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: PARTICLE_VERTEX_SHADER,
    fragmentShader: PARTICLE_FRAGMENT_SHADER,
  });

  particlePoints = new THREE.Points(particleGeometry, material);
  particlePoints.frustumCulled = false;
  particlePoints.renderOrder = 3;
  anchor.add(particlePoints);

  buildShapePlanes(images);
  computeHologramFrame();
  updateHologramPlanes(performance.now() / 1000);

  applyMorphWeights(0, 0);

  state.assetsReady = true;
  console.info(
    `[Holo] ${SHAPES.length} forms, ${particleCount.toLocaleString("en-US")} particles per form.`
  );
  setHint("左手托举立方体 · 右手张开消散 · 握拳聚合切换");
}

function liftColor(r, g, b, accent) {
  let lifted = [Math.pow(r, 0.84), Math.pow(g, 0.84), Math.pow(b, 0.84)];
  const luminance = 0.299 * lifted[0] + 0.587 * lifted[1] + 0.114 * lifted[2];
  const tint = 0.075 + (1 - luminance) * 0.19;
  lifted = [
    lifted[0] * (1 - tint) + accent[0] * tint,
    lifted[1] * (1 - tint) + accent[1] * tint,
    lifted[2] * (1 - tint) + accent[2] * tint,
  ];
  return lifted.map((value) => clamp(value * 1.12 + 0.012));
}

function updateLayoutPositions() {
  if (!shapeSamples || !positions.length) return;

  const cubeSize = holo.cubeSize || Math.min(viewport.width, viewport.height) * 0.5;
  const depthScale = cubeSize * 0.105;

  for (let s = 0; s < SHAPES.length; s += 1) {
    const sample = shapeSamples[s];
    const dims = shapeLayouts[s];
    const out = positions[s];
    for (let i = 0; i < particleCount; i += 1) {
      const offset = i * 3;
      out[offset] = (sample.u[i] - 0.5) * dims.width;
      out[offset + 1] = (0.5 - sample.v[i]) * dims.height;
      const hashValue = Math.sin((i + 1) * 12.9898 + s * 78.233) * 43758.5453;
      out[offset + 2] = (hashValue - Math.floor(hashValue) - 0.5) * depthScale;
    }
  }

  if (particleGeometry) {
    particleGeometry.attributes.position.needsUpdate = true;
    particleGeometry.attributes.aPosB.needsUpdate = true;
    particleGeometry.attributes.aPosC.needsUpdate = true;
    particleGeometry.attributes.aPosD.needsUpdate = true;
    particleUniforms.uBurstSpread.value = cubeSize * 0.36;
  }
}

function setMorphWeights(from, to) {
  if (!particleUniforms) return;
  particleUniforms.uFrom.value.set(0, 0, 0, 0);
  particleUniforms.uTo.value.set(0, 0, 0, 0);
  particleUniforms.uFrom.value.setComponent(from, 1);
  particleUniforms.uTo.value.setComponent(to, 1);
}

function applyMorphWeights(from, to) {
  setMorphWeights(from, to);
  if (particleUniforms) particleUniforms.uMorph.value = 1;
}



/* --------------------------------------------------------------------------
   Particle shader: target morph, dense particle burst, rotating cube volume
-------------------------------------------------------------------------- */

const PARTICLE_VERTEX_SHADER = /* glsl */ `
  uniform float uDisperse;
  uniform float uBurst;
  uniform float uPresence;
  uniform float uContentSpin;
  uniform mat3 uContentRotation;
  uniform float uMorph;
  uniform vec4 uFrom;
  uniform vec4 uTo;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uCameraDistance;
  uniform float uPointScale;
  uniform float uBurstSpread;
  uniform float uAdaptive;

  attribute vec3 aPosB;
  attribute vec3 aPosC;
  attribute vec3 aPosD;
  attribute vec3 aColorA;
  attribute vec3 aColorB;
  attribute vec3 aColorC;
  attribute vec3 aColorD;
  attribute vec3 aBurst;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;

  varying vec3 vColor;
  varying float vAlpha;

  float easeInOutCubic(float x) {
    x = clamp(x, 0.0, 1.0);
    return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0;
  }

  vec3 formPosition(vec4 weight) {
    return position * weight.x +
      aPosB * weight.y +
      aPosC * weight.z +
      aPosD * weight.w;
  }

  vec3 formColor(vec4 weight) {
    return aColorA * weight.x +
      aColorB * weight.y +
      aColorC * weight.z +
      aColorD * weight.w;
  }

  void main() {
    float progress = clamp(uMorph, 0.0, 1.0);
    float eased = easeInOutCubic(progress);
    float swap = smoothstep(0.18, 0.82, eased);
    vec3 imagePosition = mix(formPosition(uFrom), formPosition(uTo), swap);

    // Per-particle stagger keeps the cloud from expanding as one rigid shell.
    float localDisperse = smoothstep(
      aSeed * 0.18,
      aSeed * 0.18 + 0.82,
      clamp(uDisperse, 0.0, 1.0)
    );

    vec3 radial = imagePosition;
    radial.z *= 2.1;
    radial = normalize(radial + vec3(0.0001, 0.0001, 0.0));
    vec3 scatterDirection = normalize(mix(aBurst, radial, 0.64) + vec3(0.0, 0.14, 0.0));

    float spread = uBurstSpread * (0.22 + aSeed * 0.68);
    vec3 p = imagePosition;
    p += scatterDirection * spread * localDisperse;
    p.y += uBurstSpread * localDisperse * (0.07 + aSeed * 0.2);
    p += scatterDirection * uBurstSpread * uBurst * (0.28 + aSeed * 0.64);

    float clock = uTime * 0.55 + aSeed * 6.28318530718;
    float turbulence = localDisperse * 0.14;
    p.x += sin(clock * 1.05 + aSeed * 4.7) * uBurstSpread * turbulence;
    p.y += cos(clock * 0.82 + aSeed * 3.3) * uBurstSpread * turbulence;
    p.z += sin(clock * 0.64 + aSeed * 2.2) * uBurstSpread * turbulence * 1.2;

    float idle = 0.25 + localDisperse * 1.0;
    p.x += sin(clock * 0.4) * idle;
    p.y += cos(clock * 0.33) * idle;
    p.z += sin(clock * 0.27) * idle * 1.4;

    p = mix(p, uContentRotation * p, uContentSpin);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float depthScale = uCameraDistance / max(2.0, -mv.z);
    float size = aSize * uPointScale * uPixelRatio * depthScale;
    size *= 1.0 + localDisperse * 1.1 + uBurst * 0.9;
    gl_PointSize = min(size, 38.0 * uPixelRatio);

    vec3 colorA = formColor(uFrom);
    vec3 colorB = formColor(uTo);
    vColor = mix(colorA, colorB, swap);

    float twinkle = 0.93 + 0.07 * sin(uTime * 1.45 + aSeed * 31.0);
    vAlpha = aAlpha * uAdaptive * twinkle * uPresence;

    float assembled = 1.0 - smoothstep(0.0, 0.2, localDisperse);
    float restSparkle = mix(0.03, 0.26, smoothstep(0.82, 0.995, aSeed));
    vAlpha *= mix(1.0, restSparkle, assembled);
    vAlpha *= mix(1.0, 1.06, localDisperse);
    vAlpha *= 1.0 + uBurst * 0.32;
    vColor = mix(vColor, vColor * 1.1 + vec3(0.025), uBurst * 0.3);
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float radius = length(centered) * 2.0;
    if (radius > 1.0) discard;

    float halo = pow(max(0.0, 1.0 - radius), 1.85);
    float core = smoothstep(0.42, 0.01, radius);
    vec3 color = vColor * (0.82 + core * 1.02) + vec3(core * 0.07);
    gl_FragColor = vec4(color, halo * vAlpha);
  }
`;


/* --------------------------------------------------------------------------
   Hologram image layer: the source artwork remains legible inside the cube.
   Particles become the shimmer / dispersion around it instead of the only
   representation of the image.
-------------------------------------------------------------------------- */

const IMAGE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const IMAGE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uBreakup;
  uniform vec3 uRim;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.52;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = p * 2.03 + 17.1;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    if (uOpacity < 0.002) discard;
    vec4 tex = texture2D(uMap, vUv);
    if (tex.a < 0.012) discard;

    float dissolve = smoothstep(0.0, 0.42, uBreakup);
    float grain = fbm(vUv * vec2(11.0, 8.0) + vec2(uTime * 0.035, -uTime * 0.022));
    float threshold = mix(-0.38, 1.08, uBreakup);
    float broken = smoothstep(threshold - 0.12, threshold + 0.18, grain);
    float alpha = tex.a * uOpacity * mix(1.0, broken, dissolve);

    float edgeX = 1.6 / 900.0;
    float edgeY = 1.6 / 1200.0;
    float aL = texture2D(uMap, vUv - vec2(edgeX, 0.0)).a;
    float aR = texture2D(uMap, vUv + vec2(edgeX, 0.0)).a;
    float aB = texture2D(uMap, vUv - vec2(0.0, edgeY)).a;
    float aT = texture2D(uMap, vUv + vec2(0.0, edgeY)).a;
    float edge = clamp(tex.a - min(min(aL, aR), min(aB, aT)), 0.0, 1.0);
    edge = smoothstep(0.0, 0.22, edge);

    float scan = 0.958 + 0.042 * sin(vUv.y * 470.0 - uTime * 2.15);
    vec3 color = pow(tex.rgb, vec3(0.93)) * 1.035 * scan;

    float scanBand = exp(-pow((vUv.y - (0.5 + 0.5 * sin(uTime * 0.19))) / 0.045, 2.0));
    color += uRim * scanBand * 0.018;
    color += uRim * edge * (0.26 + scanBand * 0.75);

    gl_FragColor = vec4(color, alpha);
  }
`;

function buildShapePlanes(images) {
  if (shapePlanes.length) return;
  flowerPlaneGroup = new THREE.Group();
  flowerPlaneGroup.name = "hologram-flower-planes";
  inner.add(flowerPlaneGroup);
  portraitPlaneGroup = new THREE.Group();
  portraitPlaneGroup.name = "hologram-portrait-planes";
  anchor.add(portraitPlaneGroup);

  shapePlanes = images.map((image, index) => {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uBreakup: { value: 0 },
        uRim: { value: new THREE.Color(SHAPES[index].glow) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      vertexShader: IMAGE_VERTEX_SHADER,
      fragmentShader: IMAGE_FRAGMENT_SHADER,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.set(shapeLayouts[index].width, shapeLayouts[index].height, 1);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.visible = false;
    if (SHAPES[index].rotates) flowerPlaneGroup.add(mesh);
    else portraitPlaneGroup.add(mesh);
    return mesh;
  });
}

const haloColorA = new THREE.Color();

function updateHologramPlanes(nowSeconds) {
  if (!shapePlanes.length) return;

  const dispersion = clamp(state.dispersion);
  const assembled = 1 - smoothstep(0.16, 0.9, dispersion);
  const breakup = smoothstep(0.02, 0.7, dispersion);
  const activeIndex = state.currentShape;
  const dims = shapeLayouts[activeIndex];
  const activeUses3D = Boolean(findFlower3D(activeIndex));

  for (let i = 0; i < shapePlanes.length; i += 1) {
    const plane = shapePlanes[i];
    const visible = i === activeIndex && !activeUses3D && assembled > 0.003;
    plane.visible = visible;
    if (visible) {
      plane.material.uniforms.uOpacity.value = holo.imageOpacity * assembled * state.holoPresence;
      plane.material.uniforms.uBreakup.value = breakup;
      plane.material.uniforms.uTime.value = nowSeconds;
    }
  }

  if (imageHalo && dims) {
    haloColorA.setHex(SHAPES[activeIndex].glow);
    imageHalo.material.color.copy(haloColorA);
    imageHalo.material.opacity = (0.16 * assembled + state.burst * 0.025) * state.holoPresence;
    imageHalo.scale.set(
      Math.max(40, dims.width * 1.38),
      Math.max(40, dims.height * 1.28),
      1
    );
  }
}

/* --------------------------------------------------------------------------
   Animation
-------------------------------------------------------------------------- */

let previousTime = performance.now() / 1000;

function animate(nowMs) {
  requestAnimationFrame(animate);
  const now = nowMs / 1000;
  const dt = Math.min(0.05, Math.max(0.001, now - previousTime));
  previousTime = now;

  updateHandPresence(nowMs);
  updateHologramAnchor(dt);
  updateDispersion(dt);
  updateMorph(nowMs);
  updateBurst(dt);
  updateHologramPresence(dt, nowMs);
  updateFlower3DModels();
  updateCaptionParticles(now);
  updateHologramPlanes(now);
  updateBrightness(dt);

  if (inner) {
    const motionScale =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.22 : 1;
    // Continuous rotation in one direction, faster than the previous rock.
    inner.rotation.y = now * 0.62 * motionScale;
    inner.rotation.x = 0.035;
    inner.rotation.z = 0;
    inner.position.set(0, 0, 0);
  }

  if (particleUniforms) {
    particleUniforms.uTime.value = now;
    particleUniforms.uDisperse.value = state.dispersion;
    particleUniforms.uBurst.value = state.burst;
    particleUniforms.uPresence.value = state.holoPresence;
    particleUniforms.uAdaptive.value = state.adaptiveOpacity;
    particleUniforms.uContentSpin.value = SHAPES[state.currentShape].rotates ? 1 : 0;
    if (inner) {
      contentRotation.makeRotationFromEuler(inner.rotation);
      particleUniforms.uContentRotation.value.setFromMatrix4(contentRotation);
    }
  }

  if (captionUniforms) {
    captionUniforms.uDisperse.value = state.dispersion;
    captionUniforms.uBurst.value = state.burst;
    captionUniforms.uPresence.value = state.holoPresence;
    captionUniforms.uTime.value = now;
    captionUniforms.uPixelRatio.value = viewport.dpr;
    captionUniforms.uCameraDistance.value = viewport.cameraDistance;
  }

  updateRightHandRig(dt, nowMs);
  if (renderer && scene && camera) renderer.render(scene, camera);

  updateFps(nowMs);
  updateDebugReadout(nowMs);
}

function updateHologramPresence(dt, nowMs) {
  if (!anchor) return;

  const target = state.holoWanted ? 1 : 0;
  const response = target > state.holoPresence ? 7.5 : 9.5;
  state.holoPresence += (target - state.holoPresence) * (1 - Math.exp(-dt * response));
  if (Math.abs(target - state.holoPresence) < 0.001) {
    state.holoPresence = target;
  }

  const presence = state.holoPresence;
  anchor.visible = presence > 0.002;
  const scale = 0.955 + 0.045 * presence;
  anchor.scale.setScalar(scale);

  if (cubeEdgeMaterial) {
    cubeEdgeMaterial.opacity = presence * (0.62 + state.burst * 0.16);
  }
  if (cubeEdgeGlowMaterial) {
    cubeEdgeGlowMaterial.opacity = presence * (0.06 + state.burst * 0.035);
  }
  for (const material of cubeAccentMaterials) {
    material.opacity = presence * (material.userData.baseOpacity ?? 0.2);
  }
  if (scanRing) {
    scanRing.position.y = Math.sin(nowMs / 1000 * 0.72) * 0.31;
  }
  if (scanRingMaterial) {
    const pulse = 0.2 + 0.08 * Math.sin(nowMs / 1000 * 2.1);
    scanRingMaterial.opacity = presence * pulse;
  }
}

function updateDispersion(dt) {
  const target = clamp(state.dispersionTarget);
  const response = target > state.dispersion ? 7.2 : 6.2;
  state.dispersion += (target - state.dispersion) * (1 - Math.exp(-dt * response));
  if (Math.abs(target - state.dispersion) < 0.0008) state.dispersion = target;
}

function updateHologramAnchor(dt) {
  if (!anchor) return;
  const cube = holo.cubeSize || 300;
  const marginX = Math.min(cube * 0.55, viewport.width * 0.3);
  const marginYTop = Math.min(cube * 0.52, viewport.height * 0.28);
  const marginYBottom = Math.min(cube * 0.28, viewport.height * 0.15);

  const sx = clamp(state.leftAnchorScreen.x, marginX, viewport.width - marginX);
  const sy = clamp(state.leftAnchorScreen.y, marginYTop, viewport.height - marginYBottom);
  const targetX = sx - viewport.width * 0.5;
  const targetY = viewport.height * 0.5 - sy;

  if (!state.leftAnchorInitialized) {
    anchor.position.set(targetX, targetY, 0);
    state.leftAnchorInitialized = true;
    return;
  }

  if (state.holoPresence < 0.08) {
    anchor.position.set(targetX, targetY, 0);
    return;
  }

  const k = 1 - Math.exp(-dt * 12);
  anchor.position.x += (targetX - anchor.position.x) * k;
  anchor.position.y += (targetY - anchor.position.y) * k;
  anchor.position.z = 0;
}

function updateMorph(nowMs) {
  if (!particleUniforms) return;
  if (!morph.active) return;

  const raw = clamp((nowMs - morph.start) / FORM_BLEND_MS);
  morph.progress = raw;
  particleUniforms.uMorph.value = raw;
  setMorphWeights(morph.from, morph.to);
  if (raw >= 1) {
    morph.active = false;
    applyMorphWeights(state.currentShape, state.currentShape);
  }
}


function updateBrightness(dt) {
  if (!state.cameraReady || dom.video.readyState < 2) return;

  if (!updateBrightness.lastSample || performance.now() - updateBrightness.lastSample > 550) {
    updateBrightness.lastSample = performance.now();
    const canvas = updateBrightness.canvas || (updateBrightness.canvas = document.createElement("canvas"));
    if (canvas.width !== 36) {
      canvas.width = 36;
      canvas.height = 22;
      updateBrightness.ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = updateBrightness.ctx;
    if (ctx) {
      ctx.drawImage(dom.video, 0, 0, 36, 22);
      const pixels = ctx.getImageData(0, 0, 36, 22).data;
      let total = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        total += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
      }
      const mean = total / (pixels.length / 4);
      state.adaptiveOpacityTarget = clamp(1.17 - Math.max(0, mean - 0.22) * 0.9, 0.64, 1.17);
    }
  }

  const k = 1 - Math.exp(-dt * 2.2);
  state.adaptiveOpacity += (state.adaptiveOpacityTarget - state.adaptiveOpacity) * k;
}

function updateHandPresence(nowMs) {
  if (state.leftPresent && nowMs - state.lastLeftAt > 380) {
    state.leftPresent = false;
    state.leftOpen = false;
    state.holoWanted = false;
  }
  if (state.rightPresent && nowMs - state.lastRightAt > 380) {
    state.rightPresent = false;
    state.rightPhase = null;
    state.rightHighFrames = 0;
    state.rightLowFrames = 0;
  }
  if (!state.leftPresent && !state.rightPresent) {
    clearDebugCanvas();
  }
}

function updateFps(nowMs) {
  state.fpsFrames += 1;
  if (!state.fpsAt) state.fpsAt = nowMs;
  if (nowMs - state.fpsAt > 1000) {
    state.fps = Math.round((state.fpsFrames * 1000) / (nowMs - state.fpsAt));
    state.fpsFrames = 0;
    state.fpsAt = nowMs;
  }
}

/* --------------------------------------------------------------------------
   UI helpers
-------------------------------------------------------------------------- */

function setGateMessage(message) {
  if (dom.gateMessage) dom.gateMessage.textContent = message;
}

function setGateError(message) {
  setGateMessage(message);
  if (!dom.gateButton) return;
  dom.gateButton.hidden = false;
  dom.gateButton.disabled = false;
  dom.gateButton.textContent = state.assetError ? "重新载入" : "重新开启摄像头";
}

function tryEnterExperience() {
  if (state.inView) return;
  if (!state.cameraReady || !state.assetsReady) return;

  state.inView = true;
  dom.experience.classList.add("is-live", "is-camera-live");
  dom.gate.classList.add("is-hidden");
  dom.gateButton.hidden = true;
  setHint(
    state.trackerReady
      ? "左手托举立方体 · 右手张开消散 · 握拳聚合切换"
      : state.trackerFailed
        ? "手势追踪不可用 · 请刷新重试"
        : "手势追踪载入中…",
    !state.trackerReady
  );
  window.setTimeout(() => {
    if (state.inView && !state.cameraError) dom.gate.hidden = true;
  }, 900);
}

function setHint(text, quiet = false) {
  if (!dom.hint) return;
  dom.hint.textContent = text;
  dom.hint.classList.toggle("is-quiet", quiet);
}
let hintTimer = 0;
function flashHint(text, duration = 900) {
  if (!dom.hint) return;
  clearTimeout(hintTimer);
  dom.hint.textContent = text;
  dom.hint.classList.remove("is-quiet");
  hintTimer = window.setTimeout(() => {
    setHint("左手托举立方体 · 右手张开消散 · 握拳聚合切换", true);
  }, duration);
}

function showNotice(text, duration = 3400) {
  clearTimeout(showNotice.timer);
  dom.notice.textContent = text;
  dom.notice.classList.add("is-visible");
  showNotice.timer = window.setTimeout(() => {
    dom.notice.classList.remove("is-visible");
  }, duration);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function setModelLabel(index, immediate = false) {
  const shape = SHAPES[index];
  if (!shape) return;
  dom.modelIndex.textContent = pad2(index + 1);
  clearTimeout(state.modelLabelTimer);
  if (immediate) {
    dom.modelName.textContent = shape.name;
    return;
  }
  dom.modelName.classList.add("is-changing");
  state.modelLabelTimer = window.setTimeout(() => {
    dom.modelName.textContent = shape.name;
    dom.modelName.classList.remove("is-changing");
  }, 160);
}

function setDebugText(text) {
  if (DEBUG && dom.debugReadout) dom.debugReadout.textContent = text;
}

/* --------------------------------------------------------------------------
   Four-form cycle: a right-hand fist advances exactly one form.
-------------------------------------------------------------------------- */

function advanceForm(nowMs) {
  if (!particleUniforms) return;
  const from = state.currentShape % SHAPES.length;
  const to = (from + 1) % SHAPES.length;
  state.currentShape = to;
  morph.from = from;
  morph.to = to;
  morph.start = nowMs;
  morph.progress = 0;
  morph.active = true;
  setMorphWeights(from, to);
  particleUniforms.uMorph.value = 0;
  setModelLabel(to);
  flashHint(`${SHAPES[to].name} · 聚合`, 1100);
}

/* --------------------------------------------------------------------------
   Gesture measurement
-------------------------------------------------------------------------- */

function measureOpenness(landmarks, world) {
  const pose = world && world.length >= 21 ? world : landmarks;
  if (!pose || pose.length < 21) return 0;

  const wrist = pose[0];
  const middleMcp = pose[9];
  const fingers = [
    { mcp: 5, pip: 6, dip: 7, tip: 8 },
    { mcp: 9, pip: 10, dip: 11, tip: 12 },
    { mcp: 13, pip: 14, dip: 15, tip: 16 },
    { mcp: 17, pip: 18, dip: 19, tip: 20 },
  ];

  let extension = 0;
  for (const finger of fingers) {
    const mcp = pose[finger.mcp];
    const pip = pose[finger.pip];
    const dip = pose[finger.dip];
    const tip = pose[finger.tip];
    const boneLength =
      distance(mcp, pip) + distance(pip, dip) + distance(dip, tip) || 1e-6;
    const chord = distance(mcp, tip);
    const straightness = clamp(chord / boneLength);
    const base = normalizeVector({
      x: mcp.x - wrist.x,
      y: mcp.y - wrist.y,
      z: (mcp.z || 0) - (wrist.z || 0),
    });
    const outward = normalizeVector({
      x: tip.x - mcp.x,
      y: tip.y - mcp.y,
      z: (tip.z || 0) - (mcp.z || 0),
    });
    const forward = base.x * outward.x + base.y * outward.y + base.z * outward.z;
    const straightScore = smoothstep(0.58, 0.94, straightness);
    const reachScore = smoothstep(-0.18, 0.84, forward);
    extension += straightScore * 0.68 + reachScore * 0.32;
  }

  extension /= fingers.length;
  const palmLength = distance(wrist, middleMcp) || 1e-6;
  const thumbStraightness = clamp(
    distance(pose[2], pose[4]) /
      (distance(pose[2], pose[3]) + distance(pose[3], pose[4]) || 1e-6)
  );
  const thumbReach = distance(pose[4], pose[17]) / palmLength;
  const thumbScore =
    smoothstep(0.55, 0.93, thumbStraightness) * smoothstep(0.26, 0.95, thumbReach);

  const fused = extension * 0.92 + thumbScore * 0.08;
  return clamp((fused - 0.14) / 0.78);
}

/* --------------------------------------------------------------------------
   Camera + MediaPipe Hands
-------------------------------------------------------------------------- */

let handLandmarker = null;
let rigCtx = null;
let detectionCanvas = null;
let detectionCtx = null;
let debugCtx = null;
let visionModulePromise = null;


function mapVideoPointToScreen(x, y) {
  const vw = dom.video.videoWidth || 1280;
  const vh = dom.video.videoHeight || 720;
  const scale = Math.max(viewport.width / vw, viewport.height / vh);
  const renderedWidth = vw * scale;
  const renderedHeight = vh * scale;
  const offsetX = (renderedWidth - viewport.width) * 0.5;
  const offsetY = (renderedHeight - viewport.height) * 0.5;
  const screenX = viewport.width - (x * renderedWidth - offsetX);
  const screenY = y * renderedHeight - offsetY;
  return { x: screenX, y: screenY };
}

async function startCamera() {
  if (state.cameraReady) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("Camera API unavailable");
    error.name = "SecurityError";
    throw error;
  }

  setGateMessage("正在请求摄像头…");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });

  if (state.cameraStream) {
    for (const track of state.cameraStream.getTracks()) track.stop();
  }
  state.cameraStream = stream;
  dom.video.srcObject = stream;

  await waitForVideo();
  dom.video.play().catch((error) => console.warn("[Holo] camera play was blocked", error));
  if (dom.video.paused) await dom.video.play();
  if (!dom.video.videoWidth) throw new Error("摄像头没有输出画面");

  state.cameraReady = true;
  state.cameraError = false;
  dom.experience.classList.add("is-camera-live");
  setGateMessage("摄像头已连接，正在准备全息粒子…");
  updateBrightness.lastSample = 0;
  maybeStartDetection();
  tryEnterExperience();
}

function waitForVideo() {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      dom.video.removeEventListener("loadedmetadata", check);
      dom.video.removeEventListener("loadeddata", check);
      dom.video.removeEventListener("canplay", check);
      dom.video.removeEventListener("error", fail);
    };
    const check = () => {
      if (dom.video.videoWidth > 0 && dom.video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const fail = () => {
      cleanup();
      const error = new Error("Camera stream failed");
      error.name = "CameraStartError";
      reject(error);
    };
    dom.video.addEventListener("loadedmetadata", check);
    dom.video.addEventListener("loadeddata", check);
    dom.video.addEventListener("canplay", check);
    dom.video.addEventListener("error", fail);
    timer = window.setTimeout(() => {
      cleanup();
      const error = new Error("Camera produced no frames");
      error.name = "CameraStartError";
      reject(error);
    }, 10000);
  });
}

function describeCameraError(error) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return "摄像头需要安全环境，请通过 localhost 或 HTTPS 打开页面。";
  }
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "摄像头权限未开启。允许浏览器访问摄像头后，点击下方按钮重试。";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "没有找到可用摄像头。请连接摄像头后重试。";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "摄像头正被其他应用占用，请关闭占用程序后重试。";
  }
  return "摄像头连接失败。请确认浏览器权限和本地服务器地址后重试。";
}

async function ensureTracker() {
  if (state.trackerReady) return handLandmarker;
  if (state.trackerPromise) return state.trackerPromise;

  state.trackerStarting = true;
  state.trackerPromise = (async () => {
    if (!visionModulePromise) {
      visionModulePromise = import("./assets/mediapipe/vendor/vision_bundle.mjs");
    }
    const { FilesetResolver, HandLandmarker } = await visionModulePromise;
    const vision = await FilesetResolver.forVisionTasks(
      new URL("./assets/mediapipe/wasm", window.location.href).href
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: new URL(
          "./assets/mediapipe/hand_landmarker.task",
          window.location.href
        ).href,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.38,
      minHandPresenceConfidence: 0.38,
      minTrackingConfidence: 0.35,
    });

    state.trackerReady = true;
    state.trackerStarting = false;
    state.trackerFailed = false;
    setHint("左手托举立方体 · 右手张开消散 · 握拳聚合切换");
    maybeStartDetection();
    return handLandmarker;
  })().catch((error) => {
    state.trackerStarting = false;
    state.trackerFailed = true;
    console.error("[Holo] hand tracker failed", error);
    showNotice("手势追踪未能启动。刷新页面，或改用 Chrome / Safari 并开启硬件加速。", 6500);
    setHint("手势追踪不可用 · 请刷新重试", true);
    throw error;
  });

  return state.trackerPromise;
}

async function startSession() {
  if (state.cameraReady || state.cameraStarting) return;
  state.cameraStarting = true;
  state.cameraError = false;
  dom.gateButton.hidden = true;
  dom.gateButton.disabled = true;
  setGateMessage("正在请求摄像头…");

  const trackerTask = ensureTracker().catch(() => null);

  try {
    await startCamera();
    setGateMessage("摄像头已连接，正在准备全息粒子…");
    tryEnterExperience();
  } catch (error) {
    state.cameraError = true;
    state.cameraStarting = false;
    setGateError(describeCameraError(error));
    dom.gate.hidden = false;
    dom.gate.classList.remove("is-hidden");
    console.error("[Holo] camera failed", error);
    await trackerTask;
    return;
  }

  state.cameraStarting = false;
  await trackerTask;
}

function maybeStartDetection() {
  if (!state.cameraReady || !handLandmarker || state.detectionFrame) return;
  if (!detectionCanvas) {
    detectionCanvas = document.createElement("canvas");
    detectionCtx = detectionCanvas.getContext("2d", { willReadFrequently: false });
  }
  state.detectionFrame = requestAnimationFrame(detectLoop);
}

function stopDetection() {
  if (state.detectionFrame) cancelAnimationFrame(state.detectionFrame);
  state.detectionFrame = 0;
}

function detectLoop(nowMs) {
  state.detectionFrame = requestAnimationFrame(detectLoop);
  if (document.hidden || !state.cameraReady || !handLandmarker) return;
  if (nowMs - state.lastDetectionAt < 33) return;
  state.lastDetectionAt = nowMs;

  try {
    const targetWidth = viewport.width < 700 ? 480 : 640;
    const sourceWidth = dom.video.videoWidth;
    const sourceHeight = dom.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;
    const targetHeight = Math.max(1, Math.round(targetWidth * (sourceHeight / sourceWidth)));

    if (detectionCanvas.width !== targetWidth || detectionCanvas.height !== targetHeight) {
      detectionCanvas.width = targetWidth;
      detectionCanvas.height = targetHeight;
    }

    detectionCtx.drawImage(dom.video, 0, 0, targetWidth, targetHeight);
    const result = handLandmarker.detectForVideo(detectionCanvas, nowMs);
    state.detectionErrors = 0;
    processHandsResult(result, nowMs);
  } catch (error) {
    state.detectionErrors += 1;
    if (state.detectionErrors === 1 || state.detectionErrors % 180 === 0) {
      console.error("[Holo] hand detection error", error);
      showNotice("手部追踪暂时中断，正在重试…", 2200);
    }
  }
}

function palmCenterOf(landmarks) {
  // Wrist + middle-finger MCP keeps the point in the middle of the palm even
  // when the fingers are splayed. Averaging all knuckles biases toward the
  // pinky side and would slide the cube off the hand.
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  return {
    x: wrist.x * 0.35 + middleMcp.x * 0.65,
    y: wrist.y * 0.35 + middleMcp.y * 0.65,
  };
}

function handednessOf(result, index) {
  const categories =
    result?.handednesses?.[index] ||
    result?.handedness?.[index] ||
    [];
  const category = categories[0];
  if (!category) return { role: null, score: 0 };
  const label = String(category.categoryName || category.displayName || category.label || "").toLowerCase();
  const role = label.includes("left") ? "left" : label.includes("right") ? "right" : null;
  return { role, score: category.score ?? 0 };
}

function updateLeftHand(hand, nowMs) {
  if (!hand) return;
  if (!state.leftPresent) {
    filters.leftPalmX.reset();
    filters.leftPalmY.reset();
  }

  const rawOpenness = measureOpenness(hand.landmarks, hand.world);
  state.leftRawOpenness = rawOpenness;
  if (rawOpenness > 0.55) {
    state.leftOpen = true;
    state.holoWanted = true;
  } else if (rawOpenness < 0.3) {
    state.leftOpen = false;
    state.holoWanted = false;
  }

  const palm = palmCenterOf(hand.landmarks);
  const palmX = filters.leftPalmX.filter(palm.x, nowMs / 1000);
  const palmY = filters.leftPalmY.filter(palm.y, nowMs / 1000);
  const screenPoint = mapVideoPointToScreen(palmX, palmY);

  state.leftAnchorScreen.set(
    screenPoint.x,
    screenPoint.y - holo.cubeSize * 0.54 - 6
  );
  state.leftPresent = true;
  state.leftSeenOnce = true;
  state.lastLeftAt = nowMs;
}

function updateRightHand(hand, nowMs) {
  if (!hand) return;
  if (!state.rightPresent) {
    state.rightHighFrames = 0;
    state.rightLowFrames = 0;
  }

  const rawOpenness = measureOpenness(hand.landmarks, hand.world);
  state.rightRawOpenness = rawOpenness;
  state.rightPresent = true;
  state.lastRightAt = nowMs;

  // Classify only after the hand has held a clear pose for two frames. The
  // first clear pose establishes the phase without advancing the model.
  if (rawOpenness > 0.6) {
    state.rightHighFrames += 1;
    state.rightLowFrames = 0;
  } else if (rawOpenness < 0.3) {
    state.rightLowFrames += 1;
    state.rightHighFrames = 0;
  } else {
    state.rightHighFrames = 0;
    state.rightLowFrames = 0;
  }

  if (state.rightPhase === null) {
    if (rawOpenness > 0.55) {
      state.rightPhase = "open";
      state.dispersionTarget = 1;
      triggerBurst();
    } else if (rawOpenness < 0.3) {
      state.rightPhase = "closed";
      state.dispersionTarget = 0;
    }
    return;
  }

  if (state.rightPhase === "closed" && state.rightHighFrames >= 2) {
    state.rightPhase = "open";
    state.rightHighFrames = 0;
    state.rightLowFrames = 0;
    state.dispersionTarget = 1;
    triggerBurst();
  } else if (state.rightPhase === "open" && state.rightLowFrames >= 2) {
    state.rightPhase = "closed";
    state.rightHighFrames = 0;
    state.rightLowFrames = 0;
    state.dispersionTarget = 0;
    advanceForm(nowMs);
  }
}

function processHandsResult(result, nowMs) {
  const landmarks = result?.landmarks || [];
  const worldLandmarks = result?.worldLandmarks || [];

  if (!landmarks.length) {
    if (DEBUG) clearDebugCanvas();
    return;
  }

  const candidates = landmarks.map((handLandmarks, index) => {
    const handedness = handednessOf(result, index);
    const palm = palmCenterOf(handLandmarks);
    const screenPoint = mapVideoPointToScreen(palm.x, palm.y);
    return {
      landmarks: handLandmarks,
      world: worldLandmarks[index],
      role: handedness.role,
      score: handedness.score,
      screenX: screenPoint.x,
    };
  });

  let left = null;
  let right = null;

  if (candidates.length >= 2) {
    // The preview is mirrored, so the user's left hand appears on the left of
    // the screen. Using that visible relationship makes the roles stable even
    // if a particular browser reports handedness inconsistently.
    const ordered = [...candidates].sort((a, b) => a.screenX - b.screenX);
    left = ordered[0];
    right = ordered[1];
  } else {
    const hand = candidates[0];
    if (hand.role === "left") {
      left = hand;
    } else if (hand.role === "right") {
      right = hand;
    } else {
      // No reliable label: fall back to which half of the mirrored frame the
      // hand occupies. The demo is designed to be used with separated hands.
      if (hand.screenX < viewport.width * 0.5) left = hand;
      else right = hand;
    }
  }

  if (left) {
    updateLeftHand(left, nowMs);
    left.role = "left";
  }
  if (right) {
    updateRightHand(right, nowMs);
    right.role = "right";
    updateRightRigTarget(right.landmarks, nowMs);
  }

  if (DEBUG) drawDebugHands(left ? [left, ...(right && right !== left ? [right] : [])] : (right ? [right] : []));
}

/* --------------------------------------------------------------------------
   Right-hand control rig (always-on neon skeleton)
-------------------------------------------------------------------------- */

const RIG_PALM = [0, 5, 9, 13, 17];
const RIG_FINGERTIPS = [4, 8, 12, 16, 20];

function resizeRigCanvas() {
  if (!dom.rigCanvas) return;
  dom.rigCanvas.width = Math.round(viewport.width * viewport.dpr);
  dom.rigCanvas.height = Math.round(viewport.height * viewport.dpr);
  rigCtx = dom.rigCanvas.getContext("2d");
  if (rigCtx) {
    rigCtx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    rigCtx.imageSmoothingEnabled = true;
    rigCtx.clearRect(0, 0, viewport.width, viewport.height);
  }
  state.rightRigPositions = null;
  state.rightRigTarget = null;
  state.rightRigAlpha = 0;
}

function updateRightRigTarget(landmarks, nowMs) {
  if (!landmarks || landmarks.length < 21) return;
  if (!state.rightRigTarget) state.rightRigTarget = new Float32Array(42);
  for (let i = 0; i < 21; i += 1) {
    const point = mapVideoPointToScreen(landmarks[i].x, landmarks[i].y);
    state.rightRigTarget[i * 2] = point.x;
    state.rightRigTarget[i * 2 + 1] = point.y;
  }

  const wasCold = !state.lastRightRigAt || nowMs - state.lastRightRigAt > 420;
  state.lastRightRigAt = nowMs;
  if (!state.rightRigPositions || wasCold) {
    state.rightRigPositions = new Float32Array(state.rightRigTarget);
  }
}

function drawRightHandRig(points, alpha, nowMs) {
  if (!rigCtx) return;
  const ctx = rigCtx;
  const width = viewport.width;
  const height = viewport.height;
  ctx.clearRect(0, 0, width, height);
  if (alpha < 0.012 || typeof document !== "undefined" && document.body.classList.contains("show-debug")) {
    return;
  }

  const p = (index) => ({ x: points[index * 2], y: points[index * 2 + 1] });
  const wrist = p(0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Palm shell.
  ctx.beginPath();
  RIG_PALM.forEach((index, order) => {
    const point = p(index);
    if (order === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(105, 224, 255, 0.035)";
  ctx.fill();
  ctx.strokeStyle = "rgba(169, 240, 255, 0.14)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Dark underlay keeps the skeleton readable over a bright camera frame.
  ctx.globalCompositeOperation = "source-over";
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const start = p(a);
    const end = p(b);
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
  }
  ctx.strokeStyle = "rgba(2, 8, 13, 0.28)";
  ctx.lineWidth = 4.2;
  ctx.stroke();

  // Neon glow.
  ctx.globalCompositeOperation = "lighter";
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const start = p(a);
    const end = p(b);
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
  }
  ctx.strokeStyle = "rgba(87, 220, 255, 0.14)";
  ctx.lineWidth = 8;
  ctx.shadowColor = "rgba(86, 224, 255, 0.65)";
  ctx.shadowBlur = 16;
  ctx.stroke();

  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const start = p(a);
    const end = p(b);
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
  }
  ctx.strokeStyle = "rgba(202, 248, 255, 0.58)";
  ctx.lineWidth = 1.25;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Joints.
  for (let i = 0; i < 21; i += 1) {
    const point = p(i);
    const isTip = RIG_FINGERTIPS.includes(i);
    if (isTip) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(202, 250, 255, 0.72)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, i === 0 ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "rgba(224, 252, 255, 0.85)" : "rgba(171, 240, 255, 0.6)";
      ctx.fill();
    }
  }

  // A slowly rotating wrist scanner.
  const rotation = (nowMs / 1000) * 0.75;
  ctx.save();
  ctx.translate(wrist.x, wrist.y);
  ctx.strokeStyle = "rgba(132, 234, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.arc(0, 0, 21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(224, 253, 255, 0.72)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 24, rotation, rotation + 1.08);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

function updateRightHandRig(dt, nowMs) {
  if (!rigCtx) return;
  const active = state.lastRightRigAt && nowMs - state.lastRightRigAt < 260;
  const targetAlpha = active ? 1 : 0;
  const rate = targetAlpha > state.rightRigAlpha ? 14 : 8;
  state.rightRigAlpha += (targetAlpha - state.rightRigAlpha) * (1 - Math.exp(-dt * rate));
  if (state.rightRigAlpha < 0.009) {
    state.rightRigAlpha = 0;
    rigCtx.clearRect(0, 0, viewport.width, viewport.height);
    return;
  }

  if (!state.rightRigPositions || !state.rightRigTarget || !active) {
    drawRightHandRig(state.rightRigPositions || new Float32Array(42), state.rightRigAlpha, nowMs);
    return;
  }

  const k = 1 - Math.exp(-dt * 22);
  for (let i = 0; i < state.rightRigPositions.length; i += 1) {
    state.rightRigPositions[i] += (state.rightRigTarget[i] - state.rightRigPositions[i]) * k;
  }
  drawRightHandRig(state.rightRigPositions, state.rightRigAlpha, nowMs);
}

/* --------------------------------------------------------------------------
   Debug overlay
-------------------------------------------------------------------------- */

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
  [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function resizeDebugCanvas() {
  if (!dom.debugCanvas) return;
  dom.debugCanvas.width = Math.round(viewport.width * viewport.dpr);
  dom.debugCanvas.height = Math.round(viewport.height * viewport.dpr);
  debugCtx = dom.debugCanvas.getContext("2d");
  if (debugCtx) {
    debugCtx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    debugCtx.imageSmoothingEnabled = true;
    debugCtx.clearRect(0, 0, viewport.width, viewport.height);
  }
}

function clearDebugCanvas() {
  if (debugCtx) debugCtx.clearRect(0, 0, viewport.width, viewport.height);
}

function drawDebugHands(hands) {
  if (!debugCtx || !DEBUG) return;
  const ctx = debugCtx;
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const hand of hands) {
    const isLeft = hand.role === "left";
    const accent = isLeft
      ? { line: "rgba(165, 228, 255, 0.34)", dot: "rgba(205, 244, 255, 0.58)", text: "rgba(205, 244, 255, 0.8)" }
      : { line: "rgba(255, 175, 188, 0.34)", dot: "rgba(255, 203, 211, 0.6)", text: "rgba(255, 203, 211, 0.8)" };

    const points = hand.landmarks.map((landmark) => mapVideoPointToScreen(landmark.x, landmark.y));
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
    }
    ctx.strokeStyle = accent.line;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.beginPath();
    for (const point of points) {
      ctx.moveTo(point.x + 2, point.y);
      ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
    }
    ctx.fillStyle = accent.dot;
    ctx.fill();

    const palmIndex = 9;
    ctx.fillStyle = accent.text;
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.fillText(isLeft ? "LEFT · CUBE" : "RIGHT · CONTROL", points[palmIndex].x + 10, points[palmIndex].y - 10);
  }

  ctx.restore();
}

function updateDebugReadout(nowMs) {
  if (!DEBUG) return;
  if (nowMs - state.debugLastDraw < 160) return;
  state.debugLastDraw = nowMs;
  setDebugText(
    [
      `TRACKER  ${state.trackerReady ? "READY" : state.trackerFailed ? "FAILED" : "LOADING"}`,
      `LEFT     ${state.leftPresent ? "LOCKED" : "—"}  open=${state.leftRawOpenness.toFixed(2)}`,
      `RIGHT    ${state.rightPresent ? "LOCKED" : "—"}  open=${state.rightRawOpenness.toFixed(2)}  phase=${state.rightPhase || "unknown"}`,
      `DISP     view=${state.dispersion.toFixed(2)}  target=${state.dispersionTarget.toFixed(2)}`,
      `FORM     ${state.currentShape + 1} / 4${morph.active ? " · blending" : ""}`,
      `CUBE     ${state.holoPresence > 0.05 ? "PRESENT" : "HIDDEN"}  presence=${state.holoPresence.toFixed(2)}`
      `BURST    ${state.burst.toFixed(2)}`,
      `PERF     ${state.fps} fps · ${particleCount.toLocaleString("en-US")} pts`,
    ].join("\n")
  );
}

/* --------------------------------------------------------------------------
   Boot
-------------------------------------------------------------------------- */

function bindUi() {
  if (DEBUG) {
    resizeDebugCanvas();
    setDebugText("TRACKER / booting");
  }

  dom.gateButton?.addEventListener("click", () => {
    if (state.assetError) {
      window.location.reload();
      return;
    }
    state.cameraError = false;
    startSession();
  });

  dom.video.addEventListener("click", () => {
    if (dom.video.paused && state.cameraReady) dom.video.play().catch(() => {});
  });

  window.addEventListener("beforeunload", () => {
    if (state.cameraStream) {
      for (const track of state.cameraStream.getTracks()) track.stop();
    }
  });

  document.addEventListener("pointerdown", () => {
    if (state.cameraError) return;
    if (dom.video.paused && state.cameraReady) dom.video.play().catch(() => {});
  });
}

function installDebugApi() {
  if (!DEBUG) return;
  window.__holoGesture = {
    state,
    morph,
    setDispersion(value) {
      state.dispersion = clamp(value);
      state.dispersionTarget = state.dispersion;
    },
    setShape(index) {
      const next = ((Math.round(index) % SHAPES.length) + SHAPES.length) % SHAPES.length;
      morph.active = false;
      morph.progress = 1;
      state.currentShape = next;
      applyMorphWeights(next, next);
      setModelLabel(next, true);
      updateLayoutPositions();
    },
    setCubeScreen(normalizedX, normalizedY) {
      state.leftSeenOnce = true;
      state.leftAnchorScreen.set(
        viewport.width * clamp(normalizedX, 0, 1),
        viewport.height * clamp(normalizedY, 0, 1)
      );
    },
    measure(landmarks, world = null) {
      return measureOpenness(landmarks, world);
    },
    feedHands(hands) {
      if (!hands.length) {
        processHandsResult({ landmarks: [], worldLandmarks: [], handednesses: [] }, performance.now());
        return;
      }
      processHandsResult(
        {
          landmarks: hands.map((hand) => hand.landmarks),
          worldLandmarks: hands.map((hand) => hand.world || []),
          handednesses: hands.map((hand) => [
            { categoryName: hand.role === "left" ? "Left" : "Right", score: 1 },
          ]),
        },
        performance.now()
      );
    },
    feed(landmarks, world = null, role = "right") {
      window.__holoGesture.feedHands([{ landmarks, world, role }]);
    },
    flowers() {
      return flower3DEntries.map((entry) => ({
        index: entry.index,
        loaded: entry.loaded,
        height: entry.height,
        materials: entry.materials.map((material) => ({
          name: material.name,
          color: material.color ? material.color.getHexString() : null,
          opacity: material.opacity,
        })),
      }));
    },
    flowerTree() {
      return flower3DEntries.map((entry) => {
        const vessels = [];
        entry.wrapper.traverse((object) => {
          if (!object.isMesh) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          const names = materials.map((material) => material?.name || "");
          if (names.some((name) => /glass|water/i.test(name))) {
            vessels.push({ name: object.name, visible: object.visible, materials: names });
          }
        });
        return { index: entry.index, vessels };
      });
    },
    planes() {
      return shapePlanes.map((plane) => ({
        visible: plane.visible,
        opacity: plane.material.uniforms.uOpacity.value,
        breakup: plane.material.uniforms.uBreakup.value,
        scale: [plane.scale.x, plane.scale.y],
      }));
    },
    setParticlesVisible(visible) {
      if (particlePoints) particlePoints.visible = visible;
    },
    setPlanesVisible(visible) {
      shapePlanes.forEach((plane) => { plane.visible = visible; });
    },
    info() {
      return {
        count: particleCount,
        shape: state.currentShape,
        morphing: morph.active,
        dispersion: state.dispersion,
        dispersionTarget: state.dispersionTarget,
        leftPresent: state.leftPresent,
        rightPresent: state.rightPresent,
        leftOpen: state.leftOpen,
        holoPresence: state.holoPresence,
        leftOpenness: state.leftRawOpenness,
        rightOpenness: state.rightRawOpenness,
        rightPhase: state.rightPhase,
        burst: state.burst,
        morph: { ...morph },
      };
    },
  };
}

async function boot() {
  setGateMessage("正在准备全息粒子…");
  try {
    initScene();
    bindUi();
    setModelLabel(0, true);
    loadFlower3DModels().catch((error) => console.warn("[Holo] 3D flower fallback", error));
    requestAnimationFrame(animate);
    ensureTracker().catch(() => {});
    startSession();

    try {
      await setupParticles();
      tryEnterExperience();
    } catch (error) {
      console.error("[Holo] particle setup failed", error);
      state.assetError = true;
      setGateError("全息粒子素材载入失败。请确认页面通过本地服务器打开，然后重试。");
      dom.gate.hidden = false;
      return;
    }
  } catch (error) {
    console.error("[Holo] boot failed", error);
    setGateError("体验初始化失败。请刷新页面后重试。");
    dom.gate.hidden = false;
  }
}

installDebugApi();
boot();
