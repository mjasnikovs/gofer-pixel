import {EMPTY} from '../vox/palette'
import {Vox, type GridSize} from '../vox/grid'

/**
 * Copy-on-write chunked volume — the document's storage.
 *
 * Goxel's structure, with one change. Goxel uses 16³ blocks and manual reference counts, which
 * needs an explicit free that a garbage-collected language cannot guarantee. Instead each chunk
 * names the one volume allowed to write it in place; cloning revokes that claim, so the first
 * write after a clone copies and every later write to the same chunk is in place. Dropping a
 * volume on the floor is then safe: nothing has to be released, and nothing can be corrupted.
 *
 * 8³ rather than 16³ because the models here are 16³–64³. At 16³ a 32³ sprite is eight chunks,
 * so a one-voxel edit copies an eighth of the model; at 8³ it copies a sixty-fourth.
 * `volume.test.ts` measures this rather than asserting it.
 */
export const CHUNK_BITS = 3
export const CHUNK_SIZE = 1 << CHUNK_BITS
const CHUNK_MASK = CHUNK_SIZE - 1
const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE

/** Chunk coordinates are packed into a 1024³ space, so a volume spans 8192 voxels per axis. */
const CHUNK_STRIDE = 1024
export const MAX_COORD = CHUNK_STRIDE * CHUNK_SIZE

interface Chunk {
    data: Uint8Array
    /** Non-empty cells. Kept incrementally so `count` and emptiness are O(chunks), not O(voxels). */
    used: number
    /** The only volume permitted to write `data` in place. Null means shared, so copy first. */
    owner: Volume | null
}

const chunkKey = (cx: number, cy: number, cz: number): number =>
    (cx * CHUNK_STRIDE + cy) * CHUNK_STRIDE + cz

const cellIndex = (x: number, y: number, z: number): number =>
    (((z & CHUNK_MASK) << CHUNK_BITS) + (y & CHUNK_MASK)) * CHUNK_SIZE + (x & CHUNK_MASK)

export interface Bounds {
    x0: number
    y0: number
    z0: number
    x1: number
    y1: number
    z1: number
}

export class Volume {
    private chunks = new Map<number, Chunk>()

    static inRange(x: number, y: number, z: number): boolean {
        return x >= 0 && y >= 0 && z >= 0 && x < MAX_COORD && y < MAX_COORD && z < MAX_COORD
    }

    /** Dense grid to volume. The bridge from the generator side of the codebase. */
    static fromVox(vox: Vox): Volume {
        const volume = new Volume()
        for (let z = 0; z < vox.sz; z += 1) {
            for (let y = 0; y < vox.sy; y += 1) {
                for (let x = 0; x < vox.sx; x += 1) {
                    volume.set(x, y, z, vox.get(x, y, z))
                }
            }
        }
        return volume
    }

    get(x: number, y: number, z: number): number {
        if (!Volume.inRange(x, y, z)) {
            return EMPTY
        }
        const chunk = this.chunks.get(chunkKey(x >> CHUNK_BITS, y >> CHUNK_BITS, z >> CHUNK_BITS))
        return chunk?.data[cellIndex(x, y, z)] ?? EMPTY
    }

    /** Returns whether the cell changed, so callers can skip work on a no-op stroke. */
    set(x: number, y: number, z: number, color: number): boolean {
        if (!Volume.inRange(x, y, z)) {
            return false
        }
        const key = chunkKey(x >> CHUNK_BITS, y >> CHUNK_BITS, z >> CHUNK_BITS)
        const existing = this.chunks.get(key)
        if (!existing) {
            if (color === EMPTY) {
                return false
            }
            const chunk: Chunk = {data: new Uint8Array(CHUNK_CELLS), used: 1, owner: this}
            chunk.data[cellIndex(x, y, z)] = color
            this.chunks.set(key, chunk)
            return true
        }

        const index = cellIndex(x, y, z)
        const previous = existing.data[index] ?? EMPTY
        if (previous === color) {
            return false
        }
        const chunk = existing.owner === this ? existing : this.own(key, existing)
        chunk.data[index] = color
        chunk.used += (color === EMPTY ? 0 : 1) - (previous === EMPTY ? 0 : 1)
        if (chunk.used === 0) {
            this.chunks.delete(key)
        }
        return true
    }

    private own(key: number, shared: Chunk): Chunk {
        const chunk: Chunk = {data: new Uint8Array(shared.data), used: shared.used, owner: this}
        this.chunks.set(key, chunk)
        return chunk
    }

