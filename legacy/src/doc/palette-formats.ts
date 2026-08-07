import type {Rgba} from '../vox/palette'
import {createImage, type RgbaImage} from '../image/rgba'
import {colorFromHex, colorToHex} from './serialize'

/**
 * The palette formats a pixel artist already has on disk — the set Lospec publishes.
 *
 * `.ase` (Adobe swatch exchange) is deliberately absent. It is binary, and the layout available
 * to me is a second-hand summary rather than the specification; writing it from that would
 * produce files Adobe may or may not open, which is worse than not offering it. `PRODUCTION_PLAN.md`
 * §11 lists it, §14 is where this note belongs.
 */
export type PaletteFormat = 'gpl' | 'hex' | 'pal'

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

/** GIMP palette. The header line is required; `Name:` and `Columns:` are conventional. */
export const toGpl = (palette: readonly Rgba[], name = 'gofer-pixel'): string => {
    const lines = ['GIMP Palette', `Name: ${name}`, 'Columns: 16', '#']
    palette.forEach((color, i) => {
        if (color.a === 0) {
            return
        }
        const {r, g, b} = color
        const cells = [r, g, b].map(v => String(clamp(v)).padStart(3, ' ')).join(' ')
        lines.push(`${cells}\tIndex ${String(i + 1)}`)
    })
    return `${lines.join('\n')}\n`
}

export const fromGpl = (text: string): Rgba[] =>
    text
        .split(/\r?\n/)
        .filter(line => /^\s*\d/.test(line))
        .map(line => {
            const [r, g, b] = line.trim().split(/\s+/).map(Number)
            return {r: clamp(r ?? 0), g: clamp(g ?? 0), b: clamp(b ?? 0), a: 255}
        })

/** Lospec's `.hex`: one `rrggbb` per line, nothing else. */
export const toHex = (palette: readonly Rgba[]): string =>
    `${palette
        .filter(color => color.a !== 0)
        .map(color => colorToHex(color).slice(1, 7))
        .join('\n')}\n`

export const fromHex = (text: string): Rgba[] =>
    text
        .split(/\r?\n/)
        .map(line => line.trim().replace(/^#/, ''))
        .filter(line => /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(line))
        .map(line => colorFromHex(line))

/** JASC-PAL, as written by Paint Shop Pro and read by most pixel tools. */
export const toPal = (palette: readonly Rgba[]): string => {
    const entries = palette.filter(color => color.a !== 0)
    const body = entries
        .map(({r, g, b}) => `${String(clamp(r))} ${String(clamp(g))} ${String(clamp(b))}`)
        .join('\r\n')
    return `JASC-PAL\r\n0100\r\n${String(entries.length)}\r\n${body}\r\n`
}

export const fromPal = (text: string): Rgba[] => {
    const lines = text.split(/\r?\n/).map(line => line.trim())
    if (lines[0] !== 'JASC-PAL') {
        throw new Error('not a JASC .pal file')
    }
    return lines
        .slice(3)
        .filter(line => /^\d+\s+\d+\s+\d+/.test(line))
        .map(line => {
            const [r, g, b] = line.split(/\s+/).map(Number)
            return {r: clamp(r ?? 0), g: clamp(g ?? 0), b: clamp(b ?? 0), a: 255}
        })
}

export const encodePalette = (
    palette: readonly Rgba[],
    format: PaletteFormat,
    name?: string
): string => {
    if (format === 'gpl') {
        return toGpl(palette, name)
    }
    return format === 'hex' ? toHex(palette) : toPal(palette)
}

/** Sniff the format from the content rather than the file name, which is often wrong. */
export const decodePalette = (text: string): Rgba[] => {
    if (text.startsWith('GIMP Palette')) {
        return fromGpl(text)
    }
    if (text.startsWith('JASC-PAL')) {
        return fromPal(text)
    }
    return fromHex(text)
}

/** A palette as a 1px-per-colour strip, the other thing Lospec hands out. */
export const toStrip = (palette: readonly Rgba[], scale = 1): RgbaImage => {
    const colors = palette.filter(color => color.a !== 0)
    const image = createImage(Math.max(colors.length * scale, 1), Math.max(scale, 1))
    colors.forEach(({r, g, b, a}, i) => {
        for (let y = 0; y < scale; y += 1) {
            for (let x = 0; x < scale; x += 1) {
                const at = (y * image.width + i * scale + x) * 4
                image.data.set([r, g, b, a], at)
            }
        }
    })
    return image
}

/** Read a strip back, one entry per distinct colour run. Handles any scale. */
export const fromStrip = ({width, height, data}: RgbaImage): Rgba[] => {
    const out: Rgba[] = []
    let previous: string | null = null
    const y = Math.floor(height / 2)
    for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4
        const color: Rgba = {
            r: data[at] ?? 0,
            g: data[at + 1] ?? 0,
            b: data[at + 2] ?? 0,
            a: data[at + 3] ?? 0
        }
        const key = colorToHex(color)
        if (key !== previous && color.a !== 0) {
            out.push(color)
        }
        previous = key
    }
    return out
}
