// farmer: 24 tall; legs 0-9, torso 10-17, head 18-23; arms at the sides
const skin = '#e0b088', shirt = '#4a7a3a', pants = '#5a4632', hat = '#d8b84a'
for (const x of [5, 9]) { box(x,0,5, x+2,9,7, pants) }
box(4,10,4, 12,17,8, shirt)
for (const x of [2, 13]) { box(x,8,5, x+1,16,7, shirt) }
box(6,18,4, 10,22,8, skin)
box(5,22,3, 11,23,9, hat)
