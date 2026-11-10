// Semantic analysis: resolves names, assigns every local a slot, and checks
// types. The AST is annotated in place (expr.type, ident.slot, call.target) so
// that code generation never has to look anything up or report an error.

import { CompileError } from './parser.js';

const NUMERIC = ['int', 'float'];
const ARITHMETIC = new Set(['+', '-', '*', '/']);
const INT_ONLY = new Set(['%', '&', '|', '^', '<<', '>>']);
const ORDERING = new Set(['<', '<=', '>', '>=']);
const FLOAT_BUILTINS = new Set(['sqrt', 'floor', 'ceil', 'abs']);

export function check(program) {
  const fail = (msg, n) => { throw new CompileError(msg, n.line, n.col); };

  const functions = new Map();
  for (const f of program.fns) {
    if (functions.has(f.name)) fail(`function '${f.name}' is already defined`, f);
    if (['print', 'len', 'int', 'float'].includes(f.name) || FLOAT_BUILTINS.has(f.name)) {
      fail(`'${f.name}' is a built-in function and cannot be redefined`, f);
    }
    functions.set(f.name, f);
  }

  for (const f of program.fns) {
    f.locals = [];  // types of every slot, parameters first
    const scopes = [new Map()];
    let loopDepth = 0;

    const declare = (n, name, type) => {
      const scope = scopes[scopes.length - 1];
      if (scope.has(name)) fail(`'${name}' is already declared in this scope`, n);
      scope.set(name, { slot: f.locals.length, type });
      f.locals.push(type);
      return f.locals.length - 1;
    };
    const lookup = (n, name) => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(name)) return scopes[i].get(name);
      }
      return fail(`'${name}' is not defined`, n);
    };
    const expectType = (e, type, what) => {
      if (expr(e) !== type) fail(`${what} must be ${type}, but this is ${e.type}`, e);
    };

    function expr(e) {
      e.type = typeOf(e);
      return e.type;
    }

    function typeOf(e) {
      switch (e.kind) {
        case 'Num':
          if (e.type === 'int' && e.value > 0x7fffffff) fail('integer literal does not fit in 32 bits', e);
          return e.type;
        case 'Bool':
          return 'bool';
        case 'Ident': {
          const v = lookup(e, e.name);
          e.slot = v.slot;
          return v.type;
        }
        case 'Unary':
          if (e.op === '!') {
            expectType(e.operand, 'bool', "operand of '!'");
            return 'bool';
          }
          if (!NUMERIC.includes(expr(e.operand))) fail(`cannot negate a value of type ${e.operand.type}`, e);
          return e.operand.type;
        case 'Binary': {
          const l = expr(e.left), r = expr(e.right);
          if (e.op === '&&' || e.op === '||') {
            if (l !== 'bool' || r !== 'bool') fail(`'${e.op}' needs bool operands, got ${l} and ${r}`, e);
            return 'bool';
          }
          if (l !== r) {
            fail(`'${e.op}' needs operands of the same type, got ${l} and ${r}` +
              (NUMERIC.includes(l) && NUMERIC.includes(r) ? ' (convert with int() or float())' : ''), e);
          }
          if (e.op === '==' || e.op === '!=') {
            if (l.endsWith('[]')) fail('arrays cannot be compared', e);
            return 'bool';
          }
          if (INT_ONLY.has(e.op) ? l !== 'int' : !NUMERIC.includes(l)) {
            fail(`'${e.op}' is not defined for ${l}`, e);
          }
          return ORDERING.has(e.op) ? 'bool' : l;
        }
        case 'Index':
          if (!expr(e.array).endsWith('[]')) fail(`cannot index a value of type ${e.array.type}`, e);
          expectType(e.index, 'int', 'array index');
          return e.array.type.slice(0, -2);
        case 'NewArray':
          expectType(e.size, 'int', 'array size');
          return e.elem + '[]';
        case 'Call':
          return call(e);
        default:
          throw new Error(`unknown expression ${e.kind}`);
      }
    }

    function call(e) {
      const arity = (n) => {
        if (e.args.length !== n) fail(`'${e.name}' takes ${n} argument${n === 1 ? '' : 's'}, got ${e.args.length}`, e);
      };
      if (e.name === 'print') {
        arity(1);
        if (!['int', 'float', 'bool'].includes(expr(e.args[0]))) fail(`cannot print a value of type ${e.args[0].type}`, e);
        return 'void';
      }
      if (e.name === 'len') {
        arity(1);
        if (!expr(e.args[0]).endsWith('[]')) fail(`len() needs an array, got ${e.args[0].type}`, e);
        return 'int';
      }
      if (e.name === 'int' || e.name === 'float') {
        arity(1);
        if (!NUMERIC.includes(expr(e.args[0]))) fail(`cannot convert ${e.args[0].type} to ${e.name}`, e);
        return e.name;
      }
      if (FLOAT_BUILTINS.has(e.name)) {
        arity(1);
        expectType(e.args[0], 'float', `argument of ${e.name}()`);
        return 'float';
      }
      const target = functions.get(e.name);
      if (!target) fail(`function '${e.name}' is not defined`, e);
      arity(target.params.length);
      e.args.forEach((a, i) => {
        const want = target.params[i].type;
        if (expr(a) !== want) {
          fail(`argument ${i + 1} of '${e.name}' must be ${want}, but this is ${a.type}`, a);
        }
      });
      e.target = target;
      return target.ret;
    }

    function block(stmts) {
      scopes.push(new Map());
      stmts.forEach(statement);
      scopes.pop();
    }

    function statement(s) {
      switch (s.kind) {
        case 'Let': {
          const t = expr(s.init);
          if (t === 'void') fail('cannot store the result of a function that returns nothing', s.init);
          if (s.annotation && s.annotation !== t) {
            fail(`'${s.name}' is declared as ${s.annotation} but initialised with ${t}`, s.init);
          }
          s.slot = declare(s, s.name, t);  // declared after the initialiser is checked
          break;
        }
        case 'Assign': {
          const want = expr(s.target);
          if (expr(s.value) !== want) fail(`cannot assign ${s.value.type} to a ${want}`, s.value);
          break;
        }
        case 'If':
          expectType(s.cond, 'bool', 'condition');
          block(s.then);
          block(s.otherwise);
          break;
        case 'While':
          expectType(s.cond, 'bool', 'condition');
          loopDepth++;
          block(s.body);
          loopDepth--;
          break;
        case 'Return': {
          const t = s.value ? expr(s.value) : 'void';
          if (t !== f.ret) fail(`'${f.name}' must return ${f.ret}, but this returns ${t}`, s);
          break;
        }
        case 'Break':
        case 'Continue':
          if (!loopDepth) fail(`'${s.kind.toLowerCase()}' outside of a loop`, s);
          break;
        case 'ExprStmt':
          expr(s.expr);
          break;
        default:
          throw new Error(`unknown statement ${s.kind}`);
      }
    }

    for (const p of f.params) declare(p, p.name, p.type);
    block(f.body);
    if (f.ret !== 'void' && !alwaysReturns(f.body)) {
      fail(`function '${f.name}' does not return a value on every path`, f);
    }
  }
  return program;
}

// Conservative: true only if control can never fall off the end of the block.
function alwaysReturns(stmts) {
  return stmts.some((s) => s.kind === 'Return'
    || (s.kind === 'If' && alwaysReturns(s.then) && alwaysReturns(s.otherwise)));
}
