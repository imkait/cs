import * as THREE from "three";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/utils/SkeletonUtils.js";
import { loadArenaMap } from "./map.js";

const PLAYER_HEIGHT = 1.7;
const ENEMY_HEIGHT = PLAYER_HEIGHT;
const PLAYER_RADIUS = 0.33;
const ENEMY_RADIUS = 0.5;
const PLAYER_SPEED = 7;
const ENEMY_SPEED = 1.5;
const ENEMY_STOP_DISTANCE = 7;
const ENEMY_DETECTION_DISTANCE = 14;
const ENEMY_DAMAGE_COOLDOWN = 800;
const ENEMY_FIRE_COOLDOWN = 1800;
const ENEMY_PROJECTILE_SPEED = 12;
const ENEMY_PROJECTILE_DAMAGE = 5;
const BARREL_EXPLOSION_RADIUS = 4.5;
const BARREL_EXPLOSION_DAMAGE = 65;
const MAX_ENEMIES = 10;
const MAX_RENDER_PIXEL_RATIO = 1.75;
const weapons = [
  { name: "手槍", cooldown: 260, damage: 50, color: 0x44eaff, magazineSize: 12, reserveSize: 36, pickupAmount: 18, sound: "shoot1.mp3" },
  { name: "脈衝槍", cooldown: 100, damage: 25, color: 0xffc857, magazineSize: 40, reserveSize: 120, pickupAmount: 60, sound: "gun03.mp3" },
];

const GameState = Object.freeze({
  MENU: "menu",
  PLAYING: "playing",
  PAUSED: "paused",
  GAME_OVER: "gameover",
});

document.addEventListener("mouseup", (event) => {
  if (event.button === 0) isFiring = false;
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050816);
scene.fog = new THREE.Fog(0x050816, 55, 210);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 420);
camera.position.set(0, PLAYER_HEIGHT, 9);
camera.layers.enable(1);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(camera);

function updateRenderQuality() {
  const isSmallScreen = window.innerWidth < 900;
  const pixelRatioLimit = isSmallScreen ? 1.35 : MAX_RENDER_PIXEL_RATIO;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioLimit));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

updateRenderQuality();

scene.add(new THREE.HemisphereLight(0x8db7ff, 0x12091e, 3.2));
const sunLight = new THREE.DirectionalLight(0xdce8ff, 2.4);
sunLight.position.set(28, 46, 18);
scene.add(sunLight);
const fillLight = new THREE.DirectionalLight(0x7f9dff, 0.8);
fillLight.position.set(-32, 24, -26);
scene.add(fillLight);
const blueLight = new THREE.PointLight(0x26c6ff, 30, 28);
blueLight.position.set(-10, 5, 0);
scene.add(blueLight);
const pinkLight = new THREE.PointLight(0xff32a6, 25, 26);
pinkLight.position.set(10, 4, -8);
scene.add(pinkLight);

let arenaMap = null;
let minimapBackground = null;

const player = {
  health: 100,
  score: 0,
  wave: 1,
  yaw: 0,
  pitch: 0,
  velocity: new THREE.Vector3(),
};

const keys = new Set();
const enemies = [];
const explosiveBarrels = [];
const explosionEffects = [];
const explosionEffectPool = [];
const enemyProjectiles = [];
const enemyProjectilePool = [];
const ammoPickups = [];
const reloadSound = new Audio("./bullet.mp3");
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
const gltfLoader = new GLTFLoader();
const blasterModels = [];
let soldierModel;
let soldierAnimations;
let polyhavenAmmoModel;
let weapon;
let muzzleFlash;
let currentWeaponIndex = 0;
let gameRunning = false;
let gameState = GameState.MENU;
let spawnTimer = 0;
let lastDamageAt = 0;
let lastShotAt = 0;
let isFiring = false;
let ammo = weapons.map((weapon) => ({ magazine: weapon.magazineSize, reserve: weapon.reserveSize }));

function loadModel(url, onLoad, label) {
  gltfLoader.load(
    url,
    (gltf) => onLoad(gltf.scene),
    undefined,
    (error) => console.warn(`3D 素材載入失敗：${label}`, error),
  );
}

function createExplosiveBarrel(position) {
  const barrel = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 1.15, 16),
    new THREE.MeshStandardMaterial({
      color: 0xb52d42,
      emissive: 0x4d0616,
      emissiveIntensity: 1.4,
      metalness: 0.65,
      roughness: 0.3,
    }),
  );
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.43, 0.045, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffc857 }),
  );
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.25;
  const warning = new THREE.Mesh(
    new THREE.PlaneGeometry(0.42, 0.28),
    new THREE.MeshBasicMaterial({ color: 0xfff0a3 }),
  );
  warning.position.set(0, 0.05, -0.43);
  barrel.add(body, band, warning);
  barrel.position.set(...position);
  barrel.userData.barrel = barrel;
  barrel.traverse((object) => {
    object.userData.barrel = barrel;
  });
  scene.add(barrel);
  explosiveBarrels.push(barrel);
}

function removeExplosiveBarrel(barrel) {
  scene.remove(barrel);
  const barrelIndex = explosiveBarrels.indexOf(barrel);
  if (barrelIndex >= 0) explosiveBarrels.splice(barrelIndex, 1);
}

function createExplosionEffect(position) {
  const effect = explosionEffectPool.pop() || createExplosionEffectObject();
  const [flash, shockwave] = effect.children;
  flash.material.opacity = 0.95;
  shockwave.material.opacity = 0.9;
  flash.scale.setScalar(1);
  shockwave.scale.setScalar(1);
  effect.position.copy(position);
  effect.userData.life = 0.45;
  scene.add(effect);
  explosionEffects.push(effect);
}

