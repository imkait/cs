import * as THREE from "three";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/FBXLoader.js";
import * as SkeletonUtils from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/utils/SkeletonUtils.js";

const ARENA_SIZE = 64;
const PLAYER_HEIGHT = 1.7;
const PLAYER_SPEED = 7;
const ENEMY_SPEED = 1.5;
const ENEMY_STOP_DISTANCE = 7;
const ENEMY_DETECTION_DISTANCE = 14;
const ENEMY_WANDER_RADIUS = 14;
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
scene.fog = new THREE.Fog(0x050816, 22, 68);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 140);
camera.position.set(0, PLAYER_HEIGHT, 9);
camera.layers.enable(1);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
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

scene.add(new THREE.HemisphereLight(0x8db7ff, 0x12091e, 1.8));
const blueLight = new THREE.PointLight(0x26c6ff, 30, 25);
blueLight.position.set(-8, 5, 0);
scene.add(blueLight);
const pinkLight = new THREE.PointLight(0xff32a6, 25, 22);
pinkLight.position.set(8, 4, -7);
scene.add(pinkLight);

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
const obstacles = [];
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
const fbxLoader = new FBXLoader();
const textureLoader = new THREE.TextureLoader();
const kenneyBuildingModels = [];
const kenneyCarModels = [];
const blasterModels = [];
let kenneyEnemyModel;
let kenneyEnemyAnimations = [];
let survivorEnemyModel;
let survivorEnemyAnimations = [];
let survivorEnemyTexture;
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
  obstacles.push(barrel);
}

function removeExplosiveBarrel(barrel) {
  scene.remove(barrel);
  const barrelIndex = explosiveBarrels.indexOf(barrel);
  if (barrelIndex >= 0) explosiveBarrels.splice(barrelIndex, 1);
  const obstacleIndex = obstacles.indexOf(barrel);
  if (obstacleIndex >= 0) obstacles.splice(obstacleIndex, 1);
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
    if (enemy.userData.proceduralAnimation) {
      enemy.userData.proceduralAnimation.state = "hit";
      enemy.userData.proceduralAnimation.time = 0;
      enemy.userData.hitUntil = performance.now() + 350;
    }
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
  const bounds = new THREE.Box3().setFromObject(model);
  const currentHeight = bounds.getSize(new THREE.Vector3()).y;
  model.scale.multiplyScalar(height / Math.max(currentHeight, 0.001));
  const fittedBounds = new THREE.Box3().setFromObject(model);
  model.position.y -= fittedBounds.min.y;
}

function addImportedBuilding(source, position, size, rotation = 0) {
  const building = source.clone(true);
  fitModel(building, size);
  const bounds = new THREE.Box3().setFromObject(building);
  building.position.set(position[0], position[1] - bounds.min.y, position[2]);
  building.rotation.y = rotation;
  scene.add(building);
  obstacles.push(building);
  relocateEnemiesOutsideObstacles();
}

function addImportedCar(source, position, rotation = 0, size = [4.8, 2.2, 2.6]) {
  const car = source.clone(true);
  fitModel(car, size);
  const bounds = new THREE.Box3().setFromObject(car);
  car.position.set(position[0], position[1] - bounds.min.y, position[2]);
  car.rotation.y = rotation;
  scene.add(car);
  obstacles.push(car);
}

function findEnemySpawnPosition() {
  const candidate = new THREE.Vector3();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 18 + Math.random() * 11;
    candidate.set(
      Math.cos(angle) * distance,
      0,
      Math.sin(angle) * distance,
    );
    if (
      candidate.distanceTo(camera.position) >= 12 &&
      !collidesWithObstacle(candidate, 1.2)
    ) {
      return candidate.clone();
    }
  }
  return new THREE.Vector3(0, 0, -20);
}

function relocateEnemiesOutsideObstacles() {
  enemies.forEach((enemy) => {
    if (collidesWithObstacle(enemy.position, 1.2)) {
      enemy.position.copy(findEnemySpawnPosition());
    }
  });
}

