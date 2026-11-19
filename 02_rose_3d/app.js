import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const params = new URLSearchParams(window.location.search);
const $ = (id) => document.getElementById(id);
if (params.has("clean")) document.body.classList.add("clean");

const stage = $("stageWrap");
const canvas = $("stage");
const loader = $("loader");
const errorPanel = $("error");
const spinBtn = $("spinBtn");
const spinLabel = $("spinLabel");
const cubeBtn = $("cubeBtn");

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
} catch (error) {
  showError();
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xffffff, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.94;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
camera.position.set(0.205, 0.35, 1.0);
camera.lookAt(0.0, 0.225, 0.02);

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment(renderer);
const env = pmrem.fromScene(room, 0.04).texture;
scene.environment = env;
pmrem.dispose();
room.dispose?.();

const hemi = new THREE.HemisphereLight(0xfffdf8, 0xd9d2c8, 0.62);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff7ec, 1.25);
key.position.set(-1.15, 2.4, 1.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -0.5;
key.shadow.camera.right = 0.5;
key.shadow.camera.top = 0.6;
key.shadow.camera.bottom = -0.08;
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 4;
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.001;
key.shadow.radius = 5;
scene.add(key);

const fill = new THREE.DirectionalLight(0xe8f2ff, 0.42);
fill.position.set(1.4, 1.2, 0.7);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffe4ec, 0.72);
rim.position.set(0.7, 1.4, -1.2);
scene.add(rim);

const warm = new THREE.PointLight(0xffe3cf, 0.36, 2.0, 2.0);
warm.position.set(-0.35, 0.5, 1.0);
scene.add(warm);

const shadowFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(3.0, 3.0),
  new THREE.ShadowMaterial({ color: 0x5f584f, opacity: 0.10 })
);
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.position.y = 0.0;
shadowFloor.receiveShadow = true;
scene.add(shadowFloor);

function contactTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(256, 256, 8, 256, 256, 250);
  g.addColorStop(0.0, "rgba(90, 78, 66, 0.22)");
  g.addColorStop(0.34, "rgba(90, 78, 66, 0.08)");
  g.addColorStop(0.7, "rgba(90, 78, 66, 0.02)");
  g.addColorStop(1.0, "rgba(90, 78, 66, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(0.30, 0.23),
  new THREE.MeshBasicMaterial({
    map: contactTexture(),
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    toneMapped: false,
  })
);
contact.rotation.x = -Math.PI / 2;
contact.position.set(0.0, 0.0006, 0.018);
scene.add(contact);

const turnGroup = new THREE.Group();
scene.add(turnGroup);

let autoSpin = params.get("still") !== "1";
let rotation = THREE.MathUtils.degToRad(parseFloat(params.get("a") || "-7"));
if (!Number.isFinite(rotation)) rotation = 0;
turnGroup.rotation.y = rotation;

let firstFrame = true;

spinBtn?.addEventListener("click", () => {
  autoSpin = !autoSpin;
  spinBtn.setAttribute("aria-pressed", String(autoSpin));
  if (spinLabel) spinLabel.textContent = autoSpin ? "PAUSE MOTION" : "RESUME MOTION";
});
spinBtn?.setAttribute("aria-pressed", String(autoSpin));
if (spinLabel) spinLabel.textContent = autoSpin ? "PAUSE MOTION" : "RESUME MOTION";

function showError(error) {
  console.error(error);
  loader?.classList.add("is-done");
  if (errorPanel) errorPanel.hidden = false;
}

