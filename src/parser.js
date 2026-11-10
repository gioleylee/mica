// Lexer and parser: source text -> AST.
// Statements use recursive descent; expressions use precedence climbing.

export class CompileError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'CompileError';
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'while', 'return', 'break', 'continue',
  'true', 'false', 'new', 'int', 'float', 'bool']);
const OPERATORS = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<',
  '>', '=', '!', '&', '|', '^', '(', ')', '{', '}', '[', ']', ',', ':', ';'];

export function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const push = (kind, value, length) => {
    tokens.push({ kind, value, line, col });
    i += length;
    col += length;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; col = 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    let m;
    if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64)))) {
      const isFloat = m[1] !== undefined || m[2] !== undefined;
      push(isFloat ? 'float' : 'int', Number(m[0]), m[0].length);
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 128)))) {
      push(KEYWORDS.has(m[0]) ? 'kw' : 'ident', m[0], m[0].length);
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) throw new CompileError(`unexpected character '${c}'`, line, col);
      push('op', op, op.length);
    }
  }
  tokens.push({ kind: 'eof', value: '<end of file>', line, col });
  return tokens;
}

// Binary operator precedence; higher binds tighter. All are left-associative.
const PRECEDENCE = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

export function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const at = (value) => peek().kind !== 'ident' && peek().kind !== 'int' && peek().kind !== 'float'
    && peek().value === value;
  const fail = (msg, t = peek()) => { throw new CompileError(msg, t.line, t.col); };
  const eat = (value) => (at(value) ? tokens[pos++] : null);
  const expect = (value) => eat(value) ?? fail(`expected '${value}' but found '${peek().value}'`);
  const ident = () => (peek().kind === 'ident' ? tokens[pos++].value
    : fail(`expected a name but found '${peek().value}'`));
  const node = (t, kind, fields) => ({ kind, line: t.line, col: t.col, ...fields });

  function type() {
    const t = peek();
    if (t.kind !== 'kw' || !['int', 'float', 'bool'].includes(t.value)) {
      fail(`expected a type but found '${t.value}'`);
    }
    pos++;
    if (eat('[')) {
      expect(']');
      if (t.value === 'bool') fail('arrays of bool are not supported', t);
      return t.value + '[]';
    }
    return t.value;
  }

  function fn() {
    const t = expect('fn');
    const name = ident();
    expect('(');
    const params = [];
    while (!at(')')) {
      if (params.length) expect(',');
      const p = peek();
      const pname = ident();
      expect(':');
      params.push(node(p, 'Param', { name: pname, type: type() }));
    }
    expect(')');
    const ret = eat(':') ? type() : 'void';
    return node(t, 'Fn', { name, params, ret, body: block() });
  }

  function block() {
    expect('{');
    const stmts = [];
    while (!at('}')) {
      if (peek().kind === 'eof') fail("expected '}' before end of file");
      stmts.push(statement());
    }
    expect('}');
    return stmts;
  }

  function statement() {
    const t = peek();
    if (eat('let')) {
      const name = ident();
      const annotation = eat(':') ? type() : null;
      expect('=');
      const init = expression();
      expect(';');
      return node(t, 'Let', { name, annotation, init });
    }
    if (eat('if')) return ifStatement(t);
    if (eat('while')) return node(t, 'While', { cond: expression(), body: block() });
    if (eat('return')) {
      const value = at(';') ? null : expression();
      expect(';');
      return node(t, 'Return', { value });
    }
    if (eat('break')) { expect(';'); return node(t, 'Break', {}); }
    if (eat('continue')) { expect(';'); return node(t, 'Continue', {}); }
    const expr = expression();
    if (eat('=')) {
      if (expr.kind !== 'Ident' && expr.kind !== 'Index') fail('cannot assign to this expression', expr);
      const value = expression();
      expect(';');
      return node(t, 'Assign', { target: expr, value });
    }
    expect(';');
    return node(t, 'ExprStmt', { expr });
  }

  function ifStatement(t) {
    const cond = expression();
    const then = block();
    let otherwise = [];
    if (eat('else')) {
      const e = peek();
      otherwise = eat('if') ? [ifStatement(e)] : block();
    }
    return node(t, 'If', { cond, then, otherwise });
  }

  function expression(minPrecedence = 1) {
    let left = unary();
    for (;;) {
      const t = peek();
      const precedence = t.kind === 'op' ? PRECEDENCE[t.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      pos++;
      const right = expression(precedence + 1);
      left = node(t, 'Binary', { op: t.value, left, right });
    }
  }

  function unary() {
    const t = peek();
    if (eat('-')) return node(t, 'Unary', { op: '-', operand: unary() });
    if (eat('!')) return node(t, 'Unary', { op: '!', operand: unary() });
    let e = primary();
    while (at('[')) {
      const b = tokens[pos++];
      const index = expression();
      expect(']');
      e = node(b, 'Index', { array: e, index });
    }
    return e;
  }

  function args() {
    expect('(');
    const list = [];
    while (!at(')')) {
      if (list.length) expect(',');
      list.push(expression());
    }
    expect(')');
    return list;
  }

  function primary() {
    const t = tokens[pos++];
    if (t.kind === 'int') return node(t, 'Num', { value: t.value, type: 'int' });
    if (t.kind === 'float') return node(t, 'Num', { value: t.value, type: 'float' });
    if (t.kind === 'ident') {
      return at('(') ? node(t, 'Call', { name: t.value, args: args() }) : node(t, 'Ident', { name: t.value });
    }
    if (t.kind === 'kw') {
      if (t.value === 'true' || t.value === 'false') return node(t, 'Bool', { value: t.value === 'true' });
      // int(x) and float(x) are conversions written like calls.
      if ((t.value === 'int' || t.value === 'float') && at('(')) {
        return node(t, 'Call', { name: t.value, args: args() });
      }
      if (t.value === 'new') {
        const elem = peek();
        if (elem.kind !== 'kw' || (elem.value !== 'int' && elem.value !== 'float')) {
          fail("expected 'int' or 'float' after 'new'");
        }
        pos++;
        expect('[');
        const size = expression();
        expect(']');
        return node(t, 'NewArray', { elem: elem.value, size });
      }
    }
    if (t.kind === 'op' && t.value === '(') {
      const e = expression();
      expect(')');
      return e;
    }
    pos--;
    return fail(`expected an expression but found '${t.value}'`, t);
  }

  const fns = [];
  while (peek().kind !== 'eof') fns.push(fn());
  return { kind: 'Program', fns };
}
