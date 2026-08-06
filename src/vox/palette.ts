export interface Rgba {
    r: number
    g: number
    b: number
    a: number
}

/** Index 0 is empty. Ported verbatim from `experiments/vox.py`. */
export const PALETTE: readonly Rgba[] = [
    {r: 0, g: 0, b: 0, a: 0}, // 0 empty
    {r: 28, g: 20, b: 36, a: 255}, // 1 dark
    {r: 68, g: 56, b: 84, a: 255}, // 2 steel
    {r: 120, g: 104, b: 132, a: 255}, // 3 light steel
    {r: 200, g: 196, b: 210, a: 255}, // 4 white
    {r: 176, g: 48, b: 60, a: 255}, // 5 red
    {r: 232, g: 160, b: 48, a: 255}, // 6 gold
    {r: 56, g: 132, b: 84, a: 255}, // 7 green
    {r: 48, g: 108, b: 176, a: 255}, // 8 blue
    {r: 140, g: 88, b: 48, a: 255} // 9 wood
]

export const EMPTY = 0

const TRANSPARENT: Rgba = {r: 0, g: 0, b: 0, a: 0}

export const colorOf = (index: number): Rgba => PALETTE[index] ?? TRANSPARENT
