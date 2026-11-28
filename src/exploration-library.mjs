import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {fault} from '../extension/protocol.js';
import {isSameRegularFile} from './platform.mjs';
import {
  LIMITS,
  activeRunIds,
  listRuns,
  loadMeta,
  runPath,
  libraryRoot,
  regularFile,
  atomic,
  verifyArtifacts,
  exclusive,
  digest,
  lockRun,
  recoverLibraryLock,
  replayObservations,
  appendObservation,
  scrub,
  deleteRun,
  deleteAllRuns,
} from './exploration-storage.mjs';
import {graphOf, writeHandoff} from './exploration-model.mjs';
import {handoffFileOf} from './exploration-handoff.mjs';

export {deleteRun, deleteAllRuns};

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const decisions = new Set(['unreviewed', 'automate', 'investigate', 'report_bug', 'closed']);

// Copied by the library page's "Copy QA handoff prompt" button. The handoff
// file carries the detail, so the prompt only states the task and where to read.
export const HANDOFF_TASKS = {
  unreviewed: 'Review Latch exploration run {run}.',
  automate: 'Implement Playwright e2e tests for Latch run {run}. Follow the steps in order and assert the observed behavior.',
  investigate: 'Investigate the findings and gaps in Latch run {run} and report what is still unknown.',
  report_bug: 'Write a bug report for Latch run {run} with reproduction steps, expected vs. actual, and evidence paths.',
  closed: 'Latch run {run} is closed. Use it as reference only.',
};

// Serialized into the library page, so it must stay self-contained.
export function handoffPrompt(run, decision, note, tasks) {
  const label = run.id + (run.objective ? ' (' + run.objective + ')' : '');
  const task = (tasks[decision] || tasks.unreviewed).replace('{run}', label);
  return [task, 'Read: ' + run.handoffPath, note ? 'QA notes: ' + note : ''].filter(Boolean).join('\n');
}

export async function saveReview(id, {decision, note = ''}) {
  if (!decisions.has(decision) || typeof note !== 'string' || note.length > 8000) {
    throw fault(
      'INVALID_REVIEW',
      'Choose unreviewed, automate, investigate, report_bug or closed, and a note under 8000 characters.',
    );
  }
  await loadMeta(id);
  const review = {
    schema: 1,
    run_id: id,
    decision,
    note: scrub(note),
    updated_at: new Date().toISOString(),
    provenance: 'qa_review',
  };
  await atomic(path.join(await runPath(id), 'review.json'), JSON.stringify(review, null, 2) + '\n');
  return review;
}

async function reviewOf(id) {
  try {
    return JSON.parse(await regularFile(path.join(await runPath(id), 'review.json'), 16384));
  } catch (e) {
    if (e.code === 'ENOENT') return {decision: 'unreviewed', note: ''};
    throw e;
  }
}

const artifactURL = (id, relative) => `/artifact/${id}/${relative.split('/').map(encodeURIComponent).join('/')}`;

