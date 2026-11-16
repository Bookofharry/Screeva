import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWriteAccess, isStaticBrowserHost, loadCapabilities, loadSessions } from '../apps/client/src/api.js';

test('a static browser host never fabricates local recording or write capabilities', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const nativeFetch = globalThis.fetch;
  const requests: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'preview.example' } },
  });
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Response('<!DOCTYPE html><title>Static Screeva preview</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };
  try {
    assert.equal(isStaticBrowserHost(), true);
    await assert.rejects(loadCapabilities(), /response was not JSON.*loopback/i);
    await assert.rejects(loadSessions(), /response was not JSON.*loopback/i);
    await assert.rejects(checkWriteAccess(), /response was not JSON.*loopback/i);
    assert.deepEqual(requests, ['/api/v1/capabilities', '/api/v1/sessions', '/api/v1/bootstrap']);
  } finally {
    globalThis.fetch = nativeFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
