/* 足迹地图 · 应用逻辑
 * 世界模式：Canvas 正交投影地球仪（可拖拽旋转 / 滚轮缩放 / 点击国家城市）
 * 中国模式：Albers 等积圆锥投影的城市地图（370 个城市多边形）
 */
(() => {
  'use strict';

  const GEO = window.GEO;
  const D = Math.PI / 180;
  const TAU = Math.PI * 2;
  const $ = (s, el) => (el || document).querySelector(s);
  const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);

  /* ---------------- 小工具 ---------------- */
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const num = (n) => Number(n) || 0;
  const fmtInt = (n) => (n || 0).toLocaleString('zh-CN');

  const ETHNIC_RE = /(维吾尔|壮族|回族|蒙古族|藏族|苗族|侗族|瑶族|白族|傣族|彝族|哈尼族|景颇族|傈僳族|拉祜族|佤族|纳西族|羌族|土家族|布依族|朝鲜族|满族|黎族|畲族|水族|仡佬族|仫佬族|毛南族|京族|达斡尔族|鄂温克族|鄂伦春族|赫哲族|锡伯族|柯尔克孜族|塔吉克族|乌孜别克族|俄罗斯族|塔塔尔族|独龙族|怒族|德昂族|阿昌族|普米族|基诺族|布朗族|保安族|撒拉族|东乡族|土族|裕固族|门巴族|珞巴族)/g;

  function countryLabel(c) {
    if (!c) return '';
    if (c.code === 'CHN') return '中国';
    const z = c.name_zh || c.name || '';
    return z.replace(/联邦$/, '');
  }

  function prettyName(name) {
    if (!name) return '';
    let s = String(name);
    if (s === '内蒙古自治区') return '内蒙古';
    s = s.replace(ETHNIC_RE, '');
    s = s.replace(/(特别行政区|自治区|自治州|自治县|地区|林区|省|市)$/, '');
    return s || String(name);
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  /* ---------------- 全局状态 ---------------- */
  const state = {
    mode: 'globe',
    places: [],
    selectedId: null,
    query: '',
    tab: 'places',
    trip: null,
    globe: { lon: 104, lat: 28, zoom: 1, vLon: 0, vLat: 0 },
    china: { k: 1, tx: 0, ty: 0, fit: false, vx: 0, vy: 0 },
    hover: null,
    view: { W: 0, H: 0, R: 0, cx: 0, cy: 0 },
    draft: null,
    replay: {
      active: false, items: [], cursor: 0, cityLit: new Map(),
      flash: [], segments: [], lastPos: null, timer: null, raf: null,
    },
  };

  const CITIES = GEO.cities;
  const COUNTRIES = GEO.countries;
  const PROVINCES = GEO.provinces;
  const WORLDCITIES = GEO.places;
  let COUNTIES_ALL = [];
  let BORDER = null;
  let CHINA_BBOX = null;
  let CHINA_PAN = null;
  let BORDER_BBOX = null;
  let countyLoadState = 'none';
  let countyLoadPromise = null;

  const cityByCode = new Map();
  const countyByCode = new Map();
  const cityCounties = new Map();    // cityCode -> county[]
  const cityVisited = new Map();     // code -> place
  const countyVisited = new Map();   // code -> place
  const homeCities = new Set();      // 家的城市 code
  const countryVisited = new Set();  // code
  const countryByName = new Map();

  function indexCounties() {
    countyByCode.clear();
    cityCounties.clear();
    for (const c of COUNTIES_ALL) {
      countyByCode.set(c.code, c);
      if (c.cityCode) {
        if (!cityCounties.has(c.cityCode)) cityCounties.set(c.cityCode, []);
        cityCounties.get(c.cityCode).push(c);
      }
    }
  }

  function ensureCounties() {
    if (countyLoadState === 'ready') return Promise.resolve();
    if (countyLoadState === 'loading') return countyLoadPromise;
    if (window.GEO_COUNTIES && window.GEO_COUNTIES.counties && !COUNTIES_ALL.length) {
      COUNTIES_ALL = window.GEO_COUNTIES.counties.map((c) => ({
        code: c.c, name: c.n, cityCode: c.cc, city: c.cy, province: c.p,
        center: c.ct, g: c.g,
      }));
      indexCounties();
      countyLoadState = 'ready';
      state.china.countyLevel = true;
      return Promise.resolve();
    }
    countyLoadState = 'loading';
    countyLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'geo_counties.js';
      s.onload = () => {
        try {
          const raw = (window.GEO_COUNTIES && window.GEO_COUNTIES.counties) || [];
          COUNTIES_ALL = raw.map((c) => ({
            code: c.c, name: c.n, cityCode: c.cc, city: c.cy, province: c.p,
            center: c.ct, g: c.g,
          }));
          indexCounties();
          countyLoadState = 'ready';
          rebuildIndexes();
          requestDraw();
          resolve();
        } catch (e) {
          countyLoadState = 'none';
          reject(e);
        }
      };
      s.onerror = () => { countyLoadState = 'none'; reject(new Error('区县数据加载失败')); };
      document.head.appendChild(s);
    });
    return countyLoadPromise;
  }

  /* ---------------- 持久化 ---------------- */
  const LS_KEY = 'travel-atlas-v1';
  const DATA_URL = 'data/travel.json';
  let saveTimer = null;

  async function loadState() {
    let raw = null;
    let fromFile = false;
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) { raw = await res.text(); fromFile = true; }
    } catch (e) { /* 文件不存在或 fetch 不可用 */ }
    if (!raw) {
      try { raw = localStorage.getItem(LS_KEY); } catch (e) { /* ignore */ }
    }
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.places)) {
        state.places = obj.places.map(normalizePlace).filter(Boolean);
      }
    } catch (e) { toast('数据文件损坏，已忽略'); }
    if (!fromFile && state.places.length) saveState(); // 首次从 localStorage 迁移到文件
  }

  function normalizePlace(p) {
    if (!p || typeof p !== 'object') return null;
    const out = {
      id: p.id || uid(),
      name: String(p.name || ''),
      spot: String(p.spot || ''),
      from: String(p.from || ''),
      cityCode: String(p.cityCode || ''),
      cityName: String(p.cityName || ''),
      countyCode: String(p.countyCode || ''),
      countyName: String(p.countyName || ''),
      province: String(p.province || ''),
      countryCode: String(p.countryCode || ''),
      countryName: String(p.countryName || ''),
      lon: num(p.lon),
      lat: num(p.lat),
      status: p.status === 'wish' ? 'wish' : 'visited',
      isHome: !!p.isHome,
      starred: !!p.starred,
      visits: Array.isArray(p.visits) ? p.visits.map((v) => ({
        date: String(v.date || ''),
        days: v.days === '' || v.days == null ? '' : num(v.days),
        hours: v.hours === '' || v.hours == null ? '' : num(v.hours),
        note: String(v.note || ''),
      })) : [],
      note: String(p.note || ''),
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      photos: Array.isArray(p.photos) ? p.photos.map((x) => ({ file: String((x && x.file) || x || '') })).filter((x) => x.file) : [],
      journal: Array.isArray(p.journal) ? p.journal.map((j) => ({ date: String((j && j.date) || ''), text: String((j && j.text) || '') })) : [],
      updatedAt: p.updatedAt || Date.now(),
    };
    if (!out.visits.length) out.visits = [{ date: '', days: '', note: '' }];
    return out;
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const raw = JSON.stringify({ version: 1, places: state.places });
      try { localStorage.setItem(LS_KEY, raw); } catch (e) { /* ignore */ }
      try {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage('DATA|' + raw);
        } else if (window.travelFS) {
          window.travelFS.write(raw);
        }
      } catch (e) {
        toast('保存失败：' + (e && e.message ? e.message : e));
      }
    }, 150);
  }

  /* ---------------- 几何工具 ---------------- */
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function geomPolygons(geom) {
    return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  }

  function pointInGeom(lon, lat, geom) {
    const polys = geomPolygons(geom);
    for (const poly of polys) {
      if (!poly.length) continue;
      const outer = poly[0];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of outer) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
      if (pointInRing(lon, lat, outer) && !poly.slice(1).some((h) => pointInRing(lon, lat, h))) return true;
    }
    return false;
  }

  function sphereVec(lon, lat) {
    const p = lat * D, l = lon * D, cp = Math.cos(p);
    return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
  }

  function makeRot(lon0, lat0) {
    const cl = Math.cos(lon0 * D), sl = Math.sin(lon0 * D);
    const sp = Math.sin(lat0 * D), cp = Math.cos(lat0 * D);
    // 视图三轴：X=东（屏幕右）、Y=北（屏幕上）、Z=指向观察者
    return [
      -sl, cl, 0,
      -cl * sp, -sl * sp, cp,
      cl * cp, sl * cp, sp,
    ];
  }

  /* ---------------- 中国 Albers 投影 ---------------- */
  const AL = (() => {
    const p0 = 25 * D, l0 = 105 * D, p1 = 25 * D, p2 = 47 * D;
    const n = (Math.sin(p1) + Math.sin(p2)) / 2;
    const C = Math.cos(p1) * Math.cos(p1) + 2 * n * Math.sin(p1);
    const rho0 = Math.sqrt(C - 2 * n * Math.sin(p0)) / n;
    return { n, C, rho0, l0 };
  })();

  function albers(lon, lat) {
    const phi = lat * D, lam = lon * D;
    const rho = Math.sqrt(Math.max(0, AL.C - 2 * AL.n * Math.sin(phi))) / AL.n;
    const th = AL.n * (lam - AL.l0);
    return [rho * Math.sin(th), AL.rho0 - rho * Math.cos(th)];
  }

  /* ---------------- 数据预处理 ---------------- */
  function prepData() {
    CITIES.forEach((c) => {
      cityByCode.set(c.code, c);
      c._polys = geomPolygons(c.geom).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => albers(lon, lat)))
      );
      const p = albers(c.center[0], c.center[1]);
      c._p = p;
    });

    indexCounties();

    PROVINCES.forEach((p) => {
      p._polys = geomPolygons(p.geom).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => albers(lon, lat)))
      );
    });

    if (GEO.border) {
      BORDER = {
        _polys: geomPolygons(GEO.border).map((poly) =>
          poly.map((ring) => ring.map(([lon, lat]) => albers(lon, lat)))
        ),
      };
    }

    COUNTRIES.forEach((c) => {
      c._v = geomPolygons(c.geom).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => sphereVec(lon, lat)))
      );
      // 中国地图模式下的周边国家底图
      c._al = geomPolygons(c.geom).map((poly) =>
        poly.map((ring) => ring.map(([lon, lat]) => albers(lon, lat)))
      );
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const poly of c._al) for (const ring of poly) for (const [x, y] of ring) {
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
      c._alBox = [bx0, by0, bx1, by1];
      if (c.name) countryByName.set(String(c.name).toLowerCase(), c);
      if (c.name_zh) countryByName.set(String(c.name_zh), c);
    });

    WORLDCITIES.forEach((p) => {
      p._v = sphereVec(p.lon, p.lat);
      p._p = albers(p.lon, p.lat);
      const cn = countryByName.get(String(p.country || '').toLowerCase());
      p._countryCode = cn ? cn.code : '';
      p._countryZh = cn ? cn.name_zh : (p.country_zh || p.country || '');
    });
  }

  function rebuildIndexes() {
    cityVisited.clear();
    countyVisited.clear();
    homeCities.clear();
    countryVisited.clear();
    for (const p of state.places) {
      if (p.status !== 'visited') continue;
      if (p.isHome) {
        if (p.cityCode) homeCities.add(p.cityCode);
        if (p.countyCode) {
          const co = countyByCode.get(p.countyCode);
          if (co && co.cityCode) homeCities.add(co.cityCode);
        }
        continue;
      }
      if (p.cityCode && cityByCode.has(p.cityCode)) cityVisited.set(p.cityCode, p);
      if (p.countyCode && countyByCode.has(p.countyCode)) {
        countyVisited.set(p.countyCode, p);
        const co = countyByCode.get(p.countyCode);
        if (co && co.cityCode && cityByCode.has(co.cityCode) && !cityVisited.has(co.cityCode)) {
          cityVisited.set(co.cityCode, p);
        }
      }
      if (p.countryCode) countryVisited.add(p.countryCode);
    }
    invalidateChinaCache();
  }

  let countiesPrepped = false;
  function prepCounties() {
    if (countiesPrepped) return;
    for (const c of COUNTIES_ALL) {
      c._rings = (c.g || []).map((flat) => {
        const pts = new Float64Array(flat.length);
        for (let i = 0; i < flat.length; i += 2) {
          const xy = albers(flat[i], flat[i + 1]);
          pts[i] = xy[0]; pts[i + 1] = xy[1];
        }
        return pts;
      });
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const ring of c._rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i], y = ring[i + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      c._bbox = [minX, minY, maxX, maxY];
      c._p = albers(c.center[0], c.center[1]);
    }
    countiesPrepped = true;
  }

  function pointInFlatRing(x, y, flat) {
    let inside = false;
    const n = flat.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------------- 视图尺寸 ---------------- */
  const canvas = $('#map');
  const ctx = canvas.getContext('2d');

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.view.W = rect.width;
    state.view.H = rect.height;
    state.view.dpr = dpr;
    invalidateChinaCache();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!state.china.fit) { fitChina(); state.china.fit = true; }
    requestDraw();
  }

  function clampChina() {
    const c = state.china;
    const W = state.view.W, H = state.view.H;
    if (!CHINA_BBOX || !W) return;
    const fb = CHINA_BBOX;              // 主体 bbox（排除三沙）：判断是否放大
    const pb = CHINA_PAN || CHINA_BBOX; // 边界 bbox（含三沙）
    const fw = c.k * (fb[2] - fb[0]);
    const fh = c.k * (fb[3] - fb[1]);
    const x0 = c.k * pb[0] + c.tx, x1 = c.k * pb[2] + c.tx;
    const y0 = -c.k * pb[3] + c.ty, y1 = -c.k * pb[1] + c.ty;
    if (fw >= W) {
      // 放大：地图边缘贴视口边缘，能拖到地图的每一个角（包括东南的台湾、南海）
      if (x0 > 0) c.tx -= x0;
      else if (x1 < W) c.tx += W - x1;
    } else {
      // 未放大：允许拖到南海
      const mcx = (x0 + x1) / 2;
      if (mcx < 0) c.tx += -mcx;
      else if (mcx > W) c.tx -= mcx - W;
    }
    if (fh >= H) {
      if (y0 > 0) c.ty -= y0;
      else if (y1 < H) c.ty += H - y1;
    } else {
      const mcy = (y0 + y1) / 2;
      if (mcy < 0) c.ty += -mcy;
      else if (mcy > H) c.ty -= mcy - H;
    }
  }

  function fitChina() {
    const W = state.view.W, H = state.view.H;
    // 排除三沙这类离群点，避免主体被压小
    const pts = CITIES.filter((c) => c.code !== '460300').map((c) => c._p);
    const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    const minX = xs[0], maxX = xs[xs.length - 1];
    const minY = ys[0], maxY = ys[ys.length - 1];
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const bw = maxX - minX, bh = maxY - minY;
    const k = Math.min((W * 0.98) / bw, (H * 0.98) / bh);
    state.china.k = k;
    state.china.fitK = k;
    state.china.tx = W / 2 - k * cx;
    state.china.ty = H / 2 + k * cy;
    state.china.minK = k * 0.35;
    state.china.maxK = k * 30;
  }

  /* ---------------- 绘制 ---------------- */
  let rafId = null;
  function requestDraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = null; draw(); });
  }

  function draw() {
    if (!state.view.W) return;
    if (state.mode === 'globe') drawGlobe();
    else drawChina();
    updateHud();
  }

  let hudKey = '';
  function updateHud() {
    const key = state.mode + ':' + (state.mode === 'china' ? (state.china.countyLevel ? 'county' : 'city') + ':' + Math.round(state.china.k / (state.china.fitK || state.china.k)) : Math.round(state.globe.zoom * 10));
    if (key === hudKey) return;
    hudKey = key;
    const el = $('#hud');
    if (state.mode === 'globe') {
      el.innerHTML = '<b>地球仪</b> · 拖动旋转 · 滚轮缩放 · 点击国家或城市';
    } else if (state.china.countyLevel) {
      el.innerHTML = '<b>区县</b> · 点击区县记录 · 滚轮缩小回到城市';
    } else {
      el.innerHTML = '<b>城市</b> · 拖动平移 · 继续放大可见区县';
    }
  }

  /* ---- 地球仪 ---- */
  function drawGlobe() {
    const W = state.view.W, H = state.view.H;
    const g = state.globe;
    const R = Math.min(W, H) * 0.42 * g.zoom;
    const cx = W / 2, cy = H / 2;
    state.view.R = R; state.view.cx = cx; state.view.cy = cy;

    // 背景
    const bgg = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.max(W, H) * 0.8);
    bgg.addColorStop(0, '#08111b');
    bgg.addColorStop(1, '#04070c');
    ctx.fillStyle = bgg;
    ctx.fillRect(0, 0, W, H);

    // 球体
    const oc = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.38, R * 0.08, cx, cy, R * 1.02);
    oc.addColorStop(0, '#173049');
    oc.addColorStop(0.55, '#0e1d2c');
    oc.addColorStop(1, '#081420');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = oc;
    ctx.fill();

    // 外圈辉光
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 1, 0, TAU);
    ctx.strokeStyle = 'rgba(120, 170, 215, .22)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, 0, TAU);
    ctx.strokeStyle = 'rgba(120, 170, 215, .05)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();

    const M = makeRot(g.lon, g.lat);

    drawGraticule(M, R, cx, cy);

    // 国家
    for (const c of COUNTRIES) {
      const visited = countryVisited.has(c.code);
      ctx.beginPath();
      let any = false;
      for (const poly of c._v) {
        for (const ring of poly) {
          const pts = clipRing(ring, M, R, cx, cy);
          if (!pts) continue;
          any = true;
          ctx.moveTo(pts[0], pts[1]);
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        }
      }
      if (!any) continue;
      ctx.fillStyle = visited ? 'rgba(86, 133, 163, .62)' : 'rgba(33, 52, 72, .82)';
      ctx.fill();
      ctx.strokeStyle = visited ? 'rgba(150, 200, 232, .38)' : 'rgba(112, 150, 186, .22)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // 经纬网再压一层（淡）
    drawGraticule(M, R, cx, cy, 'rgba(140, 180, 220, .07)');

    // 用户地点
    const marks = [];
    for (const p of state.places) {
      const v = sphereVec(p.lon, p.lat);
      const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
      const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
      const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
      if (z <= 0.02) continue;
      marks.push({ p, sx: cx + R * x, sy: cy - R * y, z });
    }
    marks.sort((a, b) => a.z - b.z);
    for (const m of marks) drawMarker(m.p, m.sx, m.sy, true);

    drawReplayLines();
    if (state.trip) drawTripLine();
    drawGlobeLabels(marks, cx, cy, R);
  }

  function drawGraticule(M, R, cx, cy, color) {
    ctx.strokeStyle = color || 'rgba(120, 160, 200, .10)';
    ctx.lineWidth = 0.6;
    // 纬线
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let started = false;
      for (let lon = -180; lon <= 180; lon += 3) {
        const v = sphereVec(lon, lat);
        const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
        const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
        const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
        if (z > 0) {
          const sx = cx + R * x, sy = cy - R * y;
          if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
        } else { started = false; }
      }
      ctx.stroke();
    }
    // 经线
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.beginPath();
      let started = false;
      for (let lat = -85; lat <= 85; lat += 3) {
        const v = sphereVec(lon, lat);
        const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
        const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
        const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
        if (z > 0) {
          const sx = cx + R * x, sy = cy - R * y;
          if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
        } else { started = false; }
      }
      ctx.stroke();
    }
  }

  function clipRing(ring, M, R, cx, cy) {
    const n = ring.length;
    if (n < 3) return null;
    const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n);
    let anyVis = false;
    for (let i = 0; i < n; i++) {
      const v = ring[i];
      const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
      const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
      const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
      xs[i] = x; ys[i] = y; zs[i] = z;
      if (z > 0) anyVis = true;
    }
    if (!anyVis) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const vi = zs[i] > 0, vj = zs[j] > 0;
      if (vi) out.push(cx + R * xs[i], cy - R * ys[i]);
      if (vi !== vj) {
        const t = zs[i] / (zs[i] - zs[j]);
        const ix = xs[i] + (xs[j] - xs[i]) * t;
        const iy = ys[i] + (ys[j] - ys[i]) * t;
        const iz = 0;
        const len = Math.hypot(ix, iy, iz) || 1;
        out.push(cx + R * (ix / len), cy - R * (iy / len));
      }
    }
    return out.length >= 6 ? out : null;
  }

  function drawMarker(p, sx, sy, onGlobe) {
    const wish = p.status === 'wish';
    const home = p.isHome;
    const sel = p.id === state.selectedId;
    const r = sel ? 6.5 : 5;
    ctx.save();
    ctx.shadowColor = home ? 'rgba(111,182,217,.7)' : wish ? 'rgba(99,169,204,.65)' : 'rgba(255,180,100,.7)';
    ctx.shadowBlur = sel ? 16 : 10;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, TAU);
    if (wish) {
      ctx.fillStyle = 'rgba(9,15,21,.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#63a9cc';
      ctx.stroke();
    } else if (home) {
      ctx.fillStyle = sel ? '#a8dcf0' : '#6fb6d9';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(8,20,28,.7)';
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.36, 0, TAU);
      ctx.fillStyle = 'rgba(6,14,20,.75)';
      ctx.fill();
    } else {
      ctx.fillStyle = sel ? '#ffcf94' : '#ffb464';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(20,14,4,.65)';
      ctx.stroke();
    }
    ctx.restore();
    if (sel) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 6, 0, TAU);
      ctx.strokeStyle = home ? 'rgba(111,182,217,.5)' : wish ? 'rgba(99,169,204,.45)' : 'rgba(255,180,100,.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawGlobeLabels(marks, cx, cy, R) {
    const show = state.globe.zoom > 1.15;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const used = [];
    for (const m of marks) {
      if (!show && !(m.p.id === state.selectedId)) continue;
      const label = m.p.name || m.p.cityName || '未命名';
      ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = ctx.measureText(label).width;
      const x = m.sx, y = m.sy - 10;
      if (used.some((u) => Math.abs(u.x - x) < 44 && Math.abs(u.y - y) < 16)) continue;
      used.push({ x, y });
      ctx.fillStyle = 'rgba(9, 14, 20, .72)';
      const pad = 4;
      ctx.fillRect(x - w / 2 - pad, y - 14, w + pad * 2, 16);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(label, x, y);
    }
  }

  /* ---- 中国底图缓存 ---- */
  let cnCache = null;
  let cnScaleTimer = null;
  const CN_PAD = 280;

  function invalidateChinaCache() {
    cnCache = null;
    if (cnScaleTimer) { clearTimeout(cnScaleTimer); cnScaleTimer = null; }
  }

  function cullCity(c, k, tx, ty, W, H) {
    const bx0 = k * c._bbox[0] + tx, bx1 = k * c._bbox[2] + tx;
    const by0 = -k * c._bbox[3] + ty, by1 = -k * c._bbox[1] + ty;
    return bx1 < -CN_PAD || bx0 > W + CN_PAD || by1 < -CN_PAD || by0 > H + CN_PAD;
  }

  function traceCity(c2, c, k, tx, ty) {
    for (const poly of c._polys) {
      for (const ring of poly) {
        c2.moveTo(k * ring[0][0] + tx, -k * ring[0][1] + ty);
        for (let i = 1; i < ring.length; i++) {
          c2.lineTo(k * ring[i][0] + tx, -k * ring[i][1] + ty);
        }
        c2.closePath();
      }
    }
  }

  function buildChinaBase(W, H, k, tx, ty, dpr) {
    const cw = Math.round((W + CN_PAD * 2) * dpr);
    const ch = Math.round((H + CN_PAD * 2) * dpr);
    let cv = cnCache && cnCache.cv;
    if (!cv || cv.width !== cw || cv.height !== ch) {
      cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
    }
    const c2 = cv.getContext('2d');
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.clearRect(0, 0, cw, ch);
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.translate(CN_PAD, CN_PAD);

    // 周边国家（淡色底图，拖出中国范围也有东西看）
    for (const c of COUNTRIES) {
      if (c.code === 'CHN') continue;
      const b = c._alBox;
      const bx0 = k * b[0] + tx, bx1 = k * b[2] + tx;
      const by0 = -k * b[3] + ty, by1 = -k * b[1] + ty;
      if (bx1 < -CN_PAD || bx0 > W + CN_PAD || by1 < -CN_PAD || by0 > H + CN_PAD) continue;
      c2.beginPath();
      for (const poly of c._al) {
        for (const ring of poly) {
          c2.moveTo(k * ring[0][0] + tx, -k * ring[0][1] + ty);
          for (let i = 1; i < ring.length; i++) {
            c2.lineTo(k * ring[i][0] + tx, -k * ring[i][1] + ty);
          }
          c2.closePath();
        }
      }
      c2.fillStyle = 'rgba(13, 22, 33, .96)';
      c2.fill();
      c2.strokeStyle = 'rgba(90, 120, 150, .16)';
      c2.lineWidth = 0.7;
      c2.stroke();
    }

    // 省界
    c2.beginPath();
    for (const p of PROVINCES) {
      for (const poly of p._polys) {
        for (const ring of poly) {
          c2.moveTo(k * ring[0][0] + tx, -k * ring[0][1] + ty);
          for (let i = 1; i < ring.length; i++) {
            c2.lineTo(k * ring[i][0] + tx, -k * ring[i][1] + ty);
          }
          c2.closePath();
        }
      }
    }
    c2.strokeStyle = 'rgba(120, 155, 190, .16)';
    c2.lineWidth = 1.1;
    c2.stroke();

    // 未访问城市
    for (const c of CITIES) {
      if (cityVisited.get(c.code) || homeCities.has(c.code)) continue;
      if (cullCity(c, k, tx, ty, W, H)) continue;
      c2.beginPath();
      traceCity(c2, c, k, tx, ty);
      c2.fillStyle = 'rgba(24, 39, 55, .92)';
      c2.fill();
      c2.strokeStyle = 'rgba(110, 148, 185, .26)';
      c2.lineWidth = 0.8;
      c2.stroke();
    }

    // 国界
    if (BORDER) {
      c2.beginPath();
      for (const poly of BORDER._polys) {
        for (const ring of poly) {
          c2.moveTo(k * ring[0][0] + tx, -k * ring[0][1] + ty);
          for (let i = 1; i < ring.length; i++) {
            c2.lineTo(k * ring[i][0] + tx, -k * ring[i][1] + ty);
          }
          c2.closePath();
        }
      }
      c2.strokeStyle = 'rgba(240, 198, 152, .30)';
      c2.lineWidth = 1.0;
      c2.stroke();
    }
    cnCache = { cv, k, tx, ty };
    return cnCache;
  }

  /* ---- 中国城市图 ---- */
  function drawChina() {
    const W = state.view.W, H = state.view.H;
    const { k, tx, ty } = state.china;

    // 背景
    const bgg = ctx.createLinearGradient(0, 0, 0, H);
    bgg.addColorStop(0, '#060b12');
    bgg.addColorStop(1, '#04080d');
    ctx.fillStyle = bgg;
    ctx.fillRect(0, 0, W, H);

    // 底图缓存：省界 + 未访问城市 + 国界（拖动只平移，缩放先缩放旧图再重建）
    const dpr = state.view.dpr || 1;
    if (!cnCache) cnCache = buildChinaBase(W, H, k, tx, ty, dpr);
    if (cnCache.k === k) {
      if (Math.abs(tx - cnCache.tx) > CN_PAD * 0.6 || Math.abs(ty - cnCache.ty) > CN_PAD * 0.6) {
        cnCache = buildChinaBase(W, H, k, tx, ty, dpr);
      }
      const ox = CN_PAD + (cnCache.tx - tx);
      const oy = CN_PAD + (cnCache.ty - ty);
      ctx.drawImage(cnCache.cv, ox * dpr, oy * dpr, W * dpr, H * dpr, 0, 0, W, H);
    } else {
      // 缩放中：先用旧图放大/缩小顶着，停下来再重建
      const rr = cnCache.k / k;
      const sx = (CN_PAD + cnCache.tx - rr * tx) * dpr;
      const sy = (CN_PAD + cnCache.ty - rr * ty) * dpr;
      ctx.drawImage(cnCache.cv, sx, sy, W * rr * dpr, H * rr * dpr, 0, 0, W, H);
      if (cnScaleTimer) clearTimeout(cnScaleTimer);
      cnScaleTimer = setTimeout(() => {
        cnScaleTimer = null;
        cnCache = buildChinaBase(state.view.W, state.view.H, state.china.k, state.china.tx, state.china.ty, state.view.dpr || 1);
        requestDraw();
      }, 140);
    }

    // 去过的 / 悬停的 / 家的城市（实时画在缓存上面）
    for (const c of CITIES) {
      const visited = cityVisited.get(c.code);
      const home = homeCities.has(c.code);
      const hovered = state.hover && state.hover.type === 'city' && state.hover.code === c.code;
      if (!visited && !home && !hovered) continue;
      if (cullCity(c, k, tx, ty, W, H)) continue;
      ctx.beginPath();
      traceCity(ctx, c, k, tx, ty);
      ctx.fillStyle = home
        ? (hovered ? 'rgba(140, 210, 240, .38)' : 'rgba(99, 169, 204, .24)')
        : visited
          ? (hovered ? 'rgba(255, 196, 130, .42)' : 'rgba(226, 156, 84, .26)')
          : 'rgba(120, 175, 210, .18)';
      ctx.fill();
      ctx.strokeStyle = home ? 'rgba(130, 200, 230, .62)' : visited ? 'rgba(255, 190, 120, .58)' : 'rgba(140, 190, 225, .45)';
      ctx.lineWidth = home || visited ? 1.1 : 0.9;
      ctx.stroke();
    }

    // 区县图层：放大到城市级别才出现
    const ratio = state.china.k / (state.china.fitK || state.china.k);
    state.china.countyLevel = ratio > 4.2;
    if (state.china.countyLevel) {
      if (!COUNTIES_ALL.length) {
        ensureCounties().then(() => requestDraw()).catch(() => {});
      }
    }
    if (state.china.countyLevel && COUNTIES_ALL.length) {
      prepCounties();
      for (const co of COUNTIES_ALL) {
        const b = co._bbox;
        if (!b) continue;
        const bx0 = k * b[0] + tx, bx1 = k * b[2] + tx;
        const by0 = -k * b[3] + ty, by1 = -k * b[1] + ty;
        if (bx1 < -20 || bx0 > W + 20 || by1 < -20 || by0 > H + 20) continue;
        const visited = countyVisited.get(co.code);
        const hovered = state.hover && state.hover.type === 'county' && state.hover.code === co.code;
        ctx.beginPath();
        for (const ring of co._rings) {
          ctx.moveTo(k * ring[0] + tx, -k * ring[1] + ty);
          for (let i = 2; i < ring.length; i += 2) {
            ctx.lineTo(k * ring[i] + tx, -k * ring[i + 1] + ty);
          }
          ctx.closePath();
        }
        ctx.fillStyle = visited
          ? 'rgba(255, 190, 120, .30)'
          : hovered ? 'rgba(120, 175, 210, .20)' : 'rgba(17, 28, 40, .55)';
        ctx.fill();
        ctx.strokeStyle = visited ? 'rgba(255, 205, 145, .6)' : 'rgba(115, 152, 188, .30)';
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }
    }

    // 回放：按累计次数加深
    if (state.replay.active) {
      const lit = state.replay.cityLit;
      for (const c of CITIES) {
        const n = lit.get(c.code);
        if (!n) continue;
        if (cullCity(c, k, tx, ty, W, H)) continue;
        const home = homeCities.has(c.code);
        const alpha = Math.min(0.68, 0.16 + (n - 1) * 0.16);
        ctx.beginPath();
        traceCity(ctx, c, k, tx, ty);
        ctx.fillStyle = home
          ? 'rgba(99, 169, 204, ' + Math.min(0.6, 0.2 + (n - 1) * 0.14).toFixed(2) + ')'
          : 'rgba(255, 172, 92, ' + alpha.toFixed(2) + ')';
        ctx.fill();
        ctx.strokeStyle = home
          ? 'rgba(140, 210, 240, .65)'
          : 'rgba(255, 205, 150, ' + Math.min(0.9, 0.3 + n * 0.14).toFixed(2) + ')';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    // 选中的行程
    if (state.trip) {
      const codes = state.trip.codes;
      for (const c of CITIES) {
        if (codes.indexOf(c.code) < 0) continue;
        if (cullCity(c, k, tx, ty, W, H)) continue;
        ctx.beginPath();
        traceCity(ctx, c, k, tx, ty);
        ctx.fillStyle = 'rgba(255, 196, 130, .30)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 210, 160, .68)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    drawReplayLines();
    if (state.trip) drawTripLine();

    // 用户标记
    const marks = [];
    for (const p of state.places) {
      const a = albers(p.lon, p.lat);
      const sx = k * a[0] + tx, sy = -k * a[1] + ty;
      if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue;
      marks.push({ p, sx, sy });
    }
    for (const m of marks) drawMarker(m.p, m.sx, m.sy, false);

    // 标签
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const used = [];
    for (const m of marks) {
      const label = m.p.name || m.p.cityName || '未命名';
      ctx.font = (m.p.id === state.selectedId ? '700 12.5px' : '600 11.5px') + ' "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = ctx.measureText(label).width;
      const x = m.sx, y = m.sy - 9;
      if (used.some((u) => Math.abs(u.x - x) < 40 && Math.abs(u.y - y) < 15)) continue;
      used.push({ x, y });
      ctx.fillStyle = 'rgba(9, 14, 20, .78)';
      ctx.fillRect(x - w / 2 - 4, y - 14, w + 8, 16);
      ctx.fillStyle = '#e8eef5';
      ctx.fillText(label, x, y);
    }
  }

  /* ---------------- 命中测试 ---------------- */
  function screenToGlobe(sx, sy) {
    const { R, cx, cy } = state.view;
    const X = (sx - cx) / R, Y = (cy - sy) / R;
    if (X * X + Y * Y > 1) return null;
    const Z = Math.sqrt(1 - X * X - Y * Y);
    const g = state.globe;
    const sp = Math.sin(g.lat * D), cp = Math.cos(g.lat * D);
    const cl = Math.cos(g.lon * D), sl = Math.sin(g.lon * D);
    const p1x = -Y * sp + Z * cp;
    const p1y = X;
    const p1z = Y * cp + Z * sp;
    const x = p1x * cl - p1y * sl;
    const y = p1x * sl + p1y * cl;
    const lon = Math.atan2(y, x) / D;
    const lat = Math.asin(clamp(p1z, -1, 1)) / D;
    return { lon, lat };
  }

  function screenToChina(sx, sy) {
    const { k, tx, ty } = state.china;
    return [(sx - tx) / k, (ty - sy) / k];
  }

  function hitPlace(sx, sy) {
    let best = null, bestD = 14;
    for (const p of state.places) {
      let px, py;
      if (state.mode === 'globe') {
        const { R, cx, cy } = state.view;
        const v = sphereVec(p.lon, p.lat);
        const M = makeRot(state.globe.lon, state.globe.lat);
        const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
        const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
        const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
        if (z <= 0.02) continue;
        px = cx + R * x; py = cy - R * y;
      } else {
        const a = albers(p.lon, p.lat);
        px = state.china.k * a[0] + state.china.tx;
        py = -state.china.k * a[1] + state.china.ty;
      }
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function hitCounty(sx, sy) {
    if (!state.china.countyLevel || !COUNTIES_ALL.length) return null;
    const [ax, ay] = screenToChina(sx, sy);
    for (const c of COUNTIES_ALL) {
      const b = c._bbox;
      if (!b) continue;
      if (ax < b[0] || ax > b[2] || ay < b[1] || ay > b[3]) continue;
      let inside = false;
      for (const ring of c._rings) {
        if (pointInFlatRing(ax, ay, ring)) inside = !inside;
      }
      if (inside) return c;
    }
    return null;
  }

  function hitCityChina(sx, sy) {
    const [ax, ay] = screenToChina(sx, sy);
    for (const c of CITIES) {
      const b = c._bbox;
      if (ax < b[0] || ax > b[2] || ay < b[1] || ay > b[3]) continue;
      for (const poly of c._polys) {
        if (pointInRing(ax, ay, poly[0]) && !poly.slice(1).some((h) => pointInRing(ax, ay, h))) return c;
      }
    }
    return null;
  }

  function hitCountryGlobe(lon, lat) {
    // 经度归一
    for (const c of COUNTRIES) {
      if (pointInGeom(lon, lat, c.geom)) return c;
    }
    return null;
  }

  function nearestWorldCity(lon, lat, maxDeg) {
    let best = null, bestD = maxDeg;
    for (const p of WORLDCITIES) {
      let dLon = Math.abs(p.lon - lon);
      if (dLon > 180) dLon = 360 - dLon;
      const dLat = p.lat - lat;
      const d = Math.hypot(dLon * Math.cos(lat * D), dLat);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /* ---------------- 抽屉 ---------------- */
  const drawer = $('#drawer');
  let draft = null;

  function openDrawerFor(existing, draftInit) {
    draft = existing ? JSON.parse(JSON.stringify(existing)) : makeDraft(draftInit);
    if (existing) draft._editing = true;
    renderDrawer();
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function makeDraft(init) {
    return {
      id: null,
      name: '',
      spot: '',
      from: '',
      cityCode: '',
      cityName: '',
      countyCode: '',
      countyName: '',
      province: '',
      countryCode: '',
      countryName: '',
      lon: null,
      lat: null,
      status: 'visited',
      starred: false,
      photos: [],
      journal: [],
      visits: [{ date: '', days: '', note: '' }],
      note: '',
      tags: [],
      ...(init || {}),
      _editing: false,
    };
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    draft = null;
  }

  function placeLocationText(p) {
    const bits = [];
    const prov = prettyName(p.province);
    const city = prettyName(p.cityName);
    const county = prettyName(p.countyName);
    if (p.countryName && p.countryName !== '中国') bits.push(prettyName(p.countryName));
    if (prov && prov !== prettyName(p.countryName)) bits.push(prov);
    if (city && city !== prov) bits.push(city);
    if (county && county !== city && county !== p.name) bits.push(county);
    if (!bits.length && p.name) bits.push(p.name);
    return bits.join(' · ');
  }

  function renderDrawer() {
    if (!draft) return;
    const d = draft;
    $('#dh-kicker').textContent = d._editing ? '编辑地点' : '新地点';
    $('#dh-title').textContent = d.name || d.cityName || '记一笔';
    $('#dh-sub').textContent = placeLocationText(d) || (d.lon != null ? `${d.lat.toFixed(2)}, ${d.lon.toFixed(2)}` : '还没有位置');

    const totalDays = d.visits.reduce((s, v) => s + (num(v.days) || 0) + (num(v.hours) || 0) / 24, 0);
    const body = $('#drawer-body');
    body.innerHTML = `
      <div class="field">
        <label>地点</label>
        <div class="ro" style="font-size:14px;color:var(--txt)">${esc(placeLocationText(d) || '未选位置 — 点击地图上的城市或国家')}</div>
      </div>
      <div class="field">
        <label>景区 / 具体地点（可选）</label>
        <input type="text" id="f-spot" value="${esc(d.spot || '')}" placeholder="例如：故宫、洱海、莫高窟" />
      </div>
      <div class="field">
        <label>出发地（可选）</label>
        <input type="text" id="f-from" value="${esc(d.from || '')}" placeholder="例如：广州、西宁" />
      </div>
      <div class="field">
        <label>状态</label>
        <div class="seg" id="f-status">
          <button data-v="visited" class="${d.status === 'visited' ? 'on' : ''}">去过</button>
          <button data-v="wish" class="${d.status === 'wish' ? 'on' : ''}">想去</button>
        </div>
      </div>
      <div class="field">
        <label>访问记录 <span style="color:var(--dim)">· 去 ${d.visits.length} 次 · 共 ${fmtDuration(totalDays)}</span></label>
        <div id="f-visits">
          ${d.visits.map((v, i) => visitTpl(v, i)).join('')}
        </div>
        <button class="add-visit" id="f-add-visit">＋ 再加一次</button>
      </div>
      <div class="field">
        <label>整体印象 / 备注</label>
        <textarea id="f-note" placeholder="对这里的整体印象、下次还想去的地方">${esc(d.note)}</textarea>
      </div>
      <div class="field">
        <label>标签（逗号分隔）</label>
        <input type="text" id="f-tags" value="${esc(d.tags.join('，'))}" placeholder="例如：穷游，骑行，火车" />
      </div>
      <div class="field">
        <label>档案照片</label>
        <div class="photos" id="f-photos">
          ${(d.photos || []).map((ph, i) => `<div class="photo"><img src="data/photos/${esc(ph.file)}" alt="" /><button class="photo-del" data-i="${i}" title="删除">×</button></div>`).join('')}
        </div>
        <button class="add-visit" id="f-add-photo">＋ 添加照片</button>
      </div>
      <div class="field">
        <label>游记（按日期）</label>
        <div id="f-journal">
          ${(d.journal || []).map((j, i) => `
            <div class="journal" data-i="${i}">
              <input class="j-date" value="${esc(j.date)}" placeholder="日期，如 2027-01-01" />
              <textarea class="j-text" placeholder="写点什么">${esc(j.text)}</textarea>
              <div class="del-row"><button class="link-btn j-del" data-i="${i}">删除</button></div>
            </div>`).join('')}
        </div>
        <button class="add-visit" id="f-add-journal">＋ 写一条</button>
      </div>
      <label class="check subtle">
        <input type="checkbox" id="f-home" ${d.isHome ? 'checked' : ''} />
        <span>设为「家」· 不计入去过，最多 3 处</span>
      </label>
    `;

    const starBtn = $('#btn-star');
    if (starBtn) {
      starBtn.textContent = d.starred ? '★' : '☆';
      starBtn.classList.toggle('on', !!d.starred);
    }

    $('#btn-delete-place').style.display = d._editing ? '' : 'none';

    // 事件
    on($('#f-status'), 'click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      draft.status = b.dataset.v;
      renderDrawer();
    });
    on($('#f-add-visit'), 'click', () => {
      collectDrawer();
      draft.visits.push({ date: '', days: '', hours: '', note: '' });
      renderDrawer();
    });
    body.querySelectorAll('.v-del').forEach((b) => on(b, 'click', () => {
      collectDrawer();
      if (draft.visits.length <= 1) { draft.visits = [{ date: '', days: '', hours: '', note: '' }]; }
      else draft.visits.splice(Number(b.dataset.i), 1);
      renderDrawer();
    }));
    body.querySelectorAll('.d-cal').forEach((b) => on(b, 'click', () => {
      const el = b.closest('.visit');
      const init = {
        y: +el.querySelector('.d-y').value || null,
        m: +el.querySelector('.d-m').value || null,
        d: +el.querySelector('.d-d').value || null,
      };
      openDatePicker(b, init, (p) => {
        if (!p) {
          el.querySelector('.d-y').value = '';
          el.querySelector('.d-m').value = '';
          el.querySelector('.d-d').value = '';
          return;
        }
        el.querySelector('.d-y').value = String(p.y);
        el.querySelector('.d-m').value = pad2(p.m);
        el.querySelector('.d-d').value = pad2(p.d);
      });
    }));

    // 档案：照片
    on($('#f-add-photo'), 'click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result).split(',')[1] || '';
          const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
          const name = 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.' + ext;
          try {
            if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage('PHOTO|' + name + '|' + b64);
          } catch (e) { /* ignore */ }
          collectDrawer();
          draft.photos = draft.photos || [];
          draft.photos.push({ file: name });
          renderDrawer();
        };
        reader.readAsDataURL(f);
      };
      inp.click();
    });
    body.querySelectorAll('.photo-del').forEach((b) => on(b, 'click', () => {
      collectDrawer();
      (draft.photos || []).splice(Number(b.dataset.i), 1);
      renderDrawer();
    }));
    // 档案：游记
    on($('#f-add-journal'), 'click', () => {
      collectDrawer();
      draft.journal = draft.journal || [];
      draft.journal.push({ date: '', text: '' });
      renderDrawer();
    });
    body.querySelectorAll('.j-del').forEach((b) => on(b, 'click', () => {
      collectDrawer();
      (draft.journal || []).splice(Number(b.dataset.i), 1);
      renderDrawer();
    }));
  }

  function visitTpl(v, i) {
    const dt = parseDateStr(v.date);
    const yy = dt ? String(dt.y) : '';
    const mm = dt && dt.m ? pad2(dt.m) : '';
    const dd = dt && dt.d ? pad2(dt.d) : '';
    const hh = dt && dt.h != null ? pad2(dt.h) : '';
    return `<div class="visit" data-i="${i}">
      <div class="visit-top">
        <div class="d3">
          <input class="d-y" inputmode="numeric" maxlength="4" value="${yy}" /><span>年</span>
          <input class="d-m" inputmode="numeric" maxlength="2" value="${mm}" /><span>月</span>
          <input class="d-d" inputmode="numeric" maxlength="2" value="${dd}" /><span>日</span>
          <input class="d-h" inputmode="numeric" maxlength="2" value="${hh}" /><span>时</span>
        </div>
        <button class="d-cal" data-i="${i}" title="从日历选日期">▦</button>
      </div>
      <div class="visit-meta">
        <span>待了</span>
        <input class="v-days" inputmode="numeric" placeholder="0" value="${v.days === '' || v.days == null ? '' : esc(v.days)}" /><span>天</span>
        <input class="v-hours" inputmode="numeric" placeholder="0" value="${v.hours === '' || v.hours == null ? '' : esc(v.hours)}" /><span>时</span>
      </div>
      <textarea class="v-note" placeholder="这次干了什么：去了哪、见了谁、吃了什么、印象最深的事">${esc(v.note)}</textarea>
      <div class="del-row"><button class="link-btn v-del" data-i="${i}">删除这次</button></div>
    </div>`;
  }

  function fmtDuration(days) {
    const hours = days * 24;
    if (hours < 24) return Math.round(hours * 10) / 10 + ' 小时';
    if (days < 30) return Math.round(days * 10) / 10 + ' 天';
    return Math.round((days / 30) * 10) / 10 + ' 个月';
  }

  /* ---------------- 日期选择器 ---------------- */
  let dpEl = null;

  function closeDatePicker() {
    if (dpEl) { dpEl.remove(); dpEl = null; }
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function parseDateStr(s) {
    const m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?(?:[ T](\d{1,2})(?::(\d{1,2}))?)?/.exec(String(s || '').trim());
    if (!m) return null;
    const out = { y: +m[1], m: m[2] ? +m[2] : null, d: m[3] ? +m[3] : null, h: m[4] != null ? +m[4] : null, mi: m[5] != null ? +m[5] : null };
    if (out.m && (out.m < 1 || out.m > 12)) return null;
    if (out.d && (out.d < 1 || out.d > 31)) return null;
    return out;
  }

  function normalizeDateInput(s) {
    const d = parseDateStr(s);
    if (!d) return String(s || '').trim();
    let out = String(d.y);
    if (d.m) out += '-' + pad2(d.m);
    if (d.d) out += '-' + pad2(d.d);
    if (d.h != null) {
      out += ' ' + pad2(d.h);
      if (d.mi != null) out += ':' + pad2(d.mi);
    }
    return out;
  }

  function openDatePicker(anchor, init, onPick) {
    closeDatePicker();
    const sel = init && init.y ? { y: init.y, m: init.m || null, d: init.d || null } : null;
    const today = new Date();
    let viewYear = sel ? sel.y : today.getFullYear();
    let viewMonth = sel && sel.m ? sel.m : today.getMonth() + 1;
    let viewMode = 'day';

    const pop = document.createElement('div');
    pop.className = 'dp-pop';
    document.body.appendChild(pop);
    dpEl = pop;

    function renderView() {
      if (viewMode === 'year') {
        const start = Math.floor(viewYear / 12) * 12;
        let html = `<div class="dp-head"><div class="dp-title">
            <button data-act="yback">‹</button><button>${start}–${start + 11}</button><button data-act="yfwd">›</button>
          </div></div><div class="dp-grid year-grid">`;
        for (let y = start; y < start + 12; y++) {
          const cls = (y === (sel ? sel.y : -1) ? 'sel ' : '') + (y === today.getFullYear() ? 'today' : '');
          html += `<button data-y="${y}" class="${cls}">${y}</button>`;
        }
        html += `</div><div class="dp-foot"><button data-act="clear">清空</button><button data-act="now">今天</button></div>`;
        pop.innerHTML = html;
      } else {
        const first = new Date(viewYear, viewMonth - 1, 1);
        const startDay = (first.getDay() + 6) % 7;
        const cells = [];
        for (let i = 0; i < startDay; i++) {
          const dt = new Date(viewYear, viewMonth - 1, i - startDay + 1);
          cells.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), other: true });
        }
        const dim = new Date(viewYear, viewMonth, 0).getDate();
        for (let d = 1; d <= dim; d++) cells.push({ y: viewYear, m: viewMonth, d, other: false });
        let k = 1;
        while (cells.length % 7 !== 0) {
          const dt = new Date(viewYear, viewMonth, k++);
          cells.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), other: true });
        }
        let html = `<div class="dp-head">
          <div class="dp-title"><button data-act="pickyear">${viewYear}年</button><button>${viewMonth}月</button></div>
          <div class="dp-nav"><button data-act="back">‹</button><button data-act="fwd">›</button></div>
        </div>
        <div class="dp-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
        <div class="dp-grid">`;
        for (const c of cells) {
          const isSel = sel && sel.y === c.y && sel.m === c.m && sel.d === c.d;
          const isToday = c.y === today.getFullYear() && c.m === today.getMonth() + 1 && c.d === today.getDate();
          html += `<button data-y="${c.y}" data-m="${c.m}" data-d="${c.d}" class="${c.other ? 'other' : ''} ${isSel ? 'sel' : ''} ${isToday ? 'today' : ''}">${c.d}</button>`;
        }
        html += `</div><div class="dp-foot"><button data-act="clear">清空</button><button data-act="now">今天</button></div>`;
        pop.innerHTML = html;
      }
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    pop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.y && viewMode === 'year') {
        viewYear = +b.dataset.y;
        viewMode = 'day';
        renderView();
        return;
      }
      if (b.dataset.d) {
        onPick({ y: +b.dataset.y, m: +b.dataset.m, d: +b.dataset.d });
        closeDatePicker();
        return;
      }
      const act = b.dataset.act;
      if (act === 'back') { viewMonth--; if (viewMonth < 1) { viewMonth = 12; viewYear--; } renderView(); }
      else if (act === 'fwd') { viewMonth++; if (viewMonth > 12) { viewMonth = 1; viewYear++; } renderView(); }
      else if (act === 'pickyear') { viewMode = 'year'; renderView(); }
      else if (act === 'yback') { viewYear -= 12; renderView(); }
      else if (act === 'yfwd') { viewYear += 12; renderView(); }
      else if (act === 'clear') { onPick(null); closeDatePicker(); }
      else if (act === 'now') {
        onPick({ y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() });
        closeDatePicker();
      }
    });

    renderView();
    setTimeout(() => {
      const off = (ev) => {
        if (dpEl && !dpEl.contains(ev.target) && ev.target !== input) {
          closeDatePicker();
          document.removeEventListener('pointerdown', off, true);
        }
      };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  }

  function collectDrawer() {
    if (!draft) return;
    const spot = $('#f-spot');
    if (spot) draft.spot = spot.value.trim();
    const fromEl = $('#f-from');
    if (fromEl) draft.from = fromEl.value.trim();
    const note = $('#f-note');
    if (note) draft.note = note.value.trim();
    const tags = $('#f-tags');
    if (tags) {
      draft.tags = tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    const home = $('#f-home');
    if (home) draft.isHome = home.checked;
    const journal = [];
    document.querySelectorAll('#f-journal .journal').forEach((el) => {
      journal.push({
        date: el.querySelector('.j-date').value.trim(),
        text: el.querySelector('.j-text').value.trim(),
      });
    });
    draft.journal = journal;
    const visits = [];
    document.querySelectorAll('#f-visits .visit').forEach((el) => {
      const y = el.querySelector('.d-y').value.trim();
      const mo = el.querySelector('.d-m').value.trim();
      const dd = el.querySelector('.d-d').value.trim();
      const hh = el.querySelector('.d-h').value.trim();
      let date = '';
      if (y) {
        date = y;
        if (mo) date += '-' + pad2(+mo);
        if (dd) date += '-' + pad2(+dd);
        if (hh !== '') date += ' ' + pad2(+hh);
      }
      visits.push({
        date,
        days: el.querySelector('.v-days').value === '' ? '' : num(el.querySelector('.v-days').value),
        hours: el.querySelector('.v-hours').value === '' ? '' : num(el.querySelector('.v-hours').value),
        note: el.querySelector('.v-note').value.trim(),
      });
    });
    if (visits.length) draft.visits = visits;
  }

  function saveDraft() {
    collectDrawer();
    const d = draft;
    if (!d) return;
    if (d.lon == null || d.lat == null) {
      toast('还没有位置：先在地图上点一个城市或地方');
      return;
    }
    if (!d.name) {
      d.name = d.cityName || d.countryName || '未命名';
    }
    if (d.isHome) {
      const others = state.places.filter((p) => p.isHome && p.id !== (d.id || ''));
      if (others.length >= 3) { toast('最多设 3 个家'); return; }
    }
    const rec = {
      id: d.id || uid(),
      name: d.name,
      spot: d.spot || '',
      from: d.from || '',
      cityCode: d.cityCode || '',
      cityName: d.cityName || '',
      countyCode: d.countyCode || '',
      countyName: d.countyName || '',
      province: d.province || '',
      countryCode: d.countryCode || '',
      countryName: d.countryName || '',
      lon: d.lon,
      lat: d.lat,
      status: d.status,
      isHome: !!d.isHome,
      starred: !!d.starred,
      visits: d.visits.filter((v) => v.date || v.note || (v.days !== '' && v.days != null) || (v.hours !== '' && v.hours != null)),
      note: d.note,
      tags: d.tags,
      photos: d.photos || [],
      journal: (d.journal || []).filter((j) => j.date || j.text),
      updatedAt: Date.now(),
    };
    if (!rec.visits.length) rec.visits = [{ date: '', days: '', hours: '', note: '' }];

    const idx = state.places.findIndex((p) => p.id === rec.id);
    if (idx >= 0) state.places[idx] = rec;
    else state.places.push(rec);
    state.selectedId = rec.id;

    rebuildIndexes();
    saveState();
    renderSidebar();
    requestDraw();
    closeDrawer();
    toast(idx >= 0 ? '已更新' : '已记下');
  }

  function deleteDraft() {
    const d = draft;
    if (!d || !d.id) return;
    const p = state.places.find((x) => x.id === d.id);
    if (!p) return;
    if (!confirm(`删除「${p.name || p.cityName}」和它的全部记录？`)) return;
    state.places = state.places.filter((x) => x.id !== d.id);
    if (state.selectedId === d.id) state.selectedId = null;
    rebuildIndexes();
    saveState();
    renderSidebar();
    requestDraw();
    closeDrawer();
    toast('已删除');
  }

  /* ---------------- 点选地图 ---------------- */
  function pickGlobe(sx, sy) {
    const hit = hitPlace(sx, sy);
    if (hit) { openDrawerFor(hit); return; }

    const geo = screenToGlobe(sx, sy);
    if (!geo) { toast('点到球外面了，往地球里点'); return; }

    const country = hitCountryGlobe(geo.lon, geo.lat);
    const near = nearestWorldCity(geo.lon, geo.lat, 1.6);
    const init = {
      lon: geo.lon,
      lat: geo.lat,
      countryCode: country ? country.code : (near ? near._countryCode : ''),
      countryName: country ? (countryLabel(country)) : (near ? near._countryZh : ''),
    };
    if (near) {
      init.name = near.name_zh || near.name;
      init.cityName = near.name_zh || near.name;
      init.lon = near.lon;
      init.lat = near.lat;
    }
    // 中国境内：尝试对应到中国城市
    if (country && country.code === 'CHN') {
      const cc = nearestChinaCityAlbers(geo.lon, geo.lat, 120);
      if (cc) {
        init.name = prettyName(cc.name);
        init.cityName = cc.name;
        init.cityCode = cc.code;
        init.province = cc.province;
        init.countryName = '中国';
        init.countryCode = 'CHN';
        init.lon = cc.center[0];
        init.lat = cc.center[1];
      }
    }
    if (applyPickToDraft(init)) return;
    openDrawerFor(placeByCity(init.cityCode), init);
  }

  // 抽屉已打开（新建中）→ 点地图只更新位置，不重开抽屉
  function applyPickToDraft(init) {
    if (!draft || draft._editing) return false;
    collectDrawer();
    const keepName = draft.name;
    Object.assign(draft, init);
    if (keepName) draft.name = keepName;
    renderDrawer();
    return true;
  }

  function nearestChinaCityAlbers(lon, lat, maxKm) {
    const [x, y] = albers(lon, lat);
    const maxD = maxKm / 6371; // 弧度
    let best = null, bestD = maxD;
    for (const c of CITIES) {
      const dx = c._p[0] - x, dy = c._p[1] - y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function placeByCity(code) {
    if (!code) return null;
    return state.places.find((p) => p.cityCode === code) || null;
  }

  function pickChina(sx, sy) {
    const hit = hitPlace(sx, sy);
    if (hit) { openDrawerFor(hit); return; }

    const co = hitCounty(sx, sy);
    if (co) {
      const exist = state.places.find((p) => p.countyCode === co.code);
      if (exist) { openDrawerFor(exist); return; }
      const init = {
        name: prettyName(co.name),
        cityName: co.city,
        cityCode: co.cityCode,
        countyName: co.name,
        countyCode: co.code,
        province: co.province,
        countryName: '中国',
        countryCode: 'CHN',
        lon: co.center[0],
        lat: co.center[1],
      };
      if (applyPickToDraft(init)) return;
      openDrawerFor(null, init);
      return;
    }

    const c = hitCityChina(sx, sy);
    if (!c) { return; }
    const exist = placeByCity(c.code);
    if (exist) { openDrawerFor(exist); return; }
    const init2 = {
      name: prettyName(c.name),
      cityName: c.name,
      cityCode: c.code,
      province: c.province,
      countryName: '中国',
      countryCode: 'CHN',
      lon: c.center[0],
      lat: c.center[1],
    };
    if (applyPickToDraft(init2)) return;
    openDrawerFor(null, init2);
  }

  /* ---------------- 侧栏 ---------------- */
  function visitedStats() {
    const visited = state.places.filter((p) => p.status === 'visited' && !p.isHome);
    const cities = new Set();
    const countries = new Set();
    let times = 0, days = 0;
    for (const p of visited) {
      if (p.cityCode) cities.add(p.cityCode);
      else if (p.countyCode && countyByCode.has(p.countyCode)) cities.add(countyByCode.get(p.countyCode).cityCode);
      else if (p.lon != null) cities.add('w' + p.lon.toFixed(3) + ',' + p.lat.toFixed(3));
      if (p.countryCode) countries.add(p.countryCode);
      times += p.visits.filter((v) => v.date || v.note || (v.days !== '' && v.days != null)).length || 0;
      days += p.visits.reduce((s, v) => s + num(v.days) + num(v.hours) / 24, 0);
    }
    return { cities: cities.size, countries: countries.size, times, days };
  }

  /* ---------------- 行程 ---------------- */
  function buildTrips() {
    const DAY = 86400000;
    const spots = [];
    const homes = [];
    for (const p of state.places) {
      if (p.status !== 'visited') continue;
      for (const v of p.visits) {
        const dt = parseDateStr(v.date);
        if (!dt) continue;
        const it = { t: new Date(dt.y, (dt.m || 1) - 1, dt.d || 1).getTime(), p, v };
        if (p.isHome) homes.push(it); else spots.push(it);
      }
    }
    spots.sort((a, b) => a.t - b.t);
    homes.sort((a, b) => a.t - b.t);
    const trips = [];
    let cur = null;
    for (const it of spots) {
      // 两次之间如果回过家，算新的一段
      const homeBetween = cur && homes.some((h) => h.t > cur.end && h.t <= it.t);
      if (cur && !homeBetween && it.t - cur.end <= 7 * DAY) {
        cur.items.push(it);
        cur.end = it.t;
      } else {
        cur = { start: it.t, end: it.t, items: [it] };
        trips.push(cur);
      }
    }
    // 在家的时间段也单独列一段
    for (const h of homes) {
      const days = num(h.v.days) + num(h.v.hours) / 24;
      trips.push({ start: h.t, end: h.t + Math.max(0, days) * DAY, items: [h], home: true, days });
    }
    trips.sort((a, b) => a.start - b.start);
    return trips;
  }

  function fmtDay(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function renderTrips() {
    const list = $('#list');
    const trips = buildTrips();
    $('#list-count').textContent = trips.length ? trips.length + ' 段' : '';
    if (!trips.length) {
      list.innerHTML = `<div class="empty">还没有形成行程。<br>给访问记录<b>填上日期</b>，<br>相隔 7 天内的会合成一段。</div>`;
      return;
    }
    list.innerHTML = trips.map((tr, i) => {
      if (tr.home) {
        const hp = tr.items[0].p;
        const nm = hp.name || hp.cityName || '家';
        const same = fmtDay(tr.start) === fmtDay(tr.end);
        const range = same ? fmtDay(tr.start) : fmtDay(tr.start) + ' ~ ' + fmtDay(tr.end).slice(5);
        const dur = tr.days > 0 ? fmtDuration(tr.days) : '当天';
        return `<button class="trip home-trip ${state.trip && state.trip.i === i ? 'on' : ''}" data-i="${i}">
          <div class="trip-date">${range}</div>
          <div class="trip-route">${esc(nm)}（家）</div>
          <div class="trip-meta">在家 · ${dur}</div>
        </button>`;
      }
      const names = [];
      const seen = new Set();
      let spots = 0;
      for (const it of tr.items) {
        const nm = (it.p.spot || it.p.name || it.p.cityName || '未命名') + (it.p.isHome ? '（家）' : '');
        if (!seen.has(nm)) { seen.add(nm); names.push(nm); }
        if (!it.p.isHome) spots++;
      }
      const from = tr.items[0].p.from || '';
      const days = tr.items.reduce((s, it) => s + num(it.v.days) + num(it.v.hours) / 24, 0);
      const last = tr.items[tr.items.length - 1];
      const lastDays = num(last.v.days) + num(last.v.hours) / 24;
      const endT = tr.end + Math.max(0, lastDays) * 86400000;
      const same = fmtDay(tr.start) === fmtDay(endT);
      const range = same ? fmtDay(tr.start) : fmtDay(tr.start) + ' ~ ' + fmtDay(endT).slice(5);
      return `<button class="trip ${state.trip && state.trip.i === i ? 'on' : ''}" data-i="${i}">
        <div class="trip-date">${range}</div>
        <div class="trip-route">${from ? `<span class="trip-from">${esc(from)} → </span>` : ''}${names.map(esc).join(' · ')}</div>
        <div class="trip-meta">${spots} 个地方 · ${fmtDuration(days)}</div>
      </button>`;
    }).join('');
    list.querySelectorAll('.trip').forEach((el) => on(el, 'click', () => {
      const i = Number(el.dataset.i);
      if (state.trip && state.trip.i === i) { state.trip = null; }
      else {
        const tr = trips[i];
        state.trip = {
          i,
          codes: tr.items.map((it) => it.p.cityCode).filter(Boolean),
          points: tr.items.map((it) => ({ lon: it.p.lon, lat: it.p.lat })),
        };
      }
      renderSidebar();
      requestDraw();
    }));
  }

  function drawTripLine() {
    if (!state.trip) return;
    const pts = state.trip.points;
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (const pt of pts) {
      const pos = projectLL(pt.lon, pt.lat);
      if (!pos) { started = false; continue; }
      if (!started) { ctx.moveTo(pos.x, pos.y); started = true; }
      else ctx.lineTo(pos.x, pos.y);
    }
    ctx.strokeStyle = 'rgba(255, 190, 120, .6)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const pt of pts) {
      const pos = projectLL(pt.lon, pt.lat);
      if (!pos) continue;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3.6, 0, TAU);
      ctx.fillStyle = '#ffb464';
      ctx.fill();
    }
    ctx.restore();
  }

  function renderSidebar() {
    const s = visitedStats();
    $('#stats').innerHTML = `
      <div class="stat"><b>${fmtInt(s.cities)}<i>座</i></b><span>去过的城市</span></div>
      <div class="stat"><b>${fmtInt(s.countries)}<i>个</i></b><span>去过的国家</span></div>
      <div class="stat"><b>${fmtInt(s.times)}<i>次</i></b><span>出行次数</span></div>
      <div class="stat"><b style="font-size:17px">${fmtDuration(s.days)}</b><span>一共待了</span></div>`;

    if (state.tab === 'trips') { renderTrips(); return; }

    const q = state.query.trim().toLowerCase();
    let items = state.places.slice();
    if (q) {
      items = items.filter((p) => {
        const hay = [p.name, p.cityName, p.province, p.countryName, p.note, (p.tags || []).join(' ')].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    items.sort((a, b) => {
      if (a.isHome !== b.isHome) return a.isHome ? -1 : 1;
      if (a.status !== b.status) return a.status === 'visited' ? -1 : 1;
      const la = lastVisitTime(a), lb = lastVisitTime(b);
      if (la !== lb) return lb - la;
      return a.name.localeCompare(b.name, 'zh');
    });

    $('#list-count').textContent = items.length ? `${items.length} 条` : '';

    const list = $('#list');
    if (!items.length) {
      list.innerHTML = `<div class="empty">${q ? '没有匹配的记录' : '还没有足迹。<br><b>点击地图上的城市</b>开始记录，<br>或者右上角「＋ 记一笔」。'}</div>`;
      return;
    }
    list.innerHTML = items.map((p) => {
      const times = p.visits.filter((v) => v.date || v.note || (v.days !== '' && v.days != null) || (v.hours !== '' && v.hours != null)).length;
      const days = p.visits.reduce((s2, v) => s2 + num(v.days) + num(v.hours) / 24, 0);
      const wish = p.status === 'wish';
      const home = p.isHome;
      return `<button class="place ${p.id === state.selectedId ? 'on' : ''}" data-id="${p.id}">
        <div class="row1">
          <span class="nm">${esc(p.name || p.cityName || '未命名')}${p.spot ? `<em class="spot">${esc(p.spot)}</em>` : ''}</span>${p.starred ? '<span class="star-mark">★</span>' : ''}
          ${home ? '<span class="badge home">家</span>' : wish ? '<span class="badge wish">想去</span>' : times ? `<span class="badge">${times} 次</span>` : ''}
          <span class="dot ${wish ? 'wish' : home ? 'home' : ''}"></span>
        </div>
        <div class="where">${esc(placeLocationText(p))}</div>
        ${wish ? '' : `<div class="meta"><span><b>${times}</b> 次</span><span><b>${fmtDuration(days)}</b></span>${p.tags.length ? `<span>${esc(p.tags.slice(0, 2).join(' · '))}</span>` : ''}</div>`}
      </button>`;
    }).join('');

    list.querySelectorAll('.place').forEach((el) => on(el, 'click', () => {
      const p = state.places.find((x) => x.id === el.dataset.id);
      if (!p) return;
      state.selectedId = p.id;
      renderSidebar();
      focusPlace(p);
      openDrawerFor(p);
    }));
  }

  function lastVisitTime(p) {
    let t = 0;
    for (const v of p.visits) {
      const d = parseDateStr(v.date);
      if (!d) continue;
      const dt = new Date(d.y, (d.m || 1) - 1, d.d || 1, d.h || 0, d.mi || 0);
      t = Math.max(t, dt.getTime());
    }
    return t || (p.updatedAt || 0);
  }

  function focusPlace(p) {
    if (state.mode === 'china') {
      const a = albers(p.lon, p.lat);
      state.china.k = Math.max(state.china.k, state.china.fitK * 4 || state.china.k);
      state.china.tx = state.view.W / 2 - state.china.k * a[0];
      state.china.ty = state.view.H / 2 + state.china.k * a[1];
      clampChina();
    } else {
      state.globe.lon = p.lon;
      state.globe.lat = clamp(p.lat, -60, 70);
    }
    requestDraw();
  }

  /* ---------------- 指针交互 ---------------- */
  const pointer = { down: false, moved: false, x0: 0, y0: 0, lx: 0, ly: 0, t: 0, dragging: false };

  function bindPointer() {
    on(canvas, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      pointer.down = true; pointer.moved = false; pointer.dragging = false;
      pointer.x0 = pointer.lx = e.clientX; pointer.y0 = pointer.ly = e.clientY;
      pointer.t = performance.now();
      state.globe.vLon = state.globe.vLat = 0;
      state.china.vx = state.china.vy = 0;
    });

    on(window, 'pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

      if (pointer.down) {
        const dx = e.clientX - pointer.lx, dy = e.clientY - pointer.ly;
        const total = Math.hypot(e.clientX - pointer.x0, e.clientY - pointer.y0);
        if (total > 4) pointer.dragging = true;
        if (pointer.dragging) {
          pointer.moved = true;
          if (state.mode === 'globe') {
            const g = state.globe;
            // 跟手：鼠标在球面移动 1px ≈ 1/R 弧度（球半径 R）
            const R = Math.max(80, state.view.R || 300);
            const k = (180 / Math.PI) / R;
            const dl = -dx * k, dp = dy * k;
            g.lon += dl;
            g.lat = clamp(g.lat + dp, -88, 88);
            g.vLon = dl;
            g.vLat = dp;
          } else {
            const c = state.china;
            c.tx += dx; c.ty += dy;
            c.vx = dx; c.vy = dy;
            clampChina();
          }
          requestDraw();
        }
        pointer.lx = e.clientX; pointer.ly = e.clientY;
      } else {
        hoverAt(sx, sy);
      }
    });

    on(window, 'pointerup', (e) => {
      if (!pointer.down) return;
      pointer.down = false;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (!pointer.moved) {
        if (state.replay.active) return;
        if (state.mode === 'globe') pickGlobe(sx, sy);
        else pickChina(sx, sy);
      } else {
        startInertia();
      }
    });

    on(canvas, 'pointerleave', () => { hideTooltip(); state.hover = null; requestDraw(); });

    on(canvas, 'wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (state.mode === 'globe') {
        const g = state.globe;
        g.zoom = clamp(g.zoom * Math.exp(-e.deltaY * 0.0012), 0.55, 4.2);
      } else {
        const c = state.china;
        const ratio = Math.exp(-e.deltaY * 0.0012);
        const nk = clamp(c.k * ratio, c.minK, c.maxK);
        const real = nk / c.k;
        c.tx = mx - (mx - c.tx) * real;
        c.ty = my - (my - c.ty) * real;
        c.k = nk;
        clampChina();
      }
      requestDraw();
    }, { passive: false });
  }

  let cnAnim = null;

  function animateChinaTo(tx1, ty1, dur) {
    const c = state.china;
    const tx0 = c.tx, ty0 = c.ty;
    const t0 = performance.now();
    if (cnAnim) cancelAnimationFrame(cnAnim);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      c.tx = tx0 + (tx1 - tx0) * e;
      c.ty = ty0 + (ty1 - ty0) * e;
      requestDraw();
      if (p < 1) cnAnim = requestAnimationFrame(step);
      else cnAnim = null;
    };
    cnAnim = requestAnimationFrame(step);
  }

  // 拖动松手后回弹到合法位置（地图不露空白），拖动过程跟手
  function snapBackChina() {
    const c = state.china;
    const tx = c.tx, ty = c.ty;
    clampChina();
    if (Math.abs(c.tx - tx) > 0.5 || Math.abs(c.ty - ty) > 0.5) {
      const targetX = c.tx, targetY = c.ty;
      c.tx = tx; c.ty = ty;
      animateChinaTo(targetX, targetY, 240);
    }
  }

  let inertiaTimer = null;
  function startInertia() {
    const g = state.globe, c = state.china;
    if (state.mode === 'globe') {
      // 惯性：限速 + 限总幅度，避免甩一下飞半圈
      let vl = clamp(g.vLon, -6, 6);
      let vp = clamp(g.vLat, -6, 6);
      if (Math.abs(vl) < 0.05 && Math.abs(vp) < 0.05) return;
      let total = 0;
      const step = () => {
        vl *= 0.87; vp *= 0.87;
        total += Math.abs(vl);
        if (total > 70 || (Math.abs(vl) < 0.02 && Math.abs(vp) < 0.02)) {
          g.vLon = g.vLat = 0;
          return;
        }
        g.lon += vl;
        g.lat = clamp(g.lat + vp, -88, 88);
        requestDraw();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else {
      let vx = c.vx, vy = c.vy;
      if (Math.abs(vx) < 0.3 && Math.abs(vy) < 0.3) { clampChina(); return; }
      const step = () => {
        vx *= 0.9; vy *= 0.9;
        c.tx += vx; c.ty += vy;
        clampChina();
        requestDraw();
        if (Math.abs(vx) > 0.2 || Math.abs(vy) > 0.2) requestAnimationFrame(step);
        else { c.vx = c.vy = 0; clampChina(); requestDraw(); }
      };
      requestAnimationFrame(step);
    }
  }

  /* ---------------- 悬停 ---------------- */
  const tip = $('#tooltip');

  function hoverAt(sx, sy) {
    let label = '', sub = '', changed = false;
    if (state.mode === 'china') {
      const co = hitCounty(sx, sy);
      const c = co ? null : hitCityChina(sx, sy);
      const key = co ? 'c:' + co.code : (c ? 't:' + c.code : '');
      if (co) {
        const exist = countyVisited.get(co.code);
        label = prettyName(co.name);
        sub = [prettyName(co.city), exist ? `去过 ${visitCount(exist)} 次` : ''].filter(Boolean).join(' · ');
        canvas.style.cursor = 'pointer';
      } else if (c) {
        const exist = cityVisited.get(c.code);
        label = prettyName(c.name);
        sub = [prettyName(c.province), exist ? `去过 ${visitCount(exist)} 次` : ''].filter(Boolean).join(' · ');
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'grab';
      }
      const prevKey = state.hover && state.hover.type === 'county' ? 'c:' + state.hover.code
        : state.hover && state.hover.type === 'city' ? 't:' + state.hover.code : '';
      if (prevKey !== key) {
        state.hover = co ? { type: 'county', code: co.code } : c ? { type: 'city', code: c.code } : null;
        changed = true;
      }
    } else {
      const geo = screenToGlobe(sx, sy);
      const country = geo ? hitCountryGlobe(geo.lon, geo.lat) : null;
      if (country) {
        label = countryLabel(country);
        sub = countryVisited.has(country.code) ? '已去过' : '';
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = geo ? 'grab' : 'default';
      }
      const prevKey = state.hover && state.hover.type === 'country' ? state.hover.code : '';
      if (prevKey !== (country ? country.code : '')) {
        state.hover = country ? { type: 'country', code: country.code } : null;
        changed = true;
      }
    }

    if (label) {
      tip.innerHTML = `${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
      tip.style.left = sx + 'px';
      tip.style.top = sy + 'px';
      tip.style.opacity = '1';
    } else {
      tip.style.opacity = '0';
    }
    if (changed) requestDraw();
  }

  function hideTooltip() { tip.style.opacity = '0'; }

  function visitCount(p) {
    const n = p.visits.filter((v) => v.date || v.note || (v.days !== '' && v.days != null) || (v.hours !== '' && v.hours != null)).length;
    return n || (p.visits.length ? 1 : 0);
  }

  /* ---------------- 顶栏 / 侧栏按钮 ---------------- */
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode === 'china' && !state.china.fit) { fitChina(); state.china.fit = true; }
    if (mode === 'china') state.china.fitK = state.china.k;
    $('#hint').textContent = mode === 'globe'
      ? '拖动旋转地球 · 滚轮缩放 · 点击国家或城市记录足迹'
      : '拖动平移 · 滚轮缩放 · 点击城市记录足迹';
    requestDraw();
    renderSidebar();
  }

  function bindUI() {
    document.querySelectorAll('.mode').forEach((b) => on(b, 'click', () => setMode(b.dataset.mode)));

    on($('#search'), 'input', (e) => { state.query = e.target.value; renderSidebar(); });

    document.querySelectorAll('.tabs button').forEach((b) => on(b, 'click', () => {
      state.tab = b.dataset.tab;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderSidebar();
    }));

    on($('#btn-add'), 'click', () => openDrawerFor(null, {}));

    on($('#btn-close-drawer'), 'click', closeDrawer);
    on($('#btn-star'), 'click', () => {
      if (!draft) return;
      collectDrawer();
      draft.starred = !draft.starred;
      const b = $('#btn-star');
      if (b) {
        b.textContent = draft.starred ? '★' : '☆';
        b.classList.toggle('on', draft.starred);
      }
    });
    on($('#btn-save'), 'click', saveDraft);
    on($('#btn-delete-place'), 'click', deleteDraft);

    on($('#zoom-in'), 'click', () => zoomBy(1.35));
    on($('#zoom-out'), 'click', () => zoomBy(1 / 1.35));
    on($('#zoom-reset'), 'click', () => {
      if (state.mode === 'globe') { state.globe.lon = 104; state.globe.lat = 28; state.globe.zoom = 1; }
      else { fitChina(); }
      requestDraw();
    });

    on($('#btn-export'), 'click', exportJSON);
    on($('#btn-replay'), 'click', openReplaySetup);
    on($('#rs-all'), 'click', () => {
      const items = collectReplayItems();
      if (items.length) {
        const d0 = new Date(items[0].t), d1 = new Date(items[items.length - 1].t);
        writeDate3($('#rs-from'), { y: d0.getFullYear(), m: d0.getMonth() + 1, d: d0.getDate() });
        writeDate3($('#rs-to'), { y: d1.getFullYear(), m: d1.getMonth() + 1, d: d1.getDate() });
      }
    });
    on($('#rs-start'), 'click', runReplay);
    on($('#rb-stop'), 'click', () => stopReplay(false));
    on($('#btn-import'), 'click', () => $('#file-input').click());
    on($('#file-input'), 'change', importJSON);

    // Esc 关闭
    on(window, 'keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    // 滚轮模式下抽屉打开时点击地图仍可操作
  }

  function zoomBy(f) {
    if (state.mode === 'globe') {
      state.globe.zoom = clamp(state.globe.zoom * f, 0.55, 4.2);
    } else {
      const c = state.china;
      const mx = state.view.W / 2, my = state.view.H / 2;
      const nk = clamp(c.k * f, c.minK, c.maxK);
      const real = nk / c.k;
      c.tx = mx - (mx - c.tx) * real;
      c.ty = my - (my - c.ty) * real;
      c.k = nk;
      clampChina();
    }
    requestDraw();
  }

  /* ---------------- 导入导出 ---------------- */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  function exportJSON() {
    download(`足迹地图-${stamp()}.json`, JSON.stringify({ version: 1, places: state.places }, null, 2));
    toast('已导出 JSON');
  }

  function importJSON(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        const list = Array.isArray(obj) ? obj : obj.places;
        if (!Array.isArray(list)) throw new Error('格式不对');
        const incoming = list.map(normalizePlace).filter(Boolean);
        const existing = new Set(state.places.map((p) => p.id));
        let added = 0;
        for (const p of incoming) {
          if (!existing.has(p.id)) { state.places.push(p); added++; }
          else {
            const i = state.places.findIndex((x) => x.id === p.id);
            state.places[i] = p;
          }
        }
        rebuildIndexes();
        saveState();
        renderSidebar();
        requestDraw();
        toast(`导入完成，新增 ${added} 条`);
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  /* ---------------- 启动 ---------------- */
  async function init() {
    prepData();
    // 两套 bbox：fit 用（排除三沙，主体更大）、拖动边界用（含三沙，能拖到最南）
    const gbFit = [Infinity, Infinity, -Infinity, -Infinity];
    const gbPan = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of CITIES) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const poly of c._polys) for (const ring of poly) for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      c._bbox = [minX, minY, maxX, maxY];
      const p = c._p;
      if (c.code !== '460300') {
        if (p[0] < gbFit[0]) gbFit[0] = p[0];
        if (p[1] < gbFit[1]) gbFit[1] = p[1];
        if (p[0] > gbFit[2]) gbFit[2] = p[0];
        if (p[1] > gbFit[3]) gbFit[3] = p[1];
      }
      if (minX < gbPan[0]) gbPan[0] = minX;
      if (minY < gbPan[1]) gbPan[1] = minY;
      if (maxX > gbPan[2]) gbPan[2] = maxX;
      if (maxY > gbPan[3]) gbPan[3] = maxY;
    }
    CHINA_BBOX = gbFit;
    CHINA_PAN = gbPan;
    BORDER_BBOX = null;
    if (BORDER) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const poly of BORDER._polys) for (const ring of poly) for (const [x, y] of ring) {
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
        if (x > bx1) bx1 = x;
        if (y > by1) by1 = y;
      }
      BORDER_BBOX = [bx0, by0, bx1, by1];
    }

    await loadState();
    rebuildIndexes();

    bindPointer();
    bindUI();
    setMode('globe');
    resize();
    window.addEventListener('resize', resize);
    renderSidebar();
    requestDraw();
  }

  /* ---------------- 行程回放 ---------------- */
  function projectLL(lon, lat) {
    if (state.mode === 'china') {
      const a = albers(lon, lat);
      return { x: state.china.k * a[0] + state.china.tx, y: -state.china.k * a[1] + state.china.ty };
    }
    const v = sphereVec(lon, lat);
    const M = makeRot(state.globe.lon, state.globe.lat);
    const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
    const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
    const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
    if (z <= 0.02) return null;
    const { R, cx, cy } = state.view;
    return { x: cx + R * x, y: cy - R * y };
  }

  function collectReplayItems() {
    const items = [];
    for (const p of state.places) {
      if (p.status !== 'visited') continue;
      for (const v of p.visits) {
        const dt = parseDateStr(v.date);
        if (!dt) continue;
        items.push({ t: new Date(dt.y, (dt.m || 1) - 1, dt.d || 1, dt.h || 0, dt.mi || 0).getTime(), p, date: v.date });
      }
    }
    items.sort((a, b) => a.t - b.t);
    return items;
  }

  function readDate3(root) {
    const y = root.querySelector('[data-k="y"]').value.trim();
    const m = root.querySelector('[data-k="m"]').value.trim();
    const d = root.querySelector('[data-k="d"]').value.trim();
    if (!y) return null;
    return parseDateStr(y + (m ? '-' + pad2(+m) : '') + (d ? '-' + pad2(+d) : ''));
  }

  function writeDate3(root, dt) {
    root.querySelector('[data-k="y"]').value = dt ? String(dt.y) : '';
    root.querySelector('[data-k="m"]').value = dt && dt.m ? pad2(dt.m) : '';
    root.querySelector('[data-k="d"]').value = dt && dt.d ? pad2(dt.d) : '';
  }

  function openReplaySetup() {
    const items = collectReplayItems();
    if (!items.length) { toast('还没有带日期的记录，先在访问记录里填日期'); return; }
    const d0 = new Date(items[0].t), d1 = new Date(items[items.length - 1].t);
    writeDate3($('#rs-from'), { y: d0.getFullYear(), m: d0.getMonth() + 1, d: d0.getDate() });
    writeDate3($('#rs-to'), { y: d1.getFullYear(), m: d1.getMonth() + 1, d: d1.getDate() });
    $('#replay-setup').classList.add('on');
  }

  function runReplay() {
    const from = readDate3($('#rs-from'));
    const to = readDate3($('#rs-to'));
    const t0 = from ? new Date(from.y, (from.m || 1) - 1, from.d || 1).getTime() : 0;
    const t1 = to ? new Date(to.y, (to.m || 1) - 1, to.d || 1, 23, 59, 59).getTime() : Infinity;
    const items = collectReplayItems().filter((it) => it.t >= t0 && it.t <= t1);
    $('#replay-setup').classList.remove('on');
    if (!items.length) { toast('这段时间没有记录'); return; }
    closeDrawer();
    stopReplay(true);
    const r = state.replay;
    r.active = true;
    r.items = items;
    r.cursor = 0;
    r.cityLit = new Map();
    r.flash = [];
    r.segments = [];
    r.lastPos = null;
    $('#replay-bar').classList.add('on');
    r.timer = setInterval(stepReplay, 560);
    r.raf = requestAnimationFrame(replayFrame);
    stepReplay();
    toast('回放：' + items.length + ' 次');
  }

  function startReplay() { openReplaySetup(); }

  function stepReplay() {
    const r = state.replay;
    if (!r.active) return;
    if (r.cursor >= r.items.length) {
      if (r.timer) { clearInterval(r.timer); r.timer = null; }
      setTimeout(() => { if (state.replay.active) stopReplay(false); }, 1600);
      return;
    }
    const it = r.items[r.cursor++];
    if (it.p.cityCode) r.cityLit.set(it.p.cityCode, (r.cityLit.get(it.p.cityCode) || 0) + 1);
    r.flash.push({ p: it.p, born: performance.now() });
    const from = r.lastPos;
    const to = { lon: it.p.lon, lat: it.p.lat };
    if (from) r.segments.push({ from, to, born: performance.now() });
    r.lastPos = to;
    $('#rb-date').textContent = it.date || '';
    $('#rb-name').textContent = it.p.isHome
      ? (it.p.name || it.p.cityName || '家') + '（家）'
      : (it.p.spot || it.p.name || it.p.cityName || '');
    $('#rb-count').textContent = r.cursor + ' / ' + r.items.length;
  }

  function replayFrame() {
    const r = state.replay;
    if (!r.active) return;
    draw();
    r.raf = requestAnimationFrame(replayFrame);
  }

  function stopReplay(silent) {
    const r = state.replay;
    if (!r || !r.active) return;
    if (r.timer) { clearInterval(r.timer); r.timer = null; }
    if (r.raf) { cancelAnimationFrame(r.raf); r.raf = null; }
    r.active = false;
    $('#replay-bar').classList.remove('on');
    requestDraw();
    if (!silent) toast('回放结束');
  }

  function drawReplayLines() {
    const r = state.replay;
    if (!r.active) return;
    const now = performance.now();
    ctx.save();
    for (const seg of r.segments) {
      const a = projectLL(seg.from.lon, seg.from.lat);
      const b = projectLL(seg.to.lon, seg.to.lat);
      if (!a || !b) continue;
      const age = Math.min(1, (now - seg.born) / 520);
      const ex = a.x + (b.x - a.x) * age;
      const ey = a.y + (b.y - a.y) * age;
      const life = Math.min(1, (now - seg.born) / 4000);
      const alpha = 0.10 + 0.42 * (1 - life);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(255, 196, 130, ' + alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    // 跳点光圈
    r.flash = r.flash.filter((f) => now - f.born < 900);
    for (const f of r.flash) {
      const pos = projectLL(f.p.lon, f.p.lat);
      if (!pos) continue;
      const age = (now - f.born) / 900;
      const rgb = f.p.isHome ? '140, 210, 240' : '255, 196, 130';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 8 + age * 74, 0, TAU);
      ctx.strokeStyle = 'rgba(' + rgb + ', ' + (0.6 * (1 - age)).toFixed(3) + ')';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 调试/测试入口
  window.__app = {
    state, draw, requestDraw, pickChina, pickGlobe, visitedStats,
    placeLocationText, prettyName, setMode, openDrawerFor, saveDraft,
    collectDrawer, hitCityChina, hitCounty, screenToGlobe, hitCountryGlobe,
    albers, makeRot, sphereVec, ensureCounties, prepCounties,
    closeDrawer, cacheInfo: () => (cnCache ? { k: cnCache.k, tx: cnCache.tx, ty: cnCache.ty } : null),
    openReplaySetup, runReplay, stopReplay,
  };

  init();
})();
