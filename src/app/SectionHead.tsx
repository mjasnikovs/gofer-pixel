import {Text} from '@astryxdesign/core/Text'
import type {ReactNode} from 'react'

/**
 * The section label from the mockups: small, upper-cased, letter-spaced, in the weakest text role,
 * with its actions pushed to the right and no rule underneath it.
 *
 * A bar with a border around it reads as a title bar and turns every section into another box; the
 * mockups draw one line *between* sections instead, which is what `.section + .section` does. The
 * upper-casing is CSS rather than typed-out capitals so that a screen reader still hears "Cameras".
 */
export const SectionHead = ({title, children}: {title: string; children?: ReactNode}) => (
    <header className='section-head'>
        <Text
            type='supporting'
            weight='semibold'
        >
            {title}
        </Text>
        <span className='spacer' />
        {children}
    </header>
)