function loadGameAssets() {
  loadModel("./assets/kenney/city-kit-industrial/building-a.glb", (model) => {
    kenneyBuildingModels[0] = model;
    addImportedBuilding(model, [-17, 0, -14], [8, 8, 7]);
    addImportedBuilding(model, [-17, 0, 14], [9, 7, 6]);
  }, "Kenney building-a");
  loadModel("./assets/kenney/city-kit-industrial/building-e.glb", (model) => {
    kenneyBuildingModels[1] = model;
    addImportedBuilding(model, [15, 0, -16], [7, 10, 8]);
    addImportedBuilding(model, [17, 0, 13], [8, 9, 7]);
  }, "Kenney building-e");
  loadModel("./assets/kenney/city-kit-industrial/shipping-container-a.glb", (model) => {
    kenneyBuildingModels[2] = model;
    addImportedBuilding(model, [0, 0, -9], [5, 2.8, 2.3], Math.PI / 2);
  }, "Kenney shipping-container-a");
  loadModel(
    "./assets/kenney/city-kit-commercial/Models/GLB format/building-a.glb",
    (model) => {
      addImportedBuilding(model, [-19, 0, 0], [7, 9, 7], Math.PI / 2);
      addImportedBuilding(model, [19, 0, 0], [7, 8, 7], -Math.PI / 2);
    },
    "Kenney commercial building-a",
  );
  loadModel(
    "./assets/kenney/city-kit-commercial/Models/GLB format/building-f.glb",
    (model) => {
      addImportedBuilding(model, [-12, 0, -19], [8, 7, 7]);
      addImportedBuilding(model, [12, 0, 19], [8, 7, 7], Math.PI);
    },
    "Kenney commercial building-f",
  );
  loadModel(
    "./assets/kenney/city-kit-commercial/Models/GLB format/building-skyscraper-a.glb",
    (model) => {
      addImportedBuilding(model, [19, 0, 19], [7, 15, 7], Math.PI);
    },
    "Kenney commercial skyscraper-a",
  );
  loadModel("./assets/kenney/car-kit/sedan.glb", (model) => {
    kenneyCarModels[0] = model;
    addImportedCar(model, [-10, 0, -3], 0.2);
    addImportedCar(model, [-3, 0, 14], Math.PI / 2);
  }, "Kenney sedan");
  loadModel("./assets/kenney/car-kit/suv.glb", (model) => {
    kenneyCarModels[1] = model;
    addImportedCar(model, [11, 0, 6], -0.5, [5.4, 2.2, 2.9]);
  }, "Kenney SUV");
  loadModel("./assets/kenney/car-kit/race-future.glb", (model) => {
    kenneyCarModels[2] = model;
    addImportedCar(model, [5, 0, -14], Math.PI / 2);
  }, "Kenney future race car");
  fbxLoader.load(
    "./assets/animated-characters-survivors/Model/characterMedium.fbx",
    (model) => {
      survivorEnemyModel = model;
      if (survivorEnemyTexture) {
        survivorEnemyModel.traverse((object) => {
          if (object.isMesh) object.material.map = survivorEnemyTexture;
        });
      }
      survivorEnemyAnimations = [];
      const animationFiles = [
        ["idle", "idle.fbx"],
        ["walk", "run.fbx"],
        ["jump", "jump.fbx"],
      ];
      animationFiles.forEach(([name, file]) => {
        fbxLoader.load(
          `./assets/animated-characters-survivors/Animations/${file}`,
          (animation) => {
            animation.animations.forEach((clip) => {
              clip.name = name;
              survivorEnemyAnimations.push(clip);
            });
          },
          undefined,
          (error) => console.warn(`敵人動畫載入失敗：${file}`, error),
        );
      });
    },
    undefined,
    (error) => console.warn("3D 素材載入失敗：animated-characters-survivors", error),
  );
  textureLoader.load(
    "./assets/animated-characters-survivors/Skins/zombieA.png",
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      survivorEnemyTexture = texture;
      survivorEnemyModel?.traverse((object) => {
        if (object.isMesh) object.material.map = texture;
      });
    },
    undefined,
    (error) => console.warn("敵人材質載入失敗：zombieA.png", error),
  );
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

function getEnemyBone(character, name) {
  return character.getObjectByName(`mixamorig:${name}`);
}

function rotateEnemyBone(bone, baseQuaternion, axis, angle) {
  if (!bone) return;
  bone.quaternion.copy(baseQuaternion);
  bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
}

