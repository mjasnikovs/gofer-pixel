// dog: 8 wide, 11 tall, 17 long. A long body over four short legs, head low at the front, tail at the back.
const fur = '#986400', dark = '#101010'
// four legs at the corners, three tall
for (const z of [6, 12]) {
    for (const x of [0, 6]) {
        box(x,0,z, x+1,2,z+2, fur)
    }
}
box(0,3,6, 7,8,15, fur)      // body, full width from the shoulders back
box(1,3,3, 6,8,5, fur)       // chest, narrower toward the front
box(2,4,0, 5,8,3, fur)       // head, low and forward
box(3,4,0, 4,5,1, dark)      // muzzle
for (const x of [1, 6]) {    // ears
    box(x,9,2, x+1,10,4, fur)
}
for (const x of [2, 5]) {    // eyes
    box(x,7,1, x,7,2, dark)
}
box(3,6,16, 4,7,16, fur)     // tail
