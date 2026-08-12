// tower: tall shaft, battlemented top ring, door
box(1,0,1, 8,19,8, '#8a8a86')
box(0,20,0, 9,22,9, '#77776f')
erase(1,21,1, 8,22,8)
for (const c of [2, 6]) { erase(c,22,0, c+1,22,9); erase(0,22,c, 9,22,c+1) }
erase(4,0,0, 5,4,0)
box(4,8,0, 5,10,0, '#2b2b28')