function updateProceduralEnemyAnimation(enemy, delta, elapsed) {
  const animation = enemy.userData.proceduralAnimation;
  if (!animation) return;

  animation.time += delta;
  const t = animation.time;
  const bones = animation.bones;
  const base = animation.baseRotations;
  const character = animation.character;
  const speed = animation.state === "walk" ? 9 : 3;
  const wave = Math.sin(t * speed);
  const oppositeWave = Math.sin(t * speed + Math.PI);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  Object.entries(bones)
    .filter(([, bone]) => bone)
    .forEach(([name, bone]) => {
    bone.quaternion.copy(base[name]);
    });
  character.rotation.set(0, 0, 0);

  if (animation.state === "walk") {
    rotateEnemyBone(bones.leftArm, base.leftArm, zAxis, -1.5 + oppositeWave * 0.55);
    rotateEnemyBone(bones.rightArm, base.rightArm, zAxis, 1.5 + wave * 0.55);
    rotateEnemyBone(bones.leftForeArm, base.leftForeArm, xAxis, 0.25);
    rotateEnemyBone(bones.rightForeArm, base.rightForeArm, xAxis, 0.25);
    rotateEnemyBone(bones.leftUpLeg, base.leftUpLeg, xAxis, wave * 0.75);
    rotateEnemyBone(bones.rightUpLeg, base.rightUpLeg, xAxis, oppositeWave * 0.75);
    rotateEnemyBone(bones.leftLeg, base.leftLeg, xAxis, Math.max(0, -wave) * 0.55);
    rotateEnemyBone(bones.rightLeg, base.rightLeg, xAxis, Math.max(0, -oppositeWave) * 0.55);
    rotateEnemyBone(bones.spine, base.spine, zAxis, wave * 0.025);
    character.rotation.z = wave * 0.06;
    character.position.y = Math.abs(wave) * 0.035;
  } else if (animation.state === "shoot") {
    rotateEnemyBone(bones.leftArm, base.leftArm, zAxis, -0.9);
    rotateEnemyBone(bones.rightArm, base.rightArm, zAxis, 0.9);
    rotateEnemyBone(bones.leftForeArm, base.leftForeArm, xAxis, -0.65);
    rotateEnemyBone(bones.rightForeArm, base.rightForeArm, xAxis, -0.65);
    rotateEnemyBone(bones.spine, base.spine, xAxis, -0.08);
    character.rotation.x = -0.1;
    character.position.y = 0.02;
  } else if (animation.state === "hit") {
    const hitWave = Math.sin(Math.min(t, 0.35) / 0.35 * Math.PI);
    rotateEnemyBone(bones.spine, base.spine, zAxis, hitWave * 0.18);
    rotateEnemyBone(bones.head, base.head, zAxis, hitWave * -0.12);
    rotateEnemyBone(bones.leftArm, base.leftArm, zAxis, -1.5 + hitWave * 0.5);
    rotateEnemyBone(bones.rightArm, base.rightArm, zAxis, 1.5 - hitWave * 0.5);
    character.rotation.z = hitWave * 0.12;
  } else {
    rotateEnemyBone(bones.leftArm, base.leftArm, zAxis, -1.5);
    rotateEnemyBone(bones.rightArm, base.rightArm, zAxis, 1.5);
    rotateEnemyBone(bones.leftForeArm, base.leftForeArm, xAxis, -0.25);
    rotateEnemyBone(bones.rightForeArm, base.rightForeArm, xAxis, -0.25);
    rotateEnemyBone(bones.spine, base.spine, zAxis, Math.sin(t * 2) * 0.025);
    rotateEnemyBone(bones.head, base.head, zAxis, Math.sin(t * 2 + 0.5) * 0.02);
    rotateEnemyBone(bones.hips, base.hips, yAxis, Math.sin(t * 2) * 0.02);
    character.position.y = Math.sin(t * 2) * 0.015;
  }
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
const gameOverScreen = document.querySelector("#game-over-screen");
const pauseScreen = document.querySelector("#pause-screen");
const finalScoreElement = document.querySelector("#final-score");
const noticeElement = document.querySelector("#notice");
const minimap = document.querySelector("#minimap");
const minimapContext = minimap.getContext("2d");

function createArena() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x0b1630, metalness: 0.6, roughness: 0.55 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(ARENA_SIZE, 40, 0x1b8cff, 0x12305c);
  grid.position.y = 0.01;
  scene.add(grid);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x101d45,
    emissive: 0x07183d,
    emissiveIntensity: 1.6,
    metalness: 0.4,
  });
  const coverMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b3d68,
    emissive: 0x0c2e5b,
    emissiveIntensity: 1.8,
    metalness: 0.65,
    roughness: 0.32,
  });
  const covers = [
    { position: [-8, 1.2, 1], size: [5, 2.4, 1.1] },
    { position: [8, 1.2, -1], size: [5, 2.4, 1.1] },
    { position: [-2.5, 1.1, -8], size: [1.2, 2.2, 5] },
    { position: [2.5, 1.1, 8], size: [1.2, 2.2, 4] },
  ];
  covers.forEach(({ position, size }) => {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(...size), coverMaterial);
    cover.position.set(...position);
    scene.add(cover);
    obstacles.push(cover);
  });

  const outerCoverData = [
    { position: [-22, 1.4, -2], size: [4.5, 2.8, 1.2], rotation: 0.12 },
    { position: [22, 1.4, 3], size: [4.5, 2.8, 1.2], rotation: -0.16 },
    { position: [-5, 1.25, -22], size: [1.2, 2.5, 4.5], rotation: 0.08 },
    { position: [6, 1.25, 22], size: [1.2, 2.5, 4.5], rotation: -0.08 },
    { position: [-22, 1, 16], size: [3.2, 2, 3.2], rotation: 0.35 },
    { position: [22, 1, -15], size: [3.2, 2, 3.2], rotation: -0.35 },
  ];
  outerCoverData.forEach(({ position, size, rotation }) => {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(...size), coverMaterial);
    cover.position.set(...position);
    cover.rotation.y = rotation;
    scene.add(cover);
    obstacles.push(cover);
  });

  const laneMaterial = new THREE.MeshBasicMaterial({
    color: 0x26c6ff,
    transparent: true,
    opacity: 0.28,
  });
  const dangerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff326e,
    transparent: true,
    opacity: 0.22,
  });
  [
    { position: [-12, 0.025, 0], size: [7, 0.04, 0.16], rotation: 0 },
    { position: [12, 0.025, 0], size: [7, 0.04, 0.16], rotation: 0 },
    { position: [0, 0.025, -12], size: [0.16, 0.04, 7], rotation: 0 },
    { position: [0, 0.025, 12], size: [0.16, 0.04, 7], rotation: 0 },
  ].forEach(({ position, size, rotation }) => {
    const lane = new THREE.Mesh(new THREE.BoxGeometry(...size), laneMaterial);
    lane.position.set(...position);
    lane.rotation.y = rotation;
    scene.add(lane);
  });
  [
    [-6, 0.03, 6],
    [7, 0.03, 1],
  ].forEach(([x, y, z]) => {
    const hazard = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.2, 0.035, 32),
      dangerMaterial,
    );
    hazard.position.set(x, y, z);
    scene.add(hazard);
  });

  const core = new THREE.Group();
  const coreBase = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.55, 0.22, 24),
    new THREE.MeshStandardMaterial({
      color: 0x132d5b,
      emissive: 0x083c7a,
      emissiveIntensity: 2,
      metalness: 0.8,
      roughness: 0.24,
    }),
  );
  const coreBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.48, 2.4, 16),
    new THREE.MeshBasicMaterial({
      color: 0x58f0d0,
      transparent: true,
      opacity: 0.72,
    }),
  );
  const coreRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.045, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0xffc857 }),
  );
  coreBase.position.y = 0.12;
  coreBeam.position.y = 1.25;
  coreRing.rotation.x = Math.PI / 2;
  coreRing.position.y = 0.46;
  core.add(coreBase, coreBeam, coreRing);
  core.position.set(0, 0, -1.5);
  scene.add(core);

  const buildingMaterial = new THREE.MeshStandardMaterial({
    color: 0x182b50,
    emissive: 0x091b3a,
    emissiveIntensity: 1.5,
    metalness: 0.45,
    roughness: 0.55,
  });
  const buildingData = [
    { position: [-17, 4, -14], size: [8, 8, 7] },
    { position: [15, 5, -16], size: [7, 10, 8] },
    { position: [-17, 3.5, 14], size: [9, 7, 6] },
    { position: [17, 4.5, 13], size: [8, 9, 7] },
  ];
  buildingData.forEach(({ position, size }, index) => {
    const building = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(...size), buildingMaterial);
    building.add(body);
    const windowMaterial = new THREE.MeshBasicMaterial({ color: index % 2 ? 0xff32a6 : 0x26c6ff });
    for (let row = 0; row < 3; row += 1) {
      const windows = new THREE.Mesh(new THREE.BoxGeometry(size[0] * 0.65, 0.08, 0.08), windowMaterial);
      windows.position.set(0, -size[1] * 0.25 + row * 1.4, size[2] / 2 + 0.05);
      building.add(windows);
    }
    building.position.set(...position);
    scene.add(building);
    obstacles.push(building);
  });

  for (let i = 0; i < 10; i += 1) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 2.4, 8),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff32a6 : 0x26c6ff }),
    );
    const angle = (i / 10) * Math.PI * 2;
    pillar.position.set(Math.cos(angle) * 11, 1.2, Math.sin(angle) * 11);
    scene.add(pillar);
  }

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7d4dff, transparent: true, opacity: 0.8 });
  [4, 8, 12].forEach((radius, index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.025, 8, 64), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.04 + index * 0.01;
    scene.add(ring);
  });
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
  const enemySource = survivorEnemyModel || kenneyEnemyModel;
  const enemyAnimations = survivorEnemyModel
    ? survivorEnemyAnimations
    : kenneyEnemyAnimations;
  if (enemySource) {
    const character = SkeletonUtils.clone(enemySource);
    fitEnemyModel(character, 1.7);
    character.traverse((object) => {
      object.userData.enemy = enemy;
      if (object.isMesh) {
        object.material = object.material.clone();
        if ("emissive" in object.material) {
          object.material.emissive.set(0x000000);
          object.material.emissiveIntensity = 0;
        }
      }
    });
    enemy.add(character);
    enemy.userData.hitboxSource = character;
    const mixer = new THREE.AnimationMixer(character);
    const actions = {};
    enemyAnimations.forEach((clip) => {
      actions[clip.name] = mixer.clipAction(clip);
    });
    enemy.userData.mixer = mixer;
    enemy.userData.actions = actions;
    if (!survivorEnemyModel) {
      const bones = {
        hips: getEnemyBone(character, "Hips"),
        spine: getEnemyBone(character, "Spine"),
        head: getEnemyBone(character, "Head"),
        leftArm: getEnemyBone(character, "LeftArm"),
        rightArm: getEnemyBone(character, "RightArm"),
        leftForeArm: getEnemyBone(character, "LeftForeArm"),
        rightForeArm: getEnemyBone(character, "RightForeArm"),
        leftUpLeg: getEnemyBone(character, "LeftUpLeg"),
        rightUpLeg: getEnemyBone(character, "RightUpLeg"),
        leftLeg: getEnemyBone(character, "LeftLeg"),
        rightLeg: getEnemyBone(character, "RightLeg"),
      };
      const baseRotations = Object.fromEntries(
        Object.entries(bones)
          .filter(([, bone]) => bone)
          .map(([name, bone]) => [name, bone.quaternion.clone()]),
      );
      enemy.userData.proceduralAnimation = {
        character,
        bones,
        baseRotations,
        state: "idle",
        time: Math.random() * Math.PI,
      };
    }
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
  enemy.userData.hitUntil = 0;
  enemy.userData.wanderTarget = new THREE.Vector3(
    THREE.MathUtils.randFloat(-ENEMY_WANDER_RADIUS, ENEMY_WANDER_RADIUS),
    0,
    THREE.MathUtils.randFloat(-ENEMY_WANDER_RADIUS, ENEMY_WANDER_RADIUS),
  );
  enemy.userData.wanderUntil = performance.now() + THREE.MathUtils.randFloat(1800, 4200);
  if (enemy.userData.proceduralAnimation) {
    enemy.userData.proceduralAnimation.state = "idle";
  }
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
  const direction = to.clone().sub(from);
  const distance = direction.length();
  direction.normalize();
  raycaster.set(from, direction);
  const hits = raycaster.intersectObjects(obstacles, true);
  return hits.length === 0 || hits[0].distance > distance;
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
  if (enemy.userData.proceduralAnimation) {
    enemy.userData.proceduralAnimation.state = "shoot";
    enemy.userData.proceduralAnimation.time = 0;
  }
  setEnemyAnimation(enemy, "holding-both-shoot", THREE.LoopOnce);
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
    const from = projectile.position.clone();
    const direction = movement.clone().normalize();
    raycaster.set(from, direction);
    const wallHits = raycaster.intersectObjects(obstacles, true);
    const wallHit = wallHits.find((hit) => hit.distance <= movement.length());
    if (wallHit) {
      removeEnemyProjectile(projectile);
      return;
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
  const obstacleHits = raycaster.intersectObjects(obstacles, true);
  const barrelHit = barrelHits[0];
  const obstacleHit = obstacleHits.find((hit) => !hit.object.userData.barrel);
  if (barrelHit && (!obstacleHit || barrelHit.distance <= obstacleHit.distance)) {
    explodeBarrel(barrelHit.object.userData.barrel);
    return;
  }
  if (enemyHits.length === 0 && hitboxHits.length === 0) return;
  const closestEnemyHit = hitboxHits[0];
  if (obstacleHit && closestEnemyHit && obstacleHit.distance < closestEnemyHit.distance) return;

  const enemy = closestEnemyHit?.enemy
    || enemyHits[0].object.userData.enemy
    || enemyHits[0].object.parent;
  if (!enemy || !enemy.userData.health) return;
  enemy.userData.health = Math.max(0, enemy.userData.health - selectedWeapon.damage);
  if (enemy.userData.proceduralAnimation) {
    enemy.userData.proceduralAnimation.state = "hit";
    enemy.userData.proceduralAnimation.time = 0;
    enemy.userData.hitUntil = performance.now() + 350;
  }
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
  const nextPosition = camera.position.clone().add(movement);
  if (!collidesWithObstacle(nextPosition, 0.45)) {
    camera.position.copy(nextPosition);
  }
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -ARENA_SIZE / 2 + 1, ARENA_SIZE / 2 - 1);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -ARENA_SIZE / 2 + 1, ARENA_SIZE / 2 - 1);
  camera.position.y = PLAYER_HEIGHT;
}

