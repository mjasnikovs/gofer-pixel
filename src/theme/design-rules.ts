/**
 * Rules that keep the built theme legible as a hierarchy.
 *
 * A theme can satisfy every contrast requirement for text and still render an interface nobody can
 * read, because reading an interface is reading the differences between its parts: which text is a
 * value and which is a hint, which panel floats over which, which button is the one to press. Those
 * differences live in the gaps between tokens, and a token file is the one place a gap can be
 * measured before anyone has to look at a screenshot to notice it is gone.
 *
 * Distances are in CIE L*, not in contrast ratios. A ratio answers "can this be read at all", which
 * is the wrong question for two greys that are both perfectly readable and three points apart; L*
 * is perceptual lightness, so a fixed distance means the same amount of visible difference at the
 * dark end of the ramp as at the light end.
 *
 * Carried over from the sibling project, where every rule below was written because a real
 * screenshot had already lost the distinction it names.
 */

/** WCAG 1.4.11 asks 3:1 of any boundary a user has to find in order to operate a control. */
const MIN_BOUNDARY_CONTRAST = 3

/**
 * Roles a reader has to tell apart at a glance, so they need more than a nudge. Twelve points is
 * roughly the step between a neutral ramp's own stops — below it, two roles read as one colour that
 * happened to render twice.
 */
const MIN_ROLE_DISTANCE = 12

/** Surfaces are told apart by their edge as much as their fill, so they need far less. */
const MIN_SURFACE_DISTANCE = 3

export type Mode = 'light' | 'dark'

export interface Violation {
    readonly rule: string
    readonly mode: Mode
    readonly detail: string
    readonly why: string
}

const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** Relative luminance, the Y of CIE XYZ, since both WCAG contrast and L* are defined against it. */
export const luminance = (hex: string): number => {
    const [red, green, blue] = [1, 3, 5].map(at =>
        channel(Number.parseInt(hex.slice(at, at + 2), 16))
    )
    return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

/** Perceptual lightness, 0 for black and 100 for white. */
export const lightness = (hex: string): number => {
    const y = luminance(hex)
    return y <= 216 / 24389 ? y * (24389 / 27) : 116 * Math.cbrt(y) - 16
}

export const contrastRatio = (one: string, other: string): number => {
    const [darker, lighter] = [luminance(one), luminance(other)].sort((a, b) => a - b)
    return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05)
}

/**
 * Reads the pairs out of a built theme.
 *
 * Only `light-dark()` pairs of plain hex are collected: a token that resolves through `var()` or
 * carries an alpha channel has no fixed lightness to measure, and guessing what it composites over
 * would make a rule that fails on a colour nobody chose.
 */
export const parseThemeTokens = (css: string): Map<string, Record<Mode, string>> => {
    const tokens = new Map<string, Record<Mode, string>>()
    const pattern = /(--[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi
    for (const [, name, light, dark] of css.matchAll(pattern)) {
        if (name !== undefined && light !== undefined && dark !== undefined) {
            tokens.set(name, {light, dark})
        }
    }
    return tokens
}

type Tokens = Map<string, Record<Mode, string>>

/** A rule reports nothing when a token it needs is missing — an absent token is not a collapsed one. */
const read = (tokens: Tokens, mode: Mode, name: string): string | undefined =>
    tokens.get(name)?.[mode]

/**
 * Two roles far enough apart to read as two, in whichever direction. Use this where only the size
 * of the gap carries meaning; where the order carries meaning too, use `ascent`.
 */
const separation = (
    tokens: Tokens,
    mode: Mode,
    rule: string,
    from: string,
    to: string,
    minimum: number,
    why: string
): Violation | undefined => {
    const one = read(tokens, mode, from)
    const other = read(tokens, mode, to)
    if (one === undefined || other === undefined) return undefined
    const distance = Math.abs(lightness(one) - lightness(other))
    if (distance >= minimum) return undefined
    return {
        rule,
        mode,
        detail: `${from} (${one}) and ${to} (${other}) are ${distance.toFixed(1)} L* apart, need ${String(minimum)}`,
        why
    }
}

/**
 * One step up the surface ramp: `to` has to be both far enough from `from` and above it.
 *
 * An unsigned distance passes a ramp that runs backwards, which is how a dark mode once shipped a
 * popover five points *below* the panel it floats over with the gate seeing nothing.
 */
const ascent = (
    tokens: Tokens,
    mode: Mode,
    from: string,
    to: string,
    why: string
): Violation | undefined => {
    const one = read(tokens, mode, from)
    const other = read(tokens, mode, to)
    if (one === undefined || other === undefined) return undefined
    const rise = lightness(other) - lightness(one)
    if (rise >= MIN_SURFACE_DISTANCE) return undefined
    const direction =
        rise <= 0 ? `${Math.abs(rise).toFixed(1)} L* below` : `only ${rise.toFixed(1)} L* above`
    return {
        rule: 'surface-ramp',
        mode,
        detail: `${to} (${other}) is ${direction} ${from} (${one}), need ${String(MIN_SURFACE_DISTANCE)} above`,
        why
    }
}

const boundary = (
    tokens: Tokens,
    mode: Mode,
    edge: string,
    against: string
): Violation | undefined => {
    const one = read(tokens, mode, edge)
    const other = read(tokens, mode, against)
    if (one === undefined || other === undefined) return undefined
    const ratio = contrastRatio(one, other)
    if (ratio >= MIN_BOUNDARY_CONTRAST) return undefined
    return {
        rule: 'control-boundary',
        mode,
        detail: `${edge} (${one}) on ${against} (${other}) is ${ratio.toFixed(2)}:1, need ${String(MIN_BOUNDARY_CONTRAST)}:1`,
        why: 'the edge of an input or a button cannot be found (WCAG 1.4.11)'
    }
}

/**
 * Every violation the built theme carries, in both modes. The rules are deliberately few: each one
 * names a distinction a user makes without being taught it.
 */
export const findViolations = (tokens: Tokens): Violation[] => {
    const found: (Violation | undefined)[] = []
    for (const mode of ['light', 'dark'] as const) {
        found.push(
            separation(
                tokens,
                mode,
                'text-ramp',
                '--color-text-primary',
                '--color-text-secondary',
                MIN_ROLE_DISTANCE,
                'a value and its supporting text read as one weight of text'
            ),
            separation(
                tokens,
                mode,
                'text-ramp',
                '--color-text-secondary',
                '--color-text-disabled',
                MIN_ROLE_DISTANCE,
                'a placeholder reads as text the user typed'
            ),
            separation(
                tokens,
                mode,
                'accent-distinct',
                '--color-accent',
                '--color-text-primary',
                MIN_ROLE_DISTANCE,
                'the primary action carries no more emphasis than body text'
            ),
            ascent(
                tokens,
                mode,
                '--color-background-body',
                '--color-background-surface',
                'panels and the frame behind them read as one flat sheet'
            ),
            ascent(
                tokens,
                mode,
                '--color-background-surface',
                '--color-background-card',
                'a card is the panel it sits on, with a hairline drawn round it'
            ),
            ascent(
                tokens,
                mode,
                '--color-background-card',
                '--color-background-popover',
                'a popover does not read as floating over what it covers'
            ),
            boundary(tokens, mode, '--color-border-emphasized', '--color-background-surface')
        )
    }
    return found.filter((violation): violation is Violation => violation !== undefined)
}
