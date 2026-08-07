import {describe, expect, test} from 'bun:test'
import {compile, evaluate, tokenize} from './expr'

describe('tokenize', () => {
    test('splits numbers, names and operators', () => {
        expect(tokenize('x1 + 2.5 * noise(y, z)').map(token => token.text)).toEqual([
            'x1',
            '+',
            '2.5',
            '*',
            'noise',
            '(',
            'y',
            ',',
            'z',
            ')',
            ''
        ])
    })

    test('refuses a character it does not know', () => {
        expect(() => tokenize('x @ y')).toThrow('unexpected character')
    })
})

describe('arithmetic', () => {
    test('precedence and parentheses', () => {
        expect(evaluate('2 + 3 * 4', {})).toBe(14)
        expect(evaluate('(2 + 3) * 4', {})).toBe(20)
        expect(evaluate('-3 + 1', {})).toBe(-2)
    })

    test('division and modulo by zero give zero rather than infinity or NaN', () => {
        expect(evaluate('1 / 0', {})).toBe(0)
        expect(evaluate('5 % 0', {})).toBe(0)
    })

    test('comparisons and logic return 1 or 0', () => {
        expect(evaluate('3 > 2', {})).toBe(1)
        expect(evaluate('3 < 2', {})).toBe(0)
        expect(evaluate('1 && 0', {})).toBe(0)
        expect(evaluate('1 || 0', {})).toBe(1)
        expect(evaluate('!0', {})).toBe(1)
    })

    test('the ternary picks a branch', () => {
        expect(evaluate('x > 3 ? 10 : 20', {x: 5})).toBe(10)
        expect(evaluate('x > 3 ? 10 : 20', {x: 1})).toBe(20)
    })

    test('an unknown variable is zero, not an error — a script is data, not code review', () => {
        expect(evaluate('missing + 1', {})).toBe(1)
    })
})

describe('functions', () => {
    test('the maths ones behave', () => {
        expect(evaluate('mod(-1, 4)', {})).toBe(3)
        expect(evaluate('clamp(9, 0, 5)', {})).toBe(5)
        expect(evaluate('step(3, 4)', {})).toBe(1)
        expect(evaluate('mix(0, 10, 0.5)', {})).toBe(5)
        expect(evaluate('length(3, 4)', {})).toBe(5)
    })

    test('rand is deterministic and spread over 0–1', () => {
        expect(evaluate('rand(1, 2, 3)', {})).toBe(evaluate('rand(1, 2, 3)', {}))
        expect(evaluate('rand(1, 2, 3)', {})).not.toBe(evaluate('rand(1, 2, 4)', {}))
        const samples = Array.from({length: 200}, (_unused, i) =>
            evaluate(`rand(${String(i)}, 0, 0)`, {})
        )
        expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
        expect(Math.max(...samples)).toBeLessThanOrEqual(1)
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length
        expect(mean).toBeGreaterThan(0.35)
        expect(mean).toBeLessThan(0.65)
    })

    test('noise is smooth between lattice points and matches rand on them', () => {
        expect(evaluate('noise(2, 3, 4)', {})).toBeCloseTo(evaluate('rand(2, 3, 4)', {}), 6)
        const a = evaluate('noise(2.0, 3, 4)', {})
        const b = evaluate('noise(2.1, 3, 4)', {})
        expect(Math.abs(a - b)).toBeLessThan(0.3)
    })

    test('an unknown function is a clear error, not a silent zero', () => {
        expect(() => compile('rmdir(1)')).toThrow('unknown function "rmdir"')
    })
})

describe('the sandbox', () => {
    test('it cannot reach anything outside the scope it is handed', () => {
        for (const attempt of [
            'fetch',
            'globalThis',
            'window',
            'document',
            'constructor',
            'process'
        ]) {
            // names resolve against the scope object and nothing else, so these are all just 0
            expect(evaluate(attempt, {})).toBe(0)
        }
        expect(() => compile('fetch("http://x")')).toThrow('unexpected character')
        expect(() => compile('constructor(1)')).toThrow('unknown function')
    })

    test('a prototype key does not leak a function', () => {
        expect(evaluate('toString', {})).toBe(0)
        expect(() => compile('toString()')).toThrow('unknown function')
    })

    test('malformed input throws instead of producing a program', () => {
        expect(() => compile('2 +')).toThrow()
        expect(() => compile('(1')).toThrow()
        expect(() => compile('1 2')).toThrow()
    })
})

describe('compile', () => {
    test('the same program can be run many times with different scopes', () => {
        const program = compile('x * 2 + y')
        expect(program({x: 1, y: 0})).toBe(2)
        expect(program({x: 3, y: 1})).toBe(7)
    })
})
