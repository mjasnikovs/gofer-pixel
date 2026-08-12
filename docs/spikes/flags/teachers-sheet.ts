/*
 * The teacher swap, before and after.
 *
 *     bun docs/spikes/flags/teachers-sheet.ts
 *
 * Two columns and nothing else: the same subject at the same seed, taught by the hand-typed reply and
 * by a real model. If the right-hand column is not better, the claim that the examples are the
 * ceiling is wrong about real models, and the bank is not the lever it has been treated as.
 */
import {readFile, writeFile} from 'node:fs/promises'
import {toBase64} from '../../../src/image/base64'
import type {Row} from './teachers'

const OUT = 'out/teachers'
const rows = JSON.parse(await readFile(`${OUT}/rows.json`, 'utf8')) as Row[]
const PROMPTS = [...new Set(rows.map(row => row.prompt))]
const SEEDS = [...new Set(rows.map(row => row.seed))].sort((a, b) => a - b)

const png = new Map<string, string>()
const uri = async (file: string): Promise<string> => {
    const held = png.get(file)
    if (held !== undefined) return held
    const value = `data:image/png;base64,${toBase64(new Uint8Array(await readFile(`${OUT}/png/${file}`)))}`
    png.set(file, value)
    return value
}

const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const cell = async (row: Row | undefined): Promise<string> => {
    if (!row) return '<td class="cell empty">—</td>'
    if (row.failed !== undefined) return `<td class="cell"><div class="gone">${escape(row.failed)}</div></td>`
    return `<td class="cell">
    <img src="${await uri(row.file)}" alt="${escape(row.prompt)} ${row.arm} ${String(row.seed)}">
    <div class="stats"><b>${String(row.voxels)}</b> voxels &middot; rank ${row.rank.toFixed(2)} &middot; ${(100 * row.connectivity).toFixed(0)}% connected</div>
  </td>`
}

const sections: string[] = []
for (const prompt of PROMPTS) {
    const body: string[] = []
    for (const seed of SEEDS) {
        const typed = rows.find(r => r.prompt === prompt && r.seed === seed && r.arm === 'typed')
        const model = rows.find(r => r.prompt === prompt && r.seed === seed && r.arm === 'model')
        body.push(
            `<tr><th class="seed">seed<br>${String(seed)}</th>${await cell(typed)}${await cell(model)}</tr>`
        )
    }
    sections.push(`<section>
    <h2>${escape(prompt)}</h2>
    <div class="scroll"><table class="grid">
      <thead><tr><th></th><th>taught by my typed example</th><th>taught by a real model</th></tr></thead>
      <tbody>${body.join('')}</tbody>
    </table></div>
  </section>`)
}

const mean = (arm: 'typed' | 'model', pick: (row: Row) => number): string => {
    const ok = rows.filter(row => row.arm === arm && row.failed === undefined)
    return ok.length === 0 ? '—' : (ok.reduce((sum, row) => sum + pick(row), 0) / ok.length).toFixed(2)
}
const failed = (arm: 'typed' | 'model'): number =>
    rows.filter(row => row.arm === arm && row.failed !== undefined).length