function createExplosionEffectObject() {
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc857, transparent: true, opacity: 0.95 }),
  );
  const shockwave = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.55, 24),
    new THREE.MeshBasicMaterial({ color: 0xff5d3f, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  shockwave.rotation.x = -Math.PI / 2;
  shockwave.position.y = -0.4;
  const effect = new THREE.Group();
  effect.add(flash, shockwave);
  return effect;
}

function explodeBarrel(barrel) {
  const explosionPosition = barrel.position.clone();
  explosionPosition.y += 0.55;
  removeExplosiveBarrel(barrel);
  createExplosionEffect(explosionPosition);
  playSound("./gun03.mp3", 0.8);

  enemies.slice().forEach((enemy) => {
    const distance = enemy.position.distanceTo(explosionPosition);
    if (distance > BARREL_EXPLOSION_RADIUS) return;
    const damage = Math.round(BARREL_EXPLOSION_DAMAGE * (1 - distance / BARREL_EXPLOSION_RADIUS));
    enemy.userData.health = Math.max(0, enemy.userData.health - damage);
    updateEnemyHealthBar(enemy);
    if (enemy.userData.health === 0) {
      removeEnemy(enemy);
      player.score += 100 * player.wave;
    }
  });

  const playerDistance = camera.position.distanceTo(explosionPosition);
  if (playerDistance <= BARREL_EXPLOSION_RADIUS) {
    const damage = Math.round(BARREL_EXPLOSION_DAMAGE * (1 - playerDistance / BARREL_EXPLOSION_RADIUS));
    player.health = Math.max(0, player.health - damage);
    updateHud();
    if (player.health === 0) endGame();
  }
  updateHud();
}

function updateExplosionEffects(delta) {
  explosionEffects.slice().forEach((effect) => {
    effect.userData.life -= delta;
    const progress = 1 - effect.userData.life / 0.45;
    effect.children[0].scale.setScalar(1 + progress * 4);
    effect.children[0].material.opacity = 0.95 * (1 - progress);
    effect.children[1].scale.setScalar(1 + progress * 7);
    effect.children[1].material.opacity = 0.9 * (1 - progress);
    if (effect.userData.life <= 0) {
      scene.remove(effect);
      explosionEffects.splice(explosionEffects.indexOf(effect), 1);
      explosionEffectPool.push(effect);
    }
  });
}

function fitModel(model, size) {
  const bounds = new THREE.Box3().setFromObject(model);
  const dimensions = bounds.getSize(new THREE.Vector3());
  const scale = Math.min(
    size[0] / Math.max(dimensions.x, 0.001),
    size[1] / Math.max(dimensions.y, 0.001),
    size[2] / Math.max(dimensions.z, 0.001),
  );
  model.scale.setScalar(scale);
  const fittedBounds = new THREE.Box3().setFromObject(model);
  model.position.y -= fittedBounds.min.y;
}

function fitEnemyModel(model, height) {
  // SkinnedMesh updates its inverse bind matrix in updateMatrixWorld.
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  const currentHeight = bounds.max.y - bounds.min.y;
  const scale = height / Math.max(currentHeight, 0.001);
  model.scale.multiplyScalar(scale);
  model.position.y = (model.position.y - bounds.min.y) * scale;
}

function findEnemySpawnPosition() {
  if (!arenaMap) return new THREE.Vector3(0, 0, -20);
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const candidate = arenaMap.randomWalkablePoint(0.7, {
      avoid: camera.position,
      minDistance: 13,
    });
    if (
      candidate
      && candidate.distanceTo(camera.position) >= 13
      && arenaMap.canStand(candidate.x, candidate.z, 0.5)
    ) {
      return candidate;
    }
  }
  return arenaMap.randomWalkablePoint(0.7) || new THREE.Vector3(0, 0, -20);
}

async function loadSoldier() {
  try {
    const { scene, animations } = await gltfLoader.loadAsync("./assets/Soldier.glb");
    const walk = THREE.AnimationClip.findByName(animations, "walk");
    const shoot = THREE.AnimationClip.findByName(animations, "shoot");

    // The armature's local Y axis points forward in the world.
    const hipsPosition = walk.tracks.find((track) => track.name === "mixamorigHips.position");
    for (let i = 1; i < hipsPosition.values.length; i += 3) {
      hipsPosition.values[i] = hipsPosition.values[1];
    }

    const idle = THREE.AnimationUtils.subclip(shoot, "idle", 0, 2, 24);
    idle.duration = 1;
    fitEnemyModel(scene, ENEMY_HEIGHT);
    soldierAnimations = [idle, walk, shoot];
    soldierModel = scene;
  } catch (error) {
    console.warn("敵人模型載入失敗：Soldier.glb", error);
  }
}

function loadGameAssets() {
  loadModel("./assets/polyhaven/ammo_box/ammo_box.gltf", (model) => {
    polyhavenAmmoModel = model;
  }, "Poly Haven ammo_box");
  ["blaster-a", "blaster-b"].forEach((name, index) => {
    gltfLoader.load(
      `./assets/kenney/blaster-kit/Models/GLB format/${name}.glb`,
      (gltf) => {
        blasterModels[index] = gltf.scene;
        if (weapon) updateWeaponAppearance();
      },
      undefined,
      (error) => console.warn(`武器模型載入失敗：${name}`, error),
    );
  });
}

function setEnemyAnimation(enemy, name, loop = THREE.LoopRepeat) {
  const action = enemy.userData.actions?.[name];
  if (!action || enemy.userData.currentAnimation === name) return;
  const previousAction = enemy.userData.currentAnimation
    ? enemy.userData.actions[enemy.userData.currentAnimation]
    : null;
  action.reset();
  action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
  action.clampWhenFinished = loop === THREE.LoopOnce;
  action.fadeIn(0.12).play();
  if (previousAction && previousAction !== action) previousAction.fadeOut(0.12);
  enemy.userData.currentAnimation = name;
}

