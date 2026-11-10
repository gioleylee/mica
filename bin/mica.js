#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { CompileError, compile, formatError, instantiate } from '../src/index.js';

const USAGE = `usage:
  mica run <file.mica>                 compile and run main()
  mica build <file.mica> [-o out.wasm] write a WebAssembly module
options:
  --no-opt                             disable constant folding`;

const args = process.argv.slice(2);
const optimize = !args.includes('--no-opt');
const [command, file] = args.filter((a) => a !== '--no-opt');
if (!['run', 'build'].includes(command) || !file) {
  console.error(USAGE);
  process.exit(2);
}

const source = readFileSync(file, 'utf8');
try {
  if (command === 'build') {
    const o = args.indexOf('-o');
    const out = o >= 0 ? args[o + 1] : file.replace(/\.mica$/, '') + '.wasm';
    const bytes = compile(source, { optimize });
    writeFileSync(out, bytes);
    console.log(`wrote ${out} (${bytes.length} bytes)`);
  } else {
    const exports = instantiate(source, { optimize });
    if (typeof exports.main !== 'function') throw new CompileError("program has no 'main' function", 1, 1);
    exports.main();
  }
} catch (e) {
  if (e instanceof CompileError) {
    console.error(formatError(e, source, file));
    process.exit(1);
  }
  if (e instanceof WebAssembly.RuntimeError) {
    console.error(`runtime error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
