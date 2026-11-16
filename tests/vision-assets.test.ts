import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const publicVision = path.resolve('apps/client/public/vision');

test('prepared face model is the exact pinned BlazeFace asset', async () => {
  const model = await readFile(path.join(publicVision, 'models', 'blaze_face_short_range.tflite'));
  assert.equal(model.byteLength, 229_746);
  assert.equal(createHash('sha256').update(model).digest('hex'), 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f');
});

test('prepared MediaPipe runtime includes SIMD and non-SIMD self-hosted files', async () => {
  const expected = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ];
  for (const fileName of expected) {
    const details = await stat(path.join(publicVision, 'wasm', fileName));
    assert.ok(details.isFile());
    assert.ok(details.size > 100_000, `${fileName} should not be an empty placeholder`);
  }
});

test('vision runtime dependency stays pinned to the reviewed pre-telemetry release', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies?: Record<string, string> };
  assert.equal(manifest.dependencies?.['@mediapipe/tasks-vision'], '0.10.21');
  const installed = JSON.parse(await readFile('node_modules/@mediapipe/tasks-vision/package.json', 'utf8')) as { version?: string; license?: string };
  assert.deepEqual({ version: installed.version, license: installed.license }, { version: '0.10.21', license: 'Apache-2.0' });
});
