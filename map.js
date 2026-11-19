import * as THREE from "three";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/loaders/GLTFLoader.js";

export const MAP_URL = "./assets/arena_standoff_2.glb";

const CELL_SIZE = 0.4;
const TARGET_ARENA_SPAN = 44;
const PLAYER_PROBE_HEIGHT = 1.7;
const STEP_HEIGHT = 0.35;
const STAGE_A_SPAN = 60;

const BODY_LOW = 0.35;
const BODY_HIGH = 1.6;

function worldBounds(root) {
  root.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(root);
}

/** 線段是否與矩形相交（精確標記牆面格，不做多餘外擴） */
function segmentCrossesRect(x1, z1, x2, z2, minX, maxX, minZ, maxZ) {
  const inside = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  if (inside(x1, z1) || inside(x2, z2)) return true;
  const side = (ax, az, bx, bz, px, pz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  const crosses = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d1 = side(cx, cz, dx, dz, ax, az);
    const d2 = side(cx, cz, dx, dz, bx, bz);
    const d3 = side(ax, az, bx, bz, cx, cz);
    const d4 = side(ax, az, bx, bz, dx, dz);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  return (
    crosses(x1, z1, x2, z2, minX, minZ, maxX, minZ)
    || crosses(x1, z1, x2, z2, maxX, minZ, maxX, maxZ)
    || crosses(x1, z1, x2, z2, maxX, maxZ, minX, maxZ)
    || crosses(x1, z1, x2, z2, minX, maxZ, minX, minZ)
  );
}

/**
 * 把模型三角形投影到 XZ 平面網格：
 * - top：每格在探測高度以下最高的水平表面
 * - wall：每格是否被貫穿角色身高的直立面佔據
 */
function buildGrid(root, { cell, floorY, probeHeight, stepHeight, markWalls }) {
  const box = worldBounds(root);
  const originX = box.min.x;
  const originZ = box.min.z;
  const cols = Math.max(1, Math.ceil((box.max.x - originX) / cell));
  const rows = Math.max(1, Math.ceil((box.max.z - originZ) / cell));
  const count = cols * rows;
  const top = new Float32Array(count).fill(-Infinity);
  const wall = new Uint8Array(count);
  const probeY = floorY + probeHeight;
  const bodyLow = floorY + BODY_LOW;
  const bodyHigh = floorY + BODY_HIGH;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const meshes = [];
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    // 透明貼片（草叢、污漬、落葉等 decal）只是視覺效果，不當成牆或地面
    if (materials.some((material) => material && (material.transparent || material.alphaTest > 0))) {
      return;
    }
    meshes.push(object);
  });

  const cellRange = (min, max, origin, limit) => {
    const low = Math.max(0, Math.floor((min - origin) / cell));
    const high = Math.min(limit - 1, Math.floor((max - origin) / cell));
    return [low, high];
  };

  meshes.forEach((mesh) => {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const index = geometry.index;
    const matrix = mesh.matrixWorld;
    const total = index ? index.count : position.count;

    for (let i = 0; i < total; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
      b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

      const minX = Math.min(a.x, b.x, c.x);
      const maxX = Math.max(a.x, b.x, c.x);
      const minZ = Math.min(a.z, b.z, c.z);
      const maxZ = Math.max(a.z, b.z, c.z);
      if (maxX - minX > 40 || maxZ - minZ > 40) continue; // 大面積背景板忽略

      const [cx0, cx1] = cellRange(minX, maxX, originX, cols);
      const [cz0, cz1] = cellRange(minZ, maxZ, originZ, rows);

      // 1) 水平表面：取探測高度以下最高的那一層
      const denom = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denom) > 1e-9) {
        for (let cz = cz0; cz <= cz1; cz += 1) {
          const pz = originZ + (cz + 0.5) * cell;
          for (let cx = cx0; cx <= cx1; cx += 1) {
            const px = originX + (cx + 0.5) * cell;
            const l0 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / denom;
            const l1 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / denom;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
            const y = l0 * a.y + l1 * b.y + l2 * c.y;
            if (y > probeY) continue;
            const idx = cz * cols + cx;
            if (y > top[idx]) top[idx] = y;
          }
        }
      }

      // 2) 直立面：貫穿角色身體高度的牆面會阻擋移動與視線
      if (!markWalls) continue;
      const minY = Math.min(a.y, b.y, c.y);
      const maxY = Math.max(a.y, b.y, c.y);
      if (minY > bodyHigh || maxY < bodyLow) continue;
      edge.subVectors(b, a).cross(c.clone().sub(a));
      if (edge.lengthSq() < 1e-9) continue;
      normal.copy(edge).normalize();
      if (Math.abs(normal.y) > 0.78) continue; // 地板、屋頂、斜坡不當牆

      // 只用牆面實際佔到的格子，不再額外膨脹，避免窄通道被誤判為不可走
      const segments = [
        [a.x, a.z, b.x, b.z],
        [b.x, b.z, c.x, c.z],
        [c.x, c.z, a.x, a.z],
      ];
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const z0 = originZ + cz * cell;
        const z1 = z0 + cell;
        for (let cx = cx0; cx <= cx1; cx += 1) {
          const idx = cz * cols + cx;
          if (wall[idx]) continue;
          const x0 = originX + cx * cell;
          const x1 = x0 + cell;
          for (let s = 0; s < segments.length; s += 1) {
            const [sx1, sz1, sx2, sz2] = segments[s];
            if (segmentCrossesRect(sx1, sz1, sx2, sz2, x0, x1, z0, z1)) {
              wall[idx] = 1;
              break;
            }
          }
        }
      }
    }
  });

  const blocked = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    blocked[i] = wall[i] || top[i] === -Infinity || top[i] > floorY + stepHeight ? 1 : 0;
  }

  return { box, originX, originZ, cols, rows, cell, top, blocked };
}