const html = `<title>Do real models teach better?</title>
<style>
  :root { --ground:#f7f6f9; --surface:#fff; --surface-2:#efedf4; --ink:#1a1922; --muted:#5f5b70;
    --faint:#8b869c; --rule:#dedbe8; --accent:#5b3fc4; --bad:#a63a33; --shadow:0 1px 2px rgba(26,25,34,.06);
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --ground:#131218; --surface:#1c1b23; --surface-2:#25232e; --ink:#e9e7f1; --muted:#a19db2;
    --faint:#7c7790; --rule:#2f2d3a; --accent:#a89af8; --bad:#e2827a; --shadow:0 1px 2px rgba(0,0,0,.4); }}
  :root[data-theme="dark"] { --ground:#131218; --surface:#1c1b23; --surface-2:#25232e; --ink:#e9e7f1;
    --muted:#a19db2; --faint:#7c7790; --rule:#2f2d3a; --accent:#a89af8; --bad:#e2827a;
    --shadow:0 1px 2px rgba(0,0,0,.4); }
  body { background:var(--ground); color:var(--ink); font-family:var(--sans); margin:0;
         padding:0 20px 96px; line-height:1.55; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:44px; }
  header { padding-top:64px; display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:clamp(28px,4.6vw,40px); line-height:1.1; letter-spacing:-.022em; margin:0; text-wrap:balance; }
  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase;
             color:var(--accent); margin:0; }
  .standfirst { color:var(--muted); margin:0; max-width:62ch; font-size:18px; }
  section { display:flex; flex-direction:column; gap:12px; }
  h2 { font-size:20px; margin:0; padding-bottom:8px; border-bottom:1px solid var(--rule); }
  .scroll { overflow-x:auto; }
  table.grid { border-collapse:separate; border-spacing:10px; }
  table.grid thead th { font-family:var(--mono); font-size:12px; color:var(--faint); font-weight:600; }
  th.seed { font-family:var(--mono); font-size:11px; color:var(--faint); font-weight:500; width:52px; text-align:right; }
  td.cell { background:var(--surface); border:1px solid var(--rule); border-radius:8px; padding:8px;
            width:216px; vertical-align:top; box-shadow:var(--shadow); }
  td.cell img { display:block; width:200px; height:200px; border-radius:5px; image-rendering:pixelated; background:#222226; }
  .stats { font-family:var(--mono); font-size:11px; color:var(--muted); margin-top:5px; }
  .gone { font-family:var(--mono); font-size:11px; color:var(--bad); padding:84px 4px; text-align:center; }
  td.cell.empty { color:var(--faint); text-align:center; }
  table.facts { border-collapse:collapse; background:var(--surface); border:1px solid var(--rule);
                border-radius:8px; overflow:hidden; width:100%; }
  table.facts th, table.facts td { padding:9px 14px; text-align:left; border-bottom:1px solid var(--rule); font-size:14px; }
  table.facts th { font-family:var(--mono); font-size:12px; color:var(--faint); font-weight:600; }
  table.facts tr:last-child th, table.facts tr:last-child td { border-bottom:none; }
  code { font-family:var(--mono); font-size:.88em; background:var(--surface-2); padding:1px 5px; border-radius:3px; }
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">gofer-pixel &middot; ${String(rows.length)} candidates &middot; three fixed seeds &middot; every switch off</p>
    <h1>Do real models teach better?</h1>
    <p class="standfirst">The bank has never held a real model. Every number on the record was
    produced by an example I typed by hand. Same subject, same seed, one thing changed: the assistant
    turn is either my typed reply or a CC-BY model run through the decomposer.</p>
  </header>
  <section>
    <h2>the two arms</h2>
    <table class="facts">
      <tr><th></th><th>typed</th><th>real model</th></tr>
      <tr><th>mean voxels</th><td>${mean('typed', r => r.voxels)}</td><td>${mean('model', r => r.voxels)}</td></tr>
      <tr><th>mean connectivity</th><td>${mean('typed', r => r.connectivity)}</td><td>${mean('model', r => r.connectivity)}</td></tr>
      <tr><th>mean rank</th><td>${mean('typed', r => r.rank)}</td><td>${mean('model', r => r.rank)}</td></tr>
      <tr><th>painted nothing</th><td>${String(failed('typed'))}</td><td>${String(failed('model'))}</td></tr>
    </table>
    <p class="standfirst" style="font-size:15px">Those numbers are a sort order, not a quality bar —
    <code>GEN_RESEARCH.md</code> finding 3. The pictures are the measurement.</p>
  </section>
  ${sections.join('\n')}
</div>`

await writeFile(`${OUT}/sheet.html`, html)
process.stdout.write(`wrote ${OUT}/sheet.html\n`)
