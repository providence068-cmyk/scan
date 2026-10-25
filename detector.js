/* =====================================================================
   紙の四隅の検出（画面にもワーカーにも読み込める、DOMを使わない版）

   使い方:  const r = DocDetect.detect({data, width, height}, prevQuad?, opts?)
            r = { quad: [[x,y]×4 (0〜1, 左上→右上→右下→左下)], score: 0〜1 } または null
   - 画像は長辺 300〜400px くらいに縮めてから渡すと速い（1回 10〜30ms）
   - prevQuad を渡すと、まずその近くを探す（カメラの追尾用・さらに速い）

   しくみ
   1. 色の境目（明るさだけでなく色の違いも見る）を輪郭として取り出す
   2. 輪郭から長い直線を探す（ハフ変換。勾配の向きに合う角度だけ投票するので速い）
   3. 「紙らしい明るい塊」からも四角形の候補を作る
   4. 候補の各辺を近くの本当の縁に吸い付かせ、点数（輪郭の乗り具合・内外の色の差・
      外側＝机の色の一様さ・形の自然さ）がいちばん高いものを選ぶ
   ===================================================================== */
(function (root) {
  'use strict';

  // ---------- 基本の画像処理 ----------
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / win;
        s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / win;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }
  function otsu(vals, n) { // vals: 0〜255
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, vals[i] | 0))]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = t; }
    }
    return th;
  }

  // ---------- 前処理（1枚につき1回） ----------
  function prepare(img) {
    const w = img.width, h = img.height, n = w * h, d = img.data;
    let R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i++, k += 4) { R[i] = d[k]; G[i] = d[k + 1]; B[i] = d[k + 2]; }
    // 文字の細かい模様を消すため、しっかりぼかしてから境目を探す（紙の縁のような大きな境目は残る）
    const br = Math.max(1, Math.round(Math.max(w, h) / 150));
    R = boxBlur(boxBlur(R, w, h, br), w, h, br); G = boxBlur(boxBlur(G, w, h, br), w, h, br); B = boxBlur(boxBlur(B, w, h, br), w, h, br);
    // 色を比べる用は、さらにぼかす（文字1つ1つに左右されないように）
    const cr = Math.max(2, Math.round(Math.max(w, h) / 90));
    const Rs = boxBlur(R, w, h, cr), Gs = boxBlur(G, w, h, cr), Bs = boxBlur(B, w, h, cr);
    // 色の勾配（3色のうち一番大きい変化）。白い紙と白っぽい机のように明るさが近くても色で分かる
    const mag = new Float32Array(n), gxA = new Float32Array(n), gyA = new Float32Array(n);
    let gmax = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, a = i - w - 1, b = i - w, c = i - w + 1, l = i - 1, r = i + 1, e = i + w - 1, f = i + w, g = i + w + 1;
      let gx = R[c] + 2 * R[r] + R[g] - R[a] - 2 * R[l] - R[e], gy = R[e] + 2 * R[f] + R[g] - R[a] - 2 * R[b] - R[c], best = gx * gx + gy * gy, bx = gx, by = gy;
      gx = G[c] + 2 * G[r] + G[g] - G[a] - 2 * G[l] - G[e]; gy = G[e] + 2 * G[f] + G[g] - G[a] - 2 * G[b] - G[c];
      let m = gx * gx + gy * gy; if (m > best) { best = m; bx = gx; by = gy; }
      gx = B[c] + 2 * B[r] + B[g] - B[a] - 2 * B[l] - B[e]; gy = B[e] + 2 * B[f] + B[g] - B[a] - 2 * B[b] - B[c];
      m = gx * gx + gy * gy; if (m > best) { best = m; bx = gx; by = gy; }
      const v = Math.sqrt(best); mag[i] = v; gxA[i] = bx; gyA[i] = by; if (v > gmax) gmax = v;
    }
    // 細線化＋しきい値（強い方の境目を基準に、その15%以上を輪郭とする）。ヒストグラムで上位1.5%の値を求める
    const NB = 512, hist = new Uint32Array(NB), sc = (NB - 1) / (gmax || 1);
    for (let i = 0; i < n; i++) hist[(mag[i] * sc) | 0]++;
    let acc = 0, p985 = gmax; for (let k = NB - 1; k >= 0; k--) { acc += hist[k]; if (acc >= n * 0.015) { p985 = k / sc; break; } }
    const th = Math.max(10, p985 * 0.15);
    const edge = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < th) continue;
      const ax = Math.abs(gxA[i]), ay = Math.abs(gyA[i]);
      let a, b;
      if (ax > 2.4 * ay) { a = mag[i - 1]; b = mag[i + 1]; }
      else if (ay > 2.4 * ax) { a = mag[i - w]; b = mag[i + w]; }
      else if (gxA[i] * gyA[i] > 0) { a = mag[i - w - 1]; b = mag[i + w + 1]; }
      else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
      if (m >= a && m >= b) edge[i] = 1;
    }
    // 輪郭の近く（±2px）
    const near = new Uint8Array(n), tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++) { const row = y * w; let last = -99;
      for (let x = 0; x < w; x++) { if (edge[row + x]) last = x; if (x - last <= 2) tmp[row + x] = 1; }
      last = 99999; for (let x = w - 1; x >= 0; x--) { if (edge[row + x]) last = x; if (last - x <= 2) tmp[row + x] = 1; } }
    for (let x = 0; x < w; x++) { let last = -99;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= 2) near[y * w + x] = 1; }
      last = 99999; for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= 2) near[y * w + x] = 1; } }
    return { w, h, R: Rs, G: Gs, B: Bs, mag, gx: gxA, gy: gyA, edge, near, th };
  }

  // ---------- 辺と四角形の評価 ----------
  const SAMPLES = 48;
  function col(S, x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= S.w || yi >= S.h) return null;
    const i = yi * S.w + xi; return [S.R[i], S.G[i], S.B[i]];
  }
  const cd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const chroma = (a, b) => { const sa = a[0] + a[1] + a[2] + 1, sb = b[0] + b[1] + b[2] + 1; return 300 * Math.hypot(a[0] / sa - b[0] / sb, a[1] / sa - b[1] / sb, a[2] / sa - b[2] / sb); };
  // 線分 a→b を見る（画面外は数えない）。c は四角形の内側の点
  function side(S, a, b, c) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
    if ((c[0] - a[0]) * nx + (c[1] - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
    // 近く（2%）と少し遠く（5%）の両方で内と外を比べ、小さい方を採る。
    // 紙の縁なら両方とも「紙と机」で差が大きい。文字の行の境目なら、少し離れると両側とも紙になり差が消える
    const m = Math.min(S.w, S.h), o1 = Math.max(2.5, m * 0.022), o2 = Math.max(5, m * 0.055);
    let n = 0, hit = 0, dn = 0, diff = 0, run = 0, best = 0, gapRun = 0;
    const ic = [0, 0, 0], oc = [0, 0, 0];
    for (let i = 2; i <= SAMPLES - 2; i++) {
      const x = a[0] + (b[0] - a[0]) * i / SAMPLES, y = a[1] + (b[1] - a[1]) * i / SAMPLES;
      if (x < 1 || y < 1 || x > S.w - 2 || y > S.h - 2) continue;
      n++;
      const on = S.near[Math.round(y) * S.w + Math.round(x)];
      hit += on;
      if (on) { run++; gapRun = 0; if (run > best) best = run; } else if (++gapRun > 2) run = 0;
      const i1 = col(S, x + nx * o1, y + ny * o1), u1 = col(S, x - nx * o1, y - ny * o1);
      const i2 = col(S, x + nx * o2, y + ny * o2), u2 = col(S, x - nx * o2, y - ny * o2);
      if (i1 && u1) {
        let dd = cd(i1, u1);
        if (i2 && u2) dd = Math.min(dd, cd(i2, u2), cd(i1, u2), cd(i2, u1));
        diff += dd; dn++; const iu = i2 || i1, ou = u2 || u1;
        for (let k = 0; k < 3; k++) { ic[k] += iu[k]; oc[k] += ou[k]; }
      }
    }
    if (n < 8 || dn < 5) return null;
    return { s: hit / n, run: best / n, c: diff / dn, inC: ic.map(v => v / dn), outC: oc.map(v => v / dn), n };
  }
  function lineColor(S, a, b) {
    const acc = [0, 0, 0]; let n = 0;
    for (let i = 0; i <= 24; i++) {
      const v = col(S, a[0] + (b[0] - a[0]) * i / 24, a[1] + (b[1] - a[1]) * i / 24);
      if (v) { acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2]; n++; }
    }
    return n < 6 ? null : acc.map(v => v / n);
  }
  function polyArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p[0] * r[1] - r[0] * p[1]; } return Math.abs(a) / 2; }
  function convex(q) {
    let sg = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(z) < 1e-6) return false; const s = Math.sign(z);
      if (!sg) sg = s; else if (s !== sg) return false;
    }
    return true;
  }
  function score(S, q) {
    if (!convex(q)) return 0;
    const area = polyArea(q) / (S.w * S.h);
    if (area < 0.05) return 0;
    const c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
    const sides = [0, 1, 2, 3].map(i => side(S, q[i], q[(i + 1) % 4], c));
    const seen = sides.filter(Boolean);
    if (seen.length < 2) return 0;
    let sup = 0, con = 0, weak = 9, inBright = 0, outBright = 0;
    for (const s of seen) {
      sup += 0.6 * s.s + 0.4 * s.run; con += Math.min(1, s.c / 60);
      weak = Math.min(weak, Math.min(s.s / 0.55, s.c / 22));
      inBright += s.inC[0] + s.inC[1] + s.inC[2]; outBright += s.outC[0] + s.outC[1] + s.outC[2];
    }
    sup /= seen.length; con /= seen.length;
    // 外側（机）の色が全周で同じか
    let spread = 0;
    for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) spread = Math.max(spread, chroma(seen[i].outC, seen[j].outC), cd(seen[i].outC, seen[j].outC) / 3);
    // 内側どうしも同じ紙の色のはず
    let inSpread = 0;
    for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) inSpread = Math.max(inSpread, chroma(seen[i].inC, seen[j].inC));
    // 角の形（斜めから撮っても 45〜135° に収まる）
    let shape = 1;
    for (let i = 0; i < 4; i++) {
      const p0 = q[(i + 3) % 4], p1 = q[i], p2 = q[(i + 1) % 4];
      const v1x = p0[0] - p1[0], v1y = p0[1] - p1[1], v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
      const cs = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
      const ang = Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI;
      if (ang < 45 || ang > 135) shape *= 0.3; else if (ang < 60 || ang > 120) shape *= 0.8;
    }
    // 向かい合う辺の長さが極端に違うのは不自然
    const L = i => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
    const r1 = Math.min(L(0), L(2)) / (Math.max(L(0), L(2)) || 1), r2 = Math.min(L(1), L(3)) / (Math.max(L(1), L(3)) || 1);
    if (Math.min(r1, r2) < 0.45) shape *= 0.4;
    // 画面の外にはみ出した辺：その縁ぎわが机の色なら、本当ははみ出していない
    let border = seen.length === 4 ? 1 : seen.length === 3 ? 0.9 : 0.75;
    if (seen.length < 4) {
      const desk = [0, 1, 2].map(k => seen.reduce((t, s) => t + s.outC[k], 0) / seen.length);
      sides.forEach((s, i) => {
        if (s) return;
        const a = q[i], b = q[(i + 1) % 4]; let like = 0, k = 0;
        for (let j = 3; j <= 45; j++) {
          const x = Math.min(S.w - 3, Math.max(2, a[0] + (b[0] - a[0]) * j / 48)), y = Math.min(S.h - 3, Math.max(2, a[1] + (b[1] - a[1]) * j / 48));
          const v = col(S, x + (c[0] - x) * 0.04, y + (c[1] - y) * 0.04); if (v) { k++; if (chroma(v, desk) < 9 && cd(v, desk) < 50) like++; }
        }
        if (k && like / k > 0.3) border *= 0.25;
      });
    }
    const bright = inBright > outBright ? 1 : 0.85; // 紙は机より明るいことが多い
    const sz = Math.pow(Math.min(1, area / 0.25), 0.35);
    return Math.max(0, (0.5 * sup + 0.5 * con) * Math.sqrt(Math.max(0, Math.min(1, weak))) / (1 + spread / 45) / (1 + inSpread / 120) * shape * border * bright * sz);
  }

  // ---------- 直線を探す（ハフ変換） ----------
  const NT = 180, COS = new Float32Array(NT), SIN = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { COS[t] = Math.cos(t * Math.PI / NT); SIN[t] = Math.sin(t * Math.PI / NT); }
  function houghLines(S, maxLines) {
    const { w, h, edge, gx, gy } = S, diag = Math.ceil(Math.hypot(w, h)), NR = 2 * diag + 1;
    const acc = new Uint16Array(NT * NR);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!edge[i]) continue;
      // 勾配の向き＝線の法線の向き。その前後 ±4° だけに投票
      let t0 = Math.round(Math.atan2(gy[i], gx[i]) * NT / Math.PI); t0 = ((t0 % NT) + NT) % NT;
      for (let dt = -4; dt <= 4; dt++) {
        let t = t0 + dt, flip = 1; if (t < 0) { t += NT; flip = -1; } else if (t >= NT) { t -= NT; flip = -1; }
        const r = Math.round(x * COS[t] + y * SIN[t]) + diag; if (r >= 0 && r < NR) acc[t * NR + r]++;
      }
    }
    const minV = Math.min(w, h) * 0.1, cand = [];
    for (let t = 0; t < NT; t++) for (let r = 1; r < NR - 1; r++) {
      const v = acc[t * NR + r]; if (v < minV) continue;
      if (v < acc[t * NR + r - 1] || v < acc[t * NR + r + 1]) continue;
      cand.push(v, t, r - diag);
    }
    const idx = []; for (let i = 0; i < cand.length; i += 3) idx.push(i);
    idx.sort((a, b) => cand[b] - cand[a]);
    const lines = [], md = Math.min(w, h) * 0.025;
    for (const i of idx) {
      const v = cand[i], t = cand[i + 1], r = cand[i + 2];
      if (lines.some(L => { let dt = Math.abs(L.t - t); dt = Math.min(dt, NT - dt); return dt < 5 && Math.abs(L.r - r) < md; })) continue;
      lines.push({ t, r, v }); if (lines.length >= maxLines) break;
    }
    return lines;
  }
  function meet(a, b) {
    const d = COS[a.t] * SIN[b.t] - SIN[a.t] * COS[b.t]; if (Math.abs(d) < 1e-6) return null;
    return [(a.r * SIN[b.t] - SIN[a.t] * b.r) / d, (COS[a.t] * b.r - a.r * COS[b.t]) / d];
  }
  function orderQuad(pts) {
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4, cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0; s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return [0, 1, 2, 3].map(i => s[(k + i) % 4]);
  }
  function lineQuads(S) {
    const { w, h } = S, lines = houghLines(S, 26);
    // 画面の縁も候補に（紙がはみ出しているとき用）
    const bord = [{ t: 90, r: 0 }, { t: 90, r: h - 1 }, { t: 0, r: 0 }, { t: 0, r: w - 1 }];
    // 向きで2組に分ける：いちばん多い向きと、それにほぼ垂直な向き
    const out = [], all = lines.concat(bord.map(b => ({ ...b, border: 1 })));
    const near = (a, b) => { let d = Math.abs(a - b) % NT; return Math.min(d, NT - d); };
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const A = all[i], B = all[j]; if (near(A.t, B.t) > 30) continue; // 平行に近い2本
      if (Math.abs(A.r - B.r) < Math.min(w, h) * 0.12 && near(A.t, B.t) < 10) continue;
      for (let k = 0; k < all.length; k++) {
        const C = all[k]; if (near(C.t, A.t) < 50) continue;
        for (let l = k + 1; l < all.length; l++) {
          const D = all[l]; if (near(D.t, C.t) > 30 || near(D.t, A.t) < 50) continue;
          if ((A.border ? 1 : 0) + (B.border ? 1 : 0) + (C.border ? 1 : 0) + (D.border ? 1 : 0) > 1) continue;
          const p = [meet(A, C), meet(A, D), meet(B, D), meet(B, C)];
          if (p.some(z => !z || z[0] < -0.3 * w || z[0] > 1.3 * w || z[1] < -0.3 * h || z[1] > 1.3 * h)) continue;
          const q = orderQuad(p);
          if (polyArea(q) < 0.06 * w * h) continue;
          out.push(q);
        }
      }
    }
    return out;
  }

  // ---------- 「紙らしい明るい塊」から候補を作る ----------
  function regionQuads(S) {
    const { w, h, R, G, B } = S, n = w * h, out = [];
    const maps = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]), sat = mx ? (mx - mn) / mx : 0;
      maps[0][i] = mx * (1 - sat * 0.9); maps[1][i] = Math.max(0, 255 - sat * 600);
    }
    const stack = new Int32Array(n);
    for (const M of maps) {
      const th = otsu(M, n), out0 = new Uint8Array(n);
      // 画面の縁から「紙でないところ」をたどる → 残った所が紙（文字の穴も埋まる）
      let top = 0;
      const seed = p => { if (M[p] <= th && !out0[p]) { out0[p] = 1; stack[top++] = p; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (top) {
        const p = stack[--top], x = p % w;
        if (x > 0) seed(p - 1); if (x < w - 1) seed(p + 1); if (p >= w) seed(p - w); if (p < n - w) seed(p + w);
      }
      // 最大の塊
      const lab = new Int32Array(n); let L = 0, bestL = 0, bestN = 0;
      for (let s = 0; s < n; s++) {
        if (out0[s] || lab[s]) continue;
        L++; let cnt = 0; top = 0; stack[top++] = s; lab[s] = L;
        while (top) {
          const p = stack[--top], x = p % w; cnt++;
          if (x > 0 && !out0[p - 1] && !lab[p - 1]) { lab[p - 1] = L; stack[top++] = p - 1; }
          if (x < w - 1 && !out0[p + 1] && !lab[p + 1]) { lab[p + 1] = L; stack[top++] = p + 1; }
          if (p >= w && !out0[p - w] && !lab[p - w]) { lab[p - w] = L; stack[top++] = p - w; }
          if (p < n - w && !out0[p + w] && !lab[p + w]) { lab[p + w] = L; stack[top++] = p + w; }
        }
        if (cnt > bestN) { bestN = cnt; bestL = L; }
      }
      if (bestN < 0.05 * n || bestN > 0.97 * n) continue;
      // 塊の外形から、いろいろな向きで四隅を取り、いちばん広い四角形を候補に
      const pts = [];
      for (let p = 0; p < n; p += 1) if (lab[p] === bestL) {
        const x = p % w, y = (p / w) | 0;
        // 境界の点だけ
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[p - 1] !== bestL || lab[p + 1] !== bestL || lab[p - w] !== bestL || lab[p + w] !== bestL) pts.push(x, y);
      }
      let best = null, bestA = 0;
      for (let deg = 0; deg < 90; deg += 6) {
        const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        let m = [Infinity, -Infinity, -Infinity, Infinity], P = [null, null, null, null];
        for (let i = 0; i < pts.length; i += 2) {
          const x = pts[i], y = pts[i + 1], u = x * ca + y * sa, v = -x * sa + y * ca;
          const s1 = u + v, s2 = u - v;
          if (s1 < m[0]) { m[0] = s1; P[0] = [x, y]; } if (s2 > m[1]) { m[1] = s2; P[1] = [x, y]; }
          if (s1 > m[2]) { m[2] = s1; P[2] = [x, y]; } if (s2 < m[3]) { m[3] = s2; P[3] = [x, y]; }
        }
        if (P.some(z => !z)) continue;
        const q = orderQuad(P), A = polyArea(q);
        if (A > bestA) { bestA = A; best = q; }
      }
      if (best) out.push(best);
    }
    return out;
  }

  // ---------- 各辺を近くの本当の縁に吸い付かせる ----------
  function refine(S, q, rangeFrac = 0.06, angDeg = 7, push = true) {
    const c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
    const R = Math.max(3, Math.min(S.w, S.h) * rangeFrac), lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, half = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
      let best = null;
      for (let dt = -angDeg; dt <= angDeg; dt += 1) {
        const t = ang + dt * Math.PI / 180, ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
        for (let dr = -R; dr <= R; dr += 1) {
          const px = mx + nx * dr, py = my + ny * dr;
          const s = side(S, [px - ux * half, py - uy * half], [px + ux * half, py + uy * half], c);
          if (!s) continue;
          const v = 0.4 * s.s + 0.3 * s.run + 0.3 * Math.min(1, s.c / 60) - Math.abs(dr) / R * 0.06 - Math.abs(dt) / angDeg * 0.03;
          if (!best || v > best.v) best = { v, p: [px, py], u: [ux, uy], ok: s.s > 0.35 && s.c > 12, dr, t, inC: s.inC };
        }
      }
      // 紙の縁は「いちばん外側」の境目。見つけた線の外側がまだ紙の色なら、さらに外の境目まで広げる
      if (push && best && best.ok) {
        const t = best.t, ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
        // 外向きの法線
        const sgn = ((c[0] - mx) * nx + (c[1] - my) * ny) > 0 ? -1 : 1;
        const P = best.inC, lim = Math.min(S.w, S.h) * 0.12;
        for (let k = 1; k <= lim; k++) {
          const dr = best.dr + sgn * k, px = mx + nx * dr, py = my + ny * dr;
          const A = [px - ux * half * 0.9, py - uy * half * 0.9], Bp = [px + ux * half * 0.9, py + uy * half * 0.9];
          const strip = lineColor(S, A, Bp); if (!strip) break;
          if (cd(strip, P) > 26 || chroma(strip, P) > 6) {
            // ここで紙の色が途切れた：ここが本当の縁なら採用
            const sd = side(S, [px - ux * half, py - uy * half], [px + ux * half, py + uy * half], c);
            if (k > 2 && sd && sd.s > 0.3 && sd.c > 18) best = { ...best, p: [px, py], u: [ux, uy] };
            break;
          }
        }
      }
      lines.push(best && best.ok ? best : { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u: [b[0] - a[0], b[1] - a[1]] });
    }
    const X = (L1, L2) => {
      const d = L1.u[0] * L2.u[1] - L1.u[1] * L2.u[0]; if (Math.abs(d) < 1e-9) return null;
      const t = ((L2.p[0] - L1.p[0]) * L2.u[1] - (L2.p[1] - L1.p[1]) * L2.u[0]) / d;
      return [L1.p[0] + L1.u[0] * t, L1.p[1] + L1.u[1] * t];
    };
    const out = [X(lines[3], lines[0]), X(lines[0], lines[1]), X(lines[1], lines[2]), X(lines[2], lines[3])];
    if (out.some(p => !p)) return q;
    const moved = Math.max(...out.map((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1])));
    return moved > Math.min(S.w, S.h) * 0.2 ? q : out;
  }

  // 速い下見：輪郭の乗り具合だけを少ない点で見る
  function quick(S, q) {
    let hit = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      for (let j = 1; j < 16; j++) {
        const x = Math.round(a[0] + (b[0] - a[0]) * j / 16), y = Math.round(a[1] + (b[1] - a[1]) * j / 16);
        if (x < 1 || y < 1 || x > S.w - 2 || y > S.h - 2) continue;
        n++; hit += S.near[y * S.w + x];
      }
    }
    return n < 20 ? 0 : (hit / n) * Math.pow(polyArea(q) / (S.w * S.h), 0.25);
  }

  // ---------- 本体 ----------
  function toN(S, q) { return q.map(([x, y]) => [Math.min(1.02, Math.max(-0.02, x / (S.w - 1))), Math.min(1.02, Math.max(-0.02, y / (S.h - 1)))]); }
  function toP(S, q) { return q.map(([x, y]) => [x * (S.w - 1), y * (S.h - 1)]); }
  function detect(img, prevQuad, opts = {}) {
    const S = prepare(img);
    let best = null;
    const consider = (q, kind) => { const s = score(S, q); if (!best || s > best.score) best = { q, score: s, kind }; };
    // 追尾：前の位置の近くをまず見る
    if (prevQuad) {
      const pq = toP(S, prevQuad);
      const r = refine(S, pq, opts.range ?? 0.05, opts.ang ?? 5, opts.push ?? true);
      consider(r, 'track');
      if (best.score >= (opts.trackOk ?? 0.42) || opts.refineOnly) return { quad: toN(S, best.q), score: best.score, kind: best.kind };
    }
    // 全体から探す
    const pre = lineQuads(S).map(q => ({ q, s: quick(S, q) })).sort((a, b) => b.s - a.s).slice(0, 40);
    const cands = pre.map(c => ({ q: c.q, s: score(S, c.q) })).sort((a, b) => b.s - a.s).slice(0, 6);
    for (const c of cands) consider(c.q, 'lines');
    for (const q of regionQuads(S)) consider(q, 'region');
    // 上位の候補を縁に吸い付かせて最終決定
    const top = best ? [best.q] : [];
    for (const c of cands.slice(0, 3)) if (c.q !== best?.q) top.push(c.q);
    for (const q of top) { const r = refine(S, q); consider(r, 'refined'); }
    if (!best || best.score < (opts.minScore ?? 0.12)) return null;
    return { quad: toN(S, best.q), score: best.score, kind: best.kind };
  }

  root.DocDetect = { detect, prepare, score, refine };
})(typeof self !== 'undefined' ? self : this);
