/* ============================================================
   TERRA · 程序化纹理工具

   移植自 star/js/textures.js，去掉了 13 个行星纹理分支（与地理无关），
   保留与领域无关的噪声工具箱和辉光生成器。

   注：球面纹理生成器 buildCanvas 已移到 js/geo.js，
   那边用的是修正过的经纬度约定（详见 geo.js 顶部说明）。
   ============================================================ */

const TexGen = (function () {

  /* ---------------- 基础工具 ---------------- */

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

  function smoothstep(e0, e1, x) {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  /* ---------------- 噪声 ----------------
     在球面上取 3D 噪声，天然没有经度接缝问题 */

  function hash3(x, y, z, seed) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
            Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  function noise3(x, y, z, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);

    const n000 = hash3(xi, yi, zi, seed),         n100 = hash3(xi + 1, yi, zi, seed);
    const n010 = hash3(xi, yi + 1, zi, seed),     n110 = hash3(xi + 1, yi + 1, zi, seed);
    const n001 = hash3(xi, yi, zi + 1, seed),     n101 = hash3(xi + 1, yi, zi + 1, seed);
    const n011 = hash3(xi, yi + 1, zi + 1, seed), n111 = hash3(xi + 1, yi + 1, zi + 1, seed);

    const x00 = n000 + (n100 - n000) * u, x10 = n010 + (n110 - n010) * u;
    const x01 = n001 + (n101 - n001) * u, x11 = n011 + (n111 - n011) * u;
    const y0 = x00 + (x10 - x00) * v,     y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }

  function noise1(x, seed) {
    const xi = Math.floor(x), xf = x - xi;
    const u = xf * xf * (3 - 2 * xf);
    const a = hash3(xi, 0, 0, seed), b = hash3(xi + 1, 0, 0, seed);
    return a + (b - a) * u;
  }

  /** 分形布朗运动：叠加多个频率的噪声，得到自然的不规则感 */
  function fbm3(x, y, z, seed, octaves, gain, lac) {
    octaves = octaves || 5; gain = gain || 0.5; lac = lac || 2.0;
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise3(x * f, y * f, z * f, seed + i * 131);
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** 脊状噪声：产生山脉、沟壑一类的锐利结构 */
  function ridged3(x, y, z, seed, octaves) {
    octaves = octaves || 4;
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise3(x * f, y * f, z * f, seed + i * 137) * 2 - 1);
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  /* ---------------- 辉光贴图 ----------------
     零领域耦合：标记点、光晕都用它 */

  function makeGlowTexture(inner, power) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const half = size / 2;
    const p = power || 2.4;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const d = Math.sqrt(dx * dx + dy * dy);
        let a = Math.pow(Math.max(0, 1 - Math.min(1, d)), p);
        if (a < 0.008) a = 0;                        // 低alpha量化归零，避免方形边缘
        const k = (y * size + x) * 4;
        data[k] = inner[0]; data[k + 1] = inner[1]; data[k + 2] = inner[2];
        data[k + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  /* ---------------- 纹理缓存 ----------------
     同一 key 只生成一次，避免重复计算 */

  const cache = new Map();

  function cached(key, factory) {
    if (cache.has(key)) return cache.get(key);
    const v = factory();
    cache.set(key, v);
    return v;
  }

  function clearCache() { cache.clear(); }

  return {
    clamp01, lerp, mix, smoothstep,
    hash3, noise3, noise1, fbm3, ridged3,
    makeGlowTexture,
    cached, clearCache,
    maxAnisotropy: 1,
  };
})();
