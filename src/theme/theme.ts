import {defineTheme} from '@astryxdesign/core/theme'
import {neutralTheme} from '@astryxdesign/theme-neutral/built'

/**
 * The chrome in `docs/editor.png` and `docs/featureset.png`, as tokens.
 *
 * Every hex below was sampled out of those two mockups, because they are the spec. The thing they
 * get right and a default dark theme does not is that the window is a *ramp*: the frame is nearly
 * black, panels sit above it, cards above those, and popovers above those again. A tool that paints
 * one grey everywhere loses the ability to say which region is which — the sibling project shipped
 * a screen that measured 89.5 % one colour, and `theme.test.ts` is the ratchet that stops this one
 * doing it.
 *
 * Never hand-edit `gofer-pixel-theme.css`. Edit this file and run `bun run theme`.
 */
export const goferPixelTheme = defineTheme({
    name: 'gofer-pixel',
    extends: neutralTheme,
    // The mockups' panels and cards are softly rounded, not square and not pill-shaped.
    radius: {base: 6, multiplier: 0.5},
    tokens: {
        /*
         * The four surfaces, in the order Astryx documents them: body → surface → card → popover,
         * each visibly above the last. Every step is about 3.5 L*, just over the three the gate
         * asks for — enough that a panel edge reads without a border doing all the work, and not so
         * much that the window turns into a set of grey boxes.
         *
         * The dark values are the mockup's own: the frame behind the panels sampled #13161c, the
         * panels #181c23, and the tool rail sat between them. They carry a faint blue cast, which is
         * what stops a near-black chrome reading as dead grey next to a lit render.
         *
         * Light is the awkward half — nothing can be lighter than white, so a ramp that ends at
         * white has to start below it and the panels give up pure white to the popover.
         */
        '--color-background-body': ['#dfe2e9', '#13161c'],
        '--color-background-surface': ['#eaecf1', '#191d25'],
        '--color-background-card': ['#f4f5f8', '#20242e'],
        '--color-background-popover': ['#ffffff', '#282d38'],

        /*
         * Three text roles, three lightnesses, each pair more than the twelve L* the gate measures
         * apart (23 and 20 in dark). The role that matters most here is the weakest one: a camera's
         * name, a sprite's dimensions and a placeholder all live in it, and if it lands on the same
         * value as a real label then a hint reads as data the user entered.
         */
        '--color-text-primary': ['#10131a', '#e6e9f0'],
        '--color-text-secondary': ['#4a5162', '#a3a9b8'],
        '--color-text-disabled': ['#767d8d', '#6e7484'],

        /*
         * gofer-pixel takes a hue, and it is the mockup's.
         *
         * The neutral theme's accent is a near-white six lightness points from body text, so the
         * one colour meant to say "this is the thing to press" says it in the same voice as a
         * paragraph. Both mockups put a violet on exactly three things — the selected tool, the
         * selected camera, and the export button — and nothing else in the window is coloured at
         * all. That is what makes a dense dark tool navigable, so the token moves and the whole
         * accent family moves with it; an accent icon left grey beside a violet button reads as a
         * different system.
         *
         * The light half is darker than the dark half because white has to sit on it: #5533e0
         * carries a white label at 7.2:1, and the mockup's own #7053ef manages 5.0:1, both clear.
         */
        '--color-accent': ['#5533e0', '#7053ef'],
        '--color-text-accent': ['#5533e0', '#a08cf6'],
        '--color-icon-accent': ['#5533e0', '#7053ef'],
        '--color-on-accent': ['#ffffff', '#ffffff'],
        '--color-accent-muted': ['#5533e033', '#7053ef3f'],

        /*
         * Two weights of line. The plain rule divides panels that are already told apart by their
         * fill, so it stays quiet — in the mockups it is barely there. The emphasised one is the
         * edge of a control a user has to find in order to work it, which is what WCAG 1.4.11's
         * 3:1 is about, and it clears that on the surface it is drawn on in both modes.
         */
        '--color-border': ['#c2c7d1', '#2e3440'],
        '--color-border-emphasized': ['#6d7484', '#7b8294'],

        /*
         * The selection ring the neutral theme inherits is a hardcoded blue, which in a violet app
         * means the one thing that says "this camera is the one you are looking at" arrives in a
         * colour from another design system. It moves with the accent like everything else.
         */
        '--shadow-inset-selected': 'inset 0px 0px 0px 2px #7053efcc',
        '--shadow-inset-hover': 'inset 0px 0px 0px 2px #7053ef59'
    },
    components: {
        /*
         * A field with no fill of its own is a rectangle of panel with a line around it, and in a
         * dark tool that line is the only thing saying "you can type here". Dropping the fill to
         * the body colour makes the field a well the text sits in — a boundary that survives a
         * glance and does not depend on the border being noticed.
         */
        'text-input': {base: {backgroundColor: 'var(--color-background-body)'}},

        /*
         * The mockup's Color / Normal / Depth / AO / Emission row draws the chosen one as accent
         * text inside an accent-outlined pill, and the rest as plain text with no chrome at all.
         * Inherited, the selected segment is a grey fill on a grey panel — the same 1-ish contrast
         * step that a sibling project shipped an entire window of. Which map you are looking at is
         * a top-level fact about the viewport, so it gets the hue.
         */
        'segmented-control': {base: {backgroundColor: 'transparent'}},
        'segmented-control-item': {
            selected: {
                backgroundColor: 'var(--color-accent-muted)',
                color: 'var(--color-text-accent)',
                boxShadow: 'inset 0 0 0 1px var(--color-accent)'
            }
        }
    }
})