function playSound(source, volume = 0.6) {
  const sound = new Audio(source);
  sound.volume = volume;
  sound.play().catch((error) => {
    console.warn(`音效播放失敗：${source}`, error);
  });
}

const healthElement = document.querySelector("#health");
const playerHealthFill = document.querySelector("#player-health-fill");
const scoreElement = document.querySelector("#score");
const enemyCountElement = document.querySelector("#enemy-count");
const waveElement = document.querySelector("#wave");
const weaponNameElement = document.querySelector("#weapon-name");
const ammoCountElement = document.querySelector("#ammo-count");
const startScreen = document.querySelector("#start-screen");
const startButton = document.querySelector("#start-button");
const gameOverScreen = document.querySelector("#game-over-screen");
const pauseScreen = document.querySelector("#pause-screen");
const finalScoreElement = document.querySelector("#final-score");
const noticeElement = document.querySelector("#notice");
const minimap = document.querySelector("#minimap");
const minimapContext = minimap.getContext("2d");

function createArenaBackdrop() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x080d1c, roughness: 1, metalness: 0.08 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  scene.add(ground);
}

function createArenaAccents(map) {
  const { bounds } = map;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.15, 0.035, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0x58f0d0 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(map.spawnPoint).setY(map.spawnPoint.y + 0.04);
  scene.add(ring);

  const cornerMaterialA = new THREE.MeshBasicMaterial({ color: 0x26c6ff });
  const cornerMaterialB = new THREE.MeshBasicMaterial({ color: 0xff32a6 });
  [
    [bounds.minX + 0.6, bounds.minZ + 0.6, cornerMaterialA],
    [bounds.maxX - 0.6, bounds.minZ + 0.6, cornerMaterialB],
    [bounds.minX + 0.6, bounds.maxZ - 0.6, cornerMaterialB],
    [bounds.maxX - 0.6, bounds.maxZ - 0.6, cornerMaterialA],
  ].forEach(([x, z, material]) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), material);
    post.position.set(x, map.groundAt(x, z) + 1.3, z);
    scene.add(post);
  });

  blueLight.position.set(bounds.minX + 4, 6, bounds.minZ + 4);
  pinkLight.position.set(bounds.maxX - 4, 5, bounds.maxZ - 4);
}

async function setupArenaMap(soldierReady) {
  createArenaBackdrop();
  startScreen.classList.remove("hidden");
  startButton.disabled = true;
  startButton.textContent = "載入地圖中…";

  try {
    arenaMap = await loadArenaMap({
      onProgress: (progress) => {
        startButton.textContent = `載入地圖中… ${Math.round(progress * 100)}%`;
      },
    });
    scene.add(arenaMap.root);
    minimapBackground = arenaMap.createMinimapBackground(minimap.width);
    createArenaAccents(arenaMap);
    moveCameraToSpawn();
    startButton.textContent = "準備敵人模型…";
    await soldierReady;
    startButton.disabled = false;
    startButton.textContent = "開始遊戲";
    noticeElement.textContent = "地圖載入完成，點擊「開始遊戲」鎖定滑鼠";
  } catch (error) {
    console.warn("地圖載入失敗", error);
    startButton.textContent = "地圖載入失敗";
    noticeElement.textContent = "地圖載入失敗，請確認 arena_standoff_2.glb 是否存在";
  }
}

function moveCameraToSpawn() {
  if (!arenaMap) return;
  const spawn = arenaMap.spawnPoint;
  player.yaw = aimYawFromSpawn();
  player.pitch = 0;
  camera.position.set(spawn.x, spawn.y + PLAYER_HEIGHT, spawn.z);
  camera.rotation.set(0, player.yaw, 0, "YXZ");
}

function aimYawFromSpawn() {
  if (!arenaMap) return 0;
  return arenaMap.spawnYaw ?? 0;
}

function createAmmoPickup(position) {
  const pickup = new THREE.Group();
  if (polyhavenAmmoModel) {
    const ammoBox = polyhavenAmmoModel.clone(true);
    fitModel(ammoBox, [0.8, 0.8, 0.8]);
    ammoBox.position.y = 0.15;
    pickup.add(ammoBox);
  } else {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({
      color: 0x58f0d0,
      emissive: 0x087d71,
      emissiveIntensity: 2,
      metalness: 0.4,
      roughness: 0.25,
    }),
  );
  const crossHorizontal = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  const crossVertical = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.48, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  pickup.add(body, crossHorizontal, crossVertical);
  }
  pickup.position.set(...position);
  pickup.userData.baseY = pickup.position.y;
  scene.add(pickup);
  ammoPickups.push(pickup);
}

function updateAmmoPickups(elapsed) {
  ammoPickups.slice().forEach((pickup) => {
    pickup.rotation.y = elapsed * 1.8;
    pickup.position.y = pickup.userData.baseY + Math.sin(elapsed * 3 + pickup.id) * 0.12;
    if (pickup.position.distanceTo(camera.position) < 1.4) {
      const selectedWeapon = weapons[currentWeaponIndex];
      ammo[currentWeaponIndex].reserve = Math.min(
        selectedWeapon.reserveSize,
        ammo[currentWeaponIndex].reserve + selectedWeapon.pickupAmount,
      );
      scene.remove(pickup);
      ammoPickups.splice(ammoPickups.indexOf(pickup), 1);
      updateAmmoHud();
      noticeElement.textContent = `${selectedWeapon.name} 補充彈藥`;
      window.setTimeout(() => {
        if (gameState === GameState.PLAYING) noticeElement.textContent = "WASD 移動 ・ 左鍵射擊 ・ 右鍵換武器";
      }, 900);
    }
  });
}

