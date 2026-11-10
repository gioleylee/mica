// Public API: compile Mica source to a WebAssembly module, or compile and run it.

import { check } from './checker.js';
import { generate } from './codegen.js';
import { optimize } from './optimize.js';
import { CompileError, parse } from './parser.js';

export { CompileError };

// Returns the module as a Uint8Array. Throws CompileError on invalid programs.
export function compile(source, { optimize: opt = true } = {}) {
  const program = check(parse(source));
  return generate(opt ? optimize(program) : program);
}

export function instantiate(source, { print = console.log, ...options } = {}) {
  const module = new WebAssembly.Module(compile(source, options));
  const env = {
    print_i32: (v) => print(String(v)),
    print_f64: (v) => print(String(v)),
    print_bool: (v) => print(v ? 'true' : 'false'),
  };
  return new WebAssembly.Instance(module, { env }).exports;
}

// Compiles and runs `main`, returning everything the program printed.
export function run(source, options = {}) {
  const lines = [];
  const exports = instantiate(source, { print: (s) => lines.push(s), ...options });
  if (typeof exports.main !== 'function') throw new CompileError("program has no 'main' function", 1, 1);
  exports.main();
  return lines;
}

// Renders an error with the offending source line and a caret under the column.
export function formatError(error, source, file = '<input>') {
  const text = source.split('\n')[error.line - 1] ?? '';
  return `${file}:${error.line}:${error.col}: error: ${error.message}\n  ${text}\n  ${' '.repeat(error.col - 1)}^`;
}
