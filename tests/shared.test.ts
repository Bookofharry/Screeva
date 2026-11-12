import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesSchema, responseSchema, success, writeCheckInputSchema } from '../packages/shared/src/index.js';

test('API envelope rejects wrong versions and unsupported capability claims', () => {
  const schema = responseSchema(capabilitiesSchema);
  const response = success({ name: 'Local Creator Recorder', milestone: 'reliability', storage: 'ready', recording: true, export: false });
  assert.equal(schema.safeParse(response).success, true);
  assert.equal(schema.safeParse({ ...response, apiVersion: 'v2' }).success, false);
  assert.equal(schema.safeParse({ ...response, data: { ...response.data, recording: false } }).success, false);
});

test('write-check input is a strict empty object', () => {
  assert.equal(writeCheckInputSchema.safeParse({}).success, true);
  for (const value of [null, [], '', { path: '../outside' }]) assert.equal(writeCheckInputSchema.safeParse(value).success, false);
});
