// Compact, step-centric handoff for AI agents writing e2e tests.
// Derived from the full exploration graph (exploration.json), which stays the
// source of truth for tooling. See docs/HANDOFF-V2.md.

export const HANDOFF_FILE = 'handoff.yaml';
export const HANDOFF_SCHEMA_VERSION = 2;

// Commands that only observe the page. They are evidence, not user steps.
const OBSERVATION_TYPES = new Set(['snapshot', 'screenshot', 'console', 'network', 'generate-locator', 'highlight']);
// Commands whose internals are not captured.
const OPAQUE_TYPES = new Set(['run-code', 'eval']);
const INPUT_TYPES = new Set(['fill', 'type', 'select', 'upload']);

const compact = obj => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
};

export const isUserStep = transition => !OBSERVATION_TYPES.has(transition.action?.type || '');

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

function stepOf(t, index, statesById) {
  const type = t.action?.type || 'action';
  const before = statesById.get(t.from);
  const after = statesById.get(t.to);
  const value = INPUT_TYPES.has(type)
    ? t.action?.data_reference
      ? `$${t.action.data_reference}`
      : '<redacted>'
    : null;
  return compact({
    id: `s${index + 1}`,
    ref: t.id,
    action: type,
    opaque: OPAQUE_TYPES.has(type) || undefined,
    target: targetOf(t.action?.target, statesById),
    destination: targetOf(t.action?.destination, statesById),
    url: t.action?.navigation_url,
    value,
    navigated_to: after?.url && before?.url && after.url !== before.url ? after.url : null,
    outcome: t.outcome === 'succeeded' ? null : t.outcome,
    error: t.error ? `${t.error.code}: ${t.error.message}` : null,
    expectation: t.expectation ? (t.expectation.error ?? t.expectation.value) : null,
    assertion: t.assertion_status && t.assertion_status !== 'not_asserted' ? t.assertion_status : null,
    evidence: compact({
      before: t.filmstrip?.before ?? null,
      after: t.filmstrip?.after ?? null,
      snapshot: after?.snapshot ?? null,
    }),
  });
}

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

export function handoffOf(graph) {
  const statesById = new Map(graph.states.map(s => [s.id, s]));
  const userTransitions = graph.transitions.filter(isUserStep);
  const steps = userTransitions.map((t, i) => stepOf(t, i, statesById));
  const pages = graph.pages || [];
  if (pages.length > 1) {
    steps.forEach((step, i) => {
      const t = userTransitions[i];
      const page = statesById.get(t.from)?.page || statesById.get(t.to)?.page;
      if (page) step.page = page;
    });
  }
  const ann = kind => [
    ...(graph[kind] || []),
  ].map(a => annotationOf(a, steps, graph.transitions));
  const testData = (graph.test_data || []).map(a => compact({ref: a.reference, text: a.text, step: stepForAnnotation(a, steps, graph.transitions)}));
  for (const step of steps) {
    const ref = typeof step.value === 'string' && step.value.startsWith('$') ? step.value.slice(1) : null;
    if (ref && !testData.some(d => d.ref === ref)) testData.push({ref, step: step.id});
  }
  const gapReasons = new Map();
  for (const gap of graph.coverage?.gaps || []) {
    const step = steps.find(s => s.ref === gap.step)?.id;
    const entry = gapReasons.get(gap.reason) || {reason: gap.reason, steps: []};
    if (step && !entry.steps.includes(step)) entry.steps.push(step);
    gapReasons.set(gap.reason, entry);
  }
  const redacted = steps.filter(s => s.value === '<redacted>').map(s => s.id);

  return compact({
    format: 'latch.handoff',
    schema_version: HANDOFF_SCHEMA_VERSION,
    run_id: graph.run_id,
    objective: graph.objective,
    environment: graph.environment,
    status: graph.status,
    base_url: graph.observed_start_url || graph.requested_start_url,
    pages: pages.length > 1 ? pages.map(p => compact({id: p.id, opener: p.opener_page, url: p.first_observed_url})) : null,
    prerequisites: ann('prerequisites'),
    test_data: testData,
    steps,
    behaviors: ann('behaviors'),
    findings: ann('findings'),
    questions: (graph.coverage?.questions || []).map(a => annotationOf(a, steps, graph.transitions)),
    gaps: [
      ...[...gapReasons.values()].map(g => compact(g)),
      ...(graph.coverage?.agent_reported_gaps || []).map(a => annotationOf(a, steps, graph.transitions)),
      redacted.length ? {reason: 'Input values were redacted. Supply test data before automating.', steps: redacted} : null,
    ].filter(Boolean),
    notes: [
      'Locators come from recorded snapshots. Re-verify them against the live app.',
      'Full state graph, snapshots and screenshots: exploration.json and the paths under evidence.',
    ],
  });
}

// Runs finished before handoff.yaml existed only have exploration.yaml.
export function handoffFileOf(meta) {
  const paths = new Set((meta?.artifacts || []).map(a => a.path));
  return paths.has('exploration.yaml') && !paths.has(HANDOFF_FILE) ? 'exploration.yaml' : HANDOFF_FILE;
}