function collidesWithObstacle(position, radius) {
  return obstacles.some((obstacle) => {
    const bounds = new THREE.Box3().setFromObject(obstacle);
    bounds.expandByScalar(radius);
    return bounds.containsPoint(new THREE.Vector3(position.x, 1, position.z));
  });
}

function updateEnemies(delta, elapsed) {
  enemies.forEach((enemy) => {
    enemy.userData.mixer?.update(delta);
    const toPlayer = camera.position.clone().sub(enemy.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();
    const now = performance.now();
    const isChasing = distance <= ENEMY_DETECTION_DISTANCE;
    if (!isChasing && now >= enemy.userData.wanderUntil) {
      enemy.userData.wanderTarget.set(
        THREE.MathUtils.randFloat(-ENEMY_WANDER_RADIUS, ENEMY_WANDER_RADIUS),
        0,
        THREE.MathUtils.randFloat(-ENEMY_WANDER_RADIUS, ENEMY_WANDER_RADIUS),
      );
      enemy.userData.wanderUntil = now + THREE.MathUtils.randFloat(1800, 4200);
    }
    const movementTarget = isChasing
      ? camera.position
      : enemy.userData.wanderTarget;
    const direction = movementTarget.clone().sub(enemy.position);
    direction.y = 0;
    const targetDistance = direction.length();
    const nextPosition = enemy.position.clone();
    let moved = false;
    if ((isChasing && distance > ENEMY_STOP_DISTANCE) || (!isChasing && targetDistance > 0.4)) {
      direction.normalize();
      nextPosition.addScaledVector(direction, ENEMY_SPEED * delta);
    }
    if (!collidesWithObstacle(nextPosition, 0.75)) {
      enemy.position.copy(nextPosition);
      moved = true;
    }
    if (moved) {
      enemy.lookAt(
        movementTarget.x,
        enemy.position.y,
        movementTarget.z,
      );
    }
    enemy.position.y = 0;
    if (enemy.userData.proceduralAnimation) {
      if (performance.now() < enemy.userData.hitUntil) {
        enemy.userData.proceduralAnimation.state = "hit";
      } else if (performance.now() < enemy.userData.attackUntil) {
        enemy.userData.proceduralAnimation.state = "shoot";
      } else {
        enemy.userData.proceduralAnimation.state = moved ? "walk" : "idle";
      }
      updateProceduralEnemyAnimation(enemy, delta, elapsed);
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
  const padding = 8;
  const scale = (width - padding * 2) / ARENA_SIZE;
  const toMap = (value) => value * scale + width / 2;

  minimapContext.clearRect(0, 0, width, height);
  minimapContext.fillStyle = "#071126";
  minimapContext.fillRect(0, 0, width, height);

  minimapContext.strokeStyle = "rgba(77, 168, 255, 0.22)";
  minimapContext.lineWidth = 1;
  for (let grid = -20; grid <= 20; grid += 10) {
    const position = toMap(grid);
    minimapContext.beginPath();
    minimapContext.moveTo(position, padding);
    minimapContext.lineTo(position, height - padding);
    minimapContext.moveTo(padding, position);
    minimapContext.lineTo(width - padding, position);
    minimapContext.stroke();
  }

  obstacles.forEach((obstacle) => {
    const bounds = new THREE.Box3().setFromObject(obstacle);
    const obstacleWidth = Math.max(4, (bounds.max.x - bounds.min.x) * scale);
    const obstacleDepth = Math.max(4, (bounds.max.z - bounds.min.z) * scale);
    minimapContext.fillStyle = "rgba(73, 118, 180, 0.72)";
    minimapContext.fillRect(
      toMap((bounds.min.x + bounds.max.x) / 2) - obstacleWidth / 2,
      toMap((bounds.min.z + bounds.max.z) / 2) - obstacleDepth / 2,
      obstacleWidth,
      obstacleDepth,
    );
  });

  enemies.forEach((enemy) => {
    if (enemy.userData.healthBar?.userData.billboard) {
      enemy.userData.healthBar.quaternion.copy(camera.quaternion);
    }
    minimapContext.fillStyle = "#ff3f87";
    minimapContext.shadowColor = "#ff3f87";
    minimapContext.shadowBlur = 8;
    minimapContext.beginPath();
    minimapContext.arc(toMap(enemy.position.x), toMap(enemy.position.z), 4, 0, Math.PI * 2);
    minimapContext.fill();
  });

  minimapContext.shadowBlur = 0;
  minimapContext.fillStyle = "#58f0d0";
  minimapContext.beginPath();
  minimapContext.arc(toMap(camera.position.x), toMap(camera.position.z), 5, 0, Math.PI * 2);
  minimapContext.fill();
  minimapContext.strokeStyle = "#58f0d0";
  minimapContext.lineWidth = 2;
  minimapContext.beginPath();
  minimapContext.moveTo(toMap(camera.position.x), toMap(camera.position.z));
  minimapContext.lineTo(
    toMap(camera.position.x - Math.sin(player.yaw) * 1.8),
    toMap(camera.position.z - Math.cos(player.yaw) * 1.8),
  );
  minimapContext.stroke();
}

function resetGame() {
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
  player.yaw = 0;
  player.pitch = 0;
  camera.position.set(0, PLAYER_HEIGHT, 9);
  camera.rotation.set(0, 0, 0);
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
  createExplosiveBarrel([-6, 0.6, 6]);
  createExplosiveBarrel([7, 0.6, 1]);
  createExplosiveBarrel([12, 0.6, -8]);
  createAmmoPickup([-7, 0.5, 8]);
  createAmmoPickup([9, 0.5, 12]);
  createAmmoPickup([13, 0.5, -7]);
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
    updateEnemies(delta, elapsed);
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

createArena();
loadGameAssets();
createWeapon();
updateWeaponAppearance();
updateHud();
animate();
