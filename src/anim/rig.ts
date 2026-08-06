import {EMPTY} from '../vox/palette'
import {Volume} from '../doc/volume'
import {celAt, addFrame, editCel, type Document} from '../doc/document'
import type {Box3} from '../editor/select3d'
import type {GridSize} from '../vox/grid'

/**
 * Tier 2 of `PRODUCTION_PLAN.md` §10: a rig whose bones move voxels in **whole-voxel steps**, so
 * the grid look survives the animation.
 *
 * The plan gated this on tier 1 proving the export maths, which it has — frames × angles come out
 * of `src/export/atlas.ts` with tags intact. §14 also records that there was no technical detail
 * on how whole-voxel skinning behaves, so this is deliberately the smallest thing that is honestly
 * a rig rather than a guess at a full skinning system:
 *
 * - A bone owns a box of the rest-pose volume. Boxes are disjoint by construction — the last bone
 *   to claim a voxel wins — because weighted skinning has no meaning on a grid where a voxel is
 *   either in a place or not.
 * - A keyframe is an integer offset and a visibility flag. Between keyframes the offset is
 *   interpolated and then **rounded**, which is the whole point: the in-between poses land on the
 *   grid instead of smearing across it.
 * - Mirroring is a per-bone flag that reflects the offset in x, so a walk cycle is authored once.
 */
export interface BoneKey {
    /** Frame this key applies at. */
    frame: number
    /** Whole-voxel offset from the rest pose. */
    offset: [number, number, number]
    /** Hide the bone's voxels entirely on this key. */
    hidden?: boolean
}

export interface Bone {
    name: string
    box: Box3
    keys: BoneKey[]
    /** Reflect this bone's x offset, for the mirrored half of a cycle. */
    mirrorX?: boolean
}

export interface Rig {
    bones: Bone[]
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * The pose of one bone at a fractional frame.
 *
 * Rounding after interpolating is what keeps the model on the grid. Rounding each component
 * independently is correct here: a voxel model has no sub-voxel diagonal to preserve.
 */
export const poseAt = (
    bone: Bone,
    frame: number
): {offset: [number, number, number]; hidden: boolean} => {
    const keys = [...bone.keys].sort((a, b) => a.frame - b.frame)
    const first = keys[0]
    if (!first) {
        return {offset: [0, 0, 0], hidden: false}
    }
    if (frame <= first.frame) {
        return {offset: [...first.offset], hidden: first.hidden ?? false}
    }
    const last = keys[keys.length - 1]
    if (!last || frame >= last.frame) {
        return {offset: [...(last ?? first).offset], hidden: (last ?? first).hidden ?? false}
    }

    for (let i = 1; i < keys.length; i += 1) {
        const a = keys[i - 1]
        const b = keys[i]
        if (!a || !b || frame > b.frame) {
            continue
        }
        const span = b.frame - a.frame
        const t = span === 0 ? 0 : (frame - a.frame) / span
        const sign = bone.mirrorX === true ? -1 : 1
        return {
            offset: [
                Math.round(lerp(a.offset[0], b.offset[0], t)) * sign,
                Math.round(lerp(a.offset[1], b.offset[1], t)),
                Math.round(lerp(a.offset[2], b.offset[2], t))
            ],
            // visibility does not interpolate: a bone is shown or it is not, and the key it is
            // travelling *from* is the one that decides
            hidden: a.hidden ?? false
        }
    }
    return {offset: [...first.offset], hidden: first.hidden ?? false}
}

const inBox = (box: Box3, x: number, y: number, z: number): boolean =>
    x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1

/**
 * One posed volume from the rest pose.
 *
 * Voxels outside every bone stay where they are, so a rig can cover an arm and leave the body
 * alone without anybody having to name a "root" bone for the rest of the model.
 */
export const poseVolume = (rest: Volume, rig: Rig, frame: number, size: GridSize): Volume => {
    const out = new Volume()
    const poses = rig.bones.map(bone => ({bone, pose: poseAt(bone, frame)}))

    rest.forEach((x, y, z, color) => {
        if (color === EMPTY) {
            return
        }
        const owner = poses.find(({bone}) => inBox(bone.box, x, y, z))
        if (!owner) {
            out.set(x, y, z, color)
            return
        }
        if (owner.pose.hidden) {
            return
        }
        const [dx, dy, dz] = owner.pose.offset
        const nx = x + dx
        const ny = y + dy
        const nz = z + dz
        if (nx >= 0 && ny >= 0 && nz >= 0 && nx < size.sx && ny < size.sy && nz < size.sz) {
            out.set(nx, ny, nz, color)
        }
    })
    return out
}

/**
 * Bake a rig into frames.
 *
 * `frame 0` of the document is the rest pose and stays untouched; frames 1…`count-1` are poses of
 * it. This is SpriteStack's model — author a few keys, export as many frames as the game wants —
 * and it is why the count is a parameter rather than the number of keys.
 */
export const bakeRig = (doc: Document, rig: Rig, count: number, layer = 0): Document => {
    const rest = celAt(doc, layer, 0)
    if (!rest || count < 1) {
        return doc
    }
    let out = doc
    while (out.frames < count) {
        out = addFrame(out)
    }
    for (let frame = 1; frame < count; frame += 1) {
        const posed = poseVolume(rest, rig, frame, doc.size)
        out = editCel(out, layer, frame, volume => {
            // collect before erasing: mutating a volume while walking it is asking for trouble
            const occupied: [number, number, number][] = []
            volume.forEach((x, y, z) => {
                occupied.push([x, y, z])
            })
            for (const [x, y, z] of occupied) {
                volume.set(x, y, z, EMPTY)
            }
            posed.forEach((x, y, z, color) => {
                volume.set(x, y, z, color)
            })
        })
    }
    return out
}

/** A bone's mirror image about the canvas centre, for the other half of a cycle. */
export const mirrorBone = (bone: Bone, size: GridSize, name = `${bone.name} mirrored`): Bone => ({
    name,
    box: {
        ...bone.box,
        x0: size.sx - 1 - bone.box.x1,
        x1: size.sx - 1 - bone.box.x0
    },
    keys: bone.keys.map(key => ({
        ...key,
        offset: [-key.offset[0], key.offset[1], key.offset[2]] as [number, number, number]
    })),
    ...(bone.mirrorX === undefined ? {} : {mirrorX: bone.mirrorX})
})