    /**
     * Share every chunk with the copy. Nearly free — no voxel data is touched, only the write
     * claims are revoked, which is what makes snapshot undo affordable.
     */
    clone(): Volume {
        const copy = new Volume()
        for (const [key, chunk] of this.chunks) {
            chunk.owner = null
            copy.chunks.set(key, chunk)
        }
        return copy
    }

    get count(): number {
        let n = 0
        for (const chunk of this.chunks.values()) {
            n += chunk.used
        }
        return n
    }

    get chunkCount(): number {
        return this.chunks.size
    }

    get isEmpty(): boolean {
        return this.chunks.size === 0
    }

    /** Tight box around the non-empty voxels, or null when there are none. */
    bounds(): Bounds | null {
        let x0 = Infinity
        let y0 = Infinity
        let z0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        let z1 = -Infinity
        this.forEach((x, y, z) => {
            x0 = Math.min(x0, x)
            y0 = Math.min(y0, y)
            z0 = Math.min(z0, z)
            x1 = Math.max(x1, x)
            y1 = Math.max(y1, y)
            z1 = Math.max(z1, z)
        })
        return x1 < x0 ? null : {x0, y0, z0, x1, y1, z1}
    }

    /**
     * Every non-empty voxel, z ascending.
     *
     * Ascending z is the part that is load-bearing — the renderer paints in this order, so a
     * lower slice must never arrive after a higher one. Within a single z the order is fixed but
     * arbitrary (chunk row, then column), which is no weaker than the .vox file order the
     * renderers already accept.
     */
    forEach(visit: (x: number, y: number, z: number, color: number) => void): void {
        const bands = new Map<number, number[]>()
        for (const key of this.chunks.keys()) {
            const cz = key % CHUNK_STRIDE
            const band = bands.get(cz)
            if (band) {
                band.push(key)
            } else {
                bands.set(cz, [key])
            }
        }

        for (const cz of [...bands.keys()].sort((a, b) => a - b)) {
            const keys = (bands.get(cz) ?? []).sort((a, b) => a - b)
            for (let z = 0; z < CHUNK_SIZE; z += 1) {
                for (const key of keys) {
                    const chunk = this.chunks.get(key)
                    if (!chunk) {
                        continue
                    }
                    const ox = Math.floor(key / (CHUNK_STRIDE * CHUNK_STRIDE)) * CHUNK_SIZE
                    const oy = (Math.floor(key / CHUNK_STRIDE) % CHUNK_STRIDE) * CHUNK_SIZE
                    for (let y = 0; y < CHUNK_SIZE; y += 1) {
                        const row = ((z << CHUNK_BITS) + y) * CHUNK_SIZE
                        for (let x = 0; x < CHUNK_SIZE; x += 1) {
                            const color = chunk.data[row + x] ?? EMPTY
                            if (color !== EMPTY) {
                                visit(ox + x, oy + y, cz * CHUNK_SIZE + z, color)
                            }
                        }
                    }
                }
            }
        }
    }

    /** Paint an inclusive box. One call per drag, not one per voxel — see `editCel`. */
    fillBox(box: Bounds, color: number): number {
        let n = 0
        for (let z = Math.min(box.z0, box.z1); z <= Math.max(box.z0, box.z1); z += 1) {
            for (let y = Math.min(box.y0, box.y1); y <= Math.max(box.y0, box.y1); y += 1) {
                for (let x = Math.min(box.x0, box.x1); x <= Math.max(box.x0, box.x1); x += 1) {
                    if (this.set(x, y, z, color)) {
                        n += 1
                    }
                }
            }
        }
        return n
    }

    /** Copy every non-empty voxel of `other` in, shifted by the offset. */
    paste(other: Volume, dx = 0, dy = 0, dz = 0): void {
        other.forEach((x, y, z, color) => {
            this.set(x + dx, y + dy, z + dz, color)
        })
    }

    toVox(size: GridSize): Vox {
        const vox = new Vox(size)
        this.forEach((x, y, z, color) => {
            vox.set(x, y, z, color)
        })
        return vox
    }

    /** @internal — for `uniqueChunkBytes`. */
    collectChunks(into: Set<object>): void {
        for (const chunk of this.chunks.values()) {
            into.add(chunk)
        }
    }
}

/**
 * Voxel bytes actually held by a set of volumes, counting a shared chunk once.
 *
 * Summing volumes one at a time would report an undo stack as hundreds of times larger than it
 * is, which is exactly the number the history cap must not get wrong.
 */
export const uniqueChunkBytes = (volumes: Iterable<Volume>): number => {
    const seen = new Set<object>()
    for (const volume of volumes) {
        volume.collectChunks(seen)
    }
    return seen.size * CHUNK_CELLS
}