const style = [
  ':root{--bg:#f3f6f4;--surface:#fff;--surface-2:#f8faf8;--ink:#11252d;--muted:#4d626a;--line:#d9e2dd;--dark:#11252d;--dark-2:#18333d;--emerald:#136f50;--emerald-hover:#0e583f;--mint:#56e3b0;--danger:#b43628;--warn-bg:#fff7e8;--warn-line:#d99b26;--warn-ink:#7a5108;color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;background:var(--bg);color:var(--ink)}',
  '*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;overflow-x:hidden}[hidden]{display:none!important}',
  '.topbar{width:100%;background:var(--dark);color:#f4f7f2;border-bottom:1px solid #213d48}',
  '.topbar-inner{max-width:1440px;margin:0 auto;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;gap:16px}',
  '.brand{color:#fff;text-decoration:none;font-weight:700;font-size:17px;letter-spacing:-.02em;display:inline-flex;align-items:center;gap:8px}',
  '.brand span{font-weight:500;color:#9eb7bf;font-size:14px}',
  '.local-note{font-size:12px;color:#9eb7bf;font-variant-numeric:tabular-nums}',
  'main{max-width:1440px;margin:0 auto;padding:24px 24px 48px}',
  '.crumb{display:inline-flex;align-items:center;gap:6px;color:var(--emerald);text-decoration:none;font-weight:600;font-size:13px;margin-bottom:12px}',
  '.crumb:hover{text-decoration:underline}',
  '.page-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px 24px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--line)}',
  '.page-head h1{margin:0;font-size:clamp(22px,2.4vw,30px);line-height:1.18;letter-spacing:-.025em;max-width:44ch}',
  '.meta-line{margin:6px 0 0;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  '.status-text{font-weight:700;text-transform:capitalize}',
  '.status-finished,.status-succeeded,.status-complete{color:var(--emerald)}',
  '.status-interrupted,.status-failed,.status-failed_or_unknown,.status-start_failed{color:var(--danger)}',
  '.status-partial,.status-active,.status-unknown{color:var(--warn-ink)}',
  'h2{font-size:16px;font-weight:700;margin:0;letter-spacing:-.01em}h3{font-size:13px;font-weight:700;margin:0}p{line-height:1.55;margin:0}',
  '.muted,small{color:var(--muted)}',
  '.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:22px;align-items:start}',
  '.layout>section,.layout>aside{min-width:0}',
  '.layout>aside{position:sticky;top:18px}',
  '.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px;min-width:0}',
  '.panel:last-child{margin-bottom:0}',
  '.panel-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}',
  '.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
  '.seg{display:inline-flex;background:#ebf0ed;border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}',
  '.seg button{border:0;background:transparent;color:var(--muted);padding:5px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background-color .15s ease,color .15s ease}',
  '.seg button:hover{color:var(--ink)}',
  '.seg button.active{background:var(--dark);color:#fff}',
  '.nav-step{display:inline-flex;gap:4px}',
  'button,.button{background:var(--emerald);color:#fff;border:1px solid var(--emerald);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}',
  'button:hover,.button:hover{background:var(--emerald-hover);border-color:var(--emerald-hover)}',
  'button.secondary{background:var(--surface-2);color:var(--ink);border-color:var(--line)}',
  'button.secondary:hover{background:#e8efeb}',
  'button.danger{background:var(--danger);border-color:var(--danger);color:#fff}',
  'button.danger-ghost{background:transparent;color:var(--danger);border:1px solid #e7c6c2;padding:5px 10px;font-size:12px}',
  'button.danger-ghost:hover{background:#fdf2f1}',
  'button.compact{padding:5px 10px;font-size:12px}',
  'button:disabled{opacity:.42;cursor:not-allowed}',
  'a{color:var(--emerald)}',
  'input,select,textarea{width:100%;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:#fff;color:var(--ink)}',
  'textarea{min-height:92px;resize:vertical}',
  'label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px}',
  'label input,label select,label textarea{margin-top:5px}',
  '.check-label{display:inline-flex;align-items:center;gap:6px;margin:0;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;user-select:none}',
  '.check-label input{width:auto;margin:0}',
  '.step-bar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;font-size:13px;font-variant-numeric:tabular-nums}',
  '.step-target{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--muted);overflow-wrap:anywhere}',
  '.film-stage{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}',
  '.film-stage.single{grid-template-columns:minmax(0,1fr)}',
  '.shot-pane{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--surface-2);min-width:0}',
  '.shot-pane h3{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;color:var(--ink)}',
  '.shot-frame{position:relative;border-radius:7px;overflow:hidden;background:#0e1b20;border:1px solid #d2dcd6}',
  '.shot-frame img{width:100%;max-height:460px;object-fit:contain;display:block;cursor:zoom-in}',
  '.film-stage.single .shot-frame img{max-height:600px}',
  '.shot-empty{padding:64px 16px;text-align:center;color:var(--muted);background:#edf2ef;border-radius:7px;font-size:13px}',
  '.shot-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:7px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}',
  '.compare-wrap{border-radius:10px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line);margin-bottom:14px;user-select:none}',
  '.compare-media{position:relative;overflow:hidden;background:#0e1b20}',
  '.compare-base{width:100%;max-height:560px;object-fit:contain;display:block}',
  '.compare-over{position:absolute;inset:0;overflow:hidden}',
  '.compare-over img{width:100%;height:100%;object-fit:contain;display:block}',
  '.compare-divider{position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(17,37,45,.45),0 0 10px rgba(0,0,0,.35);pointer-events:none}',
  '.compare-bar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface-2);border-top:1px solid var(--line);font-size:12px;font-weight:600;color:var(--muted)}',
  '.compare-bar input[type=range]{flex:1;padding:0;border:0;background:transparent}',
  '.film-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 10px;max-width:100%;scrollbar-width:thin}',
  '.film-item{min-width:158px;max-width:176px;text-align:left;background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line);border-radius:10px;padding:8px;flex-shrink:0;transition:border-color .15s ease,background-color .15s ease}',
  '.film-item:hover{background:#edf4f0;border-color:#9cb8ab}',
  '.film-item.active{border-color:var(--emerald);background:#e8f4ee;box-shadow:0 0 0 1px var(--emerald)}',
  '.film-item-head{display:flex;justify-content:space-between;align-items:center;gap:4px;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}',
  '.film-item-sub{display:block;font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.film-thumbs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px}',
  '.film-thumbs img{width:100%;height:46px;object-fit:cover;border-radius:4px;background:#0e1b20;display:block}',
  '.thumb-gap{height:46px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--muted);background:#e5ece8;border-radius:4px}',
  '.film-footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:4px}',
  '.list-scroll{max-height:420px;overflow-y:auto;padding-right:4px}',
  'details.row{border-top:1px solid var(--line);padding:9px 0}',
  'details.row:first-child{border-top:0;padding-top:0}',
  'details.row summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;font-variant-numeric:tabular-nums}',
  'details.row summary::-webkit-details-marker{display:none}',
  'details.row summary:hover .row-title{color:var(--emerald)}',
  '.row-left{display:flex;align-items:center;gap:8px;min-width:0}',
  '.row-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#8da0a7}',
  '.dot.ok{background:var(--emerald)}.dot.err{background:var(--danger)}.dot.warn{background:var(--warn-line)}',
  '.row-meta{font-size:12px;color:var(--muted);white-space:nowrap;flex-shrink:0}',
  '.row-body{margin-top:8px;padding-left:16px}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;background:#eef3f0;padding:10px;border-radius:8px;margin:8px 0 0;max-height:240px;overflow:auto}',
  '.locator-row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}',
  '.locator-item{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:#eef3f0;color:var(--ink);padding:2px 7px;border-radius:6px}',
  '.locator-item.ambig{background:var(--warn-bg);color:var(--warn-ink)}',
  '.link-list{display:grid;gap:8px;margin:0 0 12px}',
  '.link-item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--ink);font-size:13px;font-weight:600}',
  '.link-item:hover{border-color:var(--emerald);color:var(--emerald)}',
  '.link-item small{font-weight:400;font-size:11px}',
  '.warn-box{background:var(--warn-bg);border-left:3px solid var(--warn-line);color:var(--warn-ink);padding:9px 11px;border-radius:6px;font-size:12.5px;margin-bottom:8px;overflow-wrap:anywhere}',
  '.gap-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:12px;color:var(--warn-ink)}',
  '.gap-row:first-child{border-top:0}',
  '.gap-count{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;margin-top:18px}',
  '.run-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .16s ease,transform .16s ease}',
  '.run-card:hover{border-color:var(--emerald);transform:translateY(-2px)}',
  '.run-thumb{height:150px;background:#0e1b20;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:#8aa2aa;font-size:12px;text-decoration:none}',
  '.run-thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}',
  '.run-body{padding:14px 16px;flex:1;display:flex;flex-direction:column;gap:8px}',
  '.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px}',
  '.card-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
  '.card-link{display:block;text-decoration:none;color:inherit}',
  '.card-link h2{font-size:15px;line-height:1.35;margin-bottom:4px}',
  '.search-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:16px}',
  '.search-row input{flex:1;min-width:220px}',
  '.lightbox{position:fixed;inset:0;z-index:100;background:rgba(12,24,29,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:12px}',
  '.lightbox img{max-width:96vw;max-height:84vh;object-fit:contain;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.45)}',
  '.lightbox-bar{display:flex;align-items:center;gap:12px;color:#e6f1ee;font-size:13px}',
  'footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}',
  '#saved,#copy-status,#delete-status{font-size:12px;color:var(--emerald);min-height:18px;margin-top:8px}',
  '@media(max-width:1040px){.layout{grid-template-columns:minmax(0,1fr)}.layout>aside{position:static}}',
  '@media(max-width:720px){main{padding:16px 14px 36px}.topbar-inner{padding:12px 14px}.film-stage{grid-template-columns:minmax(0,1fr)}}',
  '@media(prefers-reduced-motion:reduce){*{transition:none!important}}',
].join('');

