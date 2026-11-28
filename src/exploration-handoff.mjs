// Compact, step-centric handoff for AI agents writing UI + API e2e tests.
// Derived from the full exploration graph (exploration.json), which stays the
// source of truth for tooling. See docs/HANDOFF-V2.md.
import crypto from 'node:crypto';
import {apiPath, sameSite} from './network-shape.mjs';

export const HANDOFF_FILE = 'handoff.yaml';
export const HANDOFF_SCHEMA_FILE = 'handoff.schema.json';
export const HANDOFF_SCHEMA_VERSION = 2;
export const VERDICTS = ['unreviewed', 'expected', 'bug', 'ignore'];

// Commands that only observe the page. They are evidence, not user steps.
const OBSERVATION_TYPES = new Set(['snapshot', 'screenshot', 'console', 'network', 'generate-locator', 'highlight']);
// Commands whose internals are not captured.
const OPAQUE_TYPES = new Set(['run-code', 'eval']);
const INPUT_TYPES = new Set(['fill', 'type', 'select', 'upload']);
// Steps that usually submit or trigger something, where "no request" is informative.
const TRIGGER_TYPES = new Set(['click', 'dblclick', 'press', 'check', 'uncheck', 'select', 'dialog']);
// Roles whose text is a user-entered value: never copied into the handoff.
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const LIVE_ROLES = new Set(['alert', 'alertdialog', 'status', 'dialog', 'log', 'marquee', 'timer']);
const MAX_EFFECTS = 10;
// Roles whose text has no accessible name of its own.
const BARE_ROLES = new Set(['generic', 'text', 'paragraph', 'strong', 'emphasis', 'cell', 'definition']);

const compact = obj => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    // An empty network list is meaningful ("no request was sent"); other empty lists are noise.
    if (Array.isArray(v) && !v.length && k !== 'network') continue;
    out[k] = v;
  }
  return out;
};

export const isUserStep = transition => !OBSERVATION_TYPES.has(transition.action?.type || '');

// --- Locators --------------------------------------------------------------

// Match a role/name snapshot target to DOM attribute observations from the same
// state, by accessible label. Only an unambiguous match is used.
function fallbacksFor(target, state) {
  const name = target?.locator_candidate?.name;
  if (!name || !state) return [];
  const matches = (state.locator_observations || []).filter(o => o.attributes?.label === name);
  if (matches.length !== 1) return [];
  const a = matches[0].attributes;
  return [
    a.test_id ? {test_id: a.test_id, attribute: a.test_id_attribute || 'data-testid'} : null,
    a.id ? {css: `#${a.id}`} : null,
    a.name ? {css: `[name="${a.name}"]`} : null,
  ].filter(Boolean);
}

function targetOf(target, statesById) {
  if (!target) return null;
  const candidate = target.locator_candidate;
  if (candidate?.strategy === 'role') {
    const state = statesById.get(target.state);
    const element = state?.elements?.find(e => e.snapshot_ref === target.snapshot_ref);
    return compact({
      role: candidate.role,
      name: candidate.name,
      ambiguous: element?.ambiguous || undefined,
      flags: element?.observed_flags,
      fallbacks: fallbacksFor(target, state),
    });
  }
  if (target.supplied_selector) return {selector: target.supplied_selector, verified: false};
  if (target.snapshot_ref) return {snapshot_ref: target.snapshot_ref, state: target.state, locator: null};
  return null;
}

const labelOf = target =>
  target?.name ? `${target.role || 'element'} "${target.name}"` : target?.selector ? `"${target.selector}"` : target?.role || null;

// --- Page effects (snapshot diff) -------------------------------------------

