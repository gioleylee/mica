import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { CompileError, compile, instantiate, run } from '../src/index.js';

const main = (body) => `fn main() { ${body} }`;
const prints = (source, expected) => assert.deepEqual(run(source), expected.map(String));

test('integer arithmetic follows 32-bit two\'s complement semantics', () => {
  prints(main(`
    print(7 / 2); print(-7 / 2); print(7 % 3); print(-7 % 3);
    print(2147483647 + 1);
    print(65536 * 65536);
    print(1 << 31); print(-16 >> 2); print(6 & 3); print(6 | 3); print(6 ^ 3);
  `), [3, -3, 1, -1, -2147483648, 0, -2147483648, -4, 2, 7, 5]);
});

test('the smallest int can be written as a literal', () => {
  for (const optimize of [true, false]) {
    assert.deepEqual(
      run('fn main() { let m = -2147483648; print(m); print(m - 1); print(- 2147483648 + 1); }', { optimize }),
      ['-2147483648', '2147483647', '-2147483647'],
    );
  }
  assert.throws(() => run('fn main() { print(2147483648); }'), /does not fit in 32 bits/);
  assert.throws(() => run('fn main() { print(-2147483649); }'), /does not fit in 32 bits/);
});

test('pathological nesting is a compile error, not a crash', () => {
  const source = `fn main() { print(${'('.repeat(20000)}1${')'.repeat(20000)}); }`;
  assert.throws(() => run(source), (e) => e instanceof CompileError && /nested too deeply/.test(e.message));
});

test('precedence and associativity', () => {
  prints(main('print(2 + 3 * 4); print((2 + 3) * 4); print(10 - 4 - 3); print(2 * 3 % 4); print(-2 * 3);'),
    [14, 20, 3, 2, -6]);
  prints(main('print(1 + 2 < 4 && 3 * 3 == 9); print(1 << 2 + 1); print(true || false && false);'),
    [true, 8, true]);
});

test('floats and conversions', () => {
  prints(main(`
    print(1.5 + 2.25); print(1.0 / 4.0); print(sqrt(2.0) * sqrt(2.0) > 1.99);
    print(float(7) / 2.0); print(int(3.99)); print(int(-3.99));
    print(floor(-1.5)); print(ceil(1.2)); print(abs(-2.5));
    print(int(1.0e30)); print(1.0 / 0.0 > 1.0e300);
  `), [3.75, 0.25, true, 3.5, 3, -3, -2, 2, 2.5, 2147483647, true]);
});

test('short-circuit evaluation skips the right operand', () => {
  // If the right-hand side ran, the out-of-bounds index would trap.
  prints(`
    fn main() {
      let a = new int[1];
      print(false && a[5] == 0);
      print(true || a[5] == 0);
      let i = 3;
      print(i < len(a) && a[i] == 0);
    }`, [false, true, false]);
});

test('control flow: while, break, continue, else-if chains', () => {
  prints(`
    fn classify(n: int): int {
      if n < 0 { return -1; } else if n == 0 { return 0; } else { return 1; }
    }
    fn main() {
      let sum = 0;
      let i = 0;
      while true {
        i = i + 1;
        if i > 10 { break; }
        if i % 2 == 0 { continue; }
        let j = 0;
        while j < 100 {
          j = j + 1;
          if j > i { break; }
          sum = sum + 1;
        }
      }
      print(sum); print(classify(-5)); print(classify(0)); print(classify(9));
    }`, [25, -1, 0, 1]);
});

test('recursion, mutual recursion and forward references', () => {
  prints(`
    fn main() { print(fact(10)); print(is_even(10)); print(is_even(7)); print(ack(2, 3)); }
    fn fact(n: int): int { if n <= 1 { return 1; } return n * fact(n - 1); }
    fn is_even(n: int): bool { if n == 0 { return true; } return is_odd(n - 1); }
    fn is_odd(n: int): bool { if n == 0 { return false; } return is_even(n - 1); }
    fn ack(m: int, n: int): int {
      if m == 0 { return n + 1; }
      if n == 0 { return ack(m - 1, 1); }
      return ack(m - 1, ack(m, n - 1));
    }`, [3628800, true, false, 9]);
});

test('block scoping and shadowing', () => {
  prints(main(`
    let x = 1;
    if true { let x = 2.5; print(x); }
    while x < 2 { let y = x * 10; x = x + 1; print(y); }
    print(x);
  `), [2.5, 10, 2]);
});

