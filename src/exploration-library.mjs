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

export {deleteRun, deleteAllRuns};

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const decisions = new Set(['unreviewed', 'automate', 'investigate', 'report_bug', 'closed']);

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
  ':root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui;background:#f4f4f0;color:#24342e}',
  'body{margin:0}[hidden]{display:none!important}',
  'header{padding:22px 5%;background:#173c32;color:#fff;display:flex;justify-content:space-between;align-items:center}',
  'header a{color:white;text-decoration:none;font-weight:700;font-size:22px}',
  'main{max-width:1240px;margin:32px auto;padding:0 24px}',
  'h1{font-size:32px;margin:12px 0}h2{font-size:20px;margin:0 0 12px}p{line-height:1.6}',
  '.muted,small{color:#66766d}',
  '.card{background:#fff;border:1px solid #d9dfd7;border-radius:14px;padding:22px;margin:16px 0}',
  '.pill{display:inline-block;font-size:12px;background:#e5eee7;color:#28503c;padding:4px 10px;border-radius:20px}',
  '.grid{display:grid;grid-template-columns:2fr 1fr;gap:22px}',
  '.runs{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px}',
  '.runs .card{margin:0}.runs .card:hover{border-color:#2d7b59}',
  '.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}',
  '.card-actions{display:flex;gap:6px;align-items:center}',
  '.card-link{display:block;text-decoration:none;color:inherit}',
  'button,.button{background:#1b684a;color:white;border:0;border-radius:8px;padding:8px 14px;font:inherit;text-decoration:none;cursor:pointer}',
  'button.secondary{background:#eef2ec;color:#24342e;border:1px solid #c4cec3}',
  'button.secondary.active{background:#173c32;color:#fff;border-color:#173c32}',
  'button.danger{background:#a83226;color:#fff}',
  'button.danger-ghost{background:transparent;color:#9b2c2c;border:1px solid #e4c2be;padding:4px 10px;font-size:12px}',
  'button.compact{padding:4px 10px;font-size:12px}',
  'button:disabled{opacity:.45;cursor:not-allowed}',
  'input,select,textarea{box-sizing:border-box;font:inherit;border:1px solid #c4cec3;border-radius:8px;padding:10px;width:100%;margin:8px 0}',
  'textarea{min-height:110px}',
  'pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#eef2ec;padding:12px;border-radius:6px}',
  'details{margin:10px 0;padding:8px 0;border-bottom:1px solid #e1e5de}',
  'a{color:#17643f}label{display:block}nav{margin:18px 0}',
  '.warning{background:#fff2da;border-left:4px solid #bd8d25;padding:12px;border-radius:4px}',
  '#saved{font-size:13px;min-height:22px}',
  'footer{padding:24px 0;color:#66766d;font-size:12px}',
  '.film-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:14px}',
  '.film-stage{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}',
  '.film-stage.single{grid-template-columns:1fr}',
  '.shot-pane{border:1px solid #d9dfd7;border-radius:10px;padding:10px;background:#f8faf7}',
  '.shot-pane h3{font-size:13px;margin:0 0 8px;display:flex;justify-content:space-between;color:#28503c}',
  '.shot-pane img{width:100%;max-height:360px;object-fit:contain;background:#101d18;border-radius:6px;display:block}',
  '.shot-empty{padding:48px 16px;text-align:center;color:#66766d;background:#eef2ec;border-radius:6px;font-size:13px}',
  '.film-strip{display:flex;gap:10px;overflow-x:auto;padding:8px 2px}',
  '.film-item{min-width:170px;max-width:190px;text-align:left;background:#f8faf7;color:#24342e;border:2px solid #d9dfd7;border-radius:10px;padding:8px;flex-shrink:0}',
  '.film-item.active{border-color:#1b684a;background:#edf5f0}',
  '.film-thumbs{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px}',
  '.film-thumbs img{width:100%;height:52px;object-fit:cover;border-radius:4px;background:#101d18}',
  '.thumb-gap{height:52px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#66766d;background:#e4e9e2;border-radius:4px}',
  '.locator-badge{display:inline-block;font-size:11px;background:#eef2ec;padding:2px 7px;border-radius:12px;margin:2px 4px 2px 0}',
  '@media(max-width:760px){.grid,.film-stage{grid-template-columns:1fr}}',
].join('');

