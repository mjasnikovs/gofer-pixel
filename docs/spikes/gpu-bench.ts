// Is headless Chromium's WebGL2 hardware here, and what does a golden-pixel test cost?
import {chromium} from 'playwright'

const PAGE = `<canvas id=c width=512 height=512></canvas><script>
window.probe = () => {
  const gl = document.getElementById('c').getContext('webgl2', {preserveDrawingBuffer: true})
  if (!gl) return {ok: false}
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const vs = \`#version 300 es
  in vec2 p; out vec2 uv; void main(){ uv = p; gl_Position = vec4(p,0.,1.); }\`
  // a real voxel DDA in the fragment shader, so the timing is the actual workload
  const fs = \`#version 300 es
  precision highp float; precision highp sampler3D;
  in vec2 uv; out vec4 o; uniform sampler3D vol; uniform float N; uniform float yaw;
  void main(){
    float cy=cos(yaw), sy=sin(yaw), cp=cos(0.5), sp=sin(0.5);
    vec3 f=vec3(-sy*cp,-cy*cp,-sp), r=vec3(cy,-sy,0.), u=vec3(-sy*sp,-cy*sp,cp);
    vec3 org = vec3(N*0.5) + r*uv.x*N*0.75 + u*uv.y*N*0.75 - f*N*2.0;
    vec3 inv = 1.0/f;
    vec3 t0=(vec3(0.0)-org)*inv, t1=(vec3(N)-org)*inv;
    vec3 lo=min(t0,t1), hi=max(t0,t1);
    float tmin=max(max(lo.x,lo.y),lo.z), tmax=min(min(hi.x,hi.y),hi.z);
    if(tmax<max(tmin,0.0)){ o=vec4(0.); return; }
    float t=max(tmin,0.0)+1e-3;
    vec3 pos=floor(org+f*t);
    vec3 s=sign(f);
    vec3 d=abs(inv);
    vec3 m=(( s*0.5+0.5)*(pos+1.0-(org+f*t)) + (0.5-s*0.5)*((org+f*t)-pos))*d;
    vec3 nrm=vec3(0.);
    for(int i=0;i<512;i++){
      if(any(lessThan(pos,vec3(0.)))||any(greaterThanEqual(pos,vec3(N)))) { o=vec4(0.); return; }
      float v=texelFetch(vol, ivec3(pos), 0).r;
      if(v>0.0){ float l=max(dot(nrm,normalize(vec3(0.4,0.6,0.7))),0.0)*0.7+0.3;
                 o=vec4(vec3(v*l, (1.0-v)*l, 0.5*l),1.0); return; }
      if(m.x<m.y&&m.x<m.z){ pos.x+=s.x; t=m.x; m.x+=d.x; nrm=vec3(-s.x,0,0); }
      else if(m.y<m.z){ pos.y+=s.y; t=m.y; m.y+=d.y; nrm=vec3(0,-s.y,0); }
      else { pos.z+=s.z; t=m.z; m.z+=d.z; nrm=vec3(0,0,-s.z); }
    }
    o=vec4(0.);
  }\`
  const mk=(t,s)=>{const h=gl.createShader(t);gl.shaderSource(h,s);gl.compileShader(h);
    if(!gl.getShaderParameter(h,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h}
  const pr=gl.createProgram(); gl.attachShader(pr,mk(gl.VERTEX_SHADER,vs)); gl.attachShader(pr,mk(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(pr); if(!gl.getProgramParameter(pr,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr)
  const N=128
  const data=new Uint8Array(N*N*N)
  for(let z=0;z<N;z++)for(let y=0;y<N;y++)for(let x=0;x<N;x++){
    const dd=Math.hypot(x-63.5,y-63.5,z-63.5)
    if(dd<N*0.42 && (x*7+y*13+z*29)%11!==0) data[(z*N+y)*N+x]=1+((x+y+z)%200)
  }
  const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D,tex)
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
  gl.texImage3D(gl.TEXTURE_3D,0,gl.R8,N,N,N,0,gl.RED,gl.UNSIGNED_BYTE,data)
  gl.uniform1i(gl.getUniformLocation(pr,'vol'),0)
  gl.uniform1f(gl.getUniformLocation(pr,'N'),N)
  const yawLoc=gl.getUniformLocation(pr,'yaw')
  const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf)
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW)
  const p=gl.getAttribLocation(pr,'p'); gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0)
  const px=new Uint8Array(512*512*4)
  const draw=(yaw)=>{ gl.uniform1f(yawLoc,yaw); gl.drawArrays(gl.TRIANGLES,0,3)
                      gl.readPixels(0,0,512,512,gl.RGBA,gl.UNSIGNED_BYTE,px) }
  draw(0.7)
  const t0=performance.now(); const K=60
  for(let i=0;i<K;i++) draw(0.7+i*0.01)
  const ms=(performance.now()-t0)/K
  // hash the last frame the way a golden test would
  let h=2166136261>>>0
  for(let i=0;i<px.length;i++){ h^=px[i]; h=Math.imul(h,16777619)>>>0 }
  let nonEmpty=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) nonEmpty++
  return {ok:true, renderer: dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
          msPerFrame: ms, hash: h.toString(16), nonEmpty}
}
</script>`

const run = async (label: string, args: string[]): Promise<void> => {
    const tLaunch = performance.now()
    const browser = await chromium.launch({args})
    const page = await browser.newPage()
    const launched = performance.now() - tLaunch
    await page.setContent(PAGE)
    const tRun = performance.now()
    const r = await page.evaluate('window.probe()')
    const ran = performance.now() - tRun
    await browser.close()
    console.log(label, JSON.stringify(r), `launch ${launched.toFixed(0)}ms  probe ${ran.toFixed(0)}ms`)
}

await run('[default headless]', [])
await run('[gpu flags]     ', [
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization'
])
