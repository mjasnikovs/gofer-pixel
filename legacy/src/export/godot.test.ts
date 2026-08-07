import {describe, expect, test} from 'bun:test'
import {addFrame, addTag, createDocument, editCel, type Document} from '../doc/document'
import {PALETTE} from '../vox/palette'
import {packAtlas} from './atlas'
import {godotCanvasTexture, godotResource} from './godot'

/**
 * The structure here was checked against a real engine, not only against the documentation:
 * Godot 4.7.1 headless loaded the generated `.tres` and reported a `SpriteFrames` with one
 * animation per angle, each frame a `CanvasTexture` whose diffuse is an `AtlasTexture` and whose
 * normal is set. `PRODUCTION_PLAN.md` §14 records that as settled.
 */
const build = (): Document => {
    let doc = createDocument({size: {sx: 6, sy: 6, sz: 3}, palette: PALETTE, name: 'car'})
    doc = editCel(doc, 0, 0, volume => {
        volume.fillBox({x0: 1, y0: 1, z0: 0, x1: 4, y1: 4, z1: 1}, 4)
    })
    doc = addFrame(doc)
    doc = editCel(doc, 0, 1, volume => {
        volume.fillBox({x0: 2, y0: 2, z0: 0, x1: 3, y1: 3, z1: 2}, 6)
    })
    return addTag(doc, {name: 'idle', from: 0, to: 1})
}

const paths = {albedoPath: 'res://car.png', normalPath: 'res://car_n.png'}

describe('godotResource', () => {
    const sidecar = packAtlas(build(), {angles: 4, scale: 2}).sidecar
    const text = godotResource(sidecar, paths)

    test('declares a SpriteFrames with both sheets as external resources', () => {
        expect(text.startsWith('[gd_resource type="SpriteFrames"')).toBe(true)
        expect(text).toContain('[ext_resource type="Texture2D" path="res://car.png" id="1_albedo"]')
        expect(text).toContain(
            '[ext_resource type="Texture2D" path="res://car_n.png" id="2_normal"]'
        )
    })

    test('one AtlasTexture pair and one CanvasTexture per sprite', () => {
        const count = (needle: string): number => text.split(needle).length - 1
        expect(count('[sub_resource type="AtlasTexture"')).toBe(sidecar.rects.length * 2)
        expect(count('[sub_resource type="CanvasTexture"')).toBe(sidecar.rects.length)
        expect(count('normal_texture = SubResource(')).toBe(sidecar.rects.length)
    })

    test('regions match the sidecar rects exactly', () => {
        for (const rect of sidecar.rects) {
            expect(text).toContain(
                `region = Rect2(${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}, ${String(rect.height)})`
            )
        }
    })

    test('one animation per tag per angle, named for both', () => {
        for (let angle = 0; angle < sidecar.angles; angle += 1) {
            expect(text).toContain(`"name": &"idle_${String(angle)}"`)
        }
        expect(text.split('"name": &"').length - 1).toBe(sidecar.angles)
    })

    test('a document with no tags still exports a default clip', () => {
        const untagged = packAtlas({...build(), tags: []}, {angles: 2, scale: 1}).sidecar
        expect(godotResource(untagged, paths)).toContain('"name": &"default_0"')
    })

    test('load_steps counts what the file references', () => {
        const declared = /load_steps=(\d+)/.exec(text)?.[1]
        expect(Number(declared)).toBe(2 + sidecar.rects.length * 3 + 1)
    })
})

describe('godotCanvasTexture', () => {
    test('pairs the two sheets for a plain Sprite2D', () => {
        const text = godotCanvasTexture(paths)
        expect(text.startsWith('[gd_resource type="CanvasTexture"')).toBe(true)
        expect(text).toContain('diffuse_texture = ExtResource("1_albedo")')
        expect(text).toContain('normal_texture = ExtResource("2_normal")')
    })
})
