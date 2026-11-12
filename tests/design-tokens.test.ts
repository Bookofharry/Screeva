import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const tokensCss = await readFile(new URL('../apps/client/src/ui/tokens.css', import.meta.url), 'utf8');
const styleCss = await readFile(new URL('../apps/client/src/style.css', import.meta.url), 'utf8');

function definedProperties(css: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) result.set(match[1]!, match[2]!.trim());
  return result;
}

const tokens = definedProperties(tokensCss);

function hex(name: string): string {
  const value = tokens.get(name);
  assert.ok(value, `token ${name} is defined`);
  assert.match(value, /^#[0-9a-f]{6}$/i, `token ${name} is a 6-digit hex colour`);
  return value;
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function compositeHex(foreground: string, alpha: number, background: string): string {
  const blend = (offset: number) => {
    const fg = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    const bg = Number.parseInt(background.slice(offset, offset + 2), 16);
    return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, '0');
  };
  return `#${blend(1)}${blend(3)}${blend(5)}`;
}

test('contrast helper matches WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(Math.round(contrast('#777777', '#ffffff') * 100) / 100, 4.48);
});

// [foreground, background, minimum ratio, usage]. 4.5 = body text, 3 = large text / UI boundaries (WCAG 2.2 AA).
const pairs: [string, string, number, string][] = [];
for (const surface of ['--bg', '--surface-1', '--surface-2', '--color-surface-hover']) {
  pairs.push(
    ['--text', surface, 4.5, 'primary text'],
    ['--text-soft', surface, 4.5, 'labels'],
    ['--text-muted', surface, 4.5, 'secondary text'],
    ['--accent', surface, 4.5, 'accent text and status'],
    ['--accent-soft', surface, 4.5, 'secondary button text'],
    ['--color-primary-text', surface, 4.5, 'active violet navigation and preset text'],
    ['--color-accent', surface, 4.5, 'mint highlight and connectivity dot'],
    ['--color-success', surface, 4.5, 'verified saved state text'],
    ['--danger', surface, 4.5, 'error text'],
    ['--warning', surface, 4.5, 'warning pill text'],
    ['--info', surface, 4.5, 'info text'],
    ['--live', surface, 4.5, 'live capture text'],
    ['--record-text', surface, 4.5, 'recording indicator text'],
    ['--border-input', surface, 3, 'input and secondary button boundary'],
    ['--record', surface, 3, 'REC dot and recording border'],
    ['--color-primary', surface, 3, 'selected violet border and progress fill'],
    ['--color-focus', surface, 3, 'keyboard focus ring'],
    ['--accent-strong', surface, 3, 'focus ring alias'],
  );
}
// The filled record button is identified by its text label, so WCAG 1.4.11 does not require a 3:1
// boundary against the surface; no red can give both that and 4.5:1 for its white label.
pairs.push(
  ['--color-on-primary', '--color-primary', 4.5, 'dark ink label on filled violet primary button'],
  ['--color-on-primary', '--color-primary-hover', 4.5, 'dark ink label on hovered violet primary button'],
  ['--color-on-accent', '--color-accent', 4.5, 'dark ink on mint accent'],
  ['--color-primary', '--color-surface', 4.5, 'brand violet on default panel surface'],
  ['--on-accent', '--accent', 4.5, 'primary button label alias'],
  ['--on-accent', '--accent-strong', 4.5, 'primary button hover label alias'],
  ['--warning-text', '--warning-surface', 4.5, 'warning callout text'],
  ['--warning', '--warning-surface', 3, 'warning callout border'],
  ['--danger', '--color-danger-surface', 4.5, 'danger banner text'],
  ['--text', '--record-button', 4.5, 'record button label'],
  ['--text', '--record-button-hover', 4.5, 'record button hover label'],
  ['--text-muted', '--surface-stage', 4.5, 'empty preview caption'],
  ['--color-disabled-text', '--color-surface', 4.5, 'disabled text on default surface'],
  ['--color-disabled-text', '--color-disabled-bg', 3, 'disabled control label visibility'],
);