function shell(title, body, script = '', nonce = '') {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escape(title)} · Latch</title><style>${style}</style></head><body>`,
    '<header><a href="/">Latch <span style="font-weight:400;font-size:15px">/ Exploration library</span></a>',
    '<span>LOCAL ON THIS MACHINE</span></header>',
    `<main>${body}<footer>Observed evidence stays separate from QA decisions. Local files may contain page content.</footer></main>`,
    script ? `<script nonce="${nonce}">${script}</script>` : '',
    '</body></html>',
  ].join('');
}

async function catalogue(token, nonce) {
  const runs = await listRuns();
  const activeIds = await activeRunIds();
  const cards = runs
    .map(r => {
      const shotCount = r.artifacts?.filter(a => a.type === 'screenshot').length ?? 0;
      const isActive = activeIds.has(r.id);
      const actionHtml = isActive
        ? '<small class="muted">Active</small>'
        : `<div class="card-actions">` +
          `<button type="button" class="danger-ghost" data-delete-start="${r.id}">Delete</button>` +
          `<button type="button" class="danger compact" data-delete-confirm="${r.id}" hidden>Confirm</button>` +
          `<button type="button" class="secondary compact" data-delete-cancel="${r.id}" hidden>Cancel</button>` +
          `</div>`;
      return (
        `<div class="card" data-run-card="${r.id}" data-search="${escape([r.objective, r.workspace, r.status, r.environment].join(' ').toLowerCase())}">` +
        `<div class="card-head"><span class="pill">${escape(r.status)}</span>${actionHtml}</div>` +
        `<a class="card-link" href="/run/${r.id}">` +
        `<h2>${escape(r.objective)}</h2>` +
        `<p>${escape(path.basename(r.workspace || ''))} · ${escape(r.environment || 'Environment not specified')}</p>` +
        `<small>${escape(r.createdAt)}<br>${escape(r.states?.length || 0)} states · ${escape(r.actions?.length || 0)} transitions · ${escape(shotCount)} screenshots</small>` +
        `</a>` +
        `<p class="muted" data-delete-error="${r.id}" hidden style="color:#a83226;margin:8px 0 0;font-size:12px"></p>` +
        '</div>'
      );
    })
    .join('');
  const script = [
    `document.getElementById('search').addEventListener('input',e=>{for(const el of document.querySelectorAll('[data-search]'))el.hidden=!el.dataset.search.includes(e.target.value.toLowerCase())});`,
    `const grid=document.getElementById('runs-grid');`,
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
    `    if(!grid.querySelector('[data-run-card]')){const empty=document.createElement('div');empty.className='card';empty.textContent='No explorations yet. Start one with latch open --record or --objective.';grid.appendChild(empty);}`,
    `  }catch(err){btn.disabled=false;toggleDelete(id,false);errEl.textContent=err.message||'Could not delete run.';errEl.hidden=false;}`,
    `});`,
  ].join('');
  return shell(
    'Library',
    `<p class="muted">EXPLORATION → REVIEW → AUTOMATION</p>` +
      `<h1>Pick up where the agent left off.</h1>` +
      `<p class="muted">Review the before/after screenshot filmstrip, captured states, and locator candidates, then decide what deserves a test.</p>` +
      `<input id="search" aria-label="Search explorations" placeholder="Search project, objective or status">` +
      `<div class="runs" id="runs-grid">${cards || '<div class="card">No explorations yet. Start one with latch open --record or --objective.</div>'}</div>`,
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
      return {
        index,
        label: `${index + 1}. ${frame.command}`,
        outcome: frame.outcome,
        startedAt: frame.started_at || '',
        beforeUrl: frame.before ? artifactURL(id, frame.before) : null,
        afterUrl: frame.after ? artifactURL(id, frame.after) : null,
        beforeStateId: frame.before_state || null,
        afterStateId: frame.after_state || null,
        beforePageUrl: beforeState?.url || null,
        afterPageUrl: afterState?.url || null,
        beforeSnapshotUrl: beforeState?.snapshot ? artifactURL(id, beforeState.snapshot) : null,
        afterSnapshotUrl: afterState?.snapshot ? artifactURL(id, afterState.snapshot) : null,
        target: action?.action?.target?.locator_candidate || action?.action?.target?.supplied_selector || null,
      };
    });
  }
  return meta.states
    .filter(s => s.frame?.id === 'main')
    .map((s, index) => ({
      index,
      label: `${index + 1}. ${s.id}`,
      outcome: 'captured',
      startedAt: s.captured_at,
      beforeUrl: null,
      afterUrl: s.screenshot ? artifactURL(id, s.screenshot) : null,
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

  const filmstripThumbsHtml = filmItems
    .map(
      (item, idx) =>
        `<button type="button" class="film-item${idx === 0 ? ' active' : ''}" data-film-index="${idx}">` +
        `<div><strong>${escape(item.label)}</strong></div>` +
        `<small>${escape(item.outcome)}</small>` +
        `<div class="film-thumbs">` +
        (item.beforeUrl ? `<img src="${item.beforeUrl}" alt="Before ${escape(item.label)}">` : `<div class="thumb-gap">No before</div>`) +
        (item.afterUrl ? `<img src="${item.afterUrl}" alt="After ${escape(item.label)}">` : `<div class="thumb-gap">No after</div>`) +
        `</div></button>`,
    )
    .join('');

  const filmstripSectionHtml = filmItems.length
    ? `<div class="film-controls">` +
      `<div id="film-meta"><strong>${escape(filmItems[0].label)}</strong> · <span class="pill">${escape(filmItems[0].outcome)}</span></div>` +
      `<div>` +
      `<button type="button" class="secondary active" data-view-mode="split">Before &amp; After</button> ` +
      `<button type="button" class="secondary" data-view-mode="before">Before only</button> ` +
      `<button type="button" class="secondary" data-view-mode="after">After only</button> ` +
      `<button type="button" class="secondary" id="film-prev">← Prev</button> ` +
      `<button type="button" class="secondary" id="film-next">Next →</button>` +
      `</div></div>` +
      `<div id="film-stage" class="film-stage">` +
      `<div class="shot-pane" id="pane-before"><h3><span>Before</span><small id="before-label"></small></h3><div id="before-body"></div></div>` +
      `<div class="shot-pane" id="pane-after"><h3><span>After</span><small id="after-label"></small></h3><div id="after-body"></div></div>` +
      `</div>` +
      `<div class="film-strip" id="film-strip">${filmstripThumbsHtml}</div>`
    : `<p>No screenshots were captured for this run.</p>`;

  const actionsHtml = graph.transitions
    .map(
      a =>
        `<details><summary>${escape(a.action.type)} · ${escape(a.outcome)} · ${escape(a.started_at)}</summary>` +
        `<p>${escape(a.from || 'Unknown source')} → ${escape(a.to || 'Unknown result')}` +
        (a.filmstrip?.before ? ` · ${link(a.filmstrip.before, 'Before PNG')}` : '') +
        (a.filmstrip?.after ? ` · ${link(a.filmstrip.after, 'After PNG')}` : '') +
        `</p>` +
        `<pre>${escape(JSON.stringify(a.action, null, 2))}</pre></details>`,
    )
    .join('');

  const statesHtml = meta.states
    .map(s => {
      const candidateBadges = (s.elements || [])
        .filter(e => e.locator_candidate)
        .slice(0, 8)
        .map(
          e =>
            `<span class="locator-badge">${escape(e.role)} "${escape(e.name)}"${e.ambiguous ? ' (ambiguous)' : ''}</span>`,
        )
        .join('');
      return (
        `<details><summary>${escape(s.id)} · ${escape(s.title || s.url)} · ${escape(s.frame.id)}</summary>` +
        `<p>${escape(s.url)}</p>` +
        `<p>${link(s.snapshot, 'Open YAML snapshot')}` +
        (s.screenshot ? ` · ${link(s.screenshot, 'Open PNG screenshot')}` : '') +
        ` · ${escape(s.captured_at)}</p>` +
        (candidateBadges ? `<p>${candidateBadges}</p>` : '') +
        `<pre>${escape(JSON.stringify({accessible_elements: s.elements, dom_attributes: s.locator_observations || []}, null, 2))}</pre></details>`
      );
    })
    .join('');

  const annotationsHtml = meta.annotations
    .map(
      a =>
        `<details><summary>${escape(a.kind)} · agent supplied</summary><p>${escape(a.text || a.observed || a.reference)}</p>` +
        (a.observed ? `<p><strong>Observed:</strong> ${escape(a.observed)}</p>` : '') +
        `<p><strong>Expected:</strong> ${escape(a.expected === null || a.expected === undefined ? 'Not specified; needs QA review' : typeof a.expected === 'string' ? a.expected : JSON.stringify(a.expected))}</p>` +
        `<small>Assertion: ${escape(a.assertion_status || 'not_asserted')}</small></details>`,
    )
    .join('');

  const gapsHtml = meta.gaps.map(g => `<p class="warning">${escape(g.reason)} ${escape(g.code || '')}</p>`).join('');
  const optionsHtml = [...decisions]
    .map(d => `<option value="${d}" ${d === review.decision ? 'selected' : ''}>${escape(d.replaceAll('_', ' '))}</option>`)
    .join('');

  const script = [
    `const filmItems=${safeJson(filmItems)};`,
    `let currentIndex=0,viewMode='split';`,
    `function renderPane(kind,url,stateId,snapUrl,pageUrl){`,
    `  const label=document.getElementById(kind+'-label');`,
    `  const body=document.getElementById(kind+'-body');`,
    `  label.textContent=stateId||'unavailable';`,
    `  body.textContent='';`,
    `  if(url){const img=document.createElement('img');img.src=url;img.alt=kind+' screenshot';body.appendChild(img);}else{const d=document.createElement('div');d.className='shot-empty';d.textContent='No screenshot captured';body.appendChild(d);}`,
    `  if(pageUrl||snapUrl){const meta=document.createElement('small');meta.style.display='block';meta.style.marginTop='6px';if(pageUrl)meta.append(document.createTextNode(pageUrl+' '));if(snapUrl){const a=document.createElement('a');a.href=snapUrl;a.textContent='YAML';meta.appendChild(a);}body.appendChild(meta);}`,
    `}`,
    `function renderFilm(){`,
    `  if(!filmItems.length)return;`,
    `  const item=filmItems[currentIndex];`,
    `  const metaEl=document.getElementById('film-meta');`,
    `  metaEl.textContent='';`,
    `  const strong=document.createElement('strong');strong.textContent=item.label;metaEl.appendChild(strong);`,
    `  metaEl.appendChild(document.createTextNode(' · '));`,
    `  const pill=document.createElement('span');pill.className='pill';pill.textContent=item.outcome;metaEl.appendChild(pill);`,
    `  renderPane('before',item.beforeUrl,item.beforeStateId,item.beforeSnapshotUrl,item.beforePageUrl);`,
    `  renderPane('after',item.afterUrl,item.afterStateId,item.afterSnapshotUrl,item.afterPageUrl);`,
    `  const stage=document.getElementById('film-stage');`,
    `  document.getElementById('pane-before').hidden=viewMode==='after';`,
    `  document.getElementById('pane-after').hidden=viewMode==='before';`,
    `  stage.classList.toggle('single',viewMode!=='split');`,
    `  document.getElementById('film-prev').disabled=currentIndex===0;`,
    `  document.getElementById('film-next').disabled=currentIndex>=filmItems.length-1;`,
    `  for(const btn of document.querySelectorAll('[data-film-index]'))btn.classList.toggle('active',Number(btn.dataset.filmIndex)===currentIndex);`,
    `}`,
    `if(filmItems.length){`,
    `  for(const btn of document.querySelectorAll('[data-film-index]'))btn.addEventListener('click',()=>{currentIndex=Number(btn.dataset.filmIndex);renderFilm();});`,
    `  for(const btn of document.querySelectorAll('[data-view-mode]'))btn.addEventListener('click',()=>{viewMode=btn.dataset.viewMode;for(const b of document.querySelectorAll('[data-view-mode]'))b.classList.toggle('active',b===btn);renderFilm();});`,
    `  document.getElementById('film-prev').addEventListener('click',()=>{if(currentIndex>0){currentIndex--;renderFilm();}});`,
    `  document.getElementById('film-next').addEventListener('click',()=>{if(currentIndex<filmItems.length-1){currentIndex++;renderFilm();}});`,
    `  renderFilm();`,
    `}`,
    `document.getElementById('review').addEventListener('submit',async e=>{e.preventDefault();const status=document.getElementById('saved');status.textContent='Saving…';try{const r=await fetch('/review/${id}',{method:'POST',headers:{'Content-Type':'application/json','X-Latch-Review':${JSON.stringify(token)}},body:JSON.stringify({decision:document.getElementById('decision').value,note:document.getElementById('note').value})});if(!r.ok)throw Error('Could not save');status.textContent='Review saved on this machine.'}catch{status.textContent='Could not save review. Try again.'}});`,
    `{const start=document.getElementById('delete-start'),confirm=document.getElementById('delete-confirm'),cancel=document.getElementById('delete-cancel'),st=document.getElementById('delete-status');`,
    `if(start&&confirm&&cancel){`,
    `  start.addEventListener('click',()=>{start.hidden=true;confirm.hidden=false;cancel.hidden=false;st.textContent='';});`,
    `  cancel.addEventListener('click',()=>{start.hidden=false;confirm.hidden=true;cancel.hidden=true;});`,
    `  confirm.addEventListener('click',async()=>{confirm.disabled=true;st.textContent='Deleting…';try{const r=await fetch('/run/${id}',{method:'DELETE',headers:{'X-Latch-Review':${JSON.stringify(token)}}});if(!r.ok)throw Error(r.status===409?'Cannot delete an active run. Finish or disconnect first.':'Could not delete run.');window.location.href='/';}catch(err){confirm.disabled=false;start.hidden=false;confirm.hidden=true;cancel.hidden=true;st.textContent=err.message||'Could not delete run.';}});`,
    `}}`,
  ].join('');

  const manageRunHtml = isActive
    ? `<div class="card"><h2>Manage run</h2><p class="muted">This run is currently active. Run <code>latch finish</code> or <code>latch disconnect</code> before deleting it.</p></div>`
    : `<div class="card"><h2>Manage run</h2><p class="muted">Permanently remove this run's screenshots, snapshots, and metadata from this machine.</p>` +
      `<div class="card-actions">` +
      `<button type="button" class="danger-ghost" id="delete-start">Delete run</button>` +
      `<button type="button" class="danger" id="delete-confirm" hidden>Confirm delete</button>` +
      `<button type="button" class="secondary" id="delete-cancel" hidden>Cancel</button>` +
      `</div><p id="delete-status" role="status"></p></div>`;

  return shell(
    meta.objective,
    `<nav><a href="/">← All explorations</a></nav><span class="pill">${escape(meta.status)}</span>` +
      `<h1>${escape(meta.objective)}</h1>` +
      `<p class="muted">${escape(meta.workspace)} · ${escape(meta.environment || 'Environment not specified')} · ${escape(meta.createdAt)}</p>` +
      (!integrity.verified
        ? '<p class="warning">Some evidence has changed or is missing. Review the integrity problems before handing this run off.</p>'
        : '') +
      `<div class="grid"><section>` +
      `<div class="card"><h2>Before / after filmstrip</h2>${filmstripSectionHtml}` +
      `<p class="muted">Screenshots: ${escape(graph.screenshots.status)} (${escape(graph.screenshots.count)} PNGs captured across states).</p></div>` +
      `<div class="card"><h2>What the agent explored</h2>${actionsHtml || '<p>No managed action steps were recorded.</p>'}</div>` +
      `<div class="card"><h2>Page states and locators</h2>${statesHtml || '<p>No captured states.</p>'}</div></section>` +
      `<aside><div class="card"><h2>Automation handoff</h2><p>${link('exploration.yaml', 'Download exploration.yaml')}</p>` +
      `<p>${link('exploration.json', 'Download exploration.json')}</p>` +
      `<p>${link('exploration.schema.json', 'View exploration.schema.json')}</p>` +
      `<p>${link('artifacts.json', 'Artifact manifest')}</p><small>Contains observed states, before/after screenshot filmstrip, transitions and locator candidates. Generated code is excluded.</small></div>` +
      `<div class="card"><h2>Your next step</h2><form id="review"><label>Decision<select id="decision">${optionsHtml}</select></label>` +
      `<label>Review notes<textarea id="note">${escape(review.note)}</textarea></label><button>Save review</button><p id="saved" role="status"></p></form></div>` +
      `<div class="card"><h2>Checkpoints, findings and gaps</h2>${annotationsHtml}${gapsHtml || '<p>No capture gaps reported.</p>'}` +
      `<p>Cleanup: ${escape(meta.cleanup?.status || 'unconfirmed')}</p></div>${manageRunHtml}</aside></div>`,
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
  const names = new Set(['exploration.yaml', 'exploration.json', 'artifacts.json', ...meta.artifacts.map(a => a.path)]);
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
      handoff: path.join(await runPath(meta.id), 'exploration.yaml'),
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
    });
  }
  throw fault('INVALID_COMMAND', 'Use library list, show, serve, review, export, delete or repair.');
}
