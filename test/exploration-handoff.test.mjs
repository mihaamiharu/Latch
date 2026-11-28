import test from 'node:test';
import assert from 'node:assert/strict';
import {behaviorId, effectsOf, handoffOf, handoffFileOf, isUserStep, snapshotItems} from '../src/exploration-handoff.mjs';
import {HANDOFF_TASKS, handoffPrompt, parseVerdicts} from '../src/exploration-library.mjs';
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
  // Agent behavior notes and findings become reviewable behaviors. A behavior on
  // an observation command attaches to the preceding user step.
  const agent = h.behaviors.find(b => b.source === 'agent');
  assert.match(agent.id, /^b-[0-9a-f]{8}$/);
  assert.deepEqual({...agent, id: null}, {id: null, text: 'Total updates after promo', source: 'agent', steps: ['s1'], verdict: 'unreviewed'});
  assert.deepEqual(h.behaviors.find(b => b.source === 'finding').steps, ['s2']);
  assert.equal(h.findings, undefined);
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
    'Implement Playwright e2e tests for Latch run run-1 (Verify checkout validation).\n' +
      'Read: /runs/run-1/handoff.yaml\n' +
      'Drive the UI from the steps and add API assertions from each step’s network. Re-verify locators against the live app.\n' +
      'QA notes: Cover promo discount',
  );
  assert.match(handoffPrompt(run, 'report_bug', '', HANDOFF_TASKS), /^Write a bug report/);
  assert.match(handoffPrompt(run, 'bogus', '', HANDOFF_TASKS), /^Review Latch exploration run/);
  // Serialized into the library page: must not depend on module scope.
  const rebuilt = new Function(`return ${handoffPrompt.toString()}`)();
  assert.equal(rebuilt(run, 'closed', '', HANDOFF_TASKS), handoffPrompt(run, 'closed', '', HANDOFF_TASKS));
});

const SNAP_BEFORE = [
  '- main [ref=e1]:',
  '  - textbox "Billing email" [ref=e2]:',
  '    - text: typed-secret@example.com',
  '  - button "Pay now" [ref=e3]',
  '  - generic [ref=e4]:',
  '    - generic [ref=e5]: Total due today',
  '    - generic [ref=e6]: $49.00',
  '  - button "Apply" [disabled] [ref=e7]',
].join('\n');
const SNAP_AFTER = [
  '- main [ref=e1]:',
  '  - textbox "Billing email" [active] [ref=e2]:',
  '    - text: other-secret@example.com',
  '  - button "Pay now" [ref=e3]',
  '  - generic [ref=e4]:',
  '    - generic [ref=e5]: Total due today',
  '    - generic [ref=e9]: $39.00',
  '  - button "Apply" [ref=e7]',
  '  - alert [ref=e8]: Card number is required.',
].join('\n');

test('snapshot diff finds appeared, changed and flag effects without input values', () => {
  const {effects} = effectsOf(SNAP_BEFORE, SNAP_AFTER);
  assert.deepEqual(effects, [
    {appeared: {role: 'alert', text: 'Card number is required.'}},
    {changed: {role: 'generic', after_label: 'Total due today', from: '$49.00', to: '$39.00'}},
    {changed: {role: 'button', name: 'Apply', flags_from: 'disabled', flags_to: 'none'}},
  ]);
  assert.ok(!JSON.stringify(snapshotItems(SNAP_AFTER)).includes('secret'));
});

function networkGraph(network) {
  const g = graph();
  const payTarget = state => ({state, snapshot_ref: 'e3', locator_candidate: pay.locator_candidate});
  g.transitions = [
    transition('a1', 'click', 'state-1', 'state-2', {action: {target: payTarget('state-1')}}),
    transition('a2', 'network', 'state-2', 'state-2'),
    transition('a3', 'click', 'state-2', 'state-3', {action: {target: payTarget('state-2')}}),
  ];
  g.transitions[0].network = network;
  g.transitions[1].network = [{method: 'GET', url: 'https://app.test/api/cart', status: 200, late: true}];
  g.transitions[2].network = [];
  g.findings = [];
  g.behaviors = [];
  g.coverage = {gaps: [], questions: [], agent_reported_gaps: []};
  return g;
}

