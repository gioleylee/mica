// AST-level optimisation: constant folding and removal of branches whose
// condition is known at compile time. Runs after type checking, so every
// expression already carries its type and folding can respect 32-bit wrapping.

const num = (e, value) => ({ ...e, kind: 'Num', value, left: undefined, right: undefined, operand: undefined });
const bool = (e, value) => ({ ...num(e, value), kind: 'Bool', type: 'bool' });

const INT_MIN = -0x80000000;

function foldBinary(e, a, b) {
  const int = e.left.type === 'int';
  switch (e.op) {
    case '+': return num(e, int ? (a + b) | 0 : a + b);
    case '-': return num(e, int ? (a - b) | 0 : a - b);
    case '*': return num(e, int ? Math.imul(a, b) : a * b);
    case '/':
      if (!int) return num(e, a / b);
      // Leave trapping divisions alone so the program still traps at run time.
      if (b === 0 || (a === INT_MIN && b === -1)) return e;
      return num(e, (a / b) | 0);
    case '%': return b === 0 ? e : num(e, (a % b) | 0);
    case '&': return num(e, a & b);
    case '|': return num(e, a | b);
    case '^': return num(e, a ^ b);
    case '<<': return num(e, a << b);
    case '>>': return num(e, a >> b);
    case '==': return bool(e, a === b);
    case '!=': return bool(e, a !== b);
    case '<': return bool(e, a < b);
    case '<=': return bool(e, a <= b);
    case '>': return bool(e, a > b);
    case '>=': return bool(e, a >= b);
    default: return e;
  }
}

const isLiteral = (e) => e.kind === 'Num' || e.kind === 'Bool';

function expr(e) {
  switch (e.kind) {
    case 'Unary': {
      e.operand = expr(e.operand);
      if (e.op === '!' && e.operand.kind === 'Bool') return bool(e, !e.operand.value);
      if (e.op === '-' && e.operand.kind === 'Num') {
        return num(e, e.type === 'int' ? (-e.operand.value) | 0 : -e.operand.value);
      }
      return e;
    }
    case 'Binary': {
      e.left = expr(e.left);
      e.right = expr(e.right);
      if (e.op === '&&' || e.op === '||') {
        if (e.left.kind !== 'Bool') return e;
        // The right side is evaluated only if the left does not decide the result.
        const decides = e.left.value === (e.op === '||');
        return decides ? e.left : e.right;
      }
      return isLiteral(e.left) && isLiteral(e.right) ? foldBinary(e, e.left.value, e.right.value) : e;
    }
    case 'Call':
      e.args = e.args.map(expr);
      return e;
    case 'Index':
      e.array = expr(e.array);
      e.index = expr(e.index);
      return e;
    case 'NewArray':
      e.size = expr(e.size);
      return e;
    default:
      return e;
  }
}

function block(stmts) {
  const out = [];
  for (const s of stmts) {
    switch (s.kind) {
      case 'Let': s.init = expr(s.init); break;
      case 'Assign': s.target = expr(s.target); s.value = expr(s.value); break;
      case 'Return': if (s.value) s.value = expr(s.value); break;
      case 'ExprStmt': s.expr = expr(s.expr); break;
      case 'While':
        s.cond = expr(s.cond);
        if (s.cond.kind === 'Bool' && !s.cond.value) continue;  // never runs
        s.body = block(s.body);
        break;
      case 'If':
        s.cond = expr(s.cond);
        if (s.cond.kind === 'Bool') {
          // Slots were assigned by the checker, so splicing the branch in is safe.
          out.push(...block(s.cond.value ? s.then : s.otherwise));
          continue;
        }
        s.then = block(s.then);
        s.otherwise = block(s.otherwise);
        break;
      default:
    }
    out.push(s);
  }
  return out;
}

export function optimize(program) {
  for (const f of program.fns) f.body = block(f.body);
  return program;
}
