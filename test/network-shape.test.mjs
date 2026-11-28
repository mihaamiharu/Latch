import test from 'node:test';
import assert from 'node:assert/strict';
import {apiPath, bodyShape, sameSite, shapeOf} from '../src/network-shape.mjs';
import {BrowserEngine} from '../src/browser-engine.mjs';

test('shapeOf keeps keys and types, never values', () => {
  const shape = shapeOf({card: '4242424242424242', items: [{sku: 'A1', qty: 2}], promo: null, ok: true, empty: []});
  assert.deepEqual(shape, {card: 'string', items: [{sku: 'string', qty: 'number'}], promo: 'null', ok: 'boolean', empty: []});
  assert.ok(!JSON.stringify(shape).includes('4242'));
});

test('bodyShape handles json, form, multipart and unparseable bodies', () => {
  assert.deepEqual(bodyShape('{"code":"QA10"}', 'application/json; charset=utf-8'), {type: 'json', shape: {code: 'string'}});
  assert.deepEqual(bodyShape('a=1&b=secret', 'application/x-www-form-urlencoded'), {type: 'form', shape: {a: 'string', b: 'string'}});
  assert.deepEqual(bodyShape('--x', 'multipart/form-data; boundary=x'), {type: 'multipart', shape: null});
  assert.deepEqual(bodyShape('{nope', 'application/json'), {type: 'json', shape: 'unparseable'});
  assert.equal(bodyShape('', 'application/json'), null);
});

test('apiPath parameterizes ids and keeps only query keys', () => {
  assert.deepEqual(apiPath('https://app.test/api/orders/8492/items/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f?token=x&draft=1'), {
    origin: 'https://app.test',
    path: '/api/orders/{id}/items/{id}',
    query: ['token', 'draft'],
  });
  assert.equal(apiPath('https://app.test/api/required-field-validation-page').path, '/api/required-field-validation-page');
});

test('sameSite accepts sibling subdomains and rejects third parties', () => {
  assert.equal(sameSite('https://api.app.test/x', 'https://www.app.test/'), true);
  assert.equal(sameSite('http://127.0.0.1:4173/api', 'http://127.0.0.1:4173/checkout'), true);
  assert.equal(sameSite('https://analytics.example.com/c', 'https://www.app.test/'), false);
});

function fakeExchange({method = 'POST', url, type = 'fetch', body, headers = {}}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => type,
    postData: () => body ?? null,
    headers: () => headers,
  };
}

test('engine records XHR/fetch exchanges as shapes and drains them once per capture', async () => {
  const engine = new BrowserEngine({
    cdpEndpoint: 'ws://127.0.0.1:9/cdp/' + 'a'.repeat(64),
    sessionKey: 'b'.repeat(64),
    workspace: process.cwd(),
    session: 'unit',
    tabId: 1,
    connectOverCDP: async () => {
      throw new Error('not used');
    },
  });
  const req = fakeExchange({
    url: 'https://app.test/api/promo',
    body: '{"code":"QA10"}',
    headers: {'content-type': 'application/json', authorization: 'Bearer secret-token'},
  });
  const image = fakeExchange({method: 'GET', url: 'https://app.test/logo.png', type: 'image'});
  const rawToken = fakeExchange({method: 'GET', url: 'https://app.test/api/me', headers: {authorization: 'secret-token-only'}});
  engine.recordApiRequest(req, 'page-1');
  engine.recordApiRequest(image, 'page-1');
  engine.recordApiRequest(rawToken, 'page-1');
  engine.recordApiResponse({
    request: () => req,
    status: () => 200,
    headers: () => ({'content-type': 'application/json'}),
    text: async () => '{"discount":10,"total":39}',
  });
  const first = await engine.drainApiExchanges();
  assert.equal(first.length, 2);
  assert.deepEqual(
    {...first[0], started_at: null},
    {
      method: 'POST',
      url: 'https://app.test/api/promo',
      resource_type: 'fetch',
      page: 'page-1',
      started_at: null,
      request: {type: 'json', shape: {code: 'string'}},
      authorization: 'Bearer',
      status: 200,
      response: {type: 'json', shape: {discount: 'number', total: 'number'}},
    },
  );
  assert.equal(first[1].authorization, 'present');
  assert.ok(!JSON.stringify(first).includes('secret-token'));
  assert.ok(!JSON.stringify(first).includes('QA10'));
  assert.deepEqual(await engine.drainApiExchanges(), []);
});
