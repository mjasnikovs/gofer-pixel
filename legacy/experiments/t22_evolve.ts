/**
 * TEST 22: does evolutionary refinement on the op list help, or does it just game CLIP?
 *
 * `PRODUCTION_PLAN.md` §9 lists the loop as unblocked and untried: generate N → score → keep top K
 * → mutate the ops → repeat, with no LLM call per generation. §9 fix 3 also says CLIP does not
 * track structural quality monotonically, so a search that optimises CLIP directly is exactly the
 * setup where that would bite.
 *
 * So this measures both: how far CLIP climbs, and what happens to the deterministic structure
 * scores of the winner while it climbs. A CLIP gain paid for by a collapse in connectivity or slice
 * usage is not an improvement, it is an adversarial example.
 *
 *   .venv/bin/python voxserve.py &        # the scorer
 *   bun experiments/t22_evolve.ts [generations] [population]
 */
import {generateMany} from '../src/gen/llama'
import {scoreWithClip, probeScorer} from '../src/gen/clip'
import {evolve, makeRng} from '../src/gen/evolve'
import {rasterise, type VoxSpec} from '../src/gen/ops'
import {scoreModel, type ModelScores} from '../src/gen/score'
import {light, rotationSheet} from '../src/vox/render'
import {encodePng} from '../src/image/png'
import {mkdir} from 'node:fs/promises'

const PROMPTS = ['a stone tower', 'a red mushroom', 'a wooden barrel']
const OUT = 'out/evolve'

/** Write the lit rotation sheet, so the CLIP number can be checked against an actual picture. */
const save = async (name: string, spec: VoxSpec): Promise<void> => {
    const sheet = rotationSheet(rasterise(spec), 8, {scale: 3})
    await Bun.write(`${OUT}/${name}.png`, await encodePng(light(sheet)))
}

const generations = Number(process.argv[2] ?? 4)
const population = Number(process.argv[3] ?? 6)

const structure = (spec: VoxSpec): ModelScores => scoreModel(rasterise(spec))

const show = (label: string, spec: VoxSpec, clip: number): void => {
    const s = structure(spec)
    console.log(
        `  ${label.padEnd(10)} clip ${clip.toFixed(4)}`
            + `  joined ${s.connectivity.toFixed(2)}`
            + `  slices ${s.sliceUsage.toFixed(2)}`
            + `  fill ${s.bboxFill.toFixed(2)}`
            + `  ${String(s.voxels)} voxels, ${String(s.colorsUsed)} colours`
            + `  ${String(spec.ops.length)} ops`
    )
}

await mkdir(OUT, {recursive: true})

if (!(await probeScorer())) {
    console.error('voxserve.py is not running — start it first')
    process.exit(1)
}

for (const prompt of PROMPTS) {
    console.log(`\n=== ${prompt}`)
    const {candidates, failures} = await generateMany(prompt, population, {
        sampler: {temperature: 0.9}
    })
    if (candidates.length < 2) {
        console.log(`  too few candidates (${String(failures.length)} failed)`)
        continue
    }

    const seeds = candidates.map(candidate => candidate.spec)
    const seedScores = await scoreWithClip(prompt, seeds)
    const bestSeedIndex = seedScores.reduce(
        (best, value, i) => ((value ?? -1) > (seedScores[best] ?? -1) ? i : best),
        0
    )
    const bestSeed = seeds[bestSeedIndex]
    if (!bestSeed) {
        continue
    }
    show('start', bestSeed, seedScores[bestSeedIndex] ?? 0)
    const slug = prompt.replace(/\s+/g, '_')
    await save(`${slug}_before`, bestSeed)

    const t0 = performance.now()
    const result = await evolve(seeds, specs => scoreWithClip(prompt, specs), {
        generations,
        population,
        keep: 2,
        rng: makeRng(20260807),
        mutate: {jitter: 2, structural: 0.3},
        onGeneration: (generation, best) => {
            console.log(`  gen ${String(generation)}: best clip ${best.toFixed(4)}`)
        }
    })
    show('evolved', result.best, result.bestScore)
    await save(`${slug}_after`, result.best)
    console.log(
        `  +${(result.bestScore - (seedScores[bestSeedIndex] ?? 0)).toFixed(4)} clip`
            + ` over ${String(generations)} generations,`
            + ` ${String(result.evaluations)} evaluations,`
            + ` ${((performance.now() - t0) / 1000).toFixed(0)} s, 0 extra LLM calls`
    )
}