function shell(title, body, script = '', nonce = '') {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escape(title)} · Latch</title><style>${style}</style></head><body>`,
    '<header class="topbar"><div class="topbar-inner"><a class="brand" href="/">Latch <span>Exploration library</span></a>',
    '<span class="local-note">127.0.0.1 · Local only</span></div></header>',
    `<main>${body}<footer>Observed evidence stays separate from QA decisions. Local files may contain page content.</footer></main>`,
    script ? `<script nonce="${nonce}">${script}</script>` : '',
    '</body></html>',
  ].join('');
}

function shortTime(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : iso.slice(0, 19);
}

function summarizeGaps(gaps = []) {
  const counts = new Map();
  for (const g of gaps) {
    const label = [g.reason, g.code].filter(Boolean).join(' · ') || 'Capture gap';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({label, count})).sort((a, b) => b.count - a.count);
}

async function catalogue(token, nonce) {
  const runs = await listRuns();
  const activeIds = await activeRunIds();
  const cards = runs
    .map(r => {
      const shots = (r.artifacts || []).filter(a => a.type === 'screenshot');
      const shotCount = shots.length;
      const lastShot = shots.at(-1)?.path || null;
      const isActive = activeIds.has(r.id);
      const actionHtml = isActive
        ? '<small class="muted">Active</small>'
        : `<div class="card-actions">` +
          `<button type="button" class="danger-ghost" data-delete-start="${r.id}">Delete</button>` +
          `<button type="button" class="danger compact" data-delete-confirm="${r.id}" hidden>Confirm</button>` +
          `<button type="button" class="secondary compact" data-delete-cancel="${r.id}" hidden>Cancel</button>` +
          `</div>`;
      const thumbHtml = lastShot
        ? `<img src="${artifactURL(r.id, lastShot)}" alt="Latest screenshot for ${escape(r.objective)}" loading="lazy">`
        : `<span>No screenshots captured</span>`;
      return (
        `<article class="run-card" data-run-card="${r.id}" data-status="${escape(r.status)}" data-search="${escape([r.objective, r.workspace, r.status, r.environment].join(' ').toLowerCase())}">` +
        `<a class="run-thumb" href="/run/${r.id}">${thumbHtml}</a>` +
        `<div class="run-body">` +
        `<div class="card-head"><span class="status-text status-${escape(r.status)}">${escape(String(r.status || '').replaceAll('_', ' '))}</span>${actionHtml}</div>` +
        `<a class="card-link" href="/run/${r.id}">` +
        `<h2>${escape(r.objective)}</h2>` +
        `<p class="muted">${escape(path.basename(r.workspace || ''))} · ${escape(r.environment || 'Local')}</p>` +
        `<small>${escape(shortTime(r.createdAt) || r.createdAt)} · ${escape(r.actions?.length || 0)} transitions · ${escape(shotCount)} screenshots</small>` +
        `</a>` +
        `<p class="muted" data-delete-error="${r.id}" hidden style="color:var(--danger);font-size:12px"></p>` +
        `</div></article>`
      );
    })
    .join('');
  const script = [
    `const grid=document.getElementById('runs-grid');`,
    `let statusFilter='all',query='';`,
    `function applyFilter(){for(const el of grid.querySelectorAll('[data-run-card]')){const qOk=!query||el.dataset.search.includes(query);const sOk=statusFilter==='all'||el.dataset.status===statusFilter;el.hidden=!(qOk&&sOk);}}`,
    `document.getElementById('search').addEventListener('input',e=>{query=e.target.value.toLowerCase();applyFilter();});`,
    `for(const btn of document.querySelectorAll('[data-status-filter]'))btn.addEventListener('click',()=>{statusFilter=btn.dataset.statusFilter;for(const b of document.querySelectorAll('[data-status-filter]'))b.classList.toggle('active',b===btn);applyFilter();});`,
    `function toggleDelete(id,confirming){`,
    `  const card=grid.querySelector('[data-run-card="'+id+'"]');if(!card)return;`,
    `  card.querySelector('[data-delete-start]').hidden=confirming;`,
    `  card.querySelector('[data-delete-confirm]').hidden=!confirming;`,
    `  card.querySelector('[data-delete-cancel]').hidden=!confirming;`,
    `}`,
    `grid.addEventListener('click',async e=>{`,
    `  const btn=e.target.closest('button');if(!btn)return;`,
    `  if(btn.dataset.deleteStart){toggleDelete(btn.dataset.deleteStart,true);return;}`,
    `  if(btn.dataset.deleteCancel){toggleDelete(btn.dataset.deleteCancel,false);return;}`,
    `  const id=btn.dataset.deleteConfirm;if(!id)return;`,
    `  const card=grid.querySelector('[data-run-card="'+id+'"]');`,
    `  const errEl=card.querySelector('[data-delete-error]');`,
    `  errEl.hidden=true;errEl.textContent='';btn.disabled=true;`,
    `  try{`,
    `    const r=await fetch('/run/'+id,{method:'DELETE',headers:{'X-Latch-Review':${JSON.stringify(token)}}});`,
    `    if(!r.ok)throw Error(r.status===409?'Cannot delete an active run.':'Could not delete run.');`,
    `    card.remove();`,
    `    if(!grid.querySelector('[data-run-card]')){const empty=document.createElement('div');empty.className='panel';empty.textContent='No explorations yet. Start one with latch open --record or --objective.';grid.appendChild(empty);}`,
    `  }catch(err){btn.disabled=false;toggleDelete(id,false);errEl.textContent=err.message||'Could not delete run.';errEl.hidden=false;}`,
    `});`,
  ].join('');
  return shell(
    'Library',
    `<div class="page-head"><div><h1>Exploration library</h1>` +
      `<p class="meta-line">Review the before/after screenshot filmstrip, captured states, and locator candidates, then decide what deserves a test.</p></div>` +
      `<div class="seg" role="tablist" aria-label="Filter runs by status">` +
      `<button type="button" class="active" data-status-filter="all">All (${runs.length})</button>` +
      `<button type="button" data-status-filter="finished">Finished</button>` +
      `<button type="button" data-status-filter="partial">Partial</button>` +
      `<button type="button" data-status-filter="interrupted">Interrupted</button>` +
      `</div></div>` +
      `<div class="search-row"><input id="search" aria-label="Search explorations" placeholder="Search project, objective, environment, or status"></div>` +
      `<div class="runs" id="runs-grid">${cards || '<div class="panel">No explorations yet. Start one with latch open --record or --objective.</div>'}</div>`,
    script,
    nonce,
  );
}

function buildFilmstripItems(id, meta, graph) {
  const stateMap = new Map(meta.states.map(s => [s.id, s]));
  if (graph.filmstrip.length) {
    return graph.filmstrip.map((frame, index) => {
      const beforeState = frame.before_state ? stateMap.get(frame.before_state) : null;
      const afterState = frame.after_state ? stateMap.get(frame.after_state) : null;
      const action = meta.actions.find(a => a.id === frame.transition_id);
      const target = action?.action?.target;
      const targetSummary =
        target?.locator_candidate?.name
          ? `${target.locator_candidate.role || 'target'} "${target.locator_candidate.name}"`
          : target?.supplied_selector || target?.snapshot_ref || null;
      return {
        index,
        label: `${index + 1}. ${frame.command}`,
        command: frame.command,
        outcome: frame.outcome,
        startedAt: shortTime(frame.started_at || ''),
        beforeUrl: frame.before ? artifactURL(id, frame.before) : null,
        afterUrl: frame.after ? artifactURL(id, frame.after) : null,
        hasShot: !!(frame.before || frame.after),
        beforeStateId: frame.before_state || null,
        afterStateId: frame.after_state || null,
        beforePageUrl: beforeState?.url || null,
        afterPageUrl: afterState?.url || null,
        beforeSnapshotUrl: beforeState?.snapshot ? artifactURL(id, beforeState.snapshot) : null,
        afterSnapshotUrl: afterState?.snapshot ? artifactURL(id, afterState.snapshot) : null,
        target: targetSummary,
      };
    });
  }
  return meta.states
    .filter(s => s.frame?.id === 'main')
    .map((s, index) => ({
      index,
      label: `${index + 1}. ${s.id}`,
      command: 'state',
      outcome: 'captured',
      startedAt: shortTime(s.captured_at),
      beforeUrl: null,
      afterUrl: s.screenshot ? artifactURL(id, s.screenshot) : null,
      hasShot: !!s.screenshot,
      beforeStateId: null,
      afterStateId: s.id,
      beforePageUrl: null,
      afterPageUrl: s.url,
      beforeSnapshotUrl: null,
      afterSnapshotUrl: artifactURL(id, s.snapshot),
      target: null,
    }));
}

async function runHTML(id, token, nonce) {
  const meta = await loadMeta(id);
  const graph = graphOf(meta);
  const review = await reviewOf(id);
  const integrity = await verifyArtifacts(meta);
  const isActive = (await activeRunIds()).has(id);
  const link = (relative, label) => `<a href="${artifactURL(id, relative)}">${escape(label || relative)}</a>`;
  const filmItems = buildFilmstripItems(id, meta, graph);
  const initialIndex = Math.max(0, filmItems.findIndex(item => item.hasShot));
  const mainStates = meta.states.filter(s => s.frame?.id === 'main');
  const childFrameCount = meta.states.length - mainStates.length;
  const groupedGaps = summarizeGaps(meta.gaps);
  const notices = Array.isArray(meta.notices) ? meta.notices : [];
  const groupedNotices = summarizeGaps(notices);
  const handoffFile = handoffFileOf(meta);
  const handoffPath = path.join(await runPath(id), handoffFile);

  const filmstripThumbsHtml = filmItems
    .map(
      (item, idx) =>
        `<button type="button" class="film-item${idx === initialIndex ? ' active' : ''}" data-film-index="${idx}" data-has-shot="${item.hasShot ? '1' : '0'}">` +
        `<div class="film-item-head"><span>${escape(item.label)}</span><span class="dot ${item.outcome === 'succeeded' || item.outcome === 'captured' ? 'ok' : 'err'}"></span></div>` +
        `<span class="film-item-sub">${escape(item.target || item.outcome)}</span>` +
        `<div class="film-thumbs">` +
        (item.beforeUrl ? `<img src="${item.beforeUrl}" alt="Before ${escape(item.label)}" loading="lazy">` : `<div class="thumb-gap">No before</div>`) +
        (item.afterUrl ? `<img src="${item.afterUrl}" alt="After ${escape(item.label)}" loading="lazy">` : `<div class="thumb-gap">No after</div>`) +
        `</div></button>`,
    )
    .join('');

  const filmstripSectionHtml = filmItems.length
    ? `<div class="step-bar">` +
      `<div id="film-meta"><strong>${escape(filmItems[initialIndex].label)}</strong> · <span class="status-text status-${escape(filmItems[initialIndex].outcome)}">${escape(String(filmItems[initialIndex].outcome || '').replaceAll('_', ' '))}</span></div>` +
      `<div class="step-target" id="film-target">${escape(filmItems[initialIndex].target || '')}</div>` +
      `</div>` +
      `<div id="film-stage" class="film-stage">` +
      `<div class="shot-pane" id="pane-before"><h3><span>Before</span><small id="before-label"></small></h3><div id="before-body"></div></div>` +
      `<div class="shot-pane" id="pane-after"><h3><span>After</span><small id="after-label"></small></h3><div id="after-body"></div></div>` +
      `</div>` +
      `<div id="compare-stage" class="compare-wrap" hidden>` +
      `<div class="compare-media">` +
      `<img id="compare-base" class="compare-base" alt="After screenshot">` +
      `<div id="compare-over" class="compare-over"><img id="compare-before" alt="Before screenshot"></div>` +
      `<div id="compare-divider" class="compare-divider"></div>` +
      `</div>` +
      `<div class="compare-bar"><span>Before</span><input id="compare-range" type="range" min="0" max="100" value="50" aria-label="Before and after comparison slider"><span>After</span></div>` +
      `</div>` +
      `<div class="film-strip" id="film-strip">${filmstripThumbsHtml}</div>` +
      `<div class="film-footer">` +
      `<span>Screenshots: ${escape(graph.screenshots.status)} (${escape(graph.screenshots.count)} PNGs captured across states)</span>` +
      `<span>Click any screenshot to zoom · Use ← / → keys to step</span>` +
      `</div>`
    : `<p class="muted">No screenshots were captured for this run.</p>`;

  const actionsHtml = graph.transitions
    .map((a, idx) => {
      const ok = a.outcome === 'succeeded';
      const target = a.action?.target;
      const targetText = target?.locator_candidate?.name
        ? `${target.locator_candidate.role || ''} "${target.locator_candidate.name}"`.trim()
        : target?.supplied_selector || target?.snapshot_ref || '';
      const isReadOnly = ['snapshot', 'screenshot', 'console', 'network'].includes(a.action.type);
      return (
        `<details class="row" data-action-row data-kind="${isReadOnly ? 'read' : 'mutate'}" data-outcome="${ok ? 'ok' : 'fail'}">` +
        `<summary><span class="row-left"><span class="dot ${ok ? 'ok' : 'err'}"></span>` +
        `<span class="row-title">${idx + 1}. ${escape(a.action.type)}${targetText ? ` · ${escape(targetText)}` : ''}</span></span>` +
        `<span class="row-meta">${escape(shortTime(a.started_at))} · <span class="status-text status-${escape(a.outcome)}">${escape(a.outcome.replaceAll('_', ' '))}</span></span></summary>` +
        `<div class="row-body">` +
        `<p class="muted">${escape(a.from || 'No before state')} → ${escape(a.to || 'No after state')}` +
        (a.filmstrip?.before ? ` · ${link(a.filmstrip.before, 'Before PNG')}` : '') +
        (a.filmstrip?.after ? ` · ${link(a.filmstrip.after, 'After PNG')}` : '') +
        ` · <button type="button" class="secondary compact" data-jump-step="${idx}">Show in filmstrip</button></p>` +
        `<pre>${escape(JSON.stringify(a.action, null, 2))}</pre></div></details>`
      );
    })
    .join('');

  const statesHtml = meta.states
    .map(s => {
      const isMain = s.frame?.id === 'main';
      const candidates = (s.elements || []).filter(e => e.locator_candidate);
      const candidateBadges = candidates
        .slice(0, 12)
        .map(
          e =>
            `<span class="locator-item${e.ambiguous ? ' ambig' : ''}">${escape(e.role)} "${escape(e.name)}"${e.ambiguous ? ' (ambiguous)' : ''}</span>`,
        )
        .join('');
      return (
        `<details class="row" data-state-row data-frame="${isMain ? 'main' : 'child'}"${isMain ? '' : ' hidden'}>` +
        `<summary><span class="row-left"><span class="dot ${s.screenshot ? 'ok' : ''}"></span>` +
        `<span class="row-title">${escape(s.id)} · ${escape(s.title || s.url)}</span></span>` +
        `<span class="row-meta">${escape(s.frame.id)} · ${candidates.length} locators${s.screenshot ? ' · PNG' : ''}</span></summary>` +
        `<div class="row-body">` +
        `<p class="muted">${escape(s.url)} · ${escape(shortTime(s.captured_at))}</p>` +
        `<p style="margin:6px 0">${link(s.snapshot, 'Open YAML snapshot')}` +
        (s.screenshot ? ` · ${link(s.screenshot, 'Open PNG screenshot')}` : '') +
        `</p>` +
        (candidateBadges ? `<div class="locator-row">${candidateBadges}</div>` : '') +
        `<pre>${escape(JSON.stringify({accessible_elements: s.elements, dom_attributes: s.locator_observations || []}, null, 2))}</pre></div></details>`
      );
    })
    .join('');

  const annotationsHtml = meta.annotations.length
    ? meta.annotations
        .map(
          a =>
            `<details class="row" open><summary><span class="row-left"><span class="dot ok"></span><span class="row-title">${escape(a.kind)}</span></span><span class="row-meta">${escape(shortTime(a.at || ''))}</span></summary>` +
            `<div class="row-body"><p>${escape(a.text || a.observed || a.reference)}</p>` +
            (a.observed ? `<p class="muted" style="margin-top:4px"><strong>Observed:</strong> ${escape(a.observed)}</p>` : '') +
            `<p class="muted" style="margin-top:4px"><strong>Expected:</strong> ${escape(a.expected === null || a.expected === undefined ? 'Needs QA review' : typeof a.expected === 'string' ? a.expected : JSON.stringify(a.expected))}</p></div></details>`,
        )
        .join('')
    : `<p class="muted">No checkpoints recorded for this run.</p>`;

  const gapsHtml = groupedGaps.length
    ? `<details class="row" style="margin-top:10px"><summary><span class="row-left"><span class="dot warn"></span><span class="row-title">Capture gaps (${meta.gaps.length})</span></span><span class="row-meta">${groupedGaps.length} unique</span></summary>` +
      `<div class="row-body">${groupedGaps
        .map(g => `<div class="gap-row"><span>${escape(g.label)}</span><span class="gap-count">×${g.count}</span></div>`)
        .join('')}</div></details>`
    : `<p class="muted" style="margin-top:10px">No capture gaps reported.</p>`;

  const noticesHtml = groupedNotices.length
    ? `<details class="row" style="margin-top:10px"><summary><span class="row-left"><span class="dot ok"></span><span class="row-title">Notices (${notices.length})</span></span><span class="row-meta">informational</span></summary>` +
      `<div class="row-body">${groupedNotices
        .map(g => `<div class="gap-row"><span>${escape(g.label)}</span><span class="gap-count">×${g.count}</span></div>`)
        .join('')}</div></details>`
    : '';

  const optionsHtml = [...decisions]
    .map(d => `<option value="${d}" ${d === review.decision ? 'selected' : ''}>${escape(d.replaceAll('_', ' '))}</option>`)
    .join('');

  const script = [
    `const filmItems=${safeJson(filmItems)};`,
    `const runMeta=${safeJson({id, objective: meta.objective, handoffPath, status: meta.status})};`,
    `const handoffTasks=${safeJson(HANDOFF_TASKS)};`,
    `const handoffPrompt=${handoffPrompt.toString()};`,
    `let currentIndex=${initialIndex},viewMode='split',onlyShots=false;`,
    `function visibleIndices(){return filmItems.filter(i=>!onlyShots||i.hasShot).map(i=>i.index);}`,
    `function openLightbox(src,caption){const lb=document.getElementById('lightbox');document.getElementById('lb-img').src=src;document.getElementById('lb-cap').textContent=caption;lb.hidden=false;}`,
    `function closeLightbox(){document.getElementById('lightbox').hidden=true;}`,
    `function renderPane(kind,url,stateId,snapUrl,pageUrl){`,
    `  const label=document.getElementById(kind+'-label');`,
    `  const body=document.getElementById(kind+'-body');`,
    `  label.textContent=stateId||'unavailable';`,
    `  body.textContent='';`,
    `  if(url){const wrap=document.createElement('div');wrap.className='shot-frame';const img=document.createElement('img');img.src=url;img.alt=kind+' screenshot';img.addEventListener('click',()=>openLightbox(url,(filmItems[currentIndex]?.label||'')+' · '+kind+' ('+(stateId||'')+')'));wrap.appendChild(img);body.appendChild(wrap);}else{const d=document.createElement('div');d.className='shot-empty';d.textContent='No screenshot captured';body.appendChild(d);}`,
    `  if(pageUrl||snapUrl){const foot=document.createElement('div');foot.className='shot-foot';const span=document.createElement('span');span.textContent=pageUrl||'';foot.appendChild(span);if(snapUrl){const a=document.createElement('a');a.href=snapUrl;a.textContent='YAML';foot.appendChild(a);}body.appendChild(foot);}`,
    `}`,
    `function renderFilm(){`,
    `  if(!filmItems.length)return;`,
    `  const vis=visibleIndices();`,
    `  if(vis.length&&!vis.includes(currentIndex))currentIndex=vis[0];`,
    `  const item=filmItems[currentIndex];`,
    `  const metaEl=document.getElementById('film-meta');`,
    `  metaEl.textContent='';`,
    `  const strong=document.createElement('strong');strong.textContent=item.label;metaEl.appendChild(strong);`,
    `  metaEl.appendChild(document.createTextNode(' · '));`,
    `  const st=document.createElement('span');st.className='status-text status-'+item.outcome;st.textContent=item.outcome.replaceAll('_',' ');metaEl.appendChild(st);`,
    `  if(item.startedAt){metaEl.appendChild(document.createTextNode(' · '+item.startedAt));}`,
    `  document.getElementById('film-target').textContent=item.target||'';`,
    `  const stage=document.getElementById('film-stage');`,
    `  const cmp=document.getElementById('compare-stage');`,
    `  const canCompare=viewMode==='compare'&&item.beforeUrl&&item.afterUrl;`,
    `  stage.hidden=!!canCompare;cmp.hidden=!canCompare;`,
    `  if(canCompare){document.getElementById('compare-base').src=item.afterUrl;document.getElementById('compare-before').src=item.beforeUrl;const pct=Number(document.getElementById('compare-range').value);document.getElementById('compare-over').style.clipPath='inset(0 '+(100-pct)+'% 0 0)';document.getElementById('compare-divider').style.left=pct+'%';}`,
    `  renderPane('before',item.beforeUrl,item.beforeStateId,item.beforeSnapshotUrl,item.beforePageUrl);`,
    `  renderPane('after',item.afterUrl,item.afterStateId,item.afterSnapshotUrl,item.afterPageUrl);`,
    `  document.getElementById('pane-before').hidden=viewMode==='after';`,
    `  document.getElementById('pane-after').hidden=viewMode==='before';`,
    `  stage.classList.toggle('single',viewMode==='before'||viewMode==='after');`,
    `  const pos=vis.indexOf(currentIndex);`,
    `  document.getElementById('film-prev').disabled=pos<=0;`,
    `  document.getElementById('film-next').disabled=pos<0||pos>=vis.length-1;`,
    `  for(const btn of document.querySelectorAll('[data-film-index]')){const idx=Number(btn.dataset.filmIndex);btn.hidden=onlyShots&&btn.dataset.hasShot!=='1';btn.classList.toggle('active',idx===currentIndex);if(idx===currentIndex)btn.scrollIntoView({block:'nearest',inline:'nearest'});}`,
    `}`,
    `function stepBy(delta){const vis=visibleIndices();const pos=vis.indexOf(currentIndex);const next=vis[pos+delta];if(next!==undefined){currentIndex=next;renderFilm();}}`,
    `if(filmItems.length){`,
    `  for(const btn of document.querySelectorAll('[data-film-index]'))btn.addEventListener('click',()=>{currentIndex=Number(btn.dataset.filmIndex);renderFilm();});`,
    `  for(const btn of document.querySelectorAll('[data-view-mode]'))btn.addEventListener('click',()=>{viewMode=btn.dataset.viewMode;for(const b of document.querySelectorAll('[data-view-mode]'))b.classList.toggle('active',b===btn);renderFilm();});`,
    `  document.getElementById('only-shots')?.addEventListener('change',e=>{onlyShots=e.target.checked;renderFilm();});`,
    `  document.getElementById('compare-range')?.addEventListener('input',e=>{const pct=Number(e.target.value);document.getElementById('compare-over').style.clipPath='inset(0 '+(100-pct)+'% 0 0)';document.getElementById('compare-divider').style.left=pct+'%';});`,
    `  document.getElementById('film-prev').addEventListener('click',()=>stepBy(-1));`,
    `  document.getElementById('film-next').addEventListener('click',()=>stepBy(1));`,
    `  document.getElementById('lb-close').addEventListener('click',closeLightbox);`,
    `  document.getElementById('lightbox').addEventListener('click',e=>{if(e.target.id==='lightbox')closeLightbox();});`,
    `  document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.key==='Escape')closeLightbox();if(e.key==='ArrowLeft')stepBy(-1);if(e.key==='ArrowRight')stepBy(1);});`,
    `  for(const btn of document.querySelectorAll('[data-jump-step]'))btn.addEventListener('click',()=>{onlyShots=false;const cb=document.getElementById('only-shots');if(cb)cb.checked=false;currentIndex=Number(btn.dataset.jumpStep);renderFilm();document.getElementById('filmstrip-panel').scrollIntoView({behavior:'smooth'});});`,
    `  renderFilm();`,
    `}`,
    `for(const btn of document.querySelectorAll('[data-action-filter]'))btn.addEventListener('click',()=>{const mode=btn.dataset.actionFilter;for(const b of document.querySelectorAll('[data-action-filter]'))b.classList.toggle('active',b===btn);for(const row of document.querySelectorAll('[data-action-row]')){row.hidden=mode==='mutate'?row.dataset.kind!=='mutate':mode==='fail'?row.dataset.outcome!=='fail':false;}});`,
    `document.getElementById('show-frames')?.addEventListener('change',e=>{const show=e.target.checked;for(const row of document.querySelectorAll('[data-state-row][data-frame="child"]'))row.hidden=!show;});`,
    `document.getElementById('copy-handoff')?.addEventListener('click',async()=>{const st=document.getElementById('copy-status');const dec=document.getElementById('decision').value;const note=document.getElementById('note').value.trim();const prompt=handoffPrompt(runMeta,dec,note,handoffTasks);try{await navigator.clipboard.writeText(prompt);st.textContent='Copied agent handoff prompt.';}catch{st.textContent='Clipboard unavailable; copy handoff path from above.';}});`,
    `document.getElementById('review').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('saved');status.textContent='Saving…';try{const r=await fetch('/review/${id}',{method:'POST',headers:{'Content-Type':'application/json','X-Latch-Review':${JSON.stringify(token)}},body:JSON.stringify({decision:document.getElementById('decision').value,note:document.getElementById('note').value})});if(!r.ok)throw Error('Could not save');status.textContent='Review saved on this machine.'}catch{status.textContent='Could not save review. Try again.'}});`,
    `{const start=document.getElementById('delete-start'),confirm=document.getElementById('delete-confirm'),cancel=document.getElementById('delete-cancel'),st=document.getElementById('delete-status');`,
    `if(start&&confirm&&cancel){`,
    `  start.addEventListener('click',()=>{start.hidden=true;confirm.hidden=false;cancel.hidden=false;st.textContent='';});`,
    `  cancel.addEventListener('click',()=>{start.hidden=false;confirm.hidden=true;cancel.hidden=true;});`,
    `  confirm.addEventListener('click',async()=>{confirm.disabled=true;st.textContent='Deleting…';try{const r=await fetch('/run/${id}',{method:'DELETE',headers:{'X-Latch-Review':${JSON.stringify(token)}}});if(!r.ok)throw Error(r.status===409?'Cannot delete an active run. Finish or disconnect first.':'Could not delete run.');window.location.href='/';}catch(err){confirm.disabled=false;start.hidden=false;confirm.hidden=true;cancel.hidden=true;st.textContent=err.message||'Could not delete run.';}});`,
    `}}`,
  ].join('');

  const manageRunHtml = isActive
    ? `<div class="panel"><div class="panel-head"><h2>Manage run</h2></div><p class="muted">This run is currently active. Run <code>latch finish</code> or <code>latch disconnect</code> before deleting it.</p></div>`
    : `<div class="panel"><div class="panel-head"><h2>Manage run</h2></div><p class="muted" style="margin-bottom:10px">Permanently remove this run's screenshots, snapshots, and metadata from this machine.</p>` +
      `<div class="card-actions">` +
      `<button type="button" class="danger-ghost" id="delete-start">Delete run</button>` +
      `<button type="button" class="danger compact" id="delete-confirm" hidden>Confirm delete</button>` +
      `<button type="button" class="secondary compact" id="delete-cancel" hidden>Cancel</button>` +
      `</div><p id="delete-status" role="status"></p></div>`;

  return shell(
    meta.objective,
    `<a class="crumb" href="/">← All explorations</a>` +
      `<div class="page-head"><div><h1>${escape(meta.objective)}</h1>` +
      `<p class="meta-line"><span class="status-text status-${escape(meta.status)}">${escape(String(meta.status || '').replaceAll('_', ' '))}</span> · ${escape(path.basename(meta.workspace || ''))} · ${escape(meta.environment || 'Local')} · ${escape(shortTime(meta.createdAt) || meta.createdAt)} · ${graph.transitions.length} steps · ${graph.screenshots.count} PNGs</p></div></div>` +
      (!integrity.verified
        ? '<div class="warn-box">Some evidence has changed or is missing. Review integrity before handing this run off.</div>'
        : '') +
      `<div class="layout"><section>` +
      `<div class="panel" id="filmstrip-panel"><div class="panel-head"><h2>Before / after filmstrip</h2>` +
      (filmItems.length
        ? `<div class="toolbar">` +
          `<label class="check-label"><input type="checkbox" id="only-shots"> With screenshots only</label>` +
          `<div class="seg" role="tablist" aria-label="Filmstrip view mode">` +
          `<button type="button" class="active" data-view-mode="split">Before &amp; After</button>` +
          `<button type="button" data-view-mode="compare">Slider</button>` +
          `<button type="button" data-view-mode="before">Before</button>` +
          `<button type="button" data-view-mode="after">After</button>` +
          `</div>` +
          `<div class="nav-step">` +
          `<button type="button" class="secondary compact" id="film-prev">← Prev</button>` +
          `<button type="button" class="secondary compact" id="film-next">Next →</button>` +
          `</div></div>`
        : '') +
      `</div>${filmstripSectionHtml}</div>` +
      `<div class="panel"><div class="panel-head"><h2>What the agent explored (${graph.transitions.length})</h2>` +
      `<div class="seg" role="tablist" aria-label="Filter recorded actions">` +
      `<button type="button" class="active" data-action-filter="all">All</button>` +
      `<button type="button" data-action-filter="mutate">Actions only</button>` +
      `<button type="button" data-action-filter="fail">Failed</button>` +
      `</div></div><div class="list-scroll">${actionsHtml || '<p class="muted">No managed action steps were recorded.</p>'}</div></div>` +
      `<div class="panel"><div class="panel-head"><h2>Page states and locators (${mainStates.length} main)</h2>` +
      (childFrameCount > 0
        ? `<label class="check-label"><input type="checkbox" id="show-frames"> Show child iframes (${childFrameCount})</label>`
        : '') +
      `</div><div class="list-scroll">${statesHtml || '<p class="muted">No captured states.</p>'}</div></div>` +
      `</section>` +
      `<aside>` +
      `<div class="panel"><div class="panel-head"><h2>Your next step</h2></div>` +
      `<form id="review"><label>Decision<select id="decision">${optionsHtml}</select></label>` +
      `<label>Review notes<textarea id="note" placeholder="Add bug details or test assertions to cover…">${escape(review.note)}</textarea></label>` +
      `<button type="submit">Save review</button><p id="saved" role="status"></p></form></div>` +
      `<div class="panel"><div class="panel-head"><h2>Automation handoff</h2></div>` +
      `<div class="link-list">` +
      `<a class="link-item" href="${artifactURL(id, handoffFile)}"><span>${escape(handoffFile)}</span><small>Agent handoff</small></a>` +
      `<a class="link-item" href="${artifactURL(id, 'exploration.json')}"><span>exploration.json</span><small>JSON</small></a>` +
      `<a class="link-item" href="${artifactURL(id, 'exploration.schema.json')}"><span>exploration.schema.json</span><small>Schema</small></a>` +
      `<a class="link-item" href="${artifactURL(id, 'artifacts.json')}"><span>artifacts.json</span><small>Manifest</small></a>` +
      `</div>` +
      `<button type="button" class="secondary" id="copy-handoff" style="width:100%">Copy QA handoff prompt</button>` +
      `<p id="copy-status" role="status"></p>` +
      `<small>Contains observed states, before/after filmstrip, transitions, and locator candidates. Generated code is excluded.</small></div>` +
      `<div class="panel"><div class="panel-head"><h2>Checkpoints &amp; gaps</h2></div>${annotationsHtml}${gapsHtml}${noticesHtml}` +
      `<p class="muted" style="margin-top:10px;font-size:12px">Cleanup: <span class="status-text status-${escape(meta.cleanup?.status || 'unknown')}">${escape(meta.cleanup?.status || 'unconfirmed')}</span></p></div>` +
      `${manageRunHtml}</aside></div>` +
      `<div class="lightbox" id="lightbox" hidden><img id="lb-img" alt="Zoomed screenshot"><div class="lightbox-bar"><span id="lb-cap"></span><button type="button" class="secondary compact" id="lb-close">Close (Esc)</button></div></div>`,
    script,
    nonce,
  );
}