/** 點到線段的距離平方（XZ 平面） */
function pointSegmentDistanceSq(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lengthSq = dx * dx + dz * dz;
  let t = lengthSq > 1e-9 ? ((px - x1) * dx + (pz - z1) * dz) / lengthSq : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + dx * t - px;
  const qz = z1 + dz * t - pz;
  return qx * qx + qz * qz;
}

const WALL_BUCKET = 1.5;

/**
 * 收集真正會擋住角色的牆面線段（XZ 投影），供精確碰撞查詢。
 * 透明貼片不列入；與網格相比沒有格子量化誤差。
 */
function buildWallSegments(root) {
  root.updateWorldMatrix(true, true);
  const box = worldBounds(root);
  const originX = box.min.x;
  const originZ = box.min.z;
  const cols = Math.max(1, Math.ceil((box.max.x - originX) / WALL_BUCKET));
  const rows = Math.max(1, Math.ceil((box.max.z - originZ) / WALL_BUCKET));
  const buckets = Array.from({ length: cols * rows }, () => []);
  const segments = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normal = new THREE.Vector3();

  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some((material) => material && (material.transparent || material.alphaTest > 0))) {
      return;
    }
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const index = geometry.index;
    const matrix = mesh.matrixWorld;
    const total = index ? index.count : position.count;

    for (let i = 0; i < total; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
      b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

      const minY = Math.min(a.y, b.y, c.y);
      const maxY = Math.max(a.y, b.y, c.y);
      if (minY > BODY_HIGH || maxY < BODY_LOW) continue;
      edge.subVectors(b, a).cross(c.clone().sub(a));
      if (edge.lengthSq() < 1e-9) continue;
      normal.copy(edge).normalize();
      if (Math.abs(normal.y) > 0.78) continue;
      if (
        Math.max(a.x, b.x, c.x) - Math.min(a.x, b.x, c.x) > 40
        || Math.max(a.z, b.z, c.z) - Math.min(a.z, b.z, c.z) > 40
      ) {
        continue;
      }

      const edges = [
        [a.x, a.z, b.x, b.z],
        [b.x, b.z, c.x, c.z],
        [c.x, c.z, a.x, a.z],
      ];
      edges.forEach(([x1, z1, x2, z2]) => {
        if (Math.hypot(x2 - x1, z2 - z1) < 0.05) return;
        const segmentIndex = segments.length / 4;
        segments.push(x1, z1, x2, z2);
        const bx0 = Math.max(0, Math.floor((Math.min(x1, x2) - originX) / WALL_BUCKET));
        const bx1 = Math.min(cols - 1, Math.floor((Math.max(x1, x2) - originX) / WALL_BUCKET));
        const bz0 = Math.max(0, Math.floor((Math.min(z1, z2) - originZ) / WALL_BUCKET));
        const bz1 = Math.min(rows - 1, Math.floor((Math.max(z1, z2) - originZ) / WALL_BUCKET));
        for (let bz = bz0; bz <= bz1; bz += 1) {
          for (let bx = bx0; bx <= bx1; bx += 1) {
            buckets[bz * cols + bx].push(segmentIndex);
          }
        }
      });
    }
  });

  return {
    segments: Float32Array.from(segments),
    buckets,
    originX,
    originZ,
    cols,
    rows,
    bucket: WALL_BUCKET,
  };
}

