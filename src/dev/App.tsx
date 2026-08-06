import {useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Heading} from '@astryxdesign/core/Heading'
import {HStack} from '@astryxdesign/core/HStack'
import {VStack} from '@astryxdesign/core/VStack'
import {Editor} from '../editor/Editor'
import {Viewer} from './Viewer'

type Mode = 'editor' | 'viewer'

/** Dev playground. Not part of the published library — see tsconfig.build.json. */
export const App = () => {
    const [mode, setMode] = useState<Mode>('editor')

    return (
        <VStack
            gap={2}
            padding={3}
        >
            <HStack
                gap={3}
                align='center'
            >
                <Heading level={1}>gofer-pixel</Heading>
                {(['editor', 'viewer'] as Mode[]).map(option => (
                    <Button
                        key={option}
                        label={option}
                        size='sm'
                        variant={mode === option ? 'primary' : 'secondary'}
                        clickAction={() => {
                            setMode(option)
                        }}
                    />
                ))}
            </HStack>
            {mode === 'editor' ?
                <Editor />
            :   <Viewer />}
        </VStack>
    )
}