function buildCube() {
  const cube = new THREE.Group();
  cube.name = "white-wireframe-cube";
  cube.position.y = 0.235;
  const w = 0.40, h = 0.46, d = 0.32;
  const corners = [
    [-w/2,-h/2,-d/2], [w/2,-h/2,-d/2], [w/2,h/2,-d/2], [-w/2,h/2,-d/2],
    [-w/2,-h/2,d/2], [w/2,-h/2,d/2], [w/2,h/2,d/2], [-w/2,h/2,d/2],
  ].map((p) => new THREE.Vector3(...p));
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const mat = new THREE.MeshBasicMaterial({
    color: 0x8ca4a9,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  const up = new THREE.Vector3(0, 1, 0);
  for (const [a, b] of edges) {
    const start = corners[a];
    const end = corners[b];
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(0.00085, 0.00085, len, 5, 1, false), mat);
    edge.position.copy(mid);
    edge.quaternion.setFromUnitVectors(up, dir.normalize());
    cube.add(edge);
  }
  const dotGeo = new THREE.BufferGeometry();
  const arr = [];
  for (const c of corners) arr.push(...c.toArray());
  dotGeo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  const dotMat = new THREE.PointsMaterial({
    color: 0x80999e,
    size: 0.015,
    transparent: true,
    opacity: 0.65,
    sizeAttenuation: true,
    depthWrite: false,
  });
  cube.add(new THREE.Points(dotGeo, dotMat));
  return cube;
}

const cubeGroup = buildCube();
cubeGroup.visible = params.get("cube") === "1";
turnGroup.add(cubeGroup);

function setCubeVisible(visible) {
  cubeGroup.visible = !!visible;
  cubeBtn?.setAttribute("aria-pressed", String(cubeGroup.visible));
}
setCubeVisible(cubeGroup.visible);
cubeBtn?.addEventListener("click", () => setCubeVisible(!cubeGroup.visible));

async function boot() {
  let normalMap = null;
  try {
    normalMap = await new THREE.TextureLoader().loadAsync("./assets/rose_normal.png");
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  } catch (error) {
    console.warn("petal normal map unavailable", error);
  }

  const petal = (color, roughness, coat) => new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0.0,
    normalMap,
    normalScale: new THREE.Vector2(0.30, 0.30),
    clearcoat: coat,
    clearcoatRoughness: 0.30,
    sheen: 0.42,
    sheenColor: new THREE.Color(0xffd6e2),
    sheenRoughness: 0.62,
    emissive: new THREE.Color(0x241015),
    emissiveIntensity: 0.12,
    envMapIntensity: 0.46,
    side: THREE.FrontSide,
  });
  const materials = {
    Pastel_Rose_Inner: petal(0xab5b72, 0.47, 0.26),
    Pastel_Rose_Mid: petal(0xbf7086, 0.44, 0.30),
    Pastel_Rose_Outer: petal(0xd58fa3, 0.41, 0.33),
    Pastel_Calyx: new THREE.MeshPhysicalMaterial({
      color: 0x5d7842, roughness: 0.56, clearcoat: 0.12,
      sheen: 0.35, sheenColor: new THREE.Color(0xcddcae), sheenRoughness: 0.6,
      envMapIntensity: 0.45,
    }),
    Pastel_Leaf: new THREE.MeshPhysicalMaterial({
      color: 0x637f48, roughness: 0.55, clearcoat: 0.12,
      sheen: 0.42, sheenColor: new THREE.Color(0xd7e5bb), sheenRoughness: 0.58,
      envMapIntensity: 0.46,
    }),
    Pastel_Stem: new THREE.MeshPhysicalMaterial({
      color: 0x5b7742, roughness: 0.56, clearcoat: 0.10,
      sheen: 0.26, sheenColor: new THREE.Color(0xc9d9a9), sheenRoughness: 0.62,
      envMapIntensity: 0.42,
    }),
    Pastel_Vein: new THREE.MeshStandardMaterial({
      color: 0xb2c584, roughness: 0.44, metalness: 0.0, envMapIntensity: 0.6,
    }),
    Pastel_Ribbon: new THREE.MeshPhysicalMaterial({
      color: 0xe0a0b1, roughness: 0.30, metalness: 0.0,
      clearcoat: 0.48, clearcoatRoughness: 0.10,
      sheen: 1.0, sheenColor: new THREE.Color(0xffdde5), sheenRoughness: 0.34,
      envMapIntensity: 1.0,
    }),
  };

  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync("./assets/pink_rose_bouquet.glb");
  } catch (error) {
    showError(error);
    return;
  }
  const model = gltf.scene;
  model.traverse((child) => {
    if (!child.isMesh) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    const next = list.map((m) => materials[m?.name] || m);
    child.material = Array.isArray(child.material) ? next : next[0];
    child.castShadow = true;
    child.receiveShadow = true;
    child.frustumCulled = true;
  });
  turnGroup.add(model);

  const clock = new THREE.Clock();
  function resize() {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  function animate() {
    const delta = Math.min(clock.getDelta(), 0.05);
    if (autoSpin) {
      rotation += delta * 0.085;
      turnGroup.rotation.y = rotation;
    }
    turnGroup.position.y = 0.004 * Math.sin(clock.elapsedTime * 0.35);
    renderer.render(scene, camera);
    if (firstFrame) {
      firstFrame = false;
      loader?.classList.add("is-done");
      window.__pastelReady = true;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  window.__pastel = {
    scene,
    camera,
    renderer,
    turnGroup,
    cube: cubeGroup,
    setRotation: (degrees) => {
      rotation = THREE.MathUtils.degToRad(degrees);
      turnGroup.rotation.y = rotation;
    },
    setAuto: (v) => {
      autoSpin = !!v;
      spinBtn?.setAttribute("aria-pressed", String(autoSpin));
      if (spinLabel) spinLabel.textContent = autoSpin ? "PAUSE MOTION" : "RESUME MOTION";
    },
    setCube: setCubeVisible,
    get ready() { return window.__pastelReady === true; },
  };
}

boot().catch(showError);