/** 四方向連通元件，回傳每格所屬元件與各元件資訊 */
function findComponents(blocked, cols, rows) {
  const comp = new Int32Array(cols * rows).fill(-1);
  const comps = [];
  for (let start = 0; start < blocked.length; start += 1) {
    if (blocked[start] || comp[start] !== -1) continue;
    const id = comps.length;
    const stack = [start];
    comp[start] = id;
    let size = 0;
    let minX = cols;
    let maxX = -1;
    let minZ = rows;
    let maxZ = -1;
    while (stack.length) {
      const cellIndex = stack.pop();
      size += 1;
      const x = cellIndex % cols;
      const z = (cellIndex - x) / cols;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (x > 0 && !blocked[cellIndex - 1] && comp[cellIndex - 1] === -1) {
        comp[cellIndex - 1] = id;
        stack.push(cellIndex - 1);
      }
      if (x < cols - 1 && !blocked[cellIndex + 1] && comp[cellIndex + 1] === -1) {
        comp[cellIndex + 1] = id;
        stack.push(cellIndex + 1);
      }
      if (z > 0 && !blocked[cellIndex - cols] && comp[cellIndex - cols] === -1) {
        comp[cellIndex - cols] = id;
        stack.push(cellIndex - cols);
      }
      if (z < rows - 1 && !blocked[cellIndex + cols] && comp[cellIndex + cols] === -1) {
        comp[cellIndex + cols] = id;
        stack.push(cellIndex + cols);
      }
    }
    comps.push({ id, size, minX, maxX, minZ, maxZ });
  }
  return { comp, comps };
}

