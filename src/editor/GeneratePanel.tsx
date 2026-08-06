import {useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {VStack} from '@astryxdesign/core/VStack'
import {light, rotationSheet} from '../vox/render'
import type {RgbaImage} from '../image/rgba'
import {generateMany, type Candidate} from '../gen/llama'
import {overallScore, scoreModel, type ModelScores} from '../gen/score'
import {probeScorer, rankAgreement, scoreWithClip} from '../gen/clip'
import type {Editor as EditorApi} from './useEditor'

/**
 * `PRODUCTION_PLAN.md` §12 M3: the `voxbatch` pipeline behind a panel. Prompt, N candidates,
 * ranked grid, pick one into the editor as an ordinary undoable document.
 *
 * Ranking is the deterministic side of §9 fix 3 — connectivity, slice usage, fill, palette — which
 * is exact and computed in the page. CLIP is an extra opinion: it needs torch on the CPU, so it
 * lives in `voxserve.py` and is asked only if that service happens to be up. The plan is explicit
 * that CLIP must not be a quality gate, so nothing here depends on it being there.
 */
interface Ranked {
    candidate: Candidate
    scores: ModelScores
    overall: number
    clip: number | null
}

const paint = (canvas: HTMLCanvasElement | null, image: RgbaImage): void => {
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) {
        return
    }
    canvas.width = image.width
    canvas.height = image.height
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0
    )
}

const CandidateCard = ({
    entry,
    rank,
    onPick
}: {
    entry: Ranked
    rank: number
    onPick: () => void
}) => {
    const canvas = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        paint(canvas.current, light(rotationSheet(entry.candidate.voxels, 4, {scale: 2})))
    }, [entry])

    const {scores} = entry
    return (
        <VStack gap={1}>
            <canvas
                ref={canvas}
                data-testid={`candidate-${String(rank)}`}
                style={{
                    imageRendering: 'pixelated',
                    display: 'block',
                    maxWidth: 220,
                    background: '#1e1e1e',
                    outline: '1px solid #333'
                }}
            />
            <Text type='supporting'>
                {`${entry.candidate.spec.name} · ${entry.overall.toFixed(2)}`
                    + (entry.clip === null ? '' : ` · clip ${entry.clip.toFixed(3)}`)
                    + ` · joined ${(scores.connectivity * 100).toFixed(0)}%`
                    + ` · slices ${(scores.sliceUsage * 100).toFixed(0)}%`
                    + ` · ${String(scores.voxels)} voxels, ${String(scores.colorsUsed)} colours`}
            </Text>
            <Button
                label='use this one'
                size='sm'
                variant='secondary'
                clickAction={onPick}
            />
        </VStack>
    )
}

