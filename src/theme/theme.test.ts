import {expect, test} from 'bun:test'
import {contrastRatio, findViolations, lightness, parseThemeTokens} from './design-rules'

const css = await Bun.file(new URL('./gofer-pixel-theme.css', import.meta.url)).text()
const tokens = parseThemeTokens(css)

/**
 * The gate the mockups are actually held to. It runs inside `bun test` rather than as its own
 * script so that "does the window still have a hierarchy" fails in the same second as a broken
 * render does, and so nobody has to remember a second command.
 */
test('the built theme keeps every distinction it is supposed to make', () => {
    const violations = findViolations(tokens)
    const report = violations
        .map(({rule, mode, detail, why}) => `\n  ${rule} (${mode})\n    ${detail}\n    ${why}`)
        .join('')
    expect(report).toBe('')
})

test('the rules themselves measure what they claim to', () => {
    expect(Math.round(lightness('#ffffff'))).toBe(100)
    expect(Math.round(lightness('#000000'))).toBe(0)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)

    // A ramp that runs backwards is a violation of the same rule as one that is too shallow.
    expect(
        findViolations(
            new Map([
                ['--color-background-body', {light: '#ffffff', dark: '#303030'}],
                ['--color-background-surface', {light: '#ffffff', dark: '#202020'}]
            ])
        ).map(({rule, mode}) => `${rule}:${mode}`)
    ).toEqual(['surface-ramp:light', 'surface-ramp:dark'])
})

test('the theme is the one the mockups were sampled from, not the inherited neutral one', () => {
    expect(tokens.get('--color-accent')?.dark).toBe('#7053ef')
    expect(tokens.get('--color-background-body')?.dark).toBe('#13161c')
})

/*
 * The two rules that only fire on a theme that is wrong.
 *
 * The built theme passes, which is the point of it — so the branches that *report* a violation are
 * never reached by the gate above. They are driven here against token sets built to fail, because a
 * rule whose failure path has never run is a rule that might not be able to fail at all.
 */
test('a text role too close to another one is reported, with the numbers behind it', () => {
    const violations = findViolations(
        new Map([
            ['--color-text-primary', {light: '#404040', dark: '#c0c0c0'}],
            ['--color-text-secondary', {light: '#454545', dark: '#c4c4c4'}]
        ])
    )

    expect(violations.map(({rule, mode}) => `${rule}:${mode}`)).toEqual([
        'text-ramp:light',
        'text-ramp:dark'
    ])
    // The detail carries both tokens, both values and the distance, so the fix is obvious from the
    // failure and nobody has to go and measure it again.
    expect(violations[0]?.detail).toContain('--color-text-primary (#404040)')
    expect(violations[0]?.detail).toContain('--color-text-secondary (#454545)')
    expect(violations[0]?.detail).toMatch(/L\* apart, need \d+/)
    expect(violations[0]?.why).toBeTruthy()
})

test('a control border that cannot be found against its background is reported as a ratio', () => {
    const violations = findViolations(
        new Map([
            ['--color-border-emphasized', {light: '#f4f4f4', dark: '#1a1a1a'}],
            ['--color-background-surface', {light: '#ffffff', dark: '#151515'}]
        ])
    )

    expect(violations.map(({rule, mode}) => `${rule}:${mode}`)).toEqual([
        'control-boundary:light',
        'control-boundary:dark'
    ])
    expect(violations[0]?.detail).toMatch(/:1, need [\d.]+:1/)
    expect(violations[0]?.why).toContain('WCAG 1.4.11')
})