/** 從表面高度直方圖找出最可能的「地板高度」 */
function findFloorCandidates(top) {
  const counts = new Map();
  for (let i = 0; i < top.length; i += 1) {
    if (top[i] === -Infinity) continue;
    const key = Math.round(top[i] * 10) / 10;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((lhs, rhs) => rhs[1] - lhs[1])
    .slice(0, 6)
    .map(([height]) => height);
}

function surfaceAt(top, idx, fallback) {
  return top[idx] === -Infinity ? fallback : top[idx];
}

export class ArenaMap {
  constructor(data) {
    Object.assign(this, data);
    this.size = {
      x: this.cols * this.cell,
      z: this.rows * this.cell,
    };
  }

  cellIndex(x, z) {
    const cx = Math.floor((x - this.originX) / this.cell);
    const cz = Math.floor((z - this.originZ) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  isWalkable(x, z, radius = 0) {
    if (radius <= 0) {
      const index = this.cellIndex(x, z);
      return index >= 0 && this.walkable[index] === 1;
    }
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const cx0 = Math.floor((minX - this.originX) / this.cell);
    const cx1 = Math.floor((maxX - this.originX) / this.cell);
    const cz0 = Math.floor((minZ - this.originZ) / this.cell);
    const cz1 = Math.floor((maxZ - this.originZ) / this.cell);
    if (cx0 < 0 || cz0 < 0 || cx1 >= this.cols || cz1 >= this.rows) return false;
    const radiusSq = radius * radius - 1e-6;
    for (let cz = cz0; cz <= cz1; cz += 1) {
      const cellMinZ = this.originZ + cz * this.cell;
      const cellMaxZ = cellMinZ + this.cell;
      const dz = z < cellMinZ ? cellMinZ - z : z > cellMaxZ ? z - cellMaxZ : 0;
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const index = cz * this.cols + cx;
        if (this.walkable[index] === 1) continue;
        const cellMinX = this.originX + cx * this.cell;
        const cellMaxX = cellMinX + this.cell;
        const dx = x < cellMinX ? cellMinX - x : x > cellMaxX ? x - cellMaxX : 0;
        if (dx * dx + dz * dz < radiusSq) return false;
      }
    }
    return true;
  }

  /** 只檢查地板是否允許站在這裡（牆面由 wallDistance 精確判定） */
  floorAllows(x, z, radius = 0) {
    if (radius <= 0) {
      const index = this.cellIndex(x, z);
      return index >= 0 && this.floorBlocked[index] === 0;
    }
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const cx0 = Math.floor((minX - this.originX) / this.cell);
    const cx1 = Math.floor((maxX - this.originX) / this.cell);
    const cz0 = Math.floor((minZ - this.originZ) / this.cell);
    const cz1 = Math.floor((maxZ - this.originZ) / this.cell);
    if (cx0 < 0 || cz0 < 0 || cx1 >= this.cols || cz1 >= this.rows) return false;
    const radiusSq = radius * radius - 1e-6;
    for (let cz = cz0; cz <= cz1; cz += 1) {
      const cellMinZ = this.originZ + cz * this.cell;
      const cellMaxZ = cellMinZ + this.cell;
      const dz = z < cellMinZ ? cellMinZ - z : z > cellMaxZ ? z - cellMaxZ : 0;
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const index = cz * this.cols + cx;
        if (this.floorBlocked[index] === 0) continue;
        const cellMinX = this.originX + cx * this.cell;
        const cellMaxX = cellMinX + this.cell;
        const dx = x < cellMinX ? cellMinX - x : x > cellMaxX ? x - cellMaxX : 0;
        if (dx * dx + dz * dz < radiusSq) return false;
      }
    }
    return true;
  }

  /** 到最近實際牆面的距離（最多回傳 maxDistance） */
  wallDistance(x, z, maxDistance) {
    const walls = this.walls;
    if (!walls) return maxDistance;
    const { originX, originZ, cols, rows, bucket, buckets, segments } = walls;
    const bx0 = Math.max(0, Math.floor((x - maxDistance - originX) / bucket));
    const bx1 = Math.min(cols - 1, Math.floor((x + maxDistance - originX) / bucket));
    const bz0 = Math.max(0, Math.floor((z - maxDistance - originZ) / bucket));
    const bz1 = Math.min(rows - 1, Math.floor((z + maxDistance - originZ) / bucket));
    let bestSq = maxDistance * maxDistance;
    for (let bz = bz0; bz <= bz1; bz += 1) {
      for (let bx = bx0; bx <= bx1; bx += 1) {
        const list = buckets[bz * cols + bx];
        for (let i = 0; i < list.length; i += 1) {
          const offset = list[i] * 4;
          const distanceSq = pointSegmentDistanceSq(
            x,
            z,
            segments[offset],
            segments[offset + 1],
            segments[offset + 2],
            segments[offset + 3],
          );
          if (distanceSq < bestSq) bestSq = distanceSq;
        }
      }
    }
    return Math.sqrt(bestSq);
  }

  /**
   * 最近的牆面資訊：距離與「由牆指向角色」的法線，供撞牆滑行使用。
   * 找不到牆時回傳 null。
   */
  nearestWall(x, z, maxDistance = 1.5) {
    const walls = this.walls;
    if (!walls) return null;
    const { originX, originZ, cols, rows, bucket, buckets, segments } = walls;
    const bx0 = Math.max(0, Math.floor((x - maxDistance - originX) / bucket));
    const bx1 = Math.min(cols - 1, Math.floor((x + maxDistance - originX) / bucket));
    const bz0 = Math.max(0, Math.floor((z - maxDistance - originZ) / bucket));
    const bz1 = Math.min(rows - 1, Math.floor((z + maxDistance - originZ) / bucket));
    let bestSq = maxDistance * maxDistance;
    let bestX = 0;
    let bestZ = 0;
    let found = false;
    for (let bz = bz0; bz <= bz1; bz += 1) {
      for (let bx = bx0; bx <= bx1; bx += 1) {
        const list = buckets[bz * cols + bx];
        for (let i = 0; i < list.length; i += 1) {
          const offset = list[i] * 4;
          const x1 = segments[offset];
          const z1 = segments[offset + 1];
          const x2 = segments[offset + 2];
          const z2 = segments[offset + 3];
          const dx = x2 - x1;
          const dz = z2 - z1;
          const lengthSq = dx * dx + dz * dz;
          let t = lengthSq > 1e-9 ? ((x - x1) * dx + (z - z1) * dz) / lengthSq : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = x1 + dx * t;
          const cz = z1 + dz * t;
          const ox = x - cx;
          const oz = z - cz;
          const distanceSq = ox * ox + oz * oz;
          if (distanceSq < bestSq) {
            bestSq = distanceSq;
            bestX = cx;
            bestZ = cz;
            found = true;
          }
        }
      }
    }
    if (!found) return null;
    const distance = Math.sqrt(bestSq);
    let nx = x - bestX;
    let nz = z - bestZ;
    const length = Math.hypot(nx, nz);
    if (length < 1e-6) {
      nx = 0;
      nz = 1;
    } else {
      nx /= length;
      nz /= length;
    }
    return { distance, nx, nz, x: bestX, z: bestZ };
  }

  /**
   * 角色（圓形）是否可以站在這個位置：有地板，且離實際牆面足夠遠。
   */
  canStand(x, z, radius = 0.38) {
    if (!this.floorAllows(x, z, radius)) return false;
    return this.wallDistance(x, z, radius) >= radius - 1e-4;
  }

  groundAt(x, z, fallback = 0) {
    const index = this.cellIndex(x, z);
    if (index < 0) return fallback;
    return this.surface[index];
  }

  /** 線段是否被牆阻擋（視線、子彈） */
  segmentBlocked(x1, z1, x2, z2) {
    return this.rayBlockedDistance(x1, z1, x2, z2) !== null;
  }

  /** 回傳從 (x1,z1) 往 (x2,z2) 方向第一個受阻的距離 */
  rayBlockedDistance(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return null;
    const step = this.cell * 0.5;
    const steps = Math.ceil(distance / step);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      if (!this.isWalkable(x1 + dx * t, z1 + dz * t)) return distance * t;
    }
    return null;
  }

  nearestWalkable(x, z, radius = 0.5, maxSearch = 24) {
    if (this.isWalkable(x, z, radius)) return new THREE.Vector3(x, this.groundAt(x, z), z);
    for (let ring = 1; ring <= maxSearch; ring += 1) {
      const samples = ring * 8;
      for (let i = 0; i < samples; i += 1) {
        const angle = (i / samples) * Math.PI * 2;
        const px = x + Math.cos(angle) * ring * this.cell * 2;
        const pz = z + Math.sin(angle) * ring * this.cell * 2;
        if (this.isWalkable(px, pz, radius)) {
          return new THREE.Vector3(px, this.groundAt(px, pz), pz);
        }
      }
    }
    return null;
  }

  randomWalkablePoint(radius = 0.6, options = {}) {
    const { avoid = null, minDistance = 0, maxTries = 240 } = options;
    for (let i = 0; i < maxTries; i += 1) {
      const x = THREE.MathUtils.randFloat(this.bounds.minX, this.bounds.maxX);
      const z = THREE.MathUtils.randFloat(this.bounds.minZ, this.bounds.maxZ);
      if (!this.isWalkable(x, z, radius)) continue;
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < minDistance) continue;
      return new THREE.Vector3(x, this.groundAt(x, z), z);
    }
    return this.spawnPoint.clone();
  }

  spawnPoints(count, radius = 0.8) {
    const farFromSpawn = 14;
    const points = [];
    for (let i = 0; i < count; i += 1) {
      const point = this.randomWalkablePoint(radius, {
        avoid: this.spawnPoint,
        minDistance: farFromSpawn,
      });
      points.push(point);
    }
    return points;
  }

  /** 產生小地圖底圖（涵蓋競技場可走範圍） */
  createMinimapBackground(size) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const bounds = this.bounds;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    const scale = (size - 12) / span;
    const offsetX = size / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    const offsetZ = size / 2 - ((bounds.minZ + bounds.maxZ) / 2) * scale;
    const toX = (x) => x * scale + offsetX;
    const toZ = (z) => z * scale + offsetZ;

    context.fillStyle = "#071126";
    context.fillRect(0, 0, size, size);

    const cellPx = Math.max(1, Math.ceil(this.cell * scale));
    const cx0 = Math.max(0, Math.floor((bounds.minX - this.originX) / this.cell) - 1);
    const cx1 = Math.min(this.cols - 1, Math.ceil((bounds.maxX - this.originX) / this.cell) + 1);
    const cz0 = Math.max(0, Math.floor((bounds.minZ - this.originZ) / this.cell) - 1);
    const cz1 = Math.min(this.rows - 1, Math.ceil((bounds.maxZ - this.originZ) / this.cell) + 1);

    for (let cz = cz0; cz <= cz1; cz += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const index = cz * this.cols + cx;
        if (this.walkable[index] === 1) continue;
        const surface = this.top[index];
        const x = this.originX + cx * this.cell;
        const z = this.originZ + cz * this.cell;
        if (surface === -Infinity) {
          context.fillStyle = "rgba(41, 73, 122, 0.55)";
        } else if (surface > 5) {
          context.fillStyle = "rgba(96, 150, 220, 0.86)";
        } else if (surface > 2.2) {
          context.fillStyle = "rgba(74, 123, 190, 0.8)";
        } else {
          context.fillStyle = "rgba(58, 98, 152, 0.72)";
        }
        context.fillRect(toX(x), toZ(z), cellPx, cellPx);
      }
    }

    context.strokeStyle = "rgba(123, 224, 255, 0.35)";
    context.lineWidth = 1.5;
    context.strokeRect(
      toX(bounds.minX),
      toZ(bounds.minZ),
      (bounds.maxX - bounds.minX) * scale,
      (bounds.maxZ - bounds.minZ) * scale,
    );
    return canvas;
  }
}

