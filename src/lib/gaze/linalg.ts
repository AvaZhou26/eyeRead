// Minimal linear algebra for ridge regression (features are small, ~20 dims).

/** Solve A x = b with Gaussian elimination + partial pivoting. A is n×n (row-major). */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * Ridge regression: minimise ||Xw - y||² + λ||w||² (bias term not penalised).
 * X rows must already include a leading 1 for the bias.
 */
export function ridge(X: number[][], y: number[], lambda: number, weights?: number[]): number[] {
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    const w = weights ? weights[i] : 1;
    const xi = X[i];
    for (let r = 0; r < d; r++) {
      b[r] += w * xi[r] * y[i];
      for (let c = r; c < d; c++) A[r][c] += w * xi[r] * xi[c];
    }
  }
  for (let r = 0; r < d; r++) for (let c = 0; c < r; c++) A[r][c] = A[c][r];
  for (let r = 1; r < d; r++) A[r][r] += lambda;
  return solve(A, b);
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
