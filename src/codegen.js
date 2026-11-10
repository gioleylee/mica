// Code generation: typed AST -> WebAssembly binary module, written byte by
// byte with no assembler or toolchain in between.
//
// WebAssembly is a stack machine with structured control flow, so expressions
// compile by post-order traversal and `if`/`while` map onto block/loop/br.
//
// Arrays live in linear memory as [length: i32][padding: i32][elements...] and
// are allocated by a bump allocator. Memory is never freed.

const I32 = 0x7f, F64 = 0x7c, VOID_BLOCK = 0x40;
const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c,
  br_if: 0x0d, return: 0x0f, call: 0x10, drop: 0x1a, local_get: 0x20, local_set: 0x21,
  local_tee: 0x22, global_get: 0x23, global_set: 0x24, i32_load: 0x28, f64_load: 0x2b,
  i32_store: 0x36, f64_store: 0x39, memory_size: 0x3f, memory_grow: 0x40, i32_const: 0x41,
  f64_const: 0x44, i32_eqz: 0x45, i32_gt_u: 0x4b, i32_le_u: 0x4d, i32_ge_u: 0x4f,
  i32_add: 0x6a, i32_sub: 0x6b, i32_and: 0x71, i32_shl: 0x74, i32_shr_u: 0x76,
  f64_abs: 0x99, f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_sqrt: 0x9f,
  f64_convert_i32_s: 0xb7,
};
const INT_OPS = {
  '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': 0x6d, '%': 0x6f, '&': 0x71, '|': 0x72, '^': 0x73,
  '<<': 0x74, '>>': 0x75, '==': 0x46, '!=': 0x47, '<': 0x48, '>': 0x4a, '<=': 0x4c, '>=': 0x4e,
};
const FLOAT_OPS = {
  '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3, '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64,
  '<=': 0x65, '>=': 0x66,
};
const FLOAT_BUILTINS = { sqrt: OP.f64_sqrt, floor: OP.f64_floor, ceil: OP.f64_ceil, abs: OP.f64_abs };

// Function index space: imports come first, then the allocator, then user code.
const IMPORTS = [['print_i32', [I32]], ['print_f64', [F64]], ['print_bool', [I32]]];
const PRINT = { int: 0, float: 1, bool: 2 };
const ALLOC = IMPORTS.length;
const FIRST_USER_FN = ALLOC + 1;
const HEAP_START = 8;  // address 0 is never handed out
const MAX_ARRAY_LENGTH = 0x0fffffff;

// ---- binary encoding ------------------------------------------------------