test('arrays: zero initialised, nested indexing, passed by reference', () => {
  prints(`
    fn fill(a: int[], v: int) { let i = 0; while i < len(a) { a[i] = v + i; i = i + 1; } }
    fn main() {
      let a = new int[4];
      print(a[3]);
      fill(a, 10);
      let perm = new int[4];
      perm[0] = 3; perm[1] = 2; perm[2] = 1; perm[3] = 0;
      print(a[perm[0]]); print(a[perm[perm[0]]]);
      a[perm[1]] = a[perm[2]] + a[perm[3]];
      print(a[2]);
      let f = new float[2];
      f[1] = 0.5;
      print(f[0] + f[1]); print(len(f));
    }`, [0, 13, 10, 21, 0.5, 2]);
});

test('the heap grows beyond the initial 64 KiB page', () => {
  prints(main(`
    let total = 0;
    let round = 0;
    while round < 20 {
      let a = new float[50000];
      a[49999] = 1.0;
      total = total + int(a[49999]) + int(a[0]);
      round = round + 1;
    }
    print(total);
  `), [20]);
});

test('runtime errors trap instead of corrupting memory', () => {
  const traps = (body) => assert.throws(() => run(main(body)), WebAssembly.RuntimeError, body);
  traps('let a = new int[3]; print(a[3]);');
  traps('let a = new int[3]; print(a[-1]);');
  traps('let a = new int[3]; a[1000000] = 1;');
  traps('let n = -1; let a = new int[n];');
  traps('let z = 0; print(1 / z);');
  traps('let z = 0; print(1 % z);');
});

test('compile errors are reported with a position', () => {
  const cases = [
    ['fn main() { let x = 1 + 2.0; }', /same type, got int and float.*convert/, 1, 23],
    ['fn main() { print(y); }', /'y' is not defined/, 1, 19],
    ['fn main() {\n  let x = 1;\n  let x = 2;\n}', /already declared/, 3, 3],
    ['fn f(): int { if true { return 1; } }\nfn main() {}', /does not return a value on every path/, 1, 1],
    ['fn f(): int { return 1.5; }', /must return int, but this returns float/, 1, 15],
    ['fn main() { if 1 { } }', /condition must be bool/, 1, 16],
    ['fn main() { break; }', /'break' outside of a loop/, 1, 13],
    ['fn f(a: int) {}\nfn main() { f(1, 2); }', /takes 1 argument, got 2/, 2, 13],
    ['fn f(a: int) {}\nfn main() { f(true); }', /argument 1 of 'f' must be int/, 2, 15],
    ['fn main() { let x = 1; x = 2.0; }', /cannot assign float to a int/, 1, 28],
    ['fn main() { let a = 1; print(a[0]); }', /cannot index a value of type int/, 1, 31],
    ['fn main() { 1 + 2 = 3; }', /cannot assign to this expression/, 1, 15],
    ['fn main() { let x = 3000000000; }', /does not fit in 32 bits/, 1, 21],
    ['fn main() { let x = 1 }', /expected ';' but found '}'/, 1, 23],
    ['fn main() { let x = @; }', /unexpected character '@'/, 1, 21],
    ['fn main() {}\nfn main() {}', /already defined/, 2, 1],
    ['fn print(x: int) {}', /built-in/, 1, 1],
    ['fn main() { let x = nothing(); }\nfn nothing() {}', /returns nothing/, 1, 21],
    ['fn main() { print(true < false); }', /'<' is not defined for bool/, 1, 24],
  ];
  for (const [source, message, line, col] of cases) {
    assert.throws(() => compile(source), (e) => {
      assert.ok(e instanceof CompileError, `${source}: ${e}`);
      assert.match(e.message, message, source);
      assert.deepEqual([e.line, e.col], [line, col], source);
      return true;
    });
  }
});

test('the emitted module is valid WebAssembly and exports every function', () => {
  const bytes = compile('fn add(a: int, b: int): int { return a + b; } fn half(x: float): float { return x / 2.0; }');
  assert.ok(WebAssembly.validate(bytes));
  const exports = instantiate('fn add(a: int, b: int): int { return a + b; } fn half(x: float): float { return x / 2.0; }');
  assert.equal(exports.add(2, 40), 42);
  assert.equal(exports.half(5), 2.5);
  assert.ok(exports.memory instanceof WebAssembly.Memory);
});

