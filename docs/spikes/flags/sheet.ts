/*
 * The corpus as pages to look at.
 *
 *     bun docs/spikes/flags/sheet.ts
 *
 * Reads `out/flags/cells.json` and writes `out/flags/sheet.html` with the PNGs inlined, so the file
 * is one thing that can be opened or published.
 *
 * The layout is the argument: **one row per seed, one column per arm**, so the eye compares the same
 * subject at the same seed across the switches and nothing else varies. A grid that put arms in rows
 * would be comparing seeds, which is the thing that is not being asked.
 *
 * Everything except the pictures is a number the code already computes. The judgement is the
 * artist's and this file does not make one — it lays the evidence out and says which cells the
 * deterministic rules would have thrown away.
 */
import {readFile, writeFile} from 'node:fs/promises'
import {toBase64} from '../../../src/image/base64'
import type {Cell} from './corpus'

const OUT = 'out/flags'

const cells = JSON.parse(await readFile(`${OUT}/cells.json`, 'utf8')) as Cell[]

const ARMS = ['off', 'silhouette', 'procedural', 'relational', 'faces'] as const
const SUBJECTS = [...new Set(cells.map(cell => cell.subject))]
const SEEDS = [...new Set(cells.map(cell => cell.seed))].sort((a, b) => a - b)

/** The names each arm actually puts in scope. Anything else in a reply throws on that line. */
const DEFINES: Readonly<Record<string, readonly string[]>> = {
    off: ['box', 'ball', 'erase', 'mirrorX'],
    silhouette: ['box', 'ball', 'erase', 'mirrorX', 'front', 'side'],
    procedural: ['box', 'ball', 'erase', 'mirrorX', 'tree', 'tower', 'rock'],
    relational: ['part', 'attach', 'legs', 'arms', 'box'],
    faces: ['box', 'ball', 'erase', 'mirrorX', 'face']
}

const foreign = (cell: Cell): readonly string[] => {
    const known = new Set(DEFINES[cell.arm] ?? [])
    return cell.called.filter(name => !known.has(name))
}

const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const png = new Map<string, string>()
const dataUri = async (file: string): Promise<string> => {
    const cached = png.get(file)
    if (cached !== undefined) return cached
    const bytes = new Uint8Array(await readFile(`${OUT}/png/${file}`))
    const uri = `data:image/png;base64,${toBase64(bytes)}`
    png.set(file, uri)
    return uri
}

const pct = (value: number): string => `${(100 * value).toFixed(0)}%`

const cellHtml = async (cell: Cell | undefined): Promise<string> => {
    if (!cell) return '<td class="cell empty">—</td>'
    if (cell.failed !== undefined) {
        return `<td class="cell"><div class="gone">${escape(cell.failed)}</div></td>`
    }
    const odd = foreign(cell)
    const tags = [
        cell.gate === undefined ? '' : `<span class="tag bad">gate: ${escape(cell.gate)}</span>`,
        cell.surface ? '<span class="tag">declared a prop</span>' : '',
        odd.length === 0 ?
            ''
        :   `<span class="tag bad">named ${escape(odd.join(' '))} — not in scope</span>`,
        cell.repaired.changed ? '<span class="tag">repair fires</span>' : ''
    ].join('')
    return `<td class="cell">
      <img src="${await dataUri(cell.file)}" alt="${escape(cell.subject)}, ${escape(cell.arm)}, seed ${String(cell.seed)}">
      <div class="stats"><b>${String(cell.voxels)}</b> voxels &middot; rank ${cell.rank.toFixed(2)} &middot; ${pct(cell.bboxFill)} solid</div>
      <div class="stats dim">called ${escape(cell.called.join(' ') || '—')}</div>
      ${tags === '' ? '' : `<div class="tags">${tags}</div>`}
    </td>`
}

const sections: string[] = []

