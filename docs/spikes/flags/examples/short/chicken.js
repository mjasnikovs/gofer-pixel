// chicken: round body on two legs, small head high at the front
const body = '#f2e3c8', wing = '#d8c4a0', leg = '#e08a2c'
box(2,5,3, 6,10,8, body)
box(3,11,6, 5,13,8, body)
for (const x of [1, 7]) { box(x,6,4, x,9,7, wing) }
for (const x of [3, 5]) { box(x,0,5, x,4,6, leg) }
