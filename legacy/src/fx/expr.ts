/**
 * A tiny arithmetic expression language, and the reason it is hand-written rather than `eval`.
 *
 * `PRODUCTION_PLAN.md` §8 wants procedural voxel shaders — MagicaVoxel's `xs` commands are not GPU
 * shaders at all but volume generators over `voxel(x,y,z)` — and it wants the same surface to be
 * drivable by the model. Handing generated text to `new Function` would give it the whole page:
 * `fetch`, `localStorage`, the document. This evaluator can only do arithmetic on the numbers it
 * is given and call the functions in one fixed table, so a hostile script's worst outcome is a
 * wrong-looking model.
 *
 * The grammar is precedence-climbing over: `?:`, `||`, `&&`, comparisons, `+ -`, `* / %`, unary
 * `- !`, then calls, numbers, names and parentheses.
 */
export type Scope = Record<string, number>

type TokenKind = 'number' | 'name' | 'op' | 'end'

interface Token {
    kind: TokenKind
    text: string
    value?: number
    at: number
}

const OPERATORS = [
    '<=',
    '>=',
    '==',
    '!=',
    '&&',
    '||',
    '+',
    '-',
    '*',
    '/',
    '%',
    '<',
    '>',
    '(',
    ')',
    ',',
    '?',
    ':',
    '!'
]

export const tokenize = (source: string): Token[] => {
    const out: Token[] = []
    let i = 0
    while (i < source.length) {
        const char = source[i] ?? ''
        if (/\s/.test(char)) {
            i += 1
            continue
        }
        if (/[0-9.]/.test(char)) {
            const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(i))
            const text = match?.[0] ?? char
            out.push({kind: 'number', text, value: Number(text), at: i})
            i += text.length
            continue
        }
        if (/[A-Za-z_]/.test(char)) {
            const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i))
            const text = match?.[0] ?? char
            out.push({kind: 'name', text, at: i})
            i += text.length
            continue
        }
        const op = OPERATORS.find(candidate => source.startsWith(candidate, i))
        if (!op) {
            throw new Error(`unexpected character "${char}" at ${String(i)}`)
        }
        out.push({kind: 'op', text: op, at: i})
        i += op.length
    }
    out.push({kind: 'end', text: '', at: source.length})
    return out
}

const hash3 = (x: number, y: number, z: number): number => {
    // integer hash, deterministic across platforms because it stays inside 32-bit ops
    let h = Math.imul(Math.trunc(x) | 0, 0x27d4eb2d)
    h = Math.imul(h ^ (Math.trunc(y) | 0), 0x165667b1)
    h = Math.imul(h ^ (Math.trunc(z) | 0), 0x9e3779b1)
    h ^= h >>> 15
    return (h >>> 0) / 0xffffffff
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Value noise, 0–1, smooth between integer lattice points. */
const noise3 = (x: number, y: number, z: number): number => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const z0 = Math.floor(z)
    const tx = smooth(x - x0)
    const ty = smooth(y - y0)
    const tz = smooth(z - z0)
    const mix = (a: number, b: number, t: number): number => a + (b - a) * t
    const corner = (dx: number, dy: number, dz: number): number => hash3(x0 + dx, y0 + dy, z0 + dz)
    const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), tx)
    const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), tx)
    const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), tx)
    const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), tx)
    return mix(mix(x00, x10, ty), mix(x01, x11, ty), tz)
}

export const FUNCTIONS: Record<string, (args: number[]) => number> = {
    abs: ([a = 0]) => Math.abs(a),
    min: args => Math.min(...args),
    max: args => Math.max(...args),
    floor: ([a = 0]) => Math.floor(a),
    ceil: ([a = 0]) => Math.ceil(a),
    round: ([a = 0]) => Math.round(a),
    sqrt: ([a = 0]) => Math.sqrt(Math.max(a, 0)),
    pow: ([a = 0, b = 0]) => a ** b,
    sin: ([a = 0]) => Math.sin(a),
    cos: ([a = 0]) => Math.cos(a),
    atan2: ([a = 0, b = 0]) => Math.atan2(a, b),
    mod: ([a = 0, b = 1]) => (b === 0 ? 0 : ((a % b) + b) % b),
    clamp: ([a = 0, lo = 0, hi = 1]) => Math.min(Math.max(a, lo), hi),
    step: ([edge = 0, a = 0]) => (a < edge ? 0 : 1),
    mix: ([a = 0, b = 0, t = 0]) => a + (b - a) * t,
    length: args => Math.hypot(...args),
    noise: ([x = 0, y = 0, z = 0]) => noise3(x, y, z),
    rand: ([x = 0, y = 0, z = 0]) => hash3(x, y, z)
}

