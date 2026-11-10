# Mica

[![ci](https://github.com/gioleylee/mica/actions/workflows/ci.yml/badge.svg)](https://github.com/gioleylee/mica/actions/workflows/ci.yml)

A small statically typed language and a **compiler that emits WebAssembly binaries
directly**: lexer, parser, type checker, optimiser and code generator in about 900 lines
of JavaScript with no dependencies. No LLVM, no Binaryen, no `wat2wasm`; every byte of the
module, from the `\0asm` header to the LEB128-encoded instructions, is produced by the code
in [`src/`](src).

```
fn count_primes(n: int): int {
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

fn main() { print(count_primes(1000000)); }
```

```
$ node bin/mica.js run examples/sieve.mica
25
78498
$ node bin/mica.js build examples/sieve.mica
wrote examples/sieve.wasm (405 bytes)
```

## The language

| | |
| --- | --- |
| Types | `int` (32-bit), `float` (64-bit), `bool`, `int[]`, `float[]` |
| Functions | typed parameters and results, recursion, forward references |
| Statements | `let` with inference, assignment, `if`/`else if`/`else`, `while`, `break`, `continue`, `return` |
| Operators | arithmetic, comparison, bitwise and shifts, short-circuit `&&` and `\|\|` |
| Built-ins | `print`, `len`, `sqrt`, `floor`, `ceil`, `abs`, and the conversions `int(x)`, `float(x)` |

There are no implicit conversions: `1 + 2.0` is a compile error that suggests `float()`.
Variables are block scoped and may be shadowed.

## Compiler pipeline

```
source ─► tokens ─► AST ─► typed AST ─► folded AST ─► .wasm
        lexer    parser   checker     optimiser     codegen
```

1. **Parser** ([parser.js](src/parser.js)). Recursive descent for statements and
   precedence climbing for expressions. Every node records its line and column.
2. **Checker** ([checker.js](src/checker.js)). Resolves names through a scope stack, assigns
   each variable a WebAssembly local slot, infers and checks types, and verifies that
   value-returning functions return on every path. After this pass the tree is fully
   annotated, so later passes cannot fail.
3. **Optimiser** ([optimize.js](src/optimize.js)). Constant folding with correct 32-bit
   wrap-around, plus removal of branches and loops whose condition is known. Divisions that
   would trap are deliberately left alone, so optimisation never changes behaviour.
4. **Code generator** ([codegen.js](src/codegen.js)). Expressions compile by post-order
   traversal onto WebAssembly's operand stack. `while` becomes a `block` wrapping a `loop`,
   with `break` and `continue` compiled to `br` instructions whose relative label depth is
   tracked during emission. `&&` and `||` become value-producing `if` blocks.

**Memory.** Arrays are stored in linear memory as a length header followed by the
elements, allocated by a bump allocator that is itself emitted as hand-assembled
WebAssembly and grows memory on demand. Every array access is bounds checked and traps on
failure, as do negative array sizes, so a Mica program cannot read or write outside its
own arrays.

**Diagnostics.**

```
examples/bad.mica:3:17: error: '+' needs operands of the same type, got int and float (convert with int() or float())
    let total = n + 0.5;
                  ^
```

## Tests

`npm test` runs 18 tests on Node's built-in runner:

- **Semantics** – integer wrap-around, truncating division, operator precedence, float
  conversion, short-circuit evaluation, scoping, recursion, arrays, heap growth.
- **Safety** – out-of-bounds and negative indexes, negative sizes and division by zero
  all trap.
- **Diagnostics** – 19 invalid programs, each checked for its message and exact position.
- **Differential testing** – 400 randomly generated integer expressions are evaluated by a
  reference interpreter and by the compiler, with and without optimisation, on five input
  sets each. All 2,000 comparisons must agree, including on which inputs trap.

## Performance

`npm run bench` compares compiled Mica with the same algorithm written in JavaScript and
run by V8's optimising JIT (Node 24, best of five runs, one Windows 11 desktop):

| Benchmark | Mica → wasm | JavaScript | Ratio |
| --- | ---: | ---: | ---: |
| `fib(35)` | 75.7 ms | 102.9 ms | 1.36× |
| `sieve(20,000,000)` | 319.4 ms | 329.8 ms | 1.03× |
| `mandelbrot(600)` | 62.1 ms | 61.9 ms | 1.00× |

The output is roughly on par with JIT-compiled JavaScript, and ahead on call-heavy code.
That says more about V8's WebAssembly backend than about this compiler, which performs no
optimisation beyond constant folding; the point is that straightforward stack code is
already a good target.

## Usage

```sh
node bin/mica.js run examples/nbody.mica
node bin/mica.js build examples/fib.mica -o fib.wasm
npm test
```

Requires Node 20 or newer. As a library:

```js
import { compile, run } from './src/index.js';
const bytes = compile(source);   // Uint8Array holding a WebAssembly module
const lines = run(source);       // compile, call main(), collect printed output
```

## Limitations

- Memory is never freed: there is no garbage collector, only a bump allocator.
- No strings, structs, closures, global variables or `for` loops.
- No register-level or SSA optimisation; the only optimisations are at the AST level.
- The checker stops at the first error instead of reporting several.
