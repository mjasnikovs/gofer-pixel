import {EMPTY} from './palette'

export interface GridSize {
    sx: number
    sy: number
    sz: number
}

/**
 * Dense voxel grid, one palette index per cell.
 *
 * The Python original used a dict keyed by (x, y, z) because a sparse model is mostly empty.
 * A flat typed array wins here anyway: 32³ is 32 KB, and every renderer walks the grid in
 * order rather than looking cells up at random.
 */
export class Vox {
    readonly sx: number
    readonly sy: number
    readonly sz: number
    readonly cells: Uint8Array

    constructor({sx = 16, sy = 16, sz = 16}: Partial<GridSize> = {}) {
        this.sx = sx
        this.sy = sy
        this.sz = sz
        this.cells = new Uint8Array(sx * sy * sz)
    }

    inBounds(x: number, y: number, z: number): boolean {
        return x >= 0 && x < this.sx && y >= 0 && y < this.sy && z >= 0 && z < this.sz
    }

    private index(x: number, y: number, z: number): number {
        return (z * this.sy + y) * this.sx + x
    }

    set(x: number, y: number, z: number, color: number): void {
        if (this.inBounds(x, y, z)) {
            this.cells[this.index(x, y, z)] = color
        }
    }

    get(x: number, y: number, z: number): number {
        return this.inBounds(x, y, z) ? (this.cells[this.index(x, y, z)] ?? EMPTY) : EMPTY
    }

    get filled(): number {
        let n = 0
        for (const c of this.cells) {
            if (c !== EMPTY) {
                n += 1
            }
        }
        return n
    }

    box(
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
        color: number
    ): number {
        let n = 0
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
            for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
                for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1) {
                    if (this.inBounds(x, y, z)) {
                        this.set(x, y, z, color)
                        n += 1
                    }
                }
            }
        }
        return n
    }

    ellipsoid(
        cx: number,
        cy: number,
        cz: number,
        rx: number,
        ry: number,
        rz: number,
        color: number
    ): number {
        let n = 0
        for (let x = 0; x < this.sx; x += 1) {
            for (let y = 0; y < this.sy; y += 1) {
                for (let z = 0; z < this.sz; z += 1) {
                    const dx = (x - cx) / Math.max(rx, 0.5)
                    const dy = (y - cy) / Math.max(ry, 0.5)
                    const dz = (z - cz) / Math.max(rz, 0.5)
                    if (dx * dx + dy * dy + dz * dz <= 1) {
                        this.set(x, y, z, color)
                        n += 1
                    }
                }
            }
        }
        return n
    }

    cylinderZ(cx: number, cy: number, z0: number, z1: number, r: number, color: number): number {
        let n = 0
        for (let x = 0; x < this.sx; x += 1) {
            for (let y = 0; y < this.sy; y += 1) {
                if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
                    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 1) {
                        if (this.inBounds(x, y, z)) {
                            this.set(x, y, z, color)
                            n += 1
                        }
                    }
                }
            }
        }
        return n
    }

    /** Mirror the x < sx/2 half onto the other side. Guarantees symmetry. */
    mirrorX(): number {
        let n = 0
        const half = this.sx / 2
        for (let x = 0; x < half; x += 1) {
            const mirrored = this.sx - 1 - x
            for (let y = 0; y < this.sy; y += 1) {
                for (let z = 0; z < this.sz; z += 1) {
                    const c = this.get(x, y, z)
                    if (c !== EMPTY) {
                        this.set(mirrored, y, z, c)
                        n += 1
                    }
                }
            }
        }
        return n
    }
}
