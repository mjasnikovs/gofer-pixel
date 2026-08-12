// dog: 8 wide, 11 tall, 17 long. Body over four legs, head low at the front, tail at the back.
const fur = '#986400', dark = '#101010'
box(0,3,6, 7,8,15, fur)      // body
box(1,3,3, 6,8,5, fur)       // chest
box(2,4,0, 5,8,3, fur)       // head
for (const z of [6, 12]) {   // four legs
    for (const x of [0, 6]) { box(x,0,z, x+1,2,z+2, fur) }
}
box(3,4,0, 4,5,1, dark)      // muzzle
box(3,6,16, 4,7,16, fur)     // tail
