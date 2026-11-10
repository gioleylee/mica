// Compares code compiled by Mica with the same algorithm written in JavaScript
// and run by V8's optimising JIT. Each case reports the best of five runs.
import { instantiate } from '../src/index.js';

const mica = instantiate(`
fn fib(n: int): int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }

fn sieve(n: int): int {
  let composite = new int[n];
  let count = 0;
  let i = 2;
  while i < n {
    if composite[i] == 0 {
      count = count + 1;
      let j = i * 2;
      while j < n { composite[j] = 1; j = j + i; }
    }
    i = i + 1;
  }
  return count;
}

fn mandelbrot(size: int): int {
  let inside = 0;
  let py = 0;
  while py < size {
    let px = 0;
    while px < size {
      let cr = float(px) * 3.0 / float(size) - 2.0;
      let ci = float(py) * 2.0 / float(size) - 1.0;
      let zr = 0.0; let zi = 0.0;
      let k = 0;
      while k < 200 && zr * zr + zi * zi <= 4.0 {
        let t = zr * zr - zi * zi + cr;
        zi = 2.0 * zr * zi + ci;
        zr = t;
        k = k + 1;
      }
      if k == 200 { inside = inside + 1; }
      px = px + 1;
    }
    py = py + 1;
  }
  return inside;
}
`);

const js = {
  fib: function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); },
  sieve(n) {
    const composite = new Int32Array(n);
    let count = 0;
    for (let i = 2; i < n; i++) {
      if (composite[i] === 0) {
        count++;
        for (let j = i * 2; j < n; j += i) composite[j] = 1;
      }
    }
    return count;
  },
  mandelbrot(size) {
    let inside = 0;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const cr = px * 3.0 / size - 2.0, ci = py * 2.0 / size - 1.0;
        let zr = 0, zi = 0, k = 0;
        while (k < 200 && zr * zr + zi * zi <= 4.0) {
          const t = zr * zr - zi * zi + cr;
          zi = 2.0 * zr * zi + ci;
          zr = t;
          k++;
        }
        if (k === 200) inside++;
      }
    }
    return inside;
  },
};

function best(fn, arg) {
  let time = Infinity, result;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    result = fn(arg);
    time = Math.min(time, performance.now() - t0);
  }
  return { time, result };
}

console.log(`node ${process.version}\n`);
console.log('benchmark            mica->wasm   javascript   ratio');
for (const [name, arg] of [['fib', 35], ['sieve', 20_000_000], ['mandelbrot', 600]]) {
  const a = best(mica[name], arg), b = best(js[name], arg);
  if (a.result !== b.result) throw new Error(`${name}: results differ (${a.result} vs ${b.result})`);
  console.log(`${`${name}(${arg})`.padEnd(20)} ${a.time.toFixed(1).padStart(8)} ms ${b.time.toFixed(1).padStart(9)} ms ${(b.time / a.time).toFixed(2).padStart(6)}x`);
}