type Node = (scope: Scope) => number

/** Parse once, evaluate many times — a script runs per voxel, so parsing per voxel would show. */
export const compile = (source: string): Node => {
    const tokens = tokenize(source)
    let pos = 0

    const peek = (): Token => tokens[pos] ?? {kind: 'end', text: '', at: 0}
    const eat = (text: string): boolean => {
        if (peek().kind === 'op' && peek().text === text) {
            pos += 1
            return true
        }
        return false
    }
    const expect = (text: string): void => {
        if (!eat(text)) {
            throw new Error(`expected "${text}" at ${String(peek().at)}`)
        }
    }

    const parseExpression = (): Node => parseTernary()

    const parseTernary = (): Node => {
        const condition = parseBinary(0)
        if (!eat('?')) {
            return condition
        }
        const whenTrue = parseExpression()
        expect(':')
        const whenFalse = parseExpression()
        return scope => (condition(scope) !== 0 ? whenTrue(scope) : whenFalse(scope))
    }

    const LEVELS: string[][] = [
        ['||'],
        ['&&'],
        ['==', '!=', '<', '>', '<=', '>='],
        ['+', '-'],
        ['*', '/', '%']
    ]

    const parseBinary = (level: number): Node => {
        if (level >= LEVELS.length) {
            return parseUnary()
        }
        let left = parseBinary(level + 1)
        for (;;) {
            const token = peek()
            const operator = (LEVELS[level] ?? []).find(
                candidate => token.kind === 'op' && token.text === candidate
            )
            if (operator === undefined) {
                return left
            }
            pos += 1
            const right = parseBinary(level + 1)
            const a = left
            left = scope => {
                const l = a(scope)
                const r = right(scope)
                switch (operator) {
                    case '||':
                        return l !== 0 || r !== 0 ? 1 : 0
                    case '&&':
                        return l !== 0 && r !== 0 ? 1 : 0
                    case '==':
                        return l === r ? 1 : 0
                    case '!=':
                        return l !== r ? 1 : 0
                    case '<':
                        return l < r ? 1 : 0
                    case '>':
                        return l > r ? 1 : 0
                    case '<=':
                        return l <= r ? 1 : 0
                    case '>=':
                        return l >= r ? 1 : 0
                    case '+':
                        return l + r
                    case '-':
                        return l - r
                    case '*':
                        return l * r
                    case '/':
                        return r === 0 ? 0 : l / r
                    default:
                        return r === 0 ? 0 : l % r
                }
            }
        }
    }

    const parseUnary = (): Node => {
        if (eat('-')) {
            const operand = parseUnary()
            return scope => -operand(scope)
        }
        if (eat('!')) {
            const operand = parseUnary()
            return scope => (operand(scope) === 0 ? 1 : 0)
        }
        return parsePrimary()
    }

    const parsePrimary = (): Node => {
        const token = peek()
        if (token.kind === 'number') {
            pos += 1
            const value = token.value ?? 0
            return () => value
        }
        if (token.kind === 'name') {
            pos += 1
            const name = token.text
            if (eat('(')) {
                const args: Node[] = []
                if (!eat(')')) {
                    do {
                        args.push(parseExpression())
                    } while (eat(','))
                    expect(')')
                }
                // `Object.hasOwn`, not a truthiness check: a plain object answers to
                // `constructor` and `toString` from its prototype, and looking those up would
                // hand a script real functions to call
                const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined
                if (!fn) {
                    throw new Error(`unknown function "${name}"`)
                }
                return scope => fn(args.map(arg => arg(scope)))
            }
            return scope => (Object.hasOwn(scope, name) ? (scope[name] ?? 0) : 0)
        }
        if (eat('(')) {
            const inner = parseExpression()
            expect(')')
            return inner
        }
        throw new Error(`unexpected "${token.text || 'end of script'}" at ${String(token.at)}`)
    }

    const root = parseExpression()
    if (peek().kind !== 'end') {
        throw new Error(`unexpected "${peek().text}" at ${String(peek().at)}`)
    }
    return scope => {
        const value = root(scope)
        return Number.isFinite(value) ? value : 0
    }
}

export const evaluate = (source: string, scope: Scope): number => compile(source)(scope)
