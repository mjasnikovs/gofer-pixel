import type {Axis} from '../doc/brush'

/**
 * The four drawing planes, named — `FEATURESET.md` §5.
 *
 * "Face" is the default and means the canvas is whatever surface the cursor is on, which is where a
 * stroke pins itself anyway; the other three override that with a plane of the grid.
 *
 * Its own file because two panels read it and neither may export it. `BrushPanel` draws the chooser
 * and `ScenePanel` borrows the labels to title a dropped reference picture by the plane it lies on;
 * a constant exported from either would break fast refresh for the whole panel. One table, so
 * "what is plane 1 called" has one answer.
 */
export const PLANES: readonly {axis: Axis | undefined; label: string; title: string}[] = [
    {axis: undefined, label: 'Face', title: 'Draw on the face under the cursor'},
    {axis: 0, label: 'YZ', title: 'Lock drawing to the YZ plane'},
    {axis: 1, label: 'XZ', title: 'Lock drawing to the XZ plane'},
    {axis: 2, label: 'XY', title: 'Lock drawing to the XY plane'}
]