/* ---- the languages, the thing the eye is for ---- */
for (const subject of SUBJECTS) {
    const rows: string[] = []
    for (const seed of SEEDS) {
        const tds = await Promise.all(
            ARMS.map(arm =>
                cellHtml(
                    cells.find(
                        cell => cell.subject === subject && cell.arm === arm && cell.seed === seed
                    )
                )
            )
        )
        rows.push(`<tr><th class="seed">seed<br>${String(seed)}</th>${tds.join('')}</tr>`)
    }
    const taught = cells.find(cell => cell.subject === subject)?.taught ?? '—'
    sections.push(`<section>
    <h2>${escape(subject)} <span class="taught">taught by <code>${escape(taught)}</code></span></h2>
    <div class="scroll"><table class="grid">
      <thead><tr><th></th>${ARMS.map(arm => `<th>${arm}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>
  </section>`)
}

/* ---- repair, before and after, on the same candidate ---- */
const repaired = cells.filter(cell => cell.repaired.changed && cell.file !== '')
const repairRows = await Promise.all(
    repaired.map(async cell => {
        const what = [
            cell.repaired.dropped > 0 ? `dropped ${String(cell.repaired.dropped)}` : '',
            cell.repaired.bridged > 0 ? `bridged ${String(cell.repaired.bridged)}` : '',
            cell.repaired.thickened > 0 ? `thickened ${String(cell.repaired.thickened)}` : '',
            cell.repaired.lifted > 0 ? `lifted ${String(cell.repaired.lifted)}` : '',
            cell.repaired.mirrored ? 'mirrored' : ''
        ]
            .filter(Boolean)
            .join(', ')
        return `<tr>
      <th class="seed">${escape(cell.subject)}<br><span class="dim">${cell.arm} · ${String(cell.seed)}</span></th>
      <td class="cell"><img src="${await dataUri(cell.file)}" alt="before"><div class="stats">before</div></td>
      <td class="cell"><img src="${cell.repairedFile === undefined ? '' : await dataUri(cell.repairedFile)}" alt="after"><div class="stats">after</div></td>
      <td class="what">${escape(what)}</td>
    </tr>`
    })
)
sections.push(`<section>
  <h2>repair <span class="taught">${String(repaired.length)} of ${String(cells.length)} candidates changed</span></h2>
  <p class="lede">Same candidate, before and after. A rule that fires on a good model is worse than a
  failure that is honest, so what matters here is the ones where the &ldquo;after&rdquo; is worse.</p>
  ${
      repaired.length === 0 ?
          '<p class="lede">Nothing fired. That is the measured no-op on the worked examples holding on real candidates too.</p>'
      :   `<div class="scroll"><table class="grid">${repairRows.join('')}</table></div>`
  }
</section>`)

/* ---- did the model use the language it was given? ---- */
const ADDS: Readonly<Record<string, readonly string[]>> = {
    silhouette: ['front', 'side'],
    procedural: ['tree', 'tower', 'rock'],
    relational: ['part', 'attach', 'legs', 'arms'],
    faces: ['face']
}
const usedNew = (cell: Cell): boolean =>
    (ADDS[cell.arm] ?? []).some(name => cell.called.includes(name))

const uptakeRows = SUBJECTS.map(subject => {
    const tds = ARMS.slice(1)
        .map(arm => {
            const mine = cells.filter(cell => cell.subject === subject && cell.arm === arm)
            const used = mine.filter(usedNew).length
            const klass = used === 0 ? 'bad' : used === mine.length ? 'good' : ''
            return `<td class="${klass}">${String(used)}/${String(mine.length)}</td>`
        })
        .join('')
    return `<tr><th>${escape(subject)}</th>${tds}</tr>`
}).join('')

sections.push(`<section>
  <h2>did the model use the language it was handed?</h2>
  <p class="lede">Counted off the raw reply, not the ops — every experiment emits the same three ops
  by design, so a spec cannot answer this. <code>GEN_IDEAS.md</code> §2 names ignoring the new
  language as the way each of these ideas dies.</p>
  <div class="scroll"><table class="facts wide">
    <thead><tr><th>subject</th>${ARMS.slice(1).map(arm => `<th>${arm}</th>`).join('')}</tr></thead>
    <tbody>${uptakeRows}</tbody>
  </table></div>
  <p class="lede"><code>procedural</code> and <code>faces</code> are told in the system prompt to be
  used only for what they are for — a plant, a building, a rock; a block, a tile, a crate. Of these
  six subjects only the tower and the block qualify, so their scores should be read as
  &ldquo;on the eligible subject&rdquo; rather than as a rate over all six.</p>
</section>`)

/* ---- gates, retryEmpty, and the prop declaration ---- */
const rejected = cells.filter(cell => cell.gate !== undefined && cell.failed === undefined)
const empties = cells.filter(cell => cell.failed !== undefined)
const wrongProp = cells.filter(cell => cell.surface && !cell.subject.includes('block'))
const facesArm = cells.filter(cell => cell.arm === 'faces' && cell.failed === undefined)

const gateRows = rejected
    .map(
        cell =>
            `<tr><td>${escape(cell.subject)}</td><td>${cell.arm}</td><td>${String(cell.seed)}</td><td class="bad">${escape(cell.gate ?? '')}</td><td>${String(cell.voxels)}</td><td>${pct(cell.bboxFill)}</td><td>${pct(cell.connectivity)}</td></tr>`
    )
    .join('')

sections.push(`<section>
  <h2>what the policy switches would have done</h2>
  <table class="facts">
    <tr><th>gates</th><td><b>${String(rejected.length)}</b> of ${String(cells.length - empties.length)} candidates rejected</td></tr>
    <tr><th>retryEmpty</th><td><b>${String(empties.length)}</b> of ${String(cells.length)} replies painted nothing — this is the count <code>GEN_IDEAS.md</code> §11 asks for before building anything</td></tr>
    <tr><th>repair</th><td><b>${String(repaired.length)}</b> of ${String(cells.length - empties.length)} candidates changed</td></tr>
    <tr><th>the prop declaration</th><td><b>${String(wrongProp.length)}</b> candidates declared themselves a prop that are not one, out of ${String(facesArm.length)} runs of the <code>faces</code> arm</td></tr>
  </table>
  ${
      gateRows === '' ? ''
      :   `<div class="scroll"><table class="facts wide"><thead><tr><th>subject</th><th>arm</th><th>seed</th><th>reason</th><th>voxels</th><th>solid</th><th>connected</th></tr></thead><tbody>${gateRows}</tbody></table></div>`
  }
</section>`)

const html = `<title>Which switches earn their place</title>
<style>
  :root {
    --ground:#f7f6f9; --surface:#fff; --surface-2:#efedf4; --ink:#1a1922; --muted:#5f5b70;
    --faint:#8b869c; --rule:#dedbe8; --accent:#5b3fc4; --bad:#a63a33; --shadow:0 1px 2px rgba(26,25,34,.06);
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --ground:#131218; --surface:#1c1b23; --surface-2:#25232e; --ink:#e9e7f1; --muted:#a19db2;
    --faint:#7c7790; --rule:#2f2d3a; --accent:#a89af8; --bad:#e2827a; --shadow:0 1px 2px rgba(0,0,0,.4);
  }}
  :root[data-theme="dark"] {
    --ground:#131218; --surface:#1c1b23; --surface-2:#25232e; --ink:#e9e7f1; --muted:#a19db2;
    --faint:#7c7790; --rule:#2f2d3a; --accent:#a89af8; --bad:#e2827a; --shadow:0 1px 2px rgba(0,0,0,.4);
  }
  body { background:var(--ground); color:var(--ink); font-family:var(--sans); margin:0;
         padding:0 20px 96px; line-height:1.55; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1180px; margin:0 auto; display:flex; flex-direction:column; gap:44px; }
  header { padding-top:64px; display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:clamp(28px,4.6vw,40px); line-height:1.1; letter-spacing:-.022em; margin:0; text-wrap:balance; }
  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase;
             color:var(--accent); margin:0; }
  .standfirst { color:var(--muted); margin:0; max-width:62ch; font-size:18px; }
  section { display:flex; flex-direction:column; gap:14px; }
  h2 { font-size:20px; letter-spacing:-.01em; margin:0; padding-bottom:8px; border-bottom:1px solid var(--rule); }
  .taught { font-family:var(--mono); font-size:12px; font-weight:400; color:var(--faint); }
  .lede { color:var(--muted); margin:0; max-width:68ch; }
  .scroll { overflow-x:auto; }
  table.grid { border-collapse:separate; border-spacing:8px; }
  table.grid thead th { font-family:var(--mono); font-size:12px; color:var(--faint); font-weight:600;
                        text-transform:uppercase; letter-spacing:.06em; padding-bottom:2px; }
  th.seed { font-family:var(--mono); font-size:11px; color:var(--faint); font-weight:500; width:56px; text-align:right; }
  td.cell { background:var(--surface); border:1px solid var(--rule); border-radius:8px; padding:8px;
            width:212px; vertical-align:top; box-shadow:var(--shadow); }
  td.cell.empty { color:var(--faint); text-align:center; }
  td.cell img { display:block; width:196px; height:196px; border-radius:5px; image-rendering:pixelated; background:#222226; }
  .stats { font-family:var(--mono); font-size:11px; color:var(--muted); margin-top:5px; }
  .stats.dim, .dim { color:var(--faint); }
  .tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
  .tag { font-family:var(--mono); font-size:10px; padding:1px 6px; border-radius:99px;
         background:var(--surface-2); color:var(--muted); }
  .tag.bad { background:color-mix(in oklab, var(--bad) 18%, transparent); color:var(--bad); }
  .gone { font-family:var(--mono); font-size:11px; color:var(--bad); padding:82px 4px; text-align:center; }
  td.what { font-family:var(--mono); font-size:12px; color:var(--muted); vertical-align:middle; }
  table.facts { border-collapse:collapse; background:var(--surface); border:1px solid var(--rule);
                border-radius:8px; overflow:hidden; }
  table.facts th, table.facts td { padding:9px 14px; text-align:left; border-bottom:1px solid var(--rule);
                                   font-size:14px; }
  table.facts th { font-family:var(--mono); font-size:12px; color:var(--faint); font-weight:600; white-space:nowrap; }
  table.facts.wide { width:100%; font-family:var(--mono); font-size:12px; }
  table.facts tr:last-child th, table.facts tr:last-child td { border-bottom:none; }
  .bad { color:var(--bad); }
  table.facts td.good { color:var(--accent); font-weight:600; }
  table.facts td.bad { color:var(--bad); font-weight:600; }
  code { font-family:var(--mono); font-size:.88em; background:var(--surface-2); padding:1px 5px; border-radius:3px; }
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">gofer-pixel &middot; ${String(cells.length)} candidates &middot; canvas 32 &middot; temp 0.9</p>
    <h1>Which switches earn their place</h1>
    <p class="standfirst">Six subjects, three fixed seeds, every language switch against off. Same
    subject and same seed in every row, so the only thing that varies across a row is the switch.
    The numbers are the ones the code already computes; the verdict is yours.</p>
  </header>
  ${sections.join('\n')}
</div>`

await writeFile(`${OUT}/sheet.html`, html)
process.stdout.write(`wrote ${OUT}/sheet.html\n`)
