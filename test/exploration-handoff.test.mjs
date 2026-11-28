import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffOf, handoffFileOf, isUserStep} from '../src/exploration-handoff.mjs';
import {HANDOFF_TASKS, handoffPrompt} from '../src/exploration-library.mjs';
import {yaml} from '../src/exploration-model.mjs';

const state = (id, {url = 'https://app.test/checkout', elements = [], dom = []} = {}) => ({
  id,
  page: 'page-1',
  frame: {id: 'main'},
  url,
  snapshot: `snapshots/${id}.yaml`,
  screenshot: `screenshots/${id}.png`,
  elements,
  locator_observations: dom.map(attributes => ({attributes})),
});

const generic = ref => ({snapshot_ref: ref, role: 'generic', name: null, locator_candidate: null, observed_flags: []});
const email = {
  snapshot_ref: 'e2',
  role: 'textbox',
  name: 'Billing email',
  locator_candidate: {strategy: 'role', role: 'textbox', name: 'Billing email', exact: true},
  observed_flags: [],
  ambiguous: false,
};
const pay = {
  snapshot_ref: 'e3',
  role: 'button',
  name: 'Pay now',
  locator_candidate: {strategy: 'role', role: 'button', name: 'Pay now', exact: true},
  observed_flags: ['disabled'],
  ambiguous: true,
};
const elements = [generic('e1'), email, pay, ...Array.from({length: 40}, (_, i) => generic(`g${i}`))];
const dom = [{tag: 'input', id: 'billing-email', test_id: 'billing-email', test_id_attribute: 'data-testid', name: 'billingEmail', label: 'Billing email'}];

const transition = (id, type, from, to, extra = {}) => ({
  id,
  from,
  to,
  finished_at: extra.finished_at || `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
  outcome: 'succeeded',
  assertion_status: 'not_asserted',
  action: {type, target: null, navigation_url: null, data_reference: null, ...extra.action},
  filmstrip: {before: `screenshots/${from}.png`, after: `screenshots/${to}.png`},
  error: null,
  expectation: null,
});

function graph() {
  const target = ref => ({state: 'state-1', snapshot_ref: ref, locator_candidate: elements.find(e => e.snapshot_ref === ref).locator_candidate});
  return {
    run_id: 'run-1',
    objective: 'Verify checkout validation',
    environment: 'staging',
    status: 'finished',
    observed_start_url: 'https://app.test/checkout',
    pages: [{id: 'page-1'}],
    states: ['state-1', 'state-2', 'state-3', 'state-4'].map(id =>
      state(id, {elements, dom, url: id === 'state-4' ? 'https://app.test/done' : undefined}),
    ),
    transitions: [
      transition('a1', 'snapshot', 'state-1', 'state-1'),
      transition('a2', 'fill', 'state-1', 'state-2', {action: {target: target('e2')}}),
      transition('a3', 'network', 'state-2', 'state-2'),
      transition('a4', 'click', 'state-2', 'state-3', {action: {target: target('e3')}}),
      transition('a5', 'fill', 'state-3', 'state-3', {action: {target: target('e2'), data_reference: 'billing_email'}}),
      transition('a6', 'run-code', 'state-3', 'state-4'),
    ],
    findings: [{text: 'Pay now shows a required error', at: '2026-01-01T00:00:04.500Z', evidence: ['snapshots/state-3.yaml']}],
    behaviors: [{observed: 'Total updates after promo', transition: 'a3'}],
    coverage: {gaps: [{step: 'a6', reason: 'Opaque script'}], questions: [], agent_reported_gaps: []},
  };
}

test('handoff keeps only user steps, drops element dumps, and adds locator fallbacks', () => {
  const h = handoffOf(graph());
  assert.equal(h.format, 'latch.handoff');
  assert.deepEqual(h.steps.map(s => [s.id, s.action, s.ref]), [
    ['s1', 'fill', 'a2'],
    ['s2', 'click', 'a4'],
    ['s3', 'fill', 'a5'],
    ['s4', 'run-code', 'a6'],
  ]);
  assert.deepEqual(h.steps[0].target, {
    role: 'textbox',
    name: 'Billing email',
    fallbacks: [{test_id: 'billing-email', attribute: 'data-testid'}, {css: '#billing-email'}, {css: '[name="billingEmail"]'}],
  });
  assert.deepEqual(h.steps[1].target, {role: 'button', name: 'Pay now', ambiguous: true, flags: ['disabled']});
  assert.equal(h.steps[0].value, '<redacted>');
  assert.equal(h.steps[2].value, '$billing_email');
  assert.equal(h.steps[3].opaque, true);
  assert.equal(h.steps[3].navigated_to, 'https://app.test/done');
  assert.equal(h.steps[1].evidence.after, 'screenshots/state-3.png');
  assert.ok(!JSON.stringify(h).includes('"generic"'));
});

test('handoff links annotations, test data and gaps to steps', () => {
  const h = handoffOf(graph());
  assert.equal(h.findings[0].step, 's2');
  // A behavior on an observation command attaches to the preceding user step.
  assert.deepEqual(h.behaviors[0], {text: 'Total updates after promo', step: 's1'});
  assert.deepEqual(h.test_data, [{ref: 'billing_email', step: 's3'}]);
  assert.deepEqual(h.gaps[0], {reason: 'Opaque script', steps: ['s4']});
  assert.deepEqual(h.gaps[1].steps, ['s1']);
  assert.equal(h.pages, undefined);
});

test('handoff is small compared to the full graph', () => {
  const g = graph();
  assert.ok(yaml(handoffOf(g)).length * 3 < yaml(g).length);
});

test('isUserStep treats observation commands as evidence', () => {
  for (const type of ['snapshot', 'screenshot', 'console', 'network']) assert.equal(isUserStep({action: {type}}), false);
  for (const type of ['click', 'fill', 'goto', 'run-code']) assert.equal(isUserStep({action: {type}}), true);
});

test('handoffFileOf falls back to exploration.yaml for runs finished before handoff.yaml', () => {
  assert.equal(handoffFileOf({artifacts: [{path: 'exploration.yaml'}]}), 'exploration.yaml');
  assert.equal(handoffFileOf({artifacts: [{path: 'exploration.yaml'}, {path: 'handoff.yaml'}]}), 'handoff.yaml');
  assert.equal(handoffFileOf({artifacts: []}), 'handoff.yaml');
});

test('copy prompt states the task for the QA decision and points at the handoff', () => {
  const run = {id: 'run-1', objective: 'Verify checkout validation', handoffPath: '/runs/run-1/handoff.yaml'};
  assert.equal(
    handoffPrompt(run, 'automate', 'Cover promo discount', HANDOFF_TASKS),
    'Implement Playwright e2e tests for Latch run run-1 (Verify checkout validation). Follow the steps in order and assert the observed behavior.\n' +
      'Read: /runs/run-1/handoff.yaml\nQA notes: Cover promo discount',
  );
  assert.match(handoffPrompt(run, 'report_bug', '', HANDOFF_TASKS), /^Write a bug report/);
  assert.match(handoffPrompt(run, 'bogus', '', HANDOFF_TASKS), /^Review Latch exploration run/);
  // Serialized into the library page: must not depend on module scope.
  const rebuilt = new Function(`return ${handoffPrompt.toString()}`)();
  assert.equal(rebuilt(run, 'closed', '', HANDOFF_TASKS), handoffPrompt(run, 'closed', '', HANDOFF_TASKS));
});
