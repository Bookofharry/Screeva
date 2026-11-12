import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Banner } from '../apps/client/src/ui/Banner.js';
import { Button, buttonClassName } from '../apps/client/src/ui/Button.js';
import { Disclosure } from '../apps/client/src/ui/Disclosure.js';
import { Icon, ICON_NAMES } from '../apps/client/src/ui/Icon.js';
import { LevelMeter, litSegments } from '../apps/client/src/ui/LevelMeter.js';
import { ProgressBar, clampProgress } from '../apps/client/src/ui/ProgressBar.js';
import { StatusPill } from '../apps/client/src/ui/StatusPill.js';

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

test('Button defaults to a non-submitting primary button and applies variant/size classes', () => {
  const markup = html(createElement(Button, null, 'Save'));
  assert.match(markup, /^<button type="button" class="ui-button ui-button--primary">Save<\/button>$/);
  assert.equal(buttonClassName('secondary', 'lg', 'extra'), 'ui-button ui-button--secondary ui-button--lg extra');
  assert.match(html(createElement(Button, { variant: 'danger', type: 'submit' }, 'Delete')), /type="submit" class="ui-button ui-button--danger"/);
});

test('Button busy state keeps the label, disables activation and exposes aria-busy', () => {
  const markup = html(createElement(Button, { busy: true }, 'Saving'));
  assert.match(markup, /disabled=""/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /<span class="ui-spinner" aria-hidden="true"><\/span>Saving/);
  assert.doesNotMatch(html(createElement(Button, null, 'Idle')), /aria-busy/);
});

test('record Button shows a decorative dot and keeps a text label', () => {
  const markup = html(createElement(Button, { variant: 'record', size: 'lg' }, 'Record'));
  assert.match(markup, /class="ui-button ui-button--record ui-button--lg"/);
  assert.match(markup, /<span class="ui-button__dot" aria-hidden="true"><\/span>Record/);
});

test('Icon is decorative by default and labelled only when a title is provided', () => {
  for (const name of ICON_NAMES) {
    const markup = html(createElement(Icon, { name }));
    assert.match(markup, /aria-hidden="true"/, name);
    assert.match(markup, /<path d="[^"]+"/, name);
    assert.doesNotMatch(markup, /role="img"/, name);
  }
  const labelled = html(createElement(Icon, { name: 'mic', title: 'Microphone' }));
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Microphone"/);
  assert.match(labelled, /<title>Microphone<\/title>/);
  assert.doesNotMatch(labelled, /aria-hidden/);
  assert.doesNotMatch(html(createElement(Icon, { name: 'mic', title: '   ' })), /role="img"/);
});

test('StatusPill always renders text, exposes a status role only when named, and dots recording state', () => {
  assert.equal(html(createElement(StatusPill, { children: 'Ready' })), '<span class="ui-pill">Ready</span>');
  const recording = html(createElement(StatusPill, { tone: 'recording', statusLabel: 'Recording status', children: 'REC 00:12' }));
  assert.match(recording, /class="ui-pill ui-pill--recording" role="status" aria-label="Recording status"/);
  assert.match(recording, /<span class="ui-pill__dot" aria-hidden="true"><\/span>REC 00:12/);
});

test('Banner announces danger by default but not persistent info/warning banners', () => {
  assert.match(html(createElement(Banner, { tone: 'danger', title: 'Failed' }, 'Details')), /^<div class="ui-banner ui-banner--danger" role="alert">/);
  assert.doesNotMatch(html(createElement(Banner, { tone: 'warning' }, 'Behind')), /role=/);
  assert.match(html(createElement(Banner, { tone: 'info', announce: true }, 'Saved')), /role="status"/);
  assert.doesNotMatch(html(createElement(Banner, { tone: 'danger', announce: false }, 'Quiet')), /role=/);
  const withAction = html(createElement(Banner, { tone: 'warning', title: 'Screen sharing stopped', action: createElement(Button, null, 'Share screen') }, 'Recording continues.'));
  assert.match(withAction, /<strong class="ui-banner__title">Screen sharing stopped<\/strong>Recording continues\./);
  assert.match(withAction, /<div class="ui-banner__action"><button/);
});

test('Disclosure uses native details/summary and keeps content mounted while closed', () => {
  const closed = html(createElement(Disclosure, { summary: 'Advanced audio', children: createElement('canvas', { 'aria-label': 'kept' }) }));
  assert.match(closed, /^<details class="ui-disclosure"><summary>Advanced audio<\/summary>/);
  assert.match(closed, /<canvas aria-label="kept">/);
  assert.match(html(createElement(Disclosure, { summary: 'Open', defaultOpen: true, children: 'x' })), /<details class="ui-disclosure" open="">/);
});

test('ProgressBar clamps determinate values and omits value for indeterminate phases', () => {
  assert.equal(clampProgress(-1), 0);
  assert.equal(clampProgress(2), 1);
  assert.equal(clampProgress(Number.NaN), 0);
  assert.equal(clampProgress(Number.POSITIVE_INFINITY), 0);
  assert.match(html(createElement(ProgressBar, { label: 'Saving', progress: { kind: 'determinate', value: 0.6 }, caption: '3 of 5' })),
    /<progress aria-label="Saving" max="1" value="0.6"><\/progress><span>3 of 5<\/span>/);
  const indeterminate = html(createElement(ProgressBar, { label: 'Checking the video file', progress: { kind: 'indeterminate' } }));
  assert.match(indeterminate, /<progress aria-label="Checking the video file"><\/progress>/);
  assert.doesNotMatch(indeterminate, /value=/);
});

test('LevelMeter exposes a non-live ARIA meter with clamped, state-aware values', () => {
  assert.equal(litSegments(0.55, 10), 6);
  assert.equal(litSegments(5, 10), 10);
  assert.equal(litSegments(-1, 10), 0);
  assert.equal(litSegments(Number.NaN, 10), 0);
  const active = html(createElement(LevelMeter, { label: 'Microphone level', level: 0.5 }));
  assert.match(active, /class="ui-level" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50%"/);
  assert.equal(active.match(/ui-level__segment--on/g)?.length, 5);
  assert.equal(active.match(/ui-level__segment--hot/g)?.length, 2);
  assert.doesNotMatch(active, /aria-live|role="status"/);
  const muted = html(createElement(LevelMeter, { label: 'Mic', level: 0.3, state: 'muted' }));
  assert.match(muted, /class="ui-level ui-level--muted"/);
  assert.match(muted, /aria-valuetext="Muted, 30%"/);
  const unavailable = html(createElement(LevelMeter, { label: 'Shared audio', level: 0.9, state: 'unavailable' }));
  assert.match(unavailable, /aria-valuenow="0" aria-valuetext="No input"/);
  assert.doesNotMatch(unavailable, /ui-level__segment--on/);
});