test('constant folding shrinks the module without changing behaviour', () => {
  const source = main(`
    let seconds = 60 * 60 * 24 * 7;
    if 1 + 1 == 3 { print(111); } else { print(seconds); }
    while 2 < 1 { print(222); }
    print(-(3 - 5) * 2); print(!(1 < 2) || 0.5 * 4.0 == 2.0);
  `);
  const expected = ['604800', '4', 'true'];
  assert.deepEqual(run(source, { optimize: true }), expected);
  assert.deepEqual(run(source, { optimize: false }), expected);
  assert.ok(compile(source).length < compile(source, { optimize: false }).length - 30);
});

test('folding never removes a division that must trap at run time', () => {
  for (const optimize of [true, false]) {
    assert.throws(() => run(main('print(1 / 0);'), { optimize }), WebAssembly.RuntimeError);
    assert.throws(() => run(main('print((0 - 2147483647 - 1) / -1);'), { optimize }), WebAssembly.RuntimeError);
    assert.deepEqual(run(main('print((0 - 2147483647 - 1) % -1);'), { optimize }), ['0']);
  }
});

test('example programs produce the same output with and without optimisation', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mica'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const out = run(source);
    assert.ok(out.length > 0, file);
    assert.deepEqual(run(source, { optimize: false }), out, file);
  }
  prints(readFileSync(new URL('sieve.mica', dir), 'utf8'), [25, 78498]);
});

// Differential test: random integer expressions are evaluated both by a tiny
// reference interpreter written directly against the language's semantics and
// by the compiler (optimised and not). All three must agree, including on
// which inputs trap.
test('random expressions agree with a reference interpreter', () => {
  let state = 12345;
  const rand = (n) => {  // xorshift32: deterministic across runs and platforms
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % n;
  };
  const OPS = {
    '+': (a, b) => (a + b) | 0, '-': (a, b) => (a - b) | 0, '*': Math.imul,
    '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
    '<<': (a, b) => a << b, '>>': (a, b) => a >> b,
    '/': (a, b) => {
      if (b === 0 || (a === -0x80000000 && b === -1)) throw new RangeError('trap');
      return (a / b) | 0;
    },
    '%': (a, b) => {
      if (b === 0) throw new RangeError('trap');
      return (a % b) | 0;
    },
  };
  const LITERALS = [0, 1, 2, 3, 7, 31, 32, 255, 65536, 2147483647];
  const gen = (depth) => {
    const roll = rand(10);
    if (depth === 0 || roll < 2) {
      if (rand(2)) {
        const name = 'abc'[rand(3)];
        return { src: name, eval: (env) => env[name] };
      }
      const v = LITERALS[rand(LITERALS.length)];
      return { src: String(v), eval: () => v };
    }
    if (roll === 2) {
      const e = gen(depth - 1);
      return { src: `(-${e.src})`, eval: (env) => (-e.eval(env)) | 0 };
    }
    const op = Object.keys(OPS)[rand(10)];
    const l = gen(depth - 1), r = gen(depth - 1);
    return { src: `(${l.src} ${op} ${r.src})`, eval: (env) => OPS[op](l.eval(env), r.eval(env)) };
  };
  const inputs = [[0, 0, 0], [1, 2, 3], [-1, 7, -13], [2147483647, -2147483648, 5], [100, -3, 31]];

  let compared = 0, traps = 0;
  for (let i = 0; i < 400; i++) {
    const e = gen(5);
    const source = `fn f(a: int, b: int, c: int): int { return ${e.src}; }`;
    const variants = [instantiate(source), instantiate(source, { optimize: false })];
    for (const [a, b, c] of inputs) {
      let expected;
      try { expected = e.eval({ a, b, c }); } catch { expected = 'trap'; }
      for (const exports of variants) {
        let actual;
        try { actual = exports.f(a, b, c); } catch (err) {
          assert.ok(err instanceof WebAssembly.RuntimeError);
          actual = 'trap';
        }
        assert.equal(actual, expected, `${e.src} with a=${a} b=${b} c=${c}`);
      }
      compared++;
      traps += expected === 'trap';
    }
  }
  assert.equal(compared, 2000);
  assert.ok(traps > 50 && traps < 1500, `expected a mix of trapping and non-trapping cases, got ${traps}`);
});