export async function startLibraryServer({port = 0} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'`,
    );
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) throw fault('FORBIDDEN', 'Invalid host.');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await catalogue(token, nonce));
        return;
      }
      const run = url.pathname.match(/^\/run\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && run) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await runHTML(run[1], token, nonce));
        return;
      }
      if (req.method === 'DELETE' && run) {
        if (req.headers.origin !== origin || req.headers['x-latch-review'] !== token) {
          throw fault('FORBIDDEN', 'Delete requires this local library page.');
        }
        const result = await deleteRun(run[1]);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
      const review = url.pathname.match(/^\/review\/([a-f0-9-]+)$/);
      if (req.method === 'POST' && review) {
        if (req.headers.origin !== origin || req.headers['x-latch-review'] !== token) {
          throw fault('FORBIDDEN', 'Review requires this local library page.');
        }
        let body = '';
        for await (const b of req) {
          body += b;
          if (Buffer.byteLength(body) > 16384) throw fault('INVALID_REVIEW', 'Review too large.');
        }
        const result = await saveReview(review[1], JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
      const artifact = url.pathname.match(/^\/artifact\/([a-f0-9-]+)\/(.+)$/);
      if (req.method === 'GET' && artifact) {
        const meta = await loadMeta(artifact[1]);
        const relative = decodeURIComponent(artifact[2]);
        const indexed = meta.artifacts.find(a => a.path === relative);
        if (!indexed && relative !== 'artifacts.json') throw fault('NOT_FOUND', 'Not an indexed artifact.');
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(s => !s || s === '..' || s === '.')) {
          throw fault('FORBIDDEN', 'Invalid artifact path.');
        }
        const dir = await runPath(meta.id);
        let parent = path.dirname(path.join(dir, relative));
        while (parent !== dir) {
          const s = await fs.lstat(parent);
          if (!s.isDirectory() || s.isSymbolicLink()) throw fault('FORBIDDEN', 'Invalid artifact directory.');
          parent = path.dirname(parent);
        }
        const file = path.join(dir, relative);
        const handle = await fs.open(file, 'r');
        let streamed = false;
        try {
          const stat = await handle.stat();
          const link = await fs.lstat(file);
          if (!(await isSameRegularFile(link, stat, file))) throw fault('FORBIDDEN', 'Invalid artifact.');
          const ext = path.extname(file);
          const types = {
            '.png': 'image/png',
            '.yaml': 'text/plain; charset=utf-8',
            '.json': 'application/json',
            '.jsonl': 'application/x-ndjson; charset=utf-8',
            '.md': 'text/plain; charset=utf-8',
          };
          res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
          if (ext !== '.png') {
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file).replaceAll('"', '')}"`);
          }
          let start = 0;
          let end = stat.size - 1;
          if (req.headers.range) {
            const m = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
            if (!m || +m[1] >= stat.size) {
              res.writeHead(416, {'Content-Range': `bytes */${stat.size}`});
              res.end();
              return;
            }
            start = +m[1];
            end = m[2] ? Math.min(+m[2], end) : end;
            if (end < start) throw fault('INVALID_RANGE', 'Invalid range');
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          }
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', Math.max(0, end - start + 1));
          if (!stat.size) {
            res.end();
            return;
          }
          const stream = handle.createReadStream({start, end, autoClose: true});
          streamed = true;
          stream.on('error', () => res.destroy());
          res.once('close', () => stream.destroy());
          stream.pipe(res);
        } finally {
          if (!streamed) await handle.close();
        }
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode =
        e.code === 'FORBIDDEN'
          ? 403
          : e.code === 'EXPLORATION_BUSY'
            ? 409
            : e.code === 'NOT_FOUND' || e.code === 'ENOENT'
              ? 404
              : 400;
      res.end(e.code || 'LIBRARY_ERROR');
    }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