test('steps carry same-site API calls as shapes, late calls and an explicit empty network', () => {
  const h = handoffOf(
    networkGraph([
      {
        method: 'POST',
        url: 'https://api.app.test/v1/orders/8492?draft=1',
        status: 201,
        authorization: 'Bearer',
        request: {type: 'json', shape: {card: 'string'}},
        response: {type: 'json', shape: {id: 'number', total: 'number'}},
      },
      {method: 'GET', url: 'https://analytics.example.com/collect', status: 204},
    ]),
    {snapshots: new Map([['snapshots/state-2.yaml', SNAP_BEFORE], ['snapshots/state-3.yaml', SNAP_AFTER]])},
  );
  const [s1, s2] = h.steps;
  assert.deepEqual(s1.network, [
    {
      method: 'POST',
      path: '/v1/orders/{id}',
      query: ['draft'],
      status: 201,
      auth: 'Bearer',
      request: {json: {card: 'string'}},
      response: {json: {id: 'number', total: 'number'}},
    },
    {method: 'GET', path: '/api/cart', status: 200, late: true},
  ]);
  assert.equal(s1.other_requests, 1);
  assert.deepEqual(s1.assert, [{request: 'POST /v1/orders/{id}', status: 201}]);
  assert.deepEqual(s2.network, []);
  assert.ok(s2.assert.some(a => a.no_request));
  assert.ok(s2.assert.some(a => a.locator?.role === 'alert' && a.visible));
  const observed = h.behaviors.filter(b => b.source === 'observed');
  assert.equal(observed[0].text, 'click button "Pay now": sends POST /v1/orders/{id} (201)');
  assert.match(observed[1].text, /alert "Card number is required\." appears/);
  assert.match(observed[1].text, /sends no API request/);
  assert.ok(!yaml(h).includes('secret'));
});

test('behavior ids are stable and verdicts come from the review', () => {
  const g = networkGraph([]);
  const first = handoffOf(g).behaviors;
  const id = first[0].id;
  assert.equal(handoffOf(g).behaviors[0].id, id);
  const reviewed = handoffOf(g, {verdicts: {[id]: 'bug', 'b-ffffffff': 'expected'}}).behaviors;
  assert.equal(reviewed[0].verdict, 'bug');
  assert.equal(reviewed.length, first.length);
  assert.equal(behaviorId('observed', first[0].text, first[0].steps), id);
});

test('runs without network capture omit the network key', () => {
  const g = networkGraph(undefined);
  g.transitions[1].network = undefined;
  g.transitions[2].network = undefined;
  const h = handoffOf(g);
  assert.ok(h.steps.every(s => !('network' in s)));
  assert.ok(h.steps.every(s => !(s.assert || []).some(a => a.no_request)));
});

test('verdict parsing accepts CLI and page forms and rejects unknown values', () => {
  assert.deepEqual(parseVerdicts('b-00000001=expected, b-00000002=bug,b-00000003=unreviewed'), {
    'b-00000001': 'expected',
    'b-00000002': 'bug',
  });
  assert.deepEqual(parseVerdicts({'b-00000001': 'ignore'}), {'b-00000001': 'ignore'});
  assert.equal(parseVerdicts(undefined), undefined);
  assert.throws(() => parseVerdicts('b-00000001=maybe'), {code: 'INVALID_REVIEW'});
  assert.throws(() => parseVerdicts('nope=expected'), {code: 'INVALID_REVIEW'});
});

test('copy prompt lists behaviors by verdict', () => {
  const run = {id: 'run-1', objective: 'Checkout', handoffPath: '/runs/run-1/handoff.yaml'};
  const prompt = handoffPrompt(run, 'automate', '', HANDOFF_TASKS, [
    {id: 'b-00000001', verdict: 'expected'},
    {id: 'b-00000002', verdict: 'bug'},
    {id: 'b-00000003', verdict: 'ignore'},
    {id: 'b-00000004', verdict: 'unreviewed'},
  ]);
  assert.ok(prompt.startsWith('Implement Playwright e2e tests for Latch run run-1 (Checkout).\nRead: /runs/run-1/handoff.yaml\n'));
  assert.match(prompt, /Cover expected behaviors: b-00000001\./);
  assert.match(prompt, /should fail until fixed\): b-00000002\./);
  assert.match(prompt, /Skip: b-00000003\./);
  assert.match(prompt, /API assertions/);
  assert.doesNotMatch(prompt, /b-00000004/);
  assert.match(
    handoffPrompt(run, 'automate', '', HANDOFF_TASKS, [{id: 'b-00000004', verdict: 'unreviewed'}]),
    /No behaviors have a QA verdict yet/,
  );
});