function createWeapon() {
  weapon = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x172b52,
    metalness: 0.85,
    roughness: 0.25,
    emissive: 0x081b42,
    emissiveIntensity: 1.4,
  });
  const accentMaterial = new THREE.MeshBasicMaterial({ color: weapons[currentWeaponIndex].color });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.8), bodyMaterial);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.45, 8), bodyMaterial);
  const accent = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.55), accentMaterial);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, 0.16), bodyMaterial);
  barrel.rotation.x = Math.PI / 2;
  body.position.z = -0.2;
  barrel.position.set(0, 0.02, -0.78);
  accent.position.set(0, 0.1, -0.22);
  grip.position.set(0, -0.22, -0.04);
  weapon.add(body, barrel, accent, grip);
  weapon.userData.fallbackParts = [body, barrel, accent, grip];
  weapon.userData.modelRoots = [];
  weapon.position.set(0.52, -0.38, -0.78);
  weapon.rotation.set(-0.08, -0.08, 0.02);
  camera.add(weapon);

  muzzleFlash = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff2a6, transparent: true, opacity: 0 }),
  );
  muzzleFlash.position.set(0, 0.02, -1.02);
  weapon.add(muzzleFlash);
}

function updateWeaponAppearance() {
  if (!weapon) return;
  weapon.userData.fallbackParts.forEach((part) => {
    part.visible = blasterModels[currentWeaponIndex] === undefined;
  });
  if (blasterModels[currentWeaponIndex] && !weapon.userData.modelRoots[currentWeaponIndex]) {
    const model = blasterModels[currentWeaponIndex].clone(true);
    fitModel(model, [0.7, 0.35, 1.15]);
    model.position.set(0, -0.08, -0.2);
    model.rotation.set(0, Math.PI, 0);
    weapon.userData.modelRoots[currentWeaponIndex] = model;
    weapon.add(model);
  }
  weapon.userData.modelRoots.forEach((model, index) => {
    if (model) model.visible = index === currentWeaponIndex;
  });
  const accent = weapon.userData.fallbackParts[2];
  accent.material.color.setHex(weapons[currentWeaponIndex].color);
  weaponNameElement.textContent = weapons[currentWeaponIndex].name;
  updateAmmoHud();
}

function updateAmmoHud() {
  const selectedAmmo = ammo[currentWeaponIndex];
  ammoCountElement.textContent = `彈匣 ${selectedAmmo.magazine} / 備用 ${selectedAmmo.reserve}`;
  ammoCountElement.style.color = selectedAmmo.magazine === 0 ? "#ff5d5d" : "";
}

function reloadWeapon() {
  if (gameState !== GameState.PLAYING) return;
  const selectedWeapon = weapons[currentWeaponIndex];
  const selectedAmmo = ammo[currentWeaponIndex];
  const missingRounds = selectedWeapon.magazineSize - selectedAmmo.magazine;
  if (missingRounds <= 0) {
    noticeElement.textContent = "彈匣已滿，不需要換彈";
    return;
  }
  if (selectedAmmo.reserve <= 0) {
    noticeElement.textContent = "沒有備用子彈，無法換彈";
    return;
  }

  const loaded = Math.min(missingRounds, selectedAmmo.reserve);
  selectedAmmo.magazine += loaded;
  selectedAmmo.reserve -= loaded;
  updateAmmoHud();
  reloadSound.currentTime = 0;
  reloadSound.volume = 0.7;
  reloadSound.play().catch((error) => {
    console.warn("換彈音效播放失敗：bullet.mp3", error);
  });
  noticeElement.textContent = `已裝填 ${loaded} 發`;
}

function switchWeapon() {
  if (gameState !== GameState.PLAYING) return;
  currentWeaponIndex = (currentWeaponIndex + 1) % weapons.length;
  updateWeaponAppearance();
  updateAmmoHud();
  noticeElement.textContent = `已切換至${weapons[currentWeaponIndex].name}`;
  window.setTimeout(() => {
    if (gameState === GameState.PLAYING) noticeElement.textContent = "WASD 移動 ・ 左鍵射擊 ・ 右鍵換武器";
  }, 900);
}

function createEnemy() {
  const enemy = new THREE.Group();
  if (soldierModel) {
    const character = SkeletonUtils.clone(soldierModel);
    character.traverse((object) => {
      object.userData.enemy = enemy;
    });
    enemy.add(character);
    enemy.userData.hitboxSource = character;

    const mixer = new THREE.AnimationMixer(character);
    enemy.userData.mixer = mixer;
    enemy.userData.actions = Object.fromEntries(
      soldierAnimations.map((clip) => [clip.name, mixer.clipAction(clip)]),
    );
    enemy.userData.currentAnimation = "idle";
    enemy.userData.actions.idle.play();
    mixer.update(0);
    enemy.updateMatrixWorld(true);
  } else {
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.75, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xff286f,
      emissive: 0x8f073a,
      emissiveIntensity: 2.2,
      roughness: 0.3,
    }),
  );
  body.position.y = 0.75;
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff6a1 }),
  );
  eye.position.set(0, 0.9, -0.67);
  enemy.add(body, eye);
  }
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.94, 0.035, 6, 24),
    new THREE.MeshBasicMaterial({ color: 0xff4b9b }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  enemy.add(ring);

  const healthBar = new THREE.Group();
  const healthBarBackground = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.14),
    new THREE.MeshBasicMaterial({ color: 0x210b1b }),
  );
  const healthBarFill = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.14),
    new THREE.MeshBasicMaterial({ color: 0xff3f87 }),
  );
  healthBarFill.position.z = 0.01;
  healthBar.add(healthBarBackground, healthBarFill);
  const enemyBounds = new THREE.Box3().setFromObject(enemy);
  healthBar.position.y = enemyBounds.max.y - enemy.position.y + 0.25;
  healthBar.userData.fill = healthBarFill;
  healthBar.userData.billboard = true;
  healthBar.traverse((object) => object.layers.set(1));
  enemy.add(healthBar);

  enemy.position.copy(findEnemySpawnPosition());
  enemy.userData.health = 100;
  enemy.userData.maxHealth = 100;
  enemy.userData.healthBar = healthBar;
  enemy.userData.lastShotAt = performance.now() + Math.random() * ENEMY_FIRE_COOLDOWN;
  enemy.userData.attackUntil = 0;
  enemy.userData.wanderTarget = arenaMap
    ? arenaMap.randomWalkablePoint(0.7)
    : new THREE.Vector3(0, 0, 0);
  enemy.userData.wanderUntil = performance.now() + THREE.MathUtils.randFloat(1800, 4200);
  enemy.userData.stuckTime = 0;
  scene.add(enemy);
  enemies.push(enemy);
  updateHud();
}