export async function exportRun(id, destination) {
  const meta = await loadMeta(id);
  const integrity = await verifyArtifacts(meta);
  if (!integrity.verified) throw fault('EVIDENCE_INTEGRITY_FAILED', 'Review missing/changed evidence before export.');
  if (!destination) throw fault('INVALID_ARGUMENT', 'Specify --destination for a new handoff directory.');
  const dest = path.resolve(destination);
  await fs.mkdir(path.dirname(dest), {recursive: true, mode: 0o700});
  await fs.mkdir(dest, {mode: 0o700});
  const dir = await runPath(id);
  const names = new Set([handoffFileOf(meta), 'exploration.json', 'artifacts.json', ...meta.artifacts.map(a => a.path)]);
  for (const name of names) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(p => p === '..')) {
      throw fault('EVIDENCE_PATH_UNSAFE', 'Invalid export path.');
    }
    await fs.mkdir(path.dirname(path.join(dest, name)), {recursive: true, mode: 0o700});
    const data = await regularFile(path.join(dir, name), LIMITS.artifactBytes);
    const expected = meta.artifacts.find(a => a.path === name);
    if (expected && digest(data) !== expected.sha256) {
      throw fault('EVIDENCE_CHANGED', 'Artifact changed during export; partial export preserved.');
    }
    await exclusive(path.join(dest, name), data);
  }
  const review = await reviewOf(id);
  await exclusive(path.join(dest, 'review.json'), JSON.stringify(review, null, 2) + '\n');
  return {exported: true, directory: dest, runId: id, files: names.size + 1};
}

