import type {Cell} from './selection'

/**
 * The tape between two voxels, and the one place its numbers come from.
 *
 * Measure is the only tool on the rail that changes nothing, so there is no draft, no history and no
 * `writeBlock` to hold it honest. What it has instead is a number on screen, and the failure mode is
 * the same one the rest of `doc/` is built against: **the box the overlay draws and the size the bar
 * reads have to be the same answer**. Both come out of `measured` below, once, so a tape cannot be
 * outlined three voxels wide while the bar says four.
 *
 * The decision worth writing down is what "how far apart" means, because there are two honest
 * answers and picking the wrong one makes every reading off by one:
 *
 * - **The size is inclusive.** Grabbing the bottom voxel of a four-tall leg and dragging to the top
 *   one reads 4, not 3 — the count of voxels an artist would get by eye, and the number that goes in
 *   a sprite budget. One voxel is one voxel wide, so no axis ever reads zero.
 * - **The diagonal is not.** It is centre to centre, which is a length rather than a count, and a
 *   `+ 1` on it would be arithmetic about nothing. Two ends on the same voxel are zero apart.
 *
 * They disagree deliberately, and the tooltip in the hint bar is where that is said to the artist.
 */

export interface Span {
    /** The voxel the press landed on. One end of the tape, and it does not move. */
    readonly from: Cell
    /** The voxel under the cursor. Equal to `from` for a press that has not been dragged. */
    readonly to: Cell
    /**
     * Whether the button is still down.
     *
     * A settled tape stays on screen, which is the whole gesture: a measurement that vanished on
     * release would have to be held in the head to be of any use. It is the flag rather than a
     * second field because the two are the same value — see `pointerAt`, which reads it to decide
     * whether a move belongs to this gesture or is just the pointer wandering.
     */
    readonly live: boolean
}

/** A tape with one end down, which is what a press makes. */
export const beganSpan = (from: Cell): Span => ({from, to: from, live: true})

/** What a tape says, derived once so the picture and the readout cannot disagree. */
export interface Measured {
    /** The integer cell box the two ends span, inclusive — what the overlay outlines. */
    readonly box: {min: Cell; max: Cell}
    /** Voxels across that box, per axis. Never zero. */
    readonly size: Cell
    /** Centre to centre, in voxels. Zero when both ends are the same voxel. */
    readonly diagonal: number
}

export const measured = ({from, to}: Span): Measured => {
    const min: Cell = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])]
    const max: Cell = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])]
    return {
        box: {min, max},
        size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1],
        diagonal: Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    }
}