for (const [foreground, background, minimum, usage] of pairs) {
  test(`${foreground} on ${background} meets ${minimum}:1 for ${usage}`, () => {
    const ratio = contrast(hex(foreground), hex(background));
    assert.ok(ratio >= minimum, `${foreground} on ${background} is ${ratio.toFixed(2)}:1, below ${minimum}:1`);
  });
}

test('Electric Violet brand anchors match specification and enforce dark ink on filled violet', () => {
  assert.equal(hex('--color-bg').toLowerCase(), '#0c0a16');
  assert.equal(hex('--color-surface').toLowerCase(), '#191529');
  assert.equal(hex('--color-surface-raised').toLowerCase(), '#241d38');
  assert.equal(hex('--color-surface-hover').toLowerCase(), '#302644');
  assert.equal(hex('--color-primary').toLowerCase(), '#9b5cff');
  assert.equal(hex('--color-primary-hover').toLowerCase(), '#b79aff');
  assert.equal(hex('--color-on-primary').toLowerCase(), '#0c0a16');
  assert.equal(hex('--color-accent').toLowerCase(), '#00e5c3');
  assert.equal(hex('--color-text').toLowerCase(), '#f6f2ff');
  assert.equal(hex('--color-recording').toLowerCase(), '#ff445e');
  // Light text #F6F2FF on #9B5CFF is ~3.55:1 (< 4.5:1), so dark ink #0C0A16 (>= 5.0:1) is required.
  assert.ok(contrast(hex('--color-text'), hex('--color-primary')) < 4.5);
  assert.ok(contrast(hex('--color-on-primary'), hex('--color-primary')) >= 5.0);
});

test('every var() reference without a fallback resolves to a defined custom property', () => {
  const defined = new Set([...tokens.keys(), ...definedProperties(styleCss).keys()]);
  const missing = [...`${tokensCss}\n${styleCss}`.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)]
    .filter(match => !match[2] && !defined.has(match[1]!)).map(match => match[1]);
  assert.deepEqual([...new Set(missing)], []);
});

test('style.css uses tokens rather than hard-coded hex colours and imports the token file', () => {
  assert.match(styleCss, /^@import '\.\/ui\/tokens\.css';/);
  assert.deepEqual(styleCss.match(/#[0-9a-f]{3,8}\b/gi) ?? [], []);
});

test('font stacks use only locally available fonts (no undeclared web fonts under the CSP)', () => {
  assert.doesNotMatch(`${tokensCss}\n${styleCss}`, /\bInter\b|@font-face|fonts\.googleapis|url\(\s*['"]?https?:/i);
});

test('reduced-motion preference disables token transitions and primitive animations', () => {
  assert.match(tokensCss, /prefers-reduced-motion: reduce[\s\S]*--duration-fast: 0ms/);
  assert.match(styleCss, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
});

test('select and option dropdown menus are explicitly styled with dark surface and accent tokens', () => {
  assert.match(styleCss, /select\s*\{[\s\S]*appearance:\s*none[\s\S]*color-scheme:\s*dark/);
  assert.match(styleCss, /select option,\s*select optgroup\s*\{[\s\S]*background-color:\s*var\(--surface-2\)[\s\S]*color:\s*var\(--text\)/);
  assert.match(styleCss, /select option:checked\s*\{[\s\S]*color:\s*var\(--accent\)/);
});

test('composited translucent header, floating trigger, and selected option backdrops maintain >= 4.5:1 text contrast', () => {
  const headerOnSurface = compositeHex('#0c0a16', 0.94, hex('--color-surface'));
  assert.ok(contrast(hex('--color-text'), headerOnSurface) >= 15);
  assert.ok(contrast(hex('--color-text-muted'), headerOnSurface) >= 7.5);

  const floatingTriggerOnStage = compositeHex('#0c0a16', 0.86, hex('--color-surface-stage'));
  assert.ok(contrast(hex('--color-text'), floatingTriggerOnStage) >= 15);

  const checkedOptionBg = compositeHex(hex('--color-primary'), 0.26, hex('--color-surface-raised'));
  assert.ok(contrast(hex('--accent'), checkedOptionBg) >= 4.5);
});