function uleb(v) {
  const out = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function sleb(v) {
  const out = [];
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const f64 = (v) => [...new Uint8Array(new Float64Array([v]).buffer)];
const name = (s) => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const wasmType = (t) => (t === 'float' ? F64 : I32);

// ---- per-function code generation -----------------------------------------

class FunctionCompiler {
  constructor(fn, fnIndex) {
    this.fn = fn;
    this.fnIndex = fnIndex;
    this.code = [];
    this.depth = 0;   // number of enclosing block/loop/if constructs
    this.loops = [];  // label depths of enclosing loops, for break/continue
    // Two scratch locals hold an array pointer and index during bounds checks.
    this.ptr = uleb(fn.locals.length);
    this.idx = uleb(fn.locals.length + 1);
  }

  emit(...bytes) { this.code.push(...bytes); }
  constInt(v) { this.emit(OP.i32_const, ...sleb(v)); }

  compile() {
    this.block(this.fn.body);
    // A value-returning function always exits through `return`; this marks the
    // fall-through as unreachable so the validator accepts the empty stack.
    if (this.fn.ret !== 'void') this.emit(OP.unreachable);
    const declared = this.fn.locals.slice(this.fn.params.length).map(wasmType).concat([I32, I32]);
    const body = [...vec(declared.map((t) => [1, t])), ...this.code, OP.end];
    return [...uleb(body.length), ...body];
  }

  block(stmts) { for (const s of stmts) this.statement(s); }

  statement(s) {
    switch (s.kind) {
      case 'Let':
        this.expr(s.init);
        this.emit(OP.local_set, ...uleb(s.slot));
        break;
      case 'Assign':
        if (s.target.kind === 'Ident') {
          this.expr(s.value);
          this.emit(OP.local_set, ...uleb(s.target.slot));
        } else {
          this.elementAddress(s.target);
          this.expr(s.value);
          this.emit(...(s.value.type === 'float' ? [OP.f64_store, 3] : [OP.i32_store, 2]), 8);
        }
        break;
      case 'If':
        this.expr(s.cond);
        this.emit(OP.if, VOID_BLOCK);
        this.depth++;
        this.block(s.then);
        if (s.otherwise.length) {
          this.emit(OP.else);
          this.block(s.otherwise);
        }
        this.depth--;
        this.emit(OP.end);
        break;
      case 'While': {
        // block            <- break jumps past here
        //   loop           <- continue jumps back here
        //     br_if (not cond) -> block
        //     body
        //     br -> loop
        this.emit(OP.block, VOID_BLOCK, OP.loop, VOID_BLOCK);
        const labels = { exit: this.depth + 1, top: this.depth + 2 };
        this.depth += 2;
        this.loops.push(labels);
        this.expr(s.cond);
        this.emit(OP.i32_eqz, OP.br_if, ...uleb(this.depth - labels.exit));
        this.block(s.body);
        this.emit(OP.br, ...uleb(this.depth - labels.top));
        this.loops.pop();
        this.depth -= 2;
        this.emit(OP.end, OP.end);
        break;
      }
      case 'Break':
        this.emit(OP.br, ...uleb(this.depth - this.loops.at(-1).exit));
        break;
      case 'Continue':
        this.emit(OP.br, ...uleb(this.depth - this.loops.at(-1).top));
        break;
      case 'Return':
        if (s.value) this.expr(s.value);
        this.emit(OP.return);
        break;
      case 'ExprStmt':
        this.expr(s.expr);
        if (s.expr.type !== 'void') this.emit(OP.drop);
        break;
      default:
        throw new Error(`unknown statement ${s.kind}`);
    }
  }

  // Leaves the address of array[index] (minus the 8-byte header) on the stack,
  // trapping if the index is out of bounds. Both operands are evaluated before
  // the scratch locals are written, so nested indexing cannot clobber them.
  elementAddress(e) {
    this.expr(e.array);
    this.expr(e.index);
    this.emit(OP.local_set, ...this.idx, OP.local_set, ...this.ptr);
    // Unsigned comparison also rejects negative indexes.
    this.emit(OP.local_get, ...this.idx, OP.local_get, ...this.ptr, OP.i32_load, 2, 0, OP.i32_ge_u);
    this.emit(OP.if, VOID_BLOCK, OP.unreachable, OP.end);
    this.emit(OP.local_get, ...this.ptr, OP.local_get, ...this.idx);
    this.constInt(e.type === 'float' ? 3 : 2);
    this.emit(OP.i32_shl, OP.i32_add);
  }

  expr(e) {
    switch (e.kind) {
      case 'Num':
        if (e.type === 'int') this.constInt(e.value);
        else this.emit(OP.f64_const, ...f64(e.value));
        break;
      case 'Bool':
        this.constInt(e.value ? 1 : 0);
        break;
      case 'Ident':
        this.emit(OP.local_get, ...uleb(e.slot));
        break;
      case 'Unary':
        if (e.op === '!') {
          this.expr(e.operand);
          this.emit(OP.i32_eqz);
        } else if (e.type === 'float') {
          this.expr(e.operand);
          this.emit(OP.f64_neg);
        } else {
          this.constInt(0);
          this.expr(e.operand);
          this.emit(OP.i32_sub);
        }
        break;
      case 'Binary':
        this.expr(e.left);
        if (e.op === '&&' || e.op === '||') {
          // Short-circuit: the right operand runs only when it can matter.
          this.emit(OP.if, I32);
          if (e.op === '&&') {
            this.expr(e.right);
            this.emit(OP.else);
            this.constInt(0);
          } else {
            this.constInt(1);
            this.emit(OP.else);
            this.expr(e.right);
          }
          this.emit(OP.end);
        } else {
          this.expr(e.right);
          this.emit((e.left.type === 'float' ? FLOAT_OPS : INT_OPS)[e.op]);
        }
        break;
      case 'Index':
        this.elementAddress(e);
        this.emit(...(e.type === 'float' ? [OP.f64_load, 3] : [OP.i32_load, 2]), 8);
        break;
      case 'NewArray':
        this.expr(e.size);
        this.emit(OP.local_tee, ...this.idx);
        this.constInt(MAX_ARRAY_LENGTH);
        this.emit(OP.i32_gt_u, OP.if, VOID_BLOCK, OP.unreachable, OP.end);
        this.emit(OP.local_get, ...this.idx);
        this.constInt(e.elem === 'float' ? 3 : 2);
        this.emit(OP.i32_shl);
        this.constInt(8);
        this.emit(OP.i32_add, OP.call, ALLOC, OP.local_tee, ...this.ptr);
        this.emit(OP.local_get, ...this.idx, OP.i32_store, 2, 0, OP.local_get, ...this.ptr);
        break;
      case 'Call':
        this.call(e);
        break;
      default:
        throw new Error(`unknown expression ${e.kind}`);
    }
  }

  call(e) {
    e.args.forEach((a) => this.expr(a));
    const from = e.args[0]?.type;
    if (e.target) this.emit(OP.call, ...uleb(this.fnIndex.get(e.target)));
    else if (e.name === 'print') this.emit(OP.call, PRINT[from]);
    else if (e.name === 'len') this.emit(OP.i32_load, 2, 0);
    else if (e.name === 'float') { if (from === 'int') this.emit(OP.f64_convert_i32_s); }
    // Saturating truncation (0xfc 0x02): out-of-range floats clamp instead of trapping.
    else if (e.name === 'int') { if (from === 'float') this.emit(0xfc, 0x02); }
    else this.emit(FLOAT_BUILTINS[e.name]);
  }
}

// alloc(size: i32) -> i32. Bumps the heap pointer (global 0), rounding up to
// 8 bytes, and grows linear memory when the heap passes its end. Fresh pages
// are zero-filled by the engine, so new arrays start out zeroed.
const ALLOC_BODY = (() => {
  const code = [
    OP.global_get, 0, OP.local_set, 1,
    OP.global_get, 0, OP.local_get, 0, OP.i32_add, OP.i32_const, 7, OP.i32_add,
    OP.i32_const, ...sleb(-8), OP.i32_and, OP.global_set, 0,
    OP.block, VOID_BLOCK,
    OP.global_get, 0, OP.memory_size, 0, OP.i32_const, 16, OP.i32_shl, OP.i32_le_u, OP.br_if, 0,
    OP.global_get, 0, OP.i32_const, ...sleb(65535), OP.i32_add, OP.i32_const, 16, OP.i32_shr_u,
    OP.memory_size, 0, OP.i32_sub, OP.memory_grow, 0, OP.drop,
    OP.end,
    OP.local_get, 1,
  ];
  const body = [...vec([[1, I32]]), ...code, OP.end];
  return [...uleb(body.length), ...body];
})();

export function generate(program) {
  // Signatures are deduplicated: the type section holds each distinct one once.
  const types = [];
  const typeIndex = (params, results) => {
    const encoded = [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
    const key = encoded.join(',');
    let i = types.findIndex((t) => t.key === key);
    if (i < 0) i = types.push({ key, encoded }) - 1;
    return i;
  };

  const imports = IMPORTS.map(([fn, params]) =>
    [...name('env'), ...name(fn), 0x00, ...uleb(typeIndex(params, []))]);
  const fnIndex = new Map(program.fns.map((f, i) => [f, FIRST_USER_FN + i]));
  const signatures = [typeIndex([I32], [I32])];  // alloc
  const bodies = [ALLOC_BODY];
  const exports = [[...name('memory'), 0x02, 0]];
  for (const f of program.fns) {
    signatures.push(typeIndex(f.params.map((p) => wasmType(p.type)),
      f.ret === 'void' ? [] : [wasmType(f.ret)]));
    bodies.push(new FunctionCompiler(f, fnIndex).compile());
    exports.push([...name(f.name), 0x00, ...uleb(fnIndex.get(f))]);
  }

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,                  // "\0asm", version 1
    ...section(1, vec(types.map((t) => t.encoded))),                  // types
    ...section(2, vec(imports)),                                      // imports
    ...section(3, vec(signatures.map((s) => uleb(s)))),               // function signatures
    ...section(5, vec([[0x00, 1]])),                                  // memory: 1 page minimum
    ...section(6, vec([[I32, 0x01, OP.i32_const, HEAP_START, OP.end]])),  // heap pointer
    ...section(7, vec(exports)),                                      // exports
    ...section(10, vec(bodies)),                                      // code
  ]);
}
