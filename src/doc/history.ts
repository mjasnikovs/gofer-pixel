/**
 * Snapshot undo.
 *
 * The usual advice is that command objects beat snapshots on memory. Copy-on-write inverts it:
 * a snapshot is one object reference and the chunks it names are shared with every other
 * snapshot that did not touch them, so the cost of an entry is the voxels the edit actually
 * changed. In exchange there is no inverse operation to write per tool, and so no inverse to get
 * subtly wrong — which is where command-based undo fails in practice.
 *
 * `T` is whatever the app wants restored, not just the document. Put the selection and the
 * viewport in it and undo puts them back too.
 */
export interface HistoryEntry<T> {
    readonly state: T
    readonly label: string
}

export interface HistoryOptions<T> {
    /** Entry ceiling. A backstop for `measure`, and the whole cap when `measure` is absent. */
    maxEntries?: number
    /** Byte ceiling for the retained states. Ignored unless `measure` is given. */
    maxBytes?: number
    /**
     * Bytes held by all retained states *together*. Measuring them jointly is the point: summing
     * snapshots one at a time counts every shared chunk once per entry and reports a stack
     * hundreds of times larger than it is.
     */
    measure?: (states: readonly T[]) => number
}

export class History<T> {
    private entries: HistoryEntry<T>[]
    private index = 0
    private readonly maxEntries: number
    private readonly maxBytes: number
    private readonly measure: ((states: readonly T[]) => number) | undefined

    constructor(initial: T, options: HistoryOptions<T> = {}) {
        this.entries = [{state: initial, label: 'open'}]
        this.maxEntries = options.maxEntries ?? 200
        this.maxBytes = options.maxBytes ?? Infinity
        this.measure = options.measure
    }

    get current(): T {
        const entry = this.entries[this.index]
        if (!entry) {
            throw new Error('history is empty, which cannot happen')
        }
        return entry.state
    }

    get canUndo(): boolean {
        return this.index > 0
    }

    get canRedo(): boolean {
        return this.index < this.entries.length - 1
    }

    get length(): number {
        return this.entries.length
    }

    /** Labels oldest first, with the current position marked — the UI's history panel. */
    get labels(): readonly string[] {
        return this.entries.map(entry => entry.label)
    }

    get position(): number {
        return this.index
    }

    get bytes(): number {
        return this.measure?.(this.entries.map(entry => entry.state)) ?? 0
    }

    /**
     * Record a new state. Anything ahead of the cursor is discarded, as in every editor: once you
     * undo and then draw, the branch you left is gone.
     *
     * A commit equal to the current state is dropped, so a tool that ran but changed nothing does
     * not litter the stack with entries that undo to themselves.
     */
    commit(state: T, label: string): void {
        if (state === this.current) {
            return
        }
        this.entries = [...this.entries.slice(0, this.index + 1), {state, label}]
        this.index = this.entries.length - 1
        this.evict()
    }

    /**
     * Update the current entry in place, adding nothing to the stack.
     *
     * For the changes that are not edits — moving to another slice, changing the selection,
     * scrolling. They still belong in the entry, because undoing back past an edit should return
     * the artist to where that edit happened, but each one is not its own undo step.
     */
    replace(state: T): void {
        const entry = this.entries[this.index]
        if (entry) {
            this.entries[this.index] = {state, label: entry.label}
        }
    }

    undo(): T {
        if (this.canUndo) {
            this.index -= 1
        }
        return this.current
    }

    redo(): T {
        if (this.canRedo) {
            this.index += 1
        }
        return this.current
    }

    /** The label of the edit `undo` would reverse, for "Undo pencil" in a menu. */
    get undoLabel(): string | null {
        return this.canUndo ? (this.entries[this.index]?.label ?? null) : null
    }

    get redoLabel(): string | null {
        return this.canRedo ? (this.entries[this.index + 1]?.label ?? null) : null
    }

    /**
     * Drop the oldest entries until the stack fits. The oldest goes first because it is the one
     * least likely to be wanted, and because the current state must survive at any cost — a cap
     * small enough to be exceeded by a single snapshot leaves exactly one entry, not zero.
     */
    private evict(): void {
        while (this.entries.length > this.maxEntries) {
            this.entries.shift()
            this.index -= 1
        }
        if (!this.measure || this.maxBytes === Infinity) {
            return
        }
        while (this.entries.length > 1 && this.bytes > this.maxBytes) {
            this.entries.shift()
            this.index -= 1
        }
    }
}
