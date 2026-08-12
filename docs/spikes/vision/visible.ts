/*
 * Is the red mark even in the picture?
 *
 * A score on "which side is the mark on" means nothing until this is known. One three-quarter view
 * from the front-right cannot show a mark on the back face, so a model answering at chance there is
 * being asked about something it was never shown — that is a bad question, not a bad model.
 *
 *     bun docs/spikes/vision/visible.ts
 *
 * No server, no calls. It counts red pixels in the render.
 */
import {build, CORPUS, truthOf} from './shapes'
import {pixelsFor, VIEW_SETS} from './views'

/*
 * Red-dominant, with no absolute floor — and that floor is why this file exists twice.
 *
 * `FACE_LIGHT` lights the `-x` face at 128/256 and the underside at 96/256, so the mark's
 * `(200, 70, 60)` reaches the picture as `(100, 35, 30)` on a left-facing wall. A first version
 * tested `r > 120` and reported the back and left marks as invisible in every view set, which would
 * have been a real finding about the app's camera ring if it had been true. The base grey-blue is
 * `(154, 164, 180)` and the background is neutral, so red-over-both is the whole test.
 */
const isMark = (r: number, g: number, b: number): boolean => r > g + 15 && r > b + 15

const SETS = ['one', 'two', 'four', 'fourIso', 'six'] as const

process.stdout.write(
    `${'shape'.padEnd(14)}${'side'.padEnd(7)}${SETS.map(s => s.padStart(9)).join('')}\n`
)
for (const stimulus of CORPUS) {
    if (!stimulus.asks.includes('mark')) continue
    const volume = build(stimulus, 32)
    const truth = truthOf(stimulus, volume)
    const cells = SETS.map(name => {
        const views = VIEW_SETS[name] ?? []
        let seen = 0
        for (const view of views) {
            const pixels = pixelsFor(volume, view, 96)
            for (let i = 0; i < pixels.length; i += 4) {
                if (isMark(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0)) seen += 1
            }
        }
        return String(seen).padStart(9)
    })
    process.stdout.write(
        `${stimulus.id.padEnd(14)}${(truth.mark ?? '—').padEnd(7)}${cells.join('')}\n`
    )
}