function spawnWave() {
  const enemyTotal = Math.min(2 + player.wave, MAX_ENEMIES);
  for (let i = 0; i < enemyTotal; i += 1) createEnemy();
}

function removeEnemy(enemy) {
  enemy.userData.mixer?.stopAllAction();
  scene.remove(enemy);
  const index = enemies.indexOf(enemy);
  if (index >= 0) enemies.splice(index, 1);
  updateHud();
}

function hasLineOfSight(from, to) {
  if (!arenaMap) return true;
  return !arenaMap.segmentBlocked(from.x, from.z, to.x, to.z);
}

function fireEnemyProjectile(enemy) {
  const origin = enemy.position.clone();
  origin.y += 0.1;
  const target = camera.position.clone();
  if (!hasLineOfSight(origin, target)) return;

  const projectile = enemyProjectilePool.pop() || new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffc857 }),
  );
  projectile.position.copy(origin);
  projectile.userData.velocity = target.sub(origin).normalize().multiplyScalar(ENEMY_PROJECTILE_SPEED);
  projectile.userData.damage = ENEMY_PROJECTILE_DAMAGE;
  projectile.userData.life = 4;
  scene.add(projectile);
  enemyProjectiles.push(projectile);
  enemy.userData.attackUntil = performance.now() + 700;
  setEnemyAnimation(enemy, "shoot", THREE.LoopOnce);
}

function removeEnemyProjectile(projectile) {
  scene.remove(projectile);
  const index = enemyProjectiles.indexOf(projectile);
  if (index >= 0) enemyProjectiles.splice(index, 1);
  enemyProjectilePool.push(projectile);
}

function updateEnemyProjectiles(delta) {
  enemyProjectiles.slice().forEach((projectile) => {
    const movement = projectile.userData.velocity.clone().multiplyScalar(delta);
    const nextPosition = projectile.position.clone().add(movement);
    if (arenaMap) {
      const blockedAt = arenaMap.rayBlockedDistance(
        projectile.position.x,
        projectile.position.z,
        nextPosition.x,
        nextPosition.z,
      );
      if (blockedAt !== null && blockedAt <= movement.length()) {
        removeEnemyProjectile(projectile);
        return;
      }
    }

    projectile.position.copy(nextPosition);
    projectile.userData.life -= delta;
    if (projectile.position.distanceTo(camera.position) < 0.7) {
      player.health = Math.max(0, player.health - projectile.userData.damage);
      updateHud();
      showDamageFeedback();
      removeEnemyProjectile(projectile);
      if (player.health === 0) endGame();
    } else if (projectile.userData.life <= 0) {
      removeEnemyProjectile(projectile);
    }
  });
}

function showDamageFeedback() {
  document.body.classList.add("damage-flash");
  window.setTimeout(() => document.body.classList.remove("damage-flash"), 140);
}

