/* ============================================================
   TERRA · 地理坐标工具

   ⚠️ 本文件的坐标约定经工具脚本实测验证（tools/verify-uv.mjs，
      10/10 特征点命中），改动前请先跑一遍验证。

   three.js 的 SphereGeometry 顶点公式（r128 源码）：
       x = -r·cos(phi)·sin(theta)     phi   = u·2π
       y =  r·cos(theta)              theta = v·π
       z =  r·sin(phi)·sin(theta)     uv    = (u, 1-v)

   配合纹理默认的 flipY=true，得到实际贴图约定：
       u: 0 = 180°W  →  1 = 180°E      （图片左边缘是西经 180°）
       v: 0 = 北极   →  1 = 南极        （图片第一行是北极）
    即经度 0° 落在 +X 轴，90°E 落在 -Z 轴。

   ★ 注意：star 项目里 TexGen.buildCanvas 的 sampler 收到的是
     (cos(lat)cos(lon), sin(lat), cos(lat)sin(lon))，z 分量符号相反，
     等价于把经度取负。那是给程序化噪声用的，没有真实经度语义；
     套到真实地理数据上会东西镜像。本文件已修正。
   ============================================================ */

const Geo = (function () {

  const DEG = Math.PI / 180;

  /* ---------------- 经纬度 ↔ 球面 ---------------- */

  /** 经纬度 → 球面位置。与 SphereGeometry 的顶点位置严格一致 */
  function latLonToVec3(lat, lon, radius) {
    const la = lat * DEG, lo = lon * DEG;
    const cl = Math.cos(la);
    const r = radius === undefined ? 1 : radius;
    return {
      x:  r * cl * Math.cos(lo),
      y:  r * Math.sin(la),
      z: -r * cl * Math.sin(lo),
    };
  }

  /** 球面位置 → 经纬度。用于拾取：射线打中球面后反查在哪 */
  function vec3ToLatLon(v) {
    const r = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    return {
      lat: Math.asin(Math.max(-1, Math.min(1, v.y / r))) / DEG,
      lon: Math.atan2(-v.z, v.x) / DEG,
    };
  }

  /** 经纬度 → 归一化 UV（u 为经度方向，v 为纬度方向，v=0 是北极） */
  function latLonToUV(lat, lon) {
    return { u: (lon + 180) / 360, v: (90 - lat) / 180 };
  }

  /* ---------------- 球面纹理生成 ---------------- */

  /**
   * 逐像素生成一张等距圆柱投影纹理。
   *
   * 与 star 的 TexGen.buildCanvas 的区别：sampler 直接拿到**真实经纬度**，
   * 不用自己算球面向量，也就不会再踩上面那个镜像的坑。
   *
   * sampler(lat, lon, u, v, out) —— out 是复用的 [r,g,b,a]，
   * 必须自己写 out[3]（透明层用得上）。
   */
  function buildCanvas(width, height, sampler) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const data = img.data;
    const out = [0, 0, 0, 255];

    for (let j = 0; j < height; j++) {
      const v = (j + 0.5) / height;
      const lat = 90 - v * 180;
      for (let i = 0; i < width; i++) {
        const u = (i + 0.5) / width;
        const lon = u * 360 - 180;
        out[0] = out[1] = out[2] = 0; out[3] = 255;
        sampler(lat, lon, u, v, out);
        const k = (j * width + i) * 4;
        data[k] = out[0]; data[k + 1] = out[1]; data[k + 2] = out[2]; data[k + 3] = out[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* ---------------- 矢量：经纬度线 → 球面线 ---------------- */

  const _va = { x: 0, y: 0, z: 0 }, _vb = { x: 0, y: 0, z: 0 };

  /** 单位向量球面线性插值（沿大圆走，保证线条贴着球面而不是切进球里） */
  function slerp(a, b, t) {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z;
    dot = Math.max(-1, Math.min(1, dot));
    const theta = Math.acos(dot);
    if (theta < 1e-7) return { x: a.x, y: a.y, z: a.z };
    const s = Math.sin(theta);
    const w1 = Math.sin((1 - t) * theta) / s;
    const w2 = Math.sin(t * theta) / s;
    return {
      x: a.x * w1 + b.x * w2,
      y: a.y * w1 + b.y * w2,
      z: a.z * w1 + b.z * w2,
    };
  }

  /**
   * 把一组经纬度坐标铺到球面上，返回扁平的 [x,y,z, x,y,z, ...]。
   *
   * 做两件事：
   *  1. 跨 180° 经线的相邻点会被拆开（否则会横穿整个地球）；
   *  2. 相邻点夹角过大时按大圆细分，避免长线段切进球体内部。
   *
   * maxStepDeg 控制细分粒度：角度越大，线条越贴合球面、顶点也越多。
   */
  function lineToSphere(coords, radius, maxStepDeg, sealSeam) {
    const maxStep = (maxStepDeg === undefined ? 2 : maxStepDeg) * DEG;
    const out = [];
    let prev = null;
    let prevLon = null;

    for (let n = 0; n < coords.length; n++) {
      const lon = coords[n][0], lat = coords[n][1];
      const p = latLonToVec3(lat, lon, radius);

      if (prev) {
        // 经度跳变超过 180° 说明这条线跨了接缝，断开另起一段
        if (sealSeam !== false && Math.abs(lon - prevLon) > 180) {
          prev = p; prevLon = lon;
          out.push(NaN, NaN, NaN);   // 分隔标记，由调用方切成多段
          continue;
        }
        // 按大圆细分
        const dot = Math.max(-1, Math.min(1,
          (prev.x * p.x + prev.y * p.y + prev.z * p.z) / (radius * radius)));
        const ang = Math.acos(dot);
        const steps = Math.ceil(ang / maxStep);
        for (let s = 1; s < steps; s++) {
          const q = slerp(prev, p, s / steps);
          out.push(q.x, q.y, q.z);
        }
      }
      out.push(p.x, p.y, p.z);
      prev = p; prevLon = lon;
    }
    return out;
  }

  /** 把一个 GeoJSON 几何体的所有线段铺成球面点集，返回多段（每段一个 Float32Array） */
  function geometryToSegments(geometry, radius, maxStepDeg) {
    const lines = [];
    const push = (coords) => {
      const flat = lineToSphere(coords, radius, maxStepDeg);
      // 按 NaN 分隔标记切段
      let cur = [];
      for (let i = 0; i < flat.length; i += 3) {
        if (Number.isNaN(flat[i])) { if (cur.length >= 6) lines.push(cur); cur = []; }
        else cur.push(flat[i], flat[i + 1], flat[i + 2]);
      }
      if (cur.length >= 6) lines.push(cur);
    };

    const g = geometry;
    if (g.type === 'LineString') push(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(push);
    else if (g.type === 'Polygon') g.coordinates.forEach(push);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(ring => ring.forEach(push));

    return lines;
  }

  /* ---------------- 点在多边形内（拾取时判断陆地/板块） ---------------- */

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** 判断经纬度落在哪个多边形的属性上，命中返回该 feature 的 properties，否则 null */
  function findPolygon(lon, lat, features) {
    for (let f = 0; f < features.length; f++) {
      const g = features[f].geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
                  : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (let p = 0; p < polys.length; p++) {
        const rings = polys[p];
        // 外环命中且不在任何内环里，才算真的在多边形内
        if (pointInRing(lon, lat, rings[0])) {
          let inHole = false;
          for (let h = 1; h < rings.length; h++) {
            if (pointInRing(lon, lat, rings[h])) { inHole = true; break; }
          }
          if (!inHole) return features[f].properties;
        }
      }
    }
    return null;
  }

  /* ---------------- 杂项 ---------------- */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  return {
    DEG,
    latLonToVec3, vec3ToLatLon, latLonToUV,
    buildCanvas,
    slerp, lineToSphere, geometryToSegments,
    pointInRing, findPolygon,
    clamp,
  };
})();
