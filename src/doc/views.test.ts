import {expect, test} from 'bun:test'
import type {Camera} from '../render/camera'
import {createVolume} from '../render/volume'
import {directions, eightDirections} from './cameras'
import {
    captureView,
    duplicateView,
    opening,
    removeView,
    reorderView,
    resetViews,
    showView,
    startViews,
    viewNamed,
    type Views
} from './views'

const volume = (): ReturnType<typeof createVolume> =>
    createVolume(16, 16, 16, new Uint8Array(256 * 4))

const start = (): Views => startViews(eightDirections(volume()))

/** Any camera at all — every test here is about the list, never about the transform. */
const someCamera = (): Camera => ({yaw: 0.4, pitch: 0.3, zoom: 20, panX: 0, panY: 0})

const ids = (views: Views): string[] => views.cameras.map(({id}) => id)

test('a fresh set opens on the three-quarter view, not the elevation', () => {
    const views = start()
    expect(views.selected).toBe('dir-1')
    expect(views.previewed).toBe('dir-1')
    expect(opening(views.cameras)?.name).toBe('Front Right')
    // Nothing was minted, so the counter has nothing to count.
    expect(views.serial).toBe(0)
})

test('the serial is read off the ids, so a reopened document does not re-mint one', () => {
    const camera = someCamera()
    const reopened = startViews([
        {id: 'cam-3', name: 'Camera 3', camera},
        {id: 'cam-7', name: 'Camera 7', camera}
    ])
    expect(reopened.serial).toBe(7)
    expect(captureView(reopened, camera).cameras.at(-1)?.id).toBe('cam-8')
})

test('capture points both fields at what it just made', () => {
    const views = captureView(start(), someCamera())
    expect(views.serial).toBe(1)
    expect(views.cameras).toHaveLength(9)
    expect(views.selected).toBe('cam-1')
    expect(views.previewed).toBe('cam-1')
})

test('duplicate copies the selected camera and does nothing without one', () => {
    const views = duplicateView(start())
    expect(views.cameras.at(-1)?.name).toBe('Front Right copy')
    expect(views.selected).toBe('cam-1')
    // The transform is copied, not shared: two entries pointing at one camera is an instance.
    expect(views.cameras.at(-1)?.camera).toEqual(views.cameras[1]?.camera)

    const orbited = showView(start(), undefined)
    expect(duplicateView(orbited)).toBe(orbited)
})

/**
 * The invariant the eight reducer cases used to keep by hand, stated once. `selected` is a claim
 * about the view and a claim about a camera that is gone is false; `previewed` has to point at
 * something or the render panel shows its empty message beside seven perfectly good cameras.
 */
test('neither pointer can name a camera that is not on the list', () => {
    const views = removeView(showView(start(), 'dir-1'), 'dir-1')
    expect(ids(views)).not.toContain('dir-1')
    expect(views.selected).toBeUndefined()
    expect(views.previewed).toBe('dir-0')
})

test('removing a camera nobody is pointing at moves neither pointer', () => {
    const views = removeView(start(), 'dir-5')
    expect(views.selected).toBe('dir-1')
    expect(views.previewed).toBe('dir-1')
    expect(removeView(views, 'nothing-here')).toBe(views)
})

test('an orbit clears the highlight and leaves the render panel alone', () => {
    const views = showView(start(), undefined)
    expect(views.selected).toBeUndefined()
    expect(views.previewed).toBe('dir-1')
})

test('a new ring of directions opens on its own three-quarter view', () => {
    const views = resetViews(captureView(start(), someCamera()), directions(volume(), 4))
    expect(ids(views)).toEqual(['dir-0', 'dir-1', 'dir-2', 'dir-3'])
    expect(views.selected).toBe('dir-1')
    // The counter does not go backwards, whatever the new list is called.
    expect(views.serial).toBe(1)
})

test('reordering moves the row and neither pointer', () => {
    const views = reorderView(start(), 'dir-6', 0)
    expect(ids(views)[0]).toBe('dir-6')
    expect(views.selected).toBe('dir-1')
    expect(reorderView(views, 'dir-6', 0)).toBe(views)
    expect(reorderView(views, 'gone', 2)).toBe(views)
})

test('a drop past the end lands at the end rather than off it', () => {
    expect(ids(reorderView(start(), 'dir-0', 99)).at(-1)).toBe('dir-0')
})

test('viewNamed answers only for cameras that are there', () => {
    expect(viewNamed(start(), 'dir-2')?.name).toBe('Right')
    expect(viewNamed(start(), 'dir-99')).toBeUndefined()
    expect(viewNamed(start(), undefined)).toBeUndefined()
})