function shoot() {
  const selectedWeapon = weapons[currentWeaponIndex];
  const selectedAmmo = ammo[currentWeaponIndex];
  if (
    gameState !== GameState.PLAYING ||
    performance.now() - lastShotAt < selectedWeapon.cooldown
  ) return;
  if (selectedAmmo.magazine <= 0) {
    noticeElement.textContent = "彈匣已空，按 R 換彈";
    return;
  }
  lastShotAt = performance.now();
  selectedAmmo.magazine -= 1;
  updateAmmoHud();
  playSound(`./${selectedWeapon.sound}`, selectedWeapon === weapons[1] ? 0.42 : 0.55);
  muzzleFlash.material.opacity = 1;
  window.setTimeout(() => {
    if (muzzleFlash) muzzleFlash.material.opacity = 0;
  }, 55);

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const enemyHits = raycaster.intersectObjects(enemies, true);
  const hitboxHits = enemies
    .map((enemy) => {
      const bounds = new THREE.Box3().setFromObject(enemy.userData.hitboxSource || enemy);
      const point = raycaster.ray.intersectBox(bounds, new THREE.Vector3());
      return point
        ? { enemy, distance: point.distanceTo(raycaster.ray.origin) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
  const barrelHits = raycaster.intersectObjects(explosiveBarrels, true);
  const barrelHit = barrelHits[0];
  const enemyHitDistance = Math.min(
    hitboxHits[0]?.distance ?? Infinity,
    enemyHits[0]?.distance ?? Infinity,
  );
  const barrelDistance = barrelHit ? barrelHit.distance : Infinity;

  let wallDistance = Infinity;
  if (arenaMap) {
    const direction = raycaster.ray.direction;
    const horizontal = Math.hypot(direction.x, direction.z);
    if (horizontal > 1e-4) {
      const origin = raycaster.ray.origin;
      const blocked = arenaMap.rayBlockedDistance(
        origin.x,
        origin.z,
        origin.x + (direction.x / horizontal) * 240,
        origin.z + (direction.z / horizontal) * 240,
      );
      if (blocked !== null) wallDistance = blocked / horizontal;
    }
  }

  if (barrelHit && barrelDistance <= wallDistance && barrelDistance <= enemyHitDistance) {
    explodeBarrel(barrelHit.object.userData.barrel);
    return;
  }
  if (enemyHitDistance === Infinity || enemyHitDistance > wallDistance) return;

  const enemy = hitboxHits[0]?.enemy
    || enemyHits[0]?.object.userData.enemy
    || enemyHits[0]?.object.parent;
  if (!enemy || !enemy.userData.health) return;
  enemy.userData.health = Math.max(0, enemy.userData.health - selectedWeapon.damage);
  updateEnemyHealthBar(enemy);
  if (enemy.userData.health === 0) {
    removeEnemy(enemy);
    player.score += 100 * player.wave;
  }
  updateHud();
  document.body.classList.add("hit-confirmed");
  window.setTimeout(() => document.body.classList.remove("hit-confirmed"), 80);
}

function updateEnemyHealthBar(enemy) {
  const healthBar = enemy.userData.healthBar;
  if (!healthBar) return;
  const ratio = enemy.userData.health / enemy.userData.maxHealth;
  healthBar.userData.fill.scale.x = ratio;
  healthBar.userData.fill.position.x = -0.85 * (1 - ratio);
  healthBar.userData.fill.material.color.set(ratio < 0.35 ? 0xff5d5d : 0xff3f87);
}

function updatePlayer(delta) {
  const direction = new THREE.Vector3();
  if (keys.has("KeyW")) direction.z -= 1;
  if (keys.has("KeyS")) direction.z += 1;
  if (keys.has("KeyA")) direction.x -= 1;
  if (keys.has("KeyD")) direction.x += 1;
  direction.normalize();

  const movement = direction.multiplyScalar(PLAYER_SPEED * delta);
  movement.applyAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw);
  movePlayerWithSlide(movement);
  if (arenaMap) {
    camera.position.y = arenaMap.groundAt(camera.position.x, camera.position.z) + PLAYER_HEIGHT;
  } else {
    camera.position.y = PLAYER_HEIGHT;
  }
}

/** 玩家撞牆時沿牆面切線滑行，避免在牆角或窄縫前卡住 */
function movePlayerWithSlide(movement) {
  // 拆成小步，斜向貼牆時才不會整步被擋掉
  const steps = Math.max(1, Math.ceil(movement.length() / 0.08));
  const step = movement.clone().divideScalar(steps);
  for (let i = 0; i < steps; i += 1) {
    if (!movePlayerStep(step)) break;
  }
}

function movePlayerStep(step) {
  const nextPosition = camera.position.clone().add(step);
  if (!collidesWithObstacle(nextPosition, PLAYER_RADIUS)) {
    camera.position.copy(nextPosition);
    return true;
  }

  // 沿最近牆面的切線滑行（牆面是斜的也能順著滑進窄縫）
  if (arenaMap) {
    const wall = arenaMap.nearestWall(camera.position.x, camera.position.z, 1.2);
    if (wall) {
      const tangentX = -wall.nz;
      const tangentZ = wall.nx;
      const along = step.x * tangentX + step.z * tangentZ;
      if (Math.abs(along) > 1e-4) {
        const slid = camera.position.clone();
        slid.x += tangentX * along;
        slid.z += tangentZ * along;
        if (!collidesWithObstacle(slid, PLAYER_RADIUS)) {
          camera.position.copy(slid);
          return true;
        }
      }
    }
  }

  const slideX = camera.position.clone();
  slideX.x += step.x;
  if (!collidesWithObstacle(slideX, PLAYER_RADIUS)) {
    camera.position.copy(slideX);
    return true;
  }
  const slideZ = camera.position.clone();
  slideZ.z += step.z;
  if (!collidesWithObstacle(slideZ, PLAYER_RADIUS)) {
    camera.position.copy(slideZ);
    return true;
  }
  return false;
}

function collidesWithObstacle(position, radius) {
  const x = position.x;
  const z = position.z;
  if (arenaMap) {
    if (!arenaMap.canStand(x, z, radius)) return true;
  }
  return explosiveBarrels.some((barrel) => {
    const dx = barrel.position.x - x;
    const dz = barrel.position.z - z;
    return Math.hypot(dx, dz) < radius + 0.45;
  });
}

/** 敵人移動遇牆時嘗試單軸滑動，避免卡在轉角 */
function moveEnemyWithSlide(enemy, stepX, stepZ) {
  const radius = ENEMY_RADIUS;
  const tryMove = (dx, dz) => {
    if (Math.abs(dx) + Math.abs(dz) < 1e-5) return false;
    const position = { x: enemy.position.x + dx, z: enemy.position.z + dz };
    if (collidesWithObstacle(position, radius)) return false;
    enemy.position.x = position.x;
    enemy.position.z = position.z;
    return true;
  };
  if (tryMove(stepX, stepZ)) return true;
  if (arenaMap) {
    const wall = arenaMap.nearestWall(enemy.position.x, enemy.position.z, 1.2);
    if (wall) {
      const tangentX = -wall.nz;
      const tangentZ = wall.nx;
      const along = stepX * tangentX + stepZ * tangentZ;
      if (tryMove(tangentX * along, tangentZ * along)) return true;
    }
  }
  return tryMove(stepX, 0) || tryMove(0, stepZ);
}

function updateEnemies(delta) {
  enemies.forEach((enemy) => {
    enemy.userData.mixer?.update(delta);
    const toPlayer = camera.position.clone().sub(enemy.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();
    const now = performance.now();
    const isChasing = distance <= ENEMY_DETECTION_DISTANCE;
    if (!isChasing && now >= enemy.userData.wanderUntil) {
      enemy.userData.wanderTarget = arenaMap
        ? arenaMap.randomWalkablePoint(0.7)
        : new THREE.Vector3(0, 0, 0);
      enemy.userData.wanderUntil = now + THREE.MathUtils.randFloat(1800, 4200);
    }
    const movementTarget = isChasing
      ? camera.position
      : enemy.userData.wanderTarget;
    const direction = movementTarget.clone().sub(enemy.position);
    direction.y = 0;
    const targetDistance = direction.length();
    let moved = false;
    if ((isChasing && distance > ENEMY_STOP_DISTANCE) || (!isChasing && targetDistance > 0.4)) {
      direction.normalize();
      moved = moveEnemyWithSlide(
        enemy,
        direction.x * ENEMY_SPEED * delta,
        direction.z * ENEMY_SPEED * delta,
      );
    }
    enemy.userData.stuckTime = moved ? 0 : enemy.userData.stuckTime + delta;
    if (!isChasing && enemy.userData.stuckTime > 2) {
      enemy.userData.stuckTime = 0;
      enemy.userData.wanderTarget = arenaMap
        ? arenaMap.randomWalkablePoint(0.7)
        : new THREE.Vector3(0, 0, 0);
      enemy.userData.wanderUntil = now + THREE.MathUtils.randFloat(1800, 4200);
    }
    if (moved) {
      enemy.lookAt(
        movementTarget.x,
        enemy.position.y,
        movementTarget.z,
      );
    }
    if (arenaMap) {
      enemy.position.y = arenaMap.groundAt(enemy.position.x, enemy.position.z);
    } else {
      enemy.position.y = 0;
    }
    enemy.userData.healthBar.lookAt(camera.position);
    if (performance.now() >= enemy.userData.attackUntil) {
      setEnemyAnimation(enemy, moved ? "walk" : "idle");
    }

    if (
      performance.now() - enemy.userData.lastShotAt > ENEMY_FIRE_COOLDOWN &&
      distance < 20 &&
      hasLineOfSight(enemy.position, camera.position)
    ) {
      enemy.userData.lastShotAt = performance.now();
      fireEnemyProjectile(enemy);
    }

    if (distance < 1.5 && performance.now() - lastDamageAt > ENEMY_DAMAGE_COOLDOWN) {
      lastDamageAt = performance.now();
      player.health = Math.max(0, player.health - 10);
      updateHud();
      showDamageFeedback();
      if (player.health === 0) endGame();
    }
  });
}

function updateHud() {
  healthElement.textContent = String(player.health);
  playerHealthFill.style.width = `${player.health}%`;
  playerHealthFill.style.background =
    player.health < 30 ? "#ff3f87" : "linear-gradient(90deg, #ff3f87, #58f0d0)";
  scoreElement.textContent = String(player.score);
  enemyCountElement.textContent = String(enemies.length);
  waveElement.textContent = String(player.wave);
}

function drawMinimap() {
  const width = minimap.width;
  const height = minimap.height;

  minimapContext.clearRect(0, 0, width, height);
  if (minimapBackground) {
    minimapContext.drawImage(minimapBackground, 0, 0, width, height);
  } else {
    minimapContext.fillStyle = "#071126";
    minimapContext.fillRect(0, 0, width, height);
  }

  let toMapX = (x) => x;
  let toMapZ = (z) => z;
  if (arenaMap) {
    const { bounds } = arenaMap;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    const scale = (width - 12) / span;
    const offsetX = width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    const offsetZ = height / 2 - ((bounds.minZ + bounds.maxZ) / 2) * scale;
    toMapX = (x) => x * scale + offsetX;
    toMapZ = (z) => z * scale + offsetZ;
  }

  explosiveBarrels.forEach((barrel) => {
    minimapContext.fillStyle = "#ffc857";
    minimapContext.beginPath();
    minimapContext.arc(toMapX(barrel.position.x), toMapZ(barrel.position.z), 3, 0, Math.PI * 2);
    minimapContext.fill();
  });

  ammoPickups.forEach((pickup) => {
    minimapContext.fillStyle = "#58f0d0";
    minimapContext.fillRect(toMapX(pickup.position.x) - 2, toMapZ(pickup.position.z) - 2, 4, 4);
  });

  enemies.forEach((enemy) => {
    if (enemy.userData.healthBar?.userData.billboard) {
      enemy.userData.healthBar.quaternion.copy(camera.quaternion);
    }
    minimapContext.fillStyle = "#ff3f87";
    minimapContext.shadowColor = "#ff3f87";
    minimapContext.shadowBlur = 8;
    minimapContext.beginPath();
    minimapContext.arc(toMapX(enemy.position.x), toMapZ(enemy.position.z), 4, 0, Math.PI * 2);
    minimapContext.fill();
  });

  minimapContext.shadowBlur = 0;
  minimapContext.fillStyle = "#58f0d0";
  minimapContext.beginPath();
  minimapContext.arc(toMapX(camera.position.x), toMapZ(camera.position.z), 5, 0, Math.PI * 2);
  minimapContext.fill();
  minimapContext.strokeStyle = "#58f0d0";
  minimapContext.lineWidth = 2;
  minimapContext.beginPath();
  minimapContext.moveTo(toMapX(camera.position.x), toMapZ(camera.position.z));
  minimapContext.lineTo(
    toMapX(camera.position.x - Math.sin(player.yaw) * 1.8),
    toMapZ(camera.position.z - Math.cos(player.yaw) * 1.8),
  );
  minimapContext.stroke();
}

function placeBarrels() {
  const spots = [];
  for (let i = 0; i < 8 && spots.length < 4; i += 1) {
    // 只放在空曠處，避免爆炸桶把窄通道整個堵住
    const point = arenaMap.randomWalkablePoint(1.1, {
      avoid: arenaMap.spawnPoint,
      minDistance: 7,
    });
    if (point.distanceTo(arenaMap.spawnPoint) < 6) continue;
    if (!arenaMap.canStand(point.x, point.z, 0.5)) continue;
    const tooClose = spots.some((spot) => spot.distanceTo(point) < 7);
    if (tooClose) continue;
    spots.push(point);
    createExplosiveBarrel([point.x, point.y + 0.6, point.z]);
  }
}

function placeAmmoPickups() {
  const spots = [];
  for (let i = 0; i < 4; i += 1) {
    const point = arenaMap.randomWalkablePoint(0.8, {
      avoid: arenaMap.spawnPoint,
      minDistance: 5,
    });
    if (!arenaMap.canStand(point.x, point.z, 0.4)) continue;
    const tooClose = spots.some((spot) => spot.distanceTo(point) < 6);
    if (tooClose) continue;
    spots.push(point);
    createAmmoPickup([point.x, point.y + 0.5, point.z]);
  }
}

function resetGame() {
  if (!arenaMap) return;
  enemies.splice(0).forEach((enemy) => scene.remove(enemy));
  explosiveBarrels.slice().forEach((barrel) => removeExplosiveBarrel(barrel));
  explosionEffects.splice(0).forEach((effect) => {
    scene.remove(effect);
    explosionEffectPool.push(effect);
  });
  enemyProjectiles.slice().forEach((projectile) => removeEnemyProjectile(projectile));
  ammoPickups.splice(0).forEach((pickup) => scene.remove(pickup));
  player.health = 100;
  player.score = 0;
  player.wave = 1;
  moveCameraToSpawn();
  spawnTimer = 0;
  lastDamageAt = 0;
  lastShotAt = 0;
  isFiring = false;
  ammo = weapons.map((weapon) => ({ magazine: weapon.magazineSize, reserve: weapon.reserveSize }));
  gameOverScreen.classList.add("hidden");
  pauseScreen.classList.add("hidden");
  startScreen.classList.add("hidden");
  gameRunning = true;
  gameState = GameState.PLAYING;
  updateHud();
  spawnWave();
  placeBarrels();
  placeAmmoPickups();
  document.body.requestPointerLock();
}

function endGame() {
  gameRunning = false;
  gameState = GameState.GAME_OVER;
  finalScoreElement.textContent = String(player.score);
  gameOverScreen.classList.remove("hidden");
  document.exitPointerLock();
}

function togglePause() {
  if (gameState === GameState.PLAYING) {
    gameState = GameState.PAUSED;
    pauseScreen.classList.remove("hidden");
    document.exitPointerLock();
  } else if (gameState === GameState.PAUSED) {
    resumeGame();
  }
}

function resumeGame() {
  gameState = GameState.PLAYING;
  pauseScreen.classList.add("hidden");
  document.body.requestPointerLock();
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  if (gameState === GameState.PLAYING) {
    updatePlayer(delta);
    updateEnemies(delta);
    updateEnemyProjectiles(delta);
    updateAmmoPickups(elapsed);
    updateExplosionEffects(delta);
    if (isFiring) shoot();
    if (weapon) {
      weapon.position.y = -0.34 + Math.sin(elapsed * 4) * 0.006;
      weapon.rotation.z = 0.02 + Math.sin(elapsed * 3) * 0.006;
    }
    spawnTimer += delta;
    if (enemies.length === 0 && spawnTimer > 1) {
      player.wave += 1;
      spawnTimer = 0;
      spawnWave();
      updateHud();
    }
  }

  renderer.render(scene, camera);
  drawMinimap();
}

document.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "KeyR") reloadWeapon();
  if (event.code === "Escape" && gameState === GameState.PLAYING) {
    togglePause();
  }
});

