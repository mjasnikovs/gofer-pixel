import type {AtlasSidecar} from './atlas'

/**
 * A Godot 4 `.tres` for a sprite-stacked asset: `AtlasTexture` regions over the two sheets, an
 * `CanvasTexture` pairing each albedo region with its exact normal region, and a `SpriteFrames`
 * whose animations are the document's tags, one per baked angle.
 *
 * Pairing albedo with normal on a `CanvasTexture` is the whole point — a `Light2D` in Godot then
 * lights the sprite from the normals the renderer read off the voxel surface, which is the thing
 * this pipeline has and a hand-drawn sprite does not (`PRODUCTION_PLAN.md` §8, §11).
 *
 * The animation names are `<tag>_<angle index>`, because Godot's `AnimatedSprite2D` selects one
 * animation at a time: a game picks the clip for the direction it is facing.
 */
export interface GodotOptions {
    /** `res://` path of the albedo sheet. */
    albedoPath: string
    /** `res://` path of the normal sheet. */
    normalPath: string
    /** Frames per second for every clip. */
    fps?: number
    /** Loop every clip. */
    loop?: boolean
}

const escape = (text: string): string => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** Godot identifiers in a `.tres` are opaque, but they must be unique and stable. */
const id = (kind: string, angle: number, frame: number): string =>
    `${kind}_a${String(angle)}f${String(frame)}`

interface Clip {
    name: string
    from: number
    to: number
}

const clipsFor = (sidecar: AtlasSidecar): Clip[] =>
    sidecar.tags.length > 0 ?
        sidecar.tags.map(tag => ({name: tag.name, from: tag.from, to: tag.to}))
    :   [{name: 'default', from: 0, to: sidecar.frames - 1}]

export const godotResource = (sidecar: AtlasSidecar, options: GodotOptions): string => {
    const fps = options.fps ?? 10
    const loop = options.loop ?? true
    const lines: string[] = []
    const subs: string[] = []

    for (const rect of sidecar.rects) {
        subs.push(
            `[sub_resource type="AtlasTexture" id="${id('AlbedoTex', rect.angle, rect.frame)}"]`,
            `atlas = ExtResource("1_albedo")`,
            `region = Rect2(${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}, ${String(rect.height)})`,
            '',
            `[sub_resource type="AtlasTexture" id="${id('NormalTex', rect.angle, rect.frame)}"]`,
            `atlas = ExtResource("2_normal")`,
            `region = Rect2(${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}, ${String(rect.height)})`,
            '',
            `[sub_resource type="CanvasTexture" id="${id('Canvas', rect.angle, rect.frame)}"]`,
            `diffuse_texture = SubResource("${id('AlbedoTex', rect.angle, rect.frame)}")`,
            `normal_texture = SubResource("${id('NormalTex', rect.angle, rect.frame)}")`,
            ''
        )
    }

    const animations: string[] = []
    for (const clip of clipsFor(sidecar)) {
        for (let angle = 0; angle < sidecar.angles; angle += 1) {
            const frames: string[] = []
            for (let frame = clip.from; frame <= clip.to; frame += 1) {
                const has = sidecar.rects.some(rect => rect.angle === angle && rect.frame === frame)
                if (has) {
                    frames.push(
                        `{\n"duration": 1.0,\n"texture": SubResource("${id('Canvas', angle, frame)}")\n}`
                    )
                }
            }
            if (frames.length === 0) {
                continue
            }
            animations.push(
                `{\n"frames": [${frames.join(', ')}],\n"loop": ${loop ? 'true' : 'false'},`
                    + `\n"name": &"${escape(clip.name)}_${String(angle)}",\n"speed": ${fps.toFixed(1)}\n}`
            )
        }
    }

    // load_steps counts the resources the file references: two textures plus three sub-resources
    // per rect, plus the resource itself
    const steps = 2 + sidecar.rects.length * 3 + 1
    lines.push(
        `[gd_resource type="SpriteFrames" load_steps=${String(steps)} format=3]`,
        '',
        `[ext_resource type="Texture2D" path="${escape(options.albedoPath)}" id="1_albedo"]`,
        `[ext_resource type="Texture2D" path="${escape(options.normalPath)}" id="2_normal"]`,
        '',
        ...subs,
        '[resource]',
        `animations = [${animations.join(', ')}]`,
        ''
    )
    return lines.join('\n')
}

/**
 * The companion `.tres` for a still: one `CanvasTexture` over the whole sheet pair, for an asset
 * used as a plain `Sprite2D` with a `Light2D` rather than through `AnimatedSprite2D`.
 */
export const godotCanvasTexture = (options: GodotOptions): string =>
    [
        '[gd_resource type="CanvasTexture" load_steps=3 format=3]',
        '',
        `[ext_resource type="Texture2D" path="${escape(options.albedoPath)}" id="1_albedo"]`,
        `[ext_resource type="Texture2D" path="${escape(options.normalPath)}" id="2_normal"]`,
        '',
        '[resource]',
        'diffuse_texture = ExtResource("1_albedo")',
        'normal_texture = ExtResource("2_normal")',
        ''
    ].join('\n')
