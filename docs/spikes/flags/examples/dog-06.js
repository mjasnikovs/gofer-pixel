// dog: 8 wide, 11 tall, 17 long. Body over four legs, head at the front.
const fur = '#986400'
box(0,3,3, 7,8,15, fur)
for (const z of [5, 12]) { for (const x of [0, 6]) { box(x,0,z, x+1,2,z+2, fur) } }
box(2,4,0, 5,9,3, fur)