document.addEventListener("keyup", (event) => keys.delete(event.code));
document.addEventListener("mousedown", (event) => {
  if (event.button === 0 && gameState === GameState.PLAYING) {
    isFiring = true;
    shoot();
  }
  if (event.button === 2) {
    event.preventDefault();
    switchWeapon();
  }
});

document.addEventListener("contextmenu", (event) => event.preventDefault());

document.addEventListener("mousemove", (event) => {
  if (gameState !== GameState.PLAYING || document.pointerLockElement !== document.body) return;
  player.yaw -= event.movementX * 0.002;
  player.pitch -= event.movementY * 0.002;
  player.pitch = THREE.MathUtils.clamp(player.pitch, -Math.PI / 2.2, Math.PI / 2.2);
  camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
});

document.addEventListener("pointerlockchange", () => {
  if (gameState === GameState.PLAYING && document.pointerLockElement !== document.body) {
    noticeElement.textContent = "點擊畫面可重新鎖定滑鼠";
  } else if (gameState === GameState.PLAYING) {
    noticeElement.textContent = "WASD 移動 ・ 左鍵射擊";
  }
});

document.querySelector("#start-button").addEventListener("click", resetGame);
document.querySelector("#restart-button").addEventListener("click", resetGame);
document.querySelector("#resume-button").addEventListener("click", resumeGame);
renderer.domElement.addEventListener("click", () => {
  if (gameState === GameState.PLAYING && document.pointerLockElement !== document.body) {
    document.body.requestPointerLock();
  }
});
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateRenderQuality();
});

setupArenaMap(loadSoldier());
loadGameAssets();
createWeapon();
updateWeaponAppearance();
updateHud();
animate();
