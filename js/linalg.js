// Small dense linear algebra helpers for symmetric positive-definite systems.
// Matrices are row-major Float64Array of size n*n.
(function (root) {
  'use strict';

  // In-place Cholesky: on success the lower triangle of M holds L (M = L L^T).
  // Returns false if the matrix is not positive definite.
  function cholesky(M, n) {
    for (let j = 0; j < n; j++) {
      let d = M[j * n + j];
      for (let k = 0; k < j; k++) d -= M[j * n + k] * M[j * n + k];
      if (!(d > 1e-12)) return false;
      d = Math.sqrt(d);
      M[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let s = M[i * n + j];
        for (let k = 0; k < j; k++) s -= M[i * n + k] * M[j * n + k];
        M[i * n + j] = s / d;
      }
    }
    return true;
  }

  // Solve L L^T x = b using a factor from cholesky(). Returns a new array.
  function cholSolve(L, n, b) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
      y[i] = s / L[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
      x[i] = s / L[i * n + i];
    }
    return x;
  }

  // Full inverse of L L^T (symmetric). n is small (< ~100) so O(n^3) is fine.
  function cholInverse(L, n) {
    const inv = new Float64Array(n * n);
    const e = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      e.fill(0);
      e[j] = 1;
      const col = cholSolve(L, n, e);
      for (let i = 0; i < n; i++) inv[i * n + j] = col[i];
    }
    return inv;
  }

  // Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), |error| < 1.5e-7.
  function normCdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-z * z / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }

  // Seeded PRNG (mulberry32) plus a cached Box-Muller normal generator.
  function makeRng(seed) {
    let a = seed >>> 0;
    let spare = null;
    const uniform = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = function () {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0, s = 0;
      do { u = uniform() * 2 - 1; v = uniform() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * m;
      return u * m;
    };
    return { uniform, normal };
  }

  const api = { cholesky, cholSolve, cholInverse, normCdf, makeRng };
  root.LinAlg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
