// dog: 6 wide, 12 tall, 17 long; body over four legs, head at the front
const fur = '#8b5a2b', light = '#a0693a'
box(1,5,3, 6,9,14, fur)
box(1,8,14, 6,11,17, light)
for (const z of [4, 12]) { box(1,1,z, 2,5,z+1, fur); box(5,1,z, 6,5,z+1, fur) }
box(3,8,2, 4,11,3, light)
