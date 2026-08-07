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
