import {expect, test} from 'bun:test'
import {
    autoNote,
    autoPrompt,
    LANGUAGES,
    LANGUAGE_USE,
    readLanguage,
    resolveFlags,
    type Language
} from './auto'
import {DEFAULT_FLAGS, type Flags} from './flags'

/**
 * Letting the model choose the language — `gen/auto.ts`. The rule under test throughout is that it
 * picks **one language or none**, never a set: the picking call is measured to pad when it is
 * unsure, and two languages on at once is a prompt describing one and examples teaching another.
 */

const on: Flags = {...DEFAULT_FLAGS, auto: true}

test('the prompt is built from the table, so a new language needs no code', () => {
    const asked = autoPrompt()
    for (const name of LANGUAGES) {
        expect(asked).toContain(name)
        expect(asked).toContain(LANGUAGE_USE[name])
    }
    // "none" is an answer, not a failure to answer: plenty of subjects fit none of the four.
    expect(asked).toContain('none')
})

test('a one-word reply is read, with or without punctuation around it', () => {
    expect(readLanguage('faces')).toBe('faces')
    expect(readLanguage('faces.')).toBe('faces')
    expect(readLanguage('  Silhouette\n')).toBe('silhouette')
    expect(readLanguage('I would say relational')).toBe('relational')
})

test('none, nonsense and an empty reply are all "no language"', () => {
    expect(readLanguage('none')).toBeUndefined()
    expect(readLanguage('')).toBeUndefined()
    expect(readLanguage('a cheese sandwich')).toBeUndefined()
    // "none" first wins even when a language is named after it, because the model answered first.
    expect(readLanguage('none of these, maybe faces')).toBeUndefined()
})

/**
 * The identity with `auto` off, and it matters more than it looks: every number in
 * `docs/GEN_RESEARCH.md` was measured with the switches meaning exactly what they say.
 */
test('with auto off the flags are exactly what the artist set', () => {
    const set: Flags = {...DEFAULT_FLAGS, faces: true, repair: true}
    expect(resolveFlags(set, 'silhouette')).toBe(set)
    expect(resolveFlags(set, undefined)).toBe(set)
})

test('the chosen language goes on and the other three go off', () => {
    for (const chosen of LANGUAGES) {
        const running = resolveFlags(on, chosen)
        expect(running[chosen]).toBe(true)
        for (const other of LANGUAGES) {
            if (other !== chosen) expect(running[other]).toBe(false)
        }
    }
})

test('a language the artist switched on by hand is turned off by a different choice', () => {
    const both: Flags = {...on, relational: true}
    const running = resolveFlags(both, 'faces')

    expect(running.faces).toBe(true)
    // The contradiction this exists to prevent: relational replaces the example set, so the two of
    // them together send the face help with nothing demonstrating it.
    expect(running.relational).toBe(false)
})

test('choosing nothing leaves every language off', () => {
    const running = resolveFlags({...on, faces: true, silhouette: true}, undefined)
    for (const name of LANGUAGES) expect(running[name]).toBe(false)
})

/**
 * The three policy switches are not the model's business. They are about what to do with output that
 * came back broken, not about the subject, so nothing here may touch them.
 */
test('the policy switches are copied through whatever the language is', () => {
    const policies: Flags = {
        ...on,
        repair: true,
        gates: true,
        retryEmpty: true
    }
    for (const chosen of [...LANGUAGES, undefined] as (Language | undefined)[]) {
        const running = resolveFlags(policies, chosen)
        expect(running.repair).toBe(true)
        expect(running.gates).toBe(true)
        expect(running.retryEmpty).toBe(true)
        expect(running.auto).toBe(true)
    }
})

test('the status line tells "none" from "not asked"', () => {
    expect(autoNote(undefined, DEFAULT_FLAGS)).toBe('')
    expect(autoNote('faces', DEFAULT_FLAGS)).toBe('')
    expect(autoNote('faces', on)).toBe('Auto: faces')
    expect(autoNote(undefined, on)).toContain('no language fits')
})
