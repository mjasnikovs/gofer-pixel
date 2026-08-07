/**
 * The nine tool glyphs as bare path data, because two things draw them.
 *
 * The rail draws them as React below, and `cursors.ts` bakes the same strings into the pointer that
 * hangs off the mouse. Sharing the `d` rather than redrawing is the point: an artist checking which
 * tool is armed by glancing at the cursor is comparing it against the rail, and the two being the
 * same drawing is what makes that comparison mean anything.
 */
export const TOOL_PATHS = {
    draw: ['M11.4 2.6a1.6 1.6 0 0 1 2.2 2.2L5.6 12.8 2.5 13.5l.7-3.1z', 'M10 4l2 2'],
    erase: [
        'M9.2 2.8 2.8 9.2a1.5 1.5 0 0 0 0 2.1l1.9 1.9h4l6.5-6.5a1.5 1.5 0 0 0 0-2.1l-2-2a1.5 1.5 0 0 0-2 0z',
        'M6 6l4 4M4.7 13.2h8.6'
    ],
    fill: [
        'M6.4 2.2 12.6 8.4a1 1 0 0 1 0 1.4l-3.9 3.9a1 1 0 0 1-1.4 0L2.6 8.9z',
        'M4.5 4.1 3 2.6M14 11c.8 1.2 1.2 2 1.2 2.5a1.2 1.2 0 0 1-2.4 0c0-.5.4-1.3 1.2-2.5z'
    ],
    pick: [
        'M11 2.4a1.8 1.8 0 0 1 2.6 2.6l-1 1 .8.8-1.3 1.3-.8-.8-5 5-2.6.6.6-2.6 5-5-.8-.8L9.8 3.2l.8.8z'
    ],
    move: [
        'M8 1.8v12.4M1.8 8h12.4M8 1.8 6.2 3.8M8 1.8 9.8 3.8M8 14.2 6.2 12.2M8 14.2 9.8 12.2M1.8 8 3.8 6.2M1.8 8 3.8 9.8M14.2 8l-2-1.8M14.2 8l-2 1.8'
    ],
    rotate: ['M13.4 8a5.4 5.4 0 1 1-1.9-4.1', 'M13.7 1.9v3h-3'],
    scale: ['M2.5 2.5h11v11h-11z', 'M5.5 10.5l5-5M10.5 5.5h-3M10.5 5.5v3'],
    clone: ['M5.5 5.5h8v8h-8z', 'M10.5 5.5v-3h-8v8h3'],
    measure: [
        'M2 9.9 9.9 2l4.1 4.1L6.1 14z',
        'M5 6.9l1.2 1.2M7 4.9l1.2 1.2M9 2.9l1.2 1.2M3 8.9l1.2 1.2'
    ]
} as const satisfies Record<string, readonly string[]>
