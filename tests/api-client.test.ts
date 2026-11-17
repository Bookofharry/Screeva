import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWriteAccess, isStaticBrowserHost, loadCapabilities, loadSessions, localServiceConnectionHelp } from '../apps/client/src/api.js';

test('a static browser host rejects local API operations without making network requests', async () => {
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
    await assert.rejects(loadCapabilities(), /hosted page.*127\.0\.0\.1:4317.*Browser recording/i);
    await assert.rejects(loadSessions(), /hosted page/i);
    await assert.rejects(checkWriteAccess(), /hosted page/i);
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = nativeFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('local HTML fallback still fails closed with connection guidance', async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!DOCTYPE html><title>Fallback</title>', {
    headers: { 'Content-Type': 'text/html' },
  });
  try {
    await assert.rejects(loadCapabilities(), /response was not JSON.*loopback/i);
    assert.match(localServiceConnectionHelp(), /Cannot reach the local service.*127\.0\.0\.1:4317/);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