async function loadGltf(url, onProgress) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      resolve,
      (event) => {
        if (!onProgress) return;
        const total = event.total || 0;
        onProgress(total ? event.loaded / total : 0);
      },
      reject,
    );
  });
}

/**
 * 載入 GLB 地圖，自動縮放、置中並產生碰撞網格。
 */
export async function loadArenaMap({ onProgress } = {}) {
  const gltf = await loadGltf(MAP_URL, onProgress);
  const model = gltf.scene;
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
  });

  const holder = new THREE.Group();
  holder.add(model);
  const scene = new THREE.Scene();
  scene.add(holder);

  // 第一階段：正規化到 60 公尺寬，找出競技場地板與可走範圍
  const rawBox = worldBounds(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.getCenter(new THREE.Vector3());
  const stageScale = STAGE_A_SPAN / Math.max(rawSize.x, rawSize.z, 0.001);
  model.position.set(-rawCenter.x, -rawBox.min.y, -rawCenter.z);
  holder.scale.setScalar(stageScale);
  scene.updateMatrixWorld(true);

  const stageBox = worldBounds(holder);
  const stageGrid = buildGrid(holder, {
    cell: 0.5,
    floorY: stageBox.min.y,
    probeHeight: stageBox.max.y - stageBox.min.y + 1,
    stepHeight: STEP_HEIGHT * (STAGE_A_SPAN / TARGET_ARENA_SPAN),
    markWalls: false,
  });

  let best = null;
  const candidates = findFloorCandidates(stageGrid.top);
  for (const floorHeight of candidates) {
    const floor = floorHeight;
    const step = STEP_HEIGHT * (STAGE_A_SPAN / TARGET_ARENA_SPAN);
    const blocked = new Uint8Array(stageGrid.blocked.length);
    for (let i = 0; i < blocked.length; i += 1) {
      const surface = stageGrid.top[i];
      blocked[i] = surface === -Infinity || surface > floor + step ? 1 : 0;
    }
    const { comp, comps } = findComponents(blocked, stageGrid.cols, stageGrid.rows);
    const enclosed = comps
      .filter((item) => item.size > 120)
      .filter(
        (item) =>
          item.minX > 1 &&
          item.minZ > 1 &&
          item.maxX < stageGrid.cols - 2 &&
          item.maxZ < stageGrid.rows - 2,
      )
      .sort((lhs, rhs) => rhs.size - lhs.size);
    if (!enclosed.length) continue;
    const chosen = enclosed[0];
    if (!best || chosen.size > best.size) {
      best = { floor, comp: chosen, compMap: comp, grid: stageGrid };
    }
  }

  if (!best) {
    throw new Error("無法從地圖中辨識出可遊玩的競技場地面");
  }

  const stageCell = stageGrid.cell;
  const arenaCenterX = stageGrid.originX + (best.comp.minX + best.comp.maxX + 1) * 0.5 * stageCell;
  const arenaCenterZ = stageGrid.originZ + (best.comp.minZ + best.comp.maxZ + 1) * 0.5 * stageCell;
  const arenaWidthX = (best.comp.maxX - best.comp.minX + 1) * stageCell;
  const arenaWidthZ = (best.comp.maxZ - best.comp.minZ + 1) * stageCell;
  const arenaSpan = Math.max(arenaWidthX, arenaWidthZ);
  const extraScale = TARGET_ARENA_SPAN / Math.max(arenaSpan, 1);
  const finalScale = stageScale * extraScale;

  // 第二階段：放到最終比例，並讓競技場中心落在原點、地板落在 y = 0
  holder.scale.setScalar(finalScale);
  holder.position.set(
    (-arenaCenterX / stageScale) * finalScale,
    (-best.floor / stageScale) * finalScale,
    (-arenaCenterZ / stageScale) * finalScale,
  );
  scene.updateMatrixWorld(true);

  const grid = buildGrid(holder, {
    cell: CELL_SIZE,
    floorY: 0,
    probeHeight: PLAYER_PROBE_HEIGHT,
    stepHeight: STEP_HEIGHT,
    markWalls: true,
  });
  const { comp, comps } = findComponents(grid.blocked, grid.cols, grid.rows);
  const arenaComp = pickArenaComponent(comp, comps, grid, 0, 0);
  if (!arenaComp) {
    throw new Error("無法建立地圖碰撞資料");
  }

  const walkable = new Uint8Array(grid.blocked.length);
  const surface = new Float32Array(grid.blocked.length);
  for (let i = 0; i < walkable.length; i += 1) {
    walkable[i] = !grid.blocked[i] && comp[i] === arenaComp.id ? 1 : 0;
    surface[i] = surfaceAt(grid.top, i, 0);
  }

  const bounds = {
    minX: grid.originX + arenaComp.minX * grid.cell,
    maxX: grid.originX + (arenaComp.maxX + 1) * grid.cell,
    minZ: grid.originZ + arenaComp.minZ * grid.cell,
    maxZ: grid.originZ + (arenaComp.maxZ + 1) * grid.cell,
  };

  // 地板判定（不含牆面）＋只保留競技場周邊，避免場外地面也能站
  const floorBlocked = new Uint8Array(grid.blocked.length);
  for (let i = 0; i < floorBlocked.length; i += 1) {
    const top = grid.top[i];
    floorBlocked[i] = top === -Infinity || top > STEP_HEIGHT ? 1 : 0;
  }
  const nearArena = new Uint8Array(grid.blocked.length);
  for (let cz = 0; cz < grid.rows; cz += 1) {
    for (let cx = 0; cx < grid.cols; cx += 1) {
      if (!walkable[cz * grid.cols + cx]) continue;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= grid.cols || nz >= grid.rows) continue;
          nearArena[nz * grid.cols + nx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < floorBlocked.length; i += 1) {
    if (!nearArena[i]) floorBlocked[i] = 1;
  }

  const walls = buildWallSegments(holder);

  const map = new ArenaMap({
    root: holder,
    originX: grid.originX,
    originZ: grid.originZ,
    cols: grid.cols,
    rows: grid.rows,
    cell: grid.cell,
    walkable,
    top: grid.top,
    surface,
    floorBlocked,
    walls,
    bounds,
    scale: finalScale,
    spawnPoint: new THREE.Vector3(0, 0, 0),
  });

  const spawn = selectSpawn(map, bounds);
  if (!spawn) throw new Error("地圖中找不到可站立的位置");
  map.spawnPoint.copy(spawn.point);
  map.spawnYaw = spawn.yaw;
  return map;
}

/**
 * 在競技場中央附近挑選最空曠的可站立格，並回傳面向最開闊方向的視角。
 */
function selectSpawn(map, bounds) {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const halfX = (bounds.maxX - bounds.minX) / 2;
  const halfZ = (bounds.maxZ - bounds.minZ) / 2;
  const searchRadius = Math.max(2, Math.min(halfX, halfZ) * 0.55);
  const maxRay = 24;
  const step = map.cell;
  const stepCount = Math.ceil(maxRay / step);
  const directions = [];
  const rayLengths = [];
  const dirCount = 16;
  for (let i = 0; i < dirCount; i += 1) {
    const angle = (i / dirCount) * Math.PI * 2;
    directions.push([Math.cos(angle), Math.sin(angle)]);
    rayLengths.push(0);
  }

  let bestPoint = null;
  let bestScore = -Infinity;
  let bestDirs = rayLengths.slice();

  for (let z = centerZ - searchRadius; z <= centerZ + searchRadius; z += step * 2) {
    for (let x = centerX - searchRadius; x <= centerX + searchRadius; x += step * 2) {
      if (!map.canStand(x, z, 0.5)) continue;
      let score = 0;
      let open = true;
      for (let i = 0; i < dirCount; i += 1) {
        const [dx, dz] = directions[i];
        let distance = 0;
        for (let s = 1; s <= stepCount; s += 1) {
          const px = x + dx * s * step;
          const pz = z + dz * s * step;
          if (!map.canStand(px, pz, 0.35)) break;
          distance = s * step;
        }
        rayLengths[i] = distance;
        if (i % 2 === 0 && distance < 2.2) {
          open = false;
          break;
        }
        score += Math.min(distance, 16);
      }
      if (!open) continue;
      score -= Math.hypot(x - centerX, z - centerZ) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestPoint = { x, z };
        bestDirs = rayLengths.slice();
      }
    }
  }

  if (!bestPoint) {
    const fallback = map.nearestWalkable(centerX, centerZ, 0.7);
    return fallback ? { point: fallback, yaw: 0 } : null;
  }

  let bestIndex = 0;
  for (let i = 1; i < bestDirs.length; i += 1) {
    if (bestDirs[i] > bestDirs[bestIndex]) bestIndex = i;
  }
  const [dx, dz] = directions[bestIndex];
  return {
    point: new THREE.Vector3(bestPoint.x, map.groundAt(bestPoint.x, bestPoint.z), bestPoint.z),
    yaw: Math.atan2(-dx, -dz),
  };
}

function pickArenaComponent(comp, comps, grid, x, z) {
  const index = Math.floor((z - grid.originZ) / grid.cell) * grid.cols
    + Math.floor((x - grid.originX) / grid.cell);
  const nearbyId = comp[index];
  if (nearbyId >= 0) {
    const nearby = comps.find((item) => item.id === nearbyId);
    if (nearby && nearby.size > 120) return nearby;
  }
  return comps
    .filter((item) => item.size > 120)
    .sort((lhs, rhs) => rhs.size - lhs.size)[0] || null;
}