export const GeneratePanel = ({editor}: {editor: EditorApi}) => {
    const {actions, snapshot} = editor
    const [prompt, setPrompt] = useState('a stone tower')
    const [count, setCount] = useState(4)
    const [busy, setBusy] = useState(false)
    const [status, setStatus] = useState('nothing generated yet')
    const [ranked, setRanked] = useState<Ranked[]>([])
    const [rankBy, setRankBy] = useState<'score' | 'clip'>('score')
    const [clipNote, setClipNote] = useState('CLIP: not asked yet')

    const run = async (): Promise<void> => {
        setBusy(true)
        setRanked([])
        setStatus(`generating 0/${String(count)}…`)
        try {
            const {candidates, failures} = await generateMany(prompt, count, {
                sampler: {temperature: 0.8},
                onProgress: (done, total) => {
                    setStatus(`generating ${String(done)}/${String(total)}…`)
                }
            })
            const scored: Ranked[] = candidates
                .map(candidate => {
                    const scores = scoreModel(candidate.voxels)
                    return {candidate, scores, overall: overallScore(scores), clip: null}
                })
                .sort((a, b) => b.overall - a.overall)
            setRanked(scored)
            setStatus(
                `${String(scored.length)} candidates, ${String(failures.length)} failed`
                    + (failures[0] ? ` — first failure: ${failures[0].slice(0, 80)}` : '')
            )

            // CLIP second, and only if the service is up: it is a second opinion on an ordering
            // that already exists, so the grid must not wait on it
            if (scored.length > 0 && (await probeScorer())) {
                setClipNote('CLIP: scoring…')
                try {
                    const clip = await scoreWithClip(
                        prompt,
                        scored.map(entry => entry.candidate.spec)
                    )
                    const withClip = scored.map((entry, i) => ({...entry, clip: clip[i] ?? null}))
                    setRanked(withClip)
                    // measured over 18 candidates: for box-shaped subjects every deterministic
                    // score comes out at exactly 1.000, so it ranks nothing. When CLIP is
                    // available it is the ordering worth showing; the deterministic score stays
                    // on each card as the check for a broken candidate. §14 has the numbers.
                    setRankBy('clip')
                    const agreement = rankAgreement(
                        withClip.map(entry => entry.overall),
                        withClip.map(entry => entry.clip)
                    )
                    setClipNote(
                        `CLIP: ${String(clip.filter(value => value !== null).length)} scored`
                            + ` · agreement with the deterministic order ${agreement.toFixed(2)}`
                    )
                } catch (error) {
                    setClipNote(`CLIP: ${error instanceof Error ? error.message : String(error)}`)
                }
            } else if (scored.length > 0) {
                setClipNote('CLIP: voxserve.py is not running — deterministic scores only')
            }
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div data-testid='generate-panel'>
            <VStack gap={2}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <div style={{width: 320}}>
                        <TextInput
                            label='prompt'
                            isLabelHidden
                            size='sm'
                            value={prompt}
                            onChange={setPrompt}
                        />
                    </div>
                    <div style={{width: 90}}>
                        <NumberInput
                            label='candidates'
                            isLabelHidden
                            size='sm'
                            min={1}
                            max={16}
                            value={count}
                            onChange={setCount}
                        />
                    </div>
                    <Button
                        label={busy ? 'generating…' : 'generate'}
                        size='sm'
                        variant='primary'
                        isDisabled={busy}
                        clickAction={run}
                    />
                </HStack>

                <HStack
                    gap={2}
                    align='center'
                >
                    <Text type='supporting'>
                        <span data-testid='generate-status'>{status}</span>
                    </Text>
                    <Text type='supporting'>
                        <span data-testid='clip-status'>{clipNote}</span>
                    </Text>
                    {(['score', 'clip'] as const).map(option => (
                        <Button
                            key={option}
                            label={option === 'score' ? 'rank by score' : 'rank by CLIP'}
                            size='sm'
                            variant={rankBy === option ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setRankBy(option)
                            }}
                        />
                    ))}
                </HStack>

                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
                        gap: 12
                    }}
                >
                    {[...ranked]
                        .sort((a, b) =>
                            rankBy === 'clip' ?
                                (b.clip ?? -Infinity) - (a.clip ?? -Infinity)
                            :   b.overall - a.overall
                        )
                        .map((entry, i) => (
                            <CandidateCard
                                key={`${entry.candidate.record.at}-${String(i)}`}
                                entry={entry}
                                rank={i}
                                onPick={() => {
                                    actions.importModel(
                                        entry.candidate.voxels,
                                        entry.candidate.spec.name,
                                        entry.candidate.record
                                    )
                                    setStatus(
                                        `loaded ${entry.candidate.spec.name}`
                                            + ` — seed ${String(entry.candidate.record.sampler.seed)},`
                                            + ` temperature ${String(entry.candidate.record.sampler.temperature)}`
                                    )
                                }}
                            />
                        ))}
                </div>

                <Text type='supporting'>
                    <span data-testid='generate-origin'>
                        {snapshot.doc.origin ?
                            `this document: "${snapshot.doc.origin.prompt}", seed ${String(snapshot.doc.origin.sampler.seed)},`
                            + ` temperature ${String(snapshot.doc.origin.sampler.temperature)}, ${snapshot.doc.origin.model}`
                        :   'this document was not generated'}
                    </span>
                </Text>
            </VStack>
        </div>
    )
}
