import * as THREE from "three";

const ARENA_SIZE = 50;
const PLAYER_HEIGHT = 1.7;
const PLAYER_SPEED = 7;
const ENEMY_SPEED = 1.5;
const ENEMY_DAMAGE_COOLDOWN = 800;
const ENEMY_FIRE_COOLDOWN = 1800;
const ENEMY_PROJECTILE_SPEED = 12;
const ENEMY_PROJECTILE_DAMAGE = 5;
const MAX_ENEMIES = 10;
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
scene.fog = new THREE.Fog(0x050816, 18, 48);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, PLAYER_HEIGHT, 9);
camera.layers.enable(1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(camera);

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
const enemyProjectiles = [];
const ammoPickups = [];
const reloadSound = new Audio("./bullet.mp3");
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
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

  const grid = new THREE.GridHelper(ARENA_SIZE, 30, 0x1b8cff, 0x12305c);
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
    { position: [-8, 1.2, 2], size: [5, 2.4, 1.1] },
    { position: [8, 1.2, -4], size: [5, 2.4, 1.1] },
    { position: [0, 1.1, -9], size: [1.2, 2.2, 5] },
  ];
  covers.forEach(({ position, size }) => {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(...size), coverMaterial);
    cover.position.set(...position);
    scene.add(cover);
    obstacles.push(cover);
  });

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

  const carBodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x263e72,
    emissive: 0x0b2050,
    emissiveIntensity: 1.2,
    metalness: 0.75,
    roughness: 0.25,
  });
  const carPositions = [
    [-10, 0.55, -3, 0.2],
    [11, 0.55, 6, -0.5],
    [-3, 0.55, 14, Math.PI / 2],
    [5, 0.55, -14, Math.PI / 2],
  ];
  carPositions.forEach(([x, y, z, rotation]) => {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.7, 1.35), carBodyMaterial);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.35, 0.55, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x10182d, metalness: 0.8, roughness: 0.15 }),
    );
    cabin.position.y = 0.55;
    car.add(body, cabin);
    car.position.set(x, y, z);
    car.rotation.y = rotation;
    scene.add(car);
    obstacles.push(car);
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
  const accent = weapon.children[2];
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
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.75, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xff286f,
      emissive: 0x8f073a,
      emissiveIntensity: 2.2,
      roughness: 0.3,
    }),
  );
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff6a1 }),
  );
  eye.position.set(0, 0.15, -0.67);
  enemy.add(body, eye);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.94, 0.035, 6, 24),
    new THREE.MeshBasicMaterial({ color: 0xff4b9b }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.62;
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
  healthBar.position.y = 1.35;
  healthBar.userData.fill = healthBarFill;
  healthBar.traverse((object) => object.layers.set(1));
  enemy.add(healthBar);

  const angle = Math.random() * Math.PI * 2;
  const distance = 10 + Math.random() * 4;
  enemy.position.set(Math.cos(angle) * distance, 0.9, Math.sin(angle) * distance);
  enemy.userData.health = 100;
  enemy.userData.maxHealth = 100;
  enemy.userData.healthBar = healthBar;
  enemy.userData.lastShotAt = performance.now() + Math.random() * ENEMY_FIRE_COOLDOWN;
  scene.add(enemy);
  enemies.push(enemy);
  updateHud();
}

function spawnWave() {
  const enemyTotal = Math.min(2 + player.wave, MAX_ENEMIES);
  for (let i = 0; i < enemyTotal; i += 1) createEnemy();
}

function removeEnemy(enemy) {
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

  const projectile = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc857 }),
  );
  projectile.position.copy(origin);
  projectile.userData.velocity = target.sub(origin).normalize().multiplyScalar(ENEMY_PROJECTILE_SPEED);
  projectile.userData.damage = ENEMY_PROJECTILE_DAMAGE;
  projectile.userData.life = 4;
  scene.add(projectile);
  enemyProjectiles.push(projectile);
}

function removeEnemyProjectile(projectile) {
  scene.remove(projectile);
  const index = enemyProjectiles.indexOf(projectile);
  if (index >= 0) enemyProjectiles.splice(index, 1);
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
      removeEnemyProjectile(projectile);
      if (player.health === 0) endGame();
    } else if (projectile.userData.life <= 0) {
      removeEnemyProjectile(projectile);
    }
  });
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
  const obstacleHits = raycaster.intersectObjects(obstacles, true);
  if (enemyHits.length === 0) return;
  if (obstacleHits.length > 0 && obstacleHits[0].distance < enemyHits[0].distance) return;

  const enemy = enemyHits[0].object.parent;
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
    const toPlayer = camera.position.clone().sub(enemy.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();
    toPlayer.normalize();
    const nextPosition = enemy.position.clone().addScaledVector(toPlayer, ENEMY_SPEED * delta);
    if (!collidesWithObstacle(nextPosition, 0.75)) {
      enemy.position.copy(nextPosition);
    }
    enemy.lookAt(camera.position.x, enemy.position.y, camera.position.z);
    enemy.position.y = 0.9 + Math.sin(elapsed * 4 + enemy.id) * 0.08;
    enemy.userData.healthBar.lookAt(camera.position);

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
  enemyProjectiles.splice(0).forEach((projectile) => scene.remove(projectile));
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
  renderer.setSize(window.innerWidth, window.innerHeight);
});

createArena();
createWeapon();
updateWeaponAppearance();
updateHud();
animate();