const LINE_RE = /^(\s*)-\s+([a-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*(?::\s*(.*))?$/i;

const unquote = text => {
  const t = (text || '').trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return t;
};

// Parse an AI ARIA snapshot into comparable items. Values typed into inputs are dropped.
export function snapshotItems(snapshot) {
  const items = [];
  const lastAtDepth = new Map();
  let valueDepth = -1;
  for (const line of String(snapshot || '').split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const depth = m[1].length;
    // Everything nested under an input is its value (e.g. "- text: <typed>").
    if (valueDepth >= 0 && depth > valueDepth) continue;
    valueDepth = -1;
    for (const d of [...lastAtDepth.keys()]) if (d > depth) lastAtDepth.delete(d);
    const role = m[2].toLowerCase();
    if (VALUE_ROLES.has(role)) valueDepth = depth;
    const sibling = lastAtDepth.get(depth);
    lastAtDepth.set(depth, null);
    if (role.startsWith('/')) continue;
    let name = null;
    if (m[3] !== undefined) {
      try {
        name = JSON.parse(`"${m[3]}"`);
      } catch {
        name = m[3];
      }
    }
    const attrs = [...(m[4] || '').matchAll(/\[([^\]]*)\]/g)].map(a => a[1]);
    const ref = attrs.find(a => a.startsWith('ref='))?.slice(4) || null;
    // Focus ([active]) and pointer hints are noise; state flags (disabled, checked, ...) are kept.
    const flags = attrs.filter(a => !/^(?:ref|cursor|level)=/.test(a) && a !== 'active').sort();
    const text = VALUE_ROLES.has(role) ? '' : unquote(m[5]);
    lastAtDepth.set(depth, name || text || null);
    if (!name && !text && !LIVE_ROLES.has(role) && !flags.length) continue;
    // A bare value ("$39.00") is identified by the label just before it ("Total due today").
    const context = !name && BARE_ROLES.has(role) && sibling && sibling !== text ? sibling : null;
    items.push({role, name, text: text || null, flags, ref, context});
  }
  return items;
}

const sig = i => JSON.stringify([i.role, i.name, i.text, i.flags, i.context]);

function locatorOf(item) {
  if (item.name) return {role: item.role, name: item.name};
  return compact({role: item.role === 'text' ? null : item.role, text: item.text, after_label: item.context});
}

const priority = e =>
  LIVE_ROLES.has(e.item.role) ? 0 : e.kind === 'changed' ? 1 : /\d/.test(e.item.text || e.item.name || '') ? 2 : 3;

export function effectsOf(beforeSnapshot, afterSnapshot) {
  const before = snapshotItems(beforeSnapshot);
  const after = snapshotItems(afterSnapshot);
  const count = new Map();
  for (const i of before) count.set(sig(i), (count.get(sig(i)) || 0) + 1);
  const appeared = [];
  for (const i of after) {
    const n = count.get(sig(i)) || 0;
    if (n > 0) count.set(sig(i), n - 1);
    else appeared.push(i);
  }
  const remaining = new Map(count);
  const disappeared = [];
  for (const i of before) {
    const n = remaining.get(sig(i)) || 0;
    if (n > 0) {
      remaining.set(sig(i), n - 1);
      disappeared.push(i);
    }
  }
  const effects = [];
  // Pair an appeared item with the disappeared one it replaced: same ref, or same role and name.
  for (const a of [...appeared]) {
    const d = disappeared.find(
      x =>
        x.role === a.role &&
        ((a.name && x.name === a.name) || (!a.name && !x.name && a.context && x.context === a.context) || (a.ref && x.ref === a.ref)),
    );
    if (!d) continue;
    appeared.splice(appeared.indexOf(a), 1);
    disappeared.splice(disappeared.indexOf(d), 1);
    effects.push({kind: 'changed', item: a, from: d});
  }
  for (const item of appeared) effects.push({kind: 'appeared', item});
  for (const item of disappeared) effects.push({kind: 'disappeared', item});
  effects.sort((x, y) => priority(x) - priority(y));
  const shown = effects.slice(0, MAX_EFFECTS).map(e => {
    const locator = locatorOf(e.kind === 'changed' && !e.item.name && e.from.text !== e.item.text ? {...e.item, text: null} : e.item);
    if (e.kind === 'changed') {
      return {
        changed: compact({
          ...locator,
          from: e.from.text !== e.item.text ? e.from.text : null,
          to: e.from.text !== e.item.text ? e.item.text : null,
          flags_from: JSON.stringify(e.from.flags) !== JSON.stringify(e.item.flags) ? e.from.flags.join(' ') || 'none' : null,
          flags_to: JSON.stringify(e.from.flags) !== JSON.stringify(e.item.flags) ? e.item.flags.join(' ') || 'none' : null,
        }),
      };
    }
    return {[e.kind]: compact({...locator, text: e.item.name && e.item.text ? e.item.text : locator.text})};
  });
  return {effects: shown, more: Math.max(0, effects.length - MAX_EFFECTS)};
}

// --- Network ------------------------------------------------------------------

const bodyOf = body => (!body ? null : ['json', 'form'].includes(body.type) ? {[body.type]: body.shape} : body.type);

function networkOf(entries, baseUrl) {
  const api = [];
  let other = 0;
  for (const e of entries) {
    if (baseUrl && !sameSite(e.url, baseUrl)) {
      other++;
      continue;
    }
    const {path, query} = apiPath(e.url);
    api.push(
      compact({
        method: e.method,
        path,
        query,
        status: e.status ?? (e.failure ? null : 'pending'),
        failed: e.failure || null,
        auth: e.authorization,
        request: bodyOf(e.request),
        response: bodyOf(e.response),
        late: e.late || null,
      }),
    );
  }
  return {api, other};
}

// --- Steps --------------------------------------------------------------------

function stepOf(t, index, ctx, extraNetwork) {
  const {statesById, snapshots, baseUrl} = ctx;
  const type = t.action?.type || 'action';
  const before = statesById.get(t.from);
  const after = statesById.get(t.to);
  const value = INPUT_TYPES.has(type) ? (t.action?.data_reference ? `$${t.action.data_reference}` : '<redacted>') : null;
  const target = targetOf(t.action?.target, statesById);
  const navigated = after?.url && before?.url && after.url !== before.url ? after.url : null;

  let effects = [];
  let more = 0;
  const beforeText = before && snapshots.get(before.snapshot);
  const afterText = after && snapshots.get(after.snapshot);
  if (before && after && before.id !== after.id && before.page === after.page && !navigated && beforeText && afterText) {
    ({effects, more} = effectsOf(beforeText, afterText));
  }

  const hasNetwork = Array.isArray(t.network) || extraNetwork.some(Array.isArray);
  const entries = [...(t.network || []), ...extraNetwork.flat().filter(Boolean)];
  const {api, other} = networkOf(entries, baseUrl);

  const assert = [];
  if (navigated) assert.push({url: apiPath(navigated).path});
  for (const e of effects) {
    if (e.changed && e.changed.to) assert.push({locator: locatorOnly(e.changed), text: e.changed.to});
    else if (e.changed && e.changed.flags_to) assert.push({locator: locatorOnly(e.changed), flags: e.changed.flags_to});
    else if (e.appeared) assert.push({locator: locatorOnly(e.appeared), visible: true});
    else if (e.disappeared) assert.push({locator: locatorOnly(e.disappeared), hidden: true});
  }
  for (const r of api.filter(r => !r.late)) assert.push(compact({request: `${r.method} ${r.path}`, status: r.status}));
  if (hasNetwork && !api.length && TRIGGER_TYPES.has(type)) assert.push({no_request: 'same-site API'});

  return compact({
    id: `s${index + 1}`,
    ref: t.id,
    action: type,
    opaque: OPAQUE_TYPES.has(type) || undefined,
    target,
    destination: targetOf(t.action?.destination, statesById),
    url: t.action?.navigation_url,
    value,
    navigated_to: navigated,
    outcome: t.outcome === 'succeeded' ? null : t.outcome,
    error: t.error ? `${t.error.code}: ${t.error.message}` : null,
    expectation: t.expectation ? (t.expectation.error ?? t.expectation.value) : null,
    assertion: t.assertion_status && t.assertion_status !== 'not_asserted' ? t.assertion_status : null,
    // `network: []` is kept on purpose: "no request was sent" is assertable.
    network: hasNetwork ? api : null,
    other_requests: other || null,
    effects,
    more_effects: more || null,
    assert,
    evidence: compact({
      before: t.filmstrip?.before ?? null,
      after: t.filmstrip?.after ?? null,
      snapshot: after?.snapshot ?? null,
    }),
  });
}

function locatorOnly(effect) {
  const {from, to, flags_from, flags_to, ...locator} = effect;
  return locator;
}

// --- Behaviors ----------------------------------------------------------------

const quoteText = t => (t && t.length > 80 ? `"${t.slice(0, 77)}…"` : `"${t}"`);

function describeEffect(e) {
  if (e.changed) {
    const what = e.changed.name
      ? `${e.changed.role} "${e.changed.name}"`
      : e.changed.after_label
        ? `value after "${e.changed.after_label}"`
        : e.changed.role && e.changed.role !== 'generic'
          ? e.changed.role
          : 'text';
    if (e.changed.to) return `${what} changes from ${quoteText(e.changed.from)} to ${quoteText(e.changed.to)}`;
    return `${what} becomes ${e.changed.flags_to}`;
  }
  const [kind, item] = Object.entries(e)[0];
  const what = item.name
    ? `${item.role} "${item.name}"`
    : `${item.role && item.role !== 'generic' ? item.role + ' ' : 'text '}${item.text ? quoteText(item.text) : ''}`.trim();
  return `${what} ${kind === 'appeared' ? 'appears' : 'disappears'}`;
}

function draftBehavior(step) {
  if (INPUT_TYPES.has(step.action) && !step.network?.length && !step.navigated_to) return null;
  const parts = [];
  if (step.navigated_to) parts.push(`navigates to ${apiPath(step.navigated_to).path}`);
  for (const e of (step.effects || []).slice(0, 3)) parts.push(describeEffect(e));
  for (const r of (step.network || []).filter(r => !r.late).slice(0, 3)) parts.push(`sends ${r.method} ${r.path} (${r.status ?? 'no response'})`);
  if (step.assert?.some(a => a.no_request)) parts.push('sends no API request');
  if (!parts.length) return null;
  const subject = [step.action, labelOf(step.target)].filter(Boolean).join(' ');
  return {text: `${subject}: ${parts.join('; ')}`, steps: [step.id]};
}

export const behaviorId = (source, text, steps) =>
  'b-' + crypto.createHash('sha256').update(JSON.stringify([source, text, steps])).digest('hex').slice(0, 8);

// --- Annotations --------------------------------------------------------------

// Annotations carry an explicit transition, or else attach to the latest user
// step that finished before the annotation was written.
function stepForAnnotation(annotation, steps, transitions) {
  const byRef = new Map(steps.map(s => [s.ref, s.id]));
  if (annotation.transition) {
    if (byRef.has(annotation.transition)) return byRef.get(annotation.transition);
    const i = transitions.findIndex(t => t.id === annotation.transition);
    for (let j = i; j >= 0; j--) if (byRef.has(transitions[j].id)) return byRef.get(transitions[j].id);
    return null;
  }
  if (!annotation.at) return null;
  let found = null;
  for (const t of transitions) {
    if (t.finished_at && t.finished_at <= annotation.at && byRef.has(t.id)) found = byRef.get(t.id);
  }
  return found;
}

function annotationOf(a, steps, transitions) {
  return compact({
    text: a.text || a.observed || a.reference || null,
    expected: a.expected,
    step: stepForAnnotation(a, steps, transitions),
    evidence: a.evidence,
  });
}

// --- Handoff ------------------------------------------------------------------

/**
 * @param graph  exploration graph (graphOf)
 * @param opts.snapshots  Map of snapshot path -> snapshot text, for page effects
 * @param opts.verdicts   {behaviorId: verdict} from review.json
 */
export function handoffOf(graph, {snapshots = new Map(), verdicts = {}} = {}) {
  const statesById = new Map(graph.states.map(s => [s.id, s]));
  const baseUrl = graph.observed_start_url || graph.requested_start_url || null;
  const ctx = {statesById, snapshots, baseUrl};

  // Observation commands are folded into the preceding user step, including any
  // requests they happened to see.
  const groups = [];
  for (const t of graph.transitions) {
    if (isUserStep(t)) groups.push({t, extra: []});
    else if (groups.length) groups.at(-1).extra.push(t.network);
  }
  const steps = groups.map((g, i) => stepOf(g.t, i, ctx, g.extra));
  const pages = graph.pages || [];
  if (pages.length > 1) {
    steps.forEach((step, i) => {
      const t = groups[i].t;
      const page = statesById.get(t.from)?.page || statesById.get(t.to)?.page;
      if (page) step.page = page;
    });
  }

  const ann = list => (list || []).map(a => annotationOf(a, steps, graph.transitions));
  const testData = (graph.test_data || []).map(a =>
    compact({ref: a.reference, text: a.text, step: stepForAnnotation(a, steps, graph.transitions)}),
  );
  for (const step of steps) {
    const ref = typeof step.value === 'string' && step.value.startsWith('$') ? step.value.slice(1) : null;
    if (ref && !testData.some(d => d.ref === ref)) testData.push({ref, step: step.id});
  }

  // Behaviors are what a human reviews: observed (drafted from effects and
  // network), plus the exploring agent's behavior and finding notes.
  const behaviors = [];
  const addBehavior = (source, b, extra = {}) => {
    if (!b?.text) return;
    const stepIds = b.steps || (b.step ? [b.step] : []);
    const id = behaviorId(source, b.text, stepIds);
    if (behaviors.some(x => x.id === id)) return;
    const verdict = VERDICTS.includes(verdicts[id]) ? verdicts[id] : 'unreviewed';
    behaviors.push(compact({id, text: b.text, source, steps: stepIds, expected: b.expected, evidence: b.evidence, ...extra, verdict}));
  };
  for (const a of ann(graph.behaviors)) addBehavior('agent', a);
  for (const a of ann(graph.findings)) addBehavior('finding', a);
  for (const step of steps) addBehavior('observed', draftBehavior(step));

  const gapReasons = new Map();
  for (const gap of graph.coverage?.gaps || []) {
    const step = steps.find(s => s.ref === gap.step)?.id;
    const entry = gapReasons.get(gap.reason) || {reason: gap.reason, steps: []};
    if (step && !entry.steps.includes(step)) entry.steps.push(step);
    gapReasons.set(gap.reason, entry);
  }
  const redacted = steps.filter(s => s.value === '<redacted>').map(s => s.id);
  const load = graph.load_network?.length ? networkOf(graph.load_network, baseUrl).api : null;

  return compact({
    $schema: `./${HANDOFF_SCHEMA_FILE}`,
    format: 'latch.handoff',
    schema_version: HANDOFF_SCHEMA_VERSION,
    run_id: graph.run_id,
    objective: graph.objective,
    environment: graph.environment,
    status: graph.status,
    base_url: baseUrl,
    pages: pages.length > 1 ? pages.map(p => compact({id: p.id, opener: p.opener_page, url: p.first_observed_url})) : null,
    prerequisites: ann(graph.prerequisites),
    test_data: testData,
    on_load: load,
    steps,
    behaviors,
    questions: ann(graph.coverage?.questions),
    gaps: [
      ...[...gapReasons.values()].map(g => compact(g)),
      ...ann(graph.coverage?.agent_reported_gaps),
      redacted.length ? {reason: 'Input values were redacted. Supply test data before automating.', steps: redacted} : null,
    ].filter(Boolean),
    notes: [
      'Behavior verdicts: expected = cover it; bug = assert the correct behavior (fails until fixed); ignore = skip; unreviewed = ask QA.',
      'assert entries are candidates derived from observed changes and requests. Keep only those that support a covered behavior.',
      'Locators come from recorded snapshots. Re-verify them against the live app.',
      'Request and response bodies are shapes (keys and types); values were not recorded.',
      'Full state graph, snapshots and screenshots: exploration.json and the paths under evidence.',
    ],
  });
}

// Runs finished before handoff.yaml existed only have exploration.yaml.
export function handoffFileOf(meta) {
  const paths = new Set((meta?.artifacts || []).map(a => a.path));
  return paths.has('exploration.yaml') && !paths.has(HANDOFF_FILE) ? 'exploration.yaml' : HANDOFF_FILE;
}
