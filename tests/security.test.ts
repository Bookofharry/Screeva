import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../apps/server/src/server.js';
import { bootstrapSchema, capabilitiesSchema, errorEnvelopeSchema, responseSchema, writeCheckSchema } from '../packages/shared/src/index.js';

let sandbox: string;
let running: Awaited<ReturnType<typeof startServer>>;
let token: string;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'recorder-security-'));
  running = await startServer({ port: 0, dataDirectory: path.join(sandbox, 'data') });
  const response = await fetch(`${running.origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  const parsed = responseSchema(bootstrapSchema).parse(await response.json());
  assert.equal(parsed.ok, true);
  if (parsed.ok) token = parsed.data.writeToken;
});
after(async () => { await running?.close(); if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

function writeHeaders(): Record<string, string> {
  return { Origin: running.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Token': token, 'Content-Type': 'application/json' };
}

// Fetch normalizes Host, so use real HTTP requests to exercise hostile Host headers.
function rawGet(url: string, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    req.on('error', reject); req.end();
  });
}

async function assertError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const body = errorEnvelopeSchema.parse(await response.json());
  assert.equal(body.error.code, code);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(body).includes(token), false);
}

test('listens only on IPv4 loopback and truthfully reports reliability capabilities', async () => {
  const address = running.server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  const response = await fetch(`${running.origin}/api/v1/capabilities`);
  assert.equal(response.status, 200);
  const parsed = responseSchema(capabilitiesSchema).parse(await response.json());
  assert.ok(parsed.ok);
  assert.equal(parsed.data.recording, true);
  assert.equal(parsed.data.export, false);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(self), display-capture=(self)');
  assert.match(response.headers.get('content-security-policy') ?? '', /media-src 'self' blob:/);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});

test('accepts an authenticated same-origin JSON write check', async () => {
  const response = await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: writeHeaders(), body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(responseSchema(writeCheckSchema).parse(await response.json()).ok, true);
});

for (const host of ['attacker.example', 'localhost:4317', '127.0.0.1.attacker.example', '127.0.0.1', '127.0.0.1:1']) {
  test(`rejects unapproved Host ${host} even with spoofed forwarding headers`, async () => {
    await assertError(await rawGet(`${running.origin}/api/v1/capabilities`, { Host: host, 'X-Forwarded-Host': new URL(running.origin).host, 'X-Forwarded-For': '127.0.0.1' }), 403, 'FORBIDDEN');
  });
}

for (const origin of ['https://evil.example', 'null', 'http://localhost:4317', 'http://127.0.0.1:1']) {
  test(`rejects origin ${origin} on reads and writes`, async () => {
    await assertError(await fetch(`${running.origin}/api/v1/capabilities`, { headers: { Origin: origin } }), 403, 'FORBIDDEN');
    await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { ...writeHeaders(), Origin: origin }, body: '{}' }), 403, 'FORBIDDEN');
  });
}

for (const site of ['cross-site', 'same-site', 'invalid']) {
  test(`rejects ${site} Fetch Metadata including token bootstrap`, async () => {
    await assertError(await fetch(`${running.origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': site, 'X-Recorder-Bootstrap': '1' } }), 403, 'FORBIDDEN');
    await assertError(await fetch(`${running.origin}/api/v1/capabilities`, { headers: { 'Sec-Fetch-Site': site } }), 403, 'FORBIDDEN');
  });
}

test('bootstrap rejects navigation, absent Fetch Metadata, missing custom header and HEAD', async () => {
  for (const headers of [{}, { 'Sec-Fetch-Site': 'none', 'X-Recorder-Bootstrap': '1' }, { 'Sec-Fetch-Site': 'same-origin' }]) {
    await assertError(await fetch(`${running.origin}/api/v1/bootstrap`, { headers: headers as Record<string, string> }), 403, 'FORBIDDEN');
  }
  const head = await fetch(`${running.origin}/api/v1/bootstrap`, { method: 'HEAD', headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
  assert.equal(head.status, 403);
});

test('writes fail closed without Origin or same-origin Fetch Metadata', async () => {
  for (const field of ['Origin', 'Sec-Fetch-Site']) {
    const headers = writeHeaders();
    delete headers[field];
    await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers, body: '{}' }), 403, 'FORBIDDEN');
  }
});

test('missing, malformed and incorrect tokens cannot authorize writes', async () => {
  for (const candidate of ['', 'short', 'a'.repeat(43), 'é'.repeat(43)]) {
    await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { ...writeHeaders(), 'X-Recorder-Token': candidate }, body: '{}' }), 401, 'UNAUTHORIZED');
  }
});

test('all unsafe methods are guarded, including unknown routes', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assertError(await fetch(`${running.origin}/api/v1/sessions`, { method }), 403, 'FORBIDDEN');
  }
});

test('preflight does not grant CORS access', async () => {
  await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), 403, 'FORBIDDEN');
});

test('malformed, extra, missing, oversized and wrong-media bodies are rejected', async () => {
  for (const body of ['{', '[]', 'null', '{"unexpected":true}', '']) {
    await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: writeHeaders(), body }), 400, 'INVALID_REQUEST');
  }
  await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ value: 'x'.repeat(17000) }) }), 413, 'PAYLOAD_TOO_LARGE');
  await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { ...writeHeaders(), 'Content-Type': 'text/plain' }, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { ...writeHeaders(), 'Content-Encoding': 'gzip' }, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
});

test('authorization runs before JSON parsing and size errors', async () => {
  await assertError(await fetch(`${running.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(17000) }), 403, 'FORBIDDEN');
});

test('raw duplicate Host headers are rejected', async () => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(running.origin + '/api/v1/capabilities', { headers: ['Host', new URL(running.origin).host, 'Host', 'evil.example'] }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('restart rotates the token and rejects the previous launch token', async () => {
  const second = await startServer({ port: 0, dataDirectory: path.join(sandbox, 'second-data') });
  try {
    const bootstrap = await fetch(`${second.origin}/api/v1/bootstrap`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Recorder-Bootstrap': '1' } });
    const parsed = responseSchema(bootstrapSchema).parse(await bootstrap.json());
    assert.ok(parsed.ok);
    assert.notEqual(parsed.data.writeToken, token);
    await assertError(await fetch(`${second.origin}/api/v1/diagnostics/write-check`, { method: 'POST', headers: { ...writeHeaders(), Origin: second.origin }, body: '{}' }), 401, 'UNAUTHORIZED');
  } finally { await second.close(); }
});

test('unimplemented media endpoints return a versioned 404', async () => {
  await assertError(await fetch(`${running.origin}/api/v1/sessions/${crypto.randomUUID()}/chunks/0`), 404, 'NOT_FOUND');
});
