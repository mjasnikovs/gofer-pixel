import {useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/HStack'
import {NumberInput} from '@astryxdesign/core/NumberInput'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {VStack} from '@astryxdesign/core/VStack'
import {bakeRig, mirrorBone, poseAt, type Bone, type Rig} from '../anim/rig'
import type {Editor as EditorApi} from './useEditor'

/**
 * Tier 2 animation (`PRODUCTION_PLAN.md` §10): bones that move voxels in whole-voxel steps.
 *
 * The rig lives in the editor's state, not in the document — a rig is authoring scaffolding and
 * the baked frames are the asset, so the project file stays at version 2 until there is a reason
 * to carry rigs across sessions. It is held one level up so that stepping out to the frame bar and
 * back does not throw the bones away. Baking is an ordinary undoable edit like everything else.
 */
const axisLabels = ['x0', 'x1', 'y0', 'y1', 'z0', 'z1'] as const

export const RigPanel = ({
    editor,
    rig,
    setRig
}: {
    editor: EditorApi
    rig: Rig
    setRig: React.Dispatch<React.SetStateAction<Rig>>
}) => {
    const {snapshot, mutate} = editor
    const {doc, frame} = snapshot
    const [name, setName] = useState('arm')
    const [offset, setOffset] = useState<[number, number, number]>([0, 0, 0])
    const [selected, setSelected] = useState(0)
    const [count, setCount] = useState(4)
    const [status, setStatus] = useState('no bones yet')

    const bone = rig.bones[selected]

    const patchBone = (index: number, patch: Partial<Bone>): void => {
        setRig(current => ({
            bones: current.bones.map((entry, i) => (i === index ? {...entry, ...patch} : entry))
        }))
    }

    const addBone = (): void => {
        const fresh: Bone = {
            name: name || `bone ${String(rig.bones.length + 1)}`,
            box: {
                x0: 0,
                y0: 0,
                z0: 0,
                x1: Math.max(0, Math.floor(doc.size.sx / 2) - 1),
                y1: doc.size.sy - 1,
                z1: doc.size.sz - 1
            },
            keys: [{frame: 0, offset: [0, 0, 0]}]
        }
        setRig(current => ({bones: [...current.bones, fresh]}))
        setSelected(rig.bones.length)
        setStatus(`added ${fresh.name}`)
    }

    const setKey = (hidden: boolean): void => {
        if (!bone) {
            return
        }
        const keys = [
            ...bone.keys.filter(key => key.frame !== frame),
            {frame, offset: [...offset] as [number, number, number], ...(hidden ? {hidden} : {})}
        ].sort((a, b) => a.frame - b.frame)
        patchBone(selected, {keys})
        setStatus(
            `${bone.name}: key at frame ${String(frame + 1)}`
                + ` → ${offset.join(',')}${hidden ? ' (hidden)' : ''}`
        )
    }

    const bake = (): void => {
        mutate('bake rig', current => bakeRig(current, rig, count))
        setStatus(`baked ${String(count)} frames from ${String(rig.bones.length)} bones`)
    }

    return (
        <div data-testid='rig-panel'>
            <VStack gap={2}>
                <HStack
                    gap={2}
                    align='center'
                >
                    <div style={{width: 130}}>
                        <TextInput
                            label='bone name'
                            isLabelHidden
                            size='sm'
                            value={name}
                            onChange={setName}
                        />
                    </div>
                    <Button
                        label='+ bone'
                        size='sm'
                        variant='secondary'
                        clickAction={addBone}
                    />
                    {rig.bones.map((entry, i) => (
                        <Button
                            key={entry.name}
                            label={entry.name}
                            size='sm'
                            variant={i === selected ? 'primary' : 'secondary'}
                            clickAction={() => {
                                setSelected(i)
                            }}
                        />
                    ))}
                </HStack>

                {bone ?
                    <>
                        <HStack
                            gap={1}
                            align='center'
                        >
                            <Text type='supporting'>box</Text>
                            {axisLabels.map(key => (
                                <div
                                    key={key}
                                    style={{width: 74}}
                                >
                                    <NumberInput
                                        label={key}
                                        isLabelHidden
                                        size='sm'
                                        min={0}
                                        value={bone.box[key]}
                                        onChange={value => {
                                            patchBone(selected, {
                                                box: {...bone.box, [key]: value}
                                            })
                                        }}
                                    />
                                </div>
                            ))}
                            <Button
                                label={bone.mirrorX === true ? 'mirror x: on' : 'mirror x: off'}
                                size='sm'
                                variant={bone.mirrorX === true ? 'primary' : 'secondary'}
                                clickAction={() => {
                                    patchBone(selected, {mirrorX: bone.mirrorX !== true})
                                }}
                            />
                            <Button
                                label='+ mirrored copy'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    setRig(current => ({
                                        bones: [...current.bones, mirrorBone(bone, doc.size)]
                                    }))
                                }}
                            />
                        </HStack>

                        <HStack
                            gap={1}
                            align='center'
                        >
                            <Text type='supporting'>offset</Text>
                            {[0, 1, 2].map(axis => (
                                <div
                                    key={axis}
                                    style={{width: 74}}
                                >
                                    <NumberInput
                                        label={['dx', 'dy', 'dz'][axis] ?? 'd'}
                                        isLabelHidden
                                        size='sm'
                                        value={offset[axis] ?? 0}
                                        onChange={value => {
                                            setOffset(current => {
                                                const next: [number, number, number] = [...current]
                                                next[axis] = value
                                                return next
                                            })
                                        }}
                                    />
                                </div>
                            ))}
                            <Button
                                label={`key at frame ${String(frame + 1)}`}
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    setKey(false)
                                }}
                            />
                            <Button
                                label='hide key'
                                size='sm'
                                variant='secondary'
                                clickAction={() => {
                                    setKey(true)
                                }}
                            />
                        </HStack>

                        <Text type='supporting'>
                            <span data-testid='rig-keys'>
                                {bone.keys.length === 0 ?
                                    'no keys'
                                :   bone.keys
                                        .map(
                                            key =>
                                                `f${String(key.frame + 1)}:${key.offset.join(',')}${key.hidden === true ? '·hidden' : ''}`
                                        )
                                        .join('  ')
                                }
                            </span>
                        </Text>
                        <Text type='supporting'>
                            <span data-testid='rig-pose'>
                                {`pose at frame ${String(frame + 1)}: ${poseAt(bone, frame).offset.join(',')}`}
                            </span>
                        </Text>
                    </>
                :   <Text type='supporting'>add a bone to start</Text>}

                <HStack
                    gap={2}
                    align='center'
                >
                    <div style={{width: 90}}>
                        <NumberInput
                            label='frames'
                            isLabelHidden
                            size='sm'
                            min={2}
                            max={64}
                            value={count}
                            onChange={setCount}
                        />
                    </div>
                    <Button
                        label='bake to frames'
                        size='sm'
                        variant='primary'
                        isDisabled={rig.bones.length === 0}
                        clickAction={bake}
                    />
                </HStack>

                <Text type='supporting'>
                    <span data-testid='rig-status'>{status}</span>
                </Text>
            </VStack>
        </div>
    )
}
