/**
 * The examples that ship in the source, and the floor under the bank.
 *
 * Programmer art, hand-typed box by box, one per body plan. There are five because one is not
 * neutral, measured 2026-08-08: with only the dog in the prompt, "a chicken" came back with four
 * legs and "a fish" came back a slab. The example teaches the answer's *shape*, so a subject whose
 * shape is different gets dragged into it.
 *
 * Any of them is replaced by dropping a real model into `src/assets/examples/` and pointing that
 * entry's `file` at it — see the README there. They stay in the source rather than being deleted
 * because an entry with no asset still has to teach something, and an empty bank must not mean a
 * prompt with no worked example in it.
 *
 * Each demonstrates the language once: a proportions comment first, loops for repeated limbs, feet
 * at `y = 0`, parts that touch, a palette with real value contrast. `tower` is the one that carves
 * with `erase`, which is why it is battlemented and not a box.
 *
 * **If you change one, render it.** `bank.test.ts` holds them to being one connected piece that is
 * not a solid brick, but only your eyes can say whether the dog looks like a dog, and an example
 * that does not look like what it claims teaches exactly that.
 */
export const BUILT_IN_REPLIES: Readonly<Record<string, string | undefined>> = {
    dog: `// dog: body 3 wide, 5 tall, 12 long; head at the front-top; legs at the corners
const fur = '#8b5a2b', light = '#a0693a', dark = '#6f4520'
box(1,5,3, 6,9,14, fur)          // body
box(1,8,14, 6,11,17, light)      // head
for (const z of [4, 12]) {       // legs, front and back pairs
    box(1,1,z, 2,5,z+1, fur)
    box(5,1,z, 6,5,z+1, fur)
}
box(1,11,14, 1,12,15, dark)      // left ear
box(6,11,14, 6,12,15, dark)      // right ear
box(3,9,17, 4,10,17, '#2b1a0d')  // nose
box(3,8,2, 4,11,3, light)        // tail`,

    chicken: `// chicken: round body on two legs, small head high at the front, comb and beak
const body = '#f2e3c8', wing = '#d8c4a0', leg = '#e08a2c'
box(2,5,3, 6,10,8, body)         // body
box(1,6,4, 1,9,7, wing)          // left wing
box(7,6,4, 7,9,7, wing)          // right wing
box(2,10,2, 6,13,2, wing)        // tail, angled up
box(3,11,6, 5,13,8, body)        // head
box(4,14,6, 4,14,7, '#cc2b2b')   // comb
box(4,11,9, 4,12,9, leg)         // beak
box(3,12,8, 3,12,8, '#2b2b28')   // eye
box(5,12,8, 5,12,8, '#2b2b28')   // eye
for (const x of [3, 5]) box(x,0,5, x,4,6, leg)  // two legs`,

    farmer: `// farmer: 24 tall; legs 0-9, torso 10-17, head 18-23; arms hang at the sides
const skin = '#e0b088', shirt = '#4a7a3a', pants = '#5a4632', hat = '#d8b84a'
box(5,0,5, 7,9,7, pants)          // left leg
box(9,0,5, 11,9,7, pants)         // right leg
box(4,10,4, 12,17,8, shirt)       // torso
box(2,10,5, 3,16,7, shirt)        // left arm
box(13,10,5, 14,16,7, shirt)      // right arm
box(2,8,5, 3,9,7, skin)           // left hand
box(13,8,5, 14,9,7, skin)         // right hand
box(6,18,4, 10,22,8, skin)        // head
box(5,22,3, 11,23,9, hat)         // hat brim
box(6,23,4, 10,23,8, hat)         // hat top
box(7,20,4, 7,20,4, '#2b2b28')    // left eye
box(9,20,4, 9,20,4, '#2b2b28')    // right eye`,

    mushroom: `// mushroom: pale stalk, wide red cap in shrinking tiers, white spots
box(4,0,4, 7,8,7, '#efe6d2')     // stalk
box(1,9,2, 10,10,9, '#c0392b')   // cap, widest tier
box(2,11,3, 9,12,8, '#c0392b')
box(3,13,4, 8,13,7, '#a5301f')   // cap top
box(2,10,4, 2,10,5, '#ffffff')   // spots
box(8,12,6, 8,12,7, '#ffffff')
box(4,9,8, 6,9,8, '#d8cbb0')     // gill hint`,

    tower: `// tower: tall shaft, battlemented top ring, door and windows
box(1,0,1, 8,19,8, '#8a8a86')    // shaft
box(1,0,1, 8,2,8, '#6f6f6b')     // base course
box(0,20,0, 9,22,9, '#77776f')   // top slab
erase(1,21,1, 8,22,8)            // hollow the ring
for (const c of [2, 6]) {        // battlement gaps on all four sides
    erase(c,22,0, c+1,22,9)
    erase(0,22,c, 9,22,c+1)
}
erase(4,0,0, 5,4,0)              // door
box(4,8,0, 5,10,0, '#2b2b28')    // windows
box(0,13,4, 0,15,5, '#2b2b28')
box(4,14,8, 5,16,8, '#2b2b28')`
}