export async function libraryCommand(action = 'list', flags = {}) {
  if (action === 'list') {
    return {
      root: libraryRoot(),
      runs: (await listRuns()).map(r => ({
        id: r.id,
        objective: r.objective,
        environment: r.environment,
        workspace: r.workspace,
        status: r.status,
        createdAt: r.createdAt,
        screenshots: r.artifacts?.filter(a => a.type === 'screenshot').length || 0,
        states: r.states?.length || 0,
        transitions: r.actions?.length || 0,
      })),
    };
  }
  if (action === 'serve') {
    const app = await startLibraryServer({port: flags.port || 0});
    console.log(JSON.stringify({localLibrary: app.url, localOnly: true}));
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        void app.close();
      });
    }
    await new Promise(resolve => app.server.once('close', resolve));
    return;
  }
  if (action === 'delete') {
    if (flags.all && flags.run) {
      throw fault('INVALID_ARGUMENT', 'Specify either --run <id> or --all, not both.');
    }
    if (flags.all) return deleteAllRuns();
    if (!flags.run) throw fault('INVALID_RUN', 'Specify --run <id> or --all.');
    return deleteRun(flags.run);
  }
  if (!flags.run) throw fault('INVALID_RUN', 'Specify --run from library list.');
  if (action === 'show') {
    const meta = await loadMeta(flags.run);
    return {
      run: meta,
      review: await reviewOf(meta.id),
      integrity: await verifyArtifacts(meta),
      handoff: path.join(await runPath(meta.id), handoffFileOf(meta)),
    };
  }
  if (action === 'review') return saveReview(flags.run, {decision: flags.decision, note: flags.note});
  if (action === 'export') return exportRun(flags.run, flags.destination);
  if (action === 'repair') {
    await recoverLibraryLock(flags.run);
    return lockRun(flags.run, async () => {
      const meta = await replayObservations(await loadMeta(flags.run));
      if (meta.pending) {
        meta.status = 'interrupted';
        let completion;
        try {
          const lines = (await regularFile(path.join(await runPath(meta.id), 'commands.jsonl'), LIMITS.ledgerBytes))
            .toString('utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l));
          completion = lines.find(e => e.event === 'finished' && e.step === meta.pending.step);
        } catch {}
        if (!meta.actions.some(a => a.id === meta.pending.step)) {
          const beforeState = meta.pending.from ? meta.states.find(s => s.id === meta.pending.from) : null;
          const pair = {
            before: beforeState?.screenshot || null,
            after: null,
            before_state: meta.pending.from || null,
            after_state: null,
          };
          meta.actions.push({
            id: meta.pending.step,
            command_id: meta.pending.step,
            from: meta.pending.from || null,
            to: null,
            action: meta.pending.action || {type: meta.pending.command},
            outcome: completion?.operation?.outcome === 'succeeded' ? 'succeeded' : 'unknown',
            screenshots: pair,
            filmstrip: pair,
            provenance: 'recovered_command_ledger',
            resulting_state: 'unavailable',
          });
        }
        meta.gaps.push({
          reason: completion
            ? 'Command completion recovered; resulting state unavailable. No action was replayed.'
            : 'An action has no durable completion. Its outcome is unknown; no action was replayed.',
          step: meta.pending.step,
        });
        delete meta.pending;
      }
      try {
        const stop = JSON.parse(await regularFile(path.join(await runPath(meta.id), 'stop-request.json'), 8192));
        if (stop.confirmed) meta.cleanup = {status: 'confirmed', preservedUserTabs: true};
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (!meta.observationTailIncomplete) {
        await appendObservation(meta, {
          type: 'summary',
          summary: {
            status: meta.status,
            recording: meta.recording,
            annotations: meta.annotations,
            gaps: meta.gaps,
            finals: meta.finals,
            cleanup: meta.cleanup,
            finishedAt: meta.finishedAt,
            pending: meta.pending || null,
          },
          artifacts: meta.artifacts,
        });
      }
      await writeHandoff(meta);
      return {repaired: true, replayedActions: 0, runId: meta.id, integrity: await verifyArtifacts(meta)};
    }, {waitMs: 0});
  }
  throw fault('INVALID_COMMAND', 'Use library list, show, serve, review, export, delete or repair.');
}
