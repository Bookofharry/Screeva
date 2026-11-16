export type RecordingShortcutAction = 'start' | 'stop' | 'pause' | 'resume' | 'cancel-countdown';

export interface RecordingShortcutInput {
  key: string;
  enabled: boolean;
  blocked: boolean;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  countdownActive: boolean;
  canStart: boolean;
  canStop: boolean;
  canPause: boolean;
  canResume: boolean;
}

const BLOCKED_TARGET_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="slider"]',
  '[role="dialog"]',
  '.pip-move',
  '.pip-resize',
  '.screen-move',
  '.screen-resize',
  '.split-handle',
].join(',');

export function isRecordingShortcutTargetBlocked(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(BLOCKED_TARGET_SELECTOR) !== null ||
    document.documentElement.hasAttribute('data-compositor-dragging');
}

export function resolveRecordingShortcut(input: RecordingShortcutInput): RecordingShortcutAction | null {
  if (!input.enabled || input.blocked || input.repeat || input.ctrlKey || input.altKey || input.metaKey) return null;
  const key = input.key.toLowerCase();
  if (key === 'escape') return input.countdownActive ? 'cancel-countdown' : null;
  if (key === 'r') {
    if (input.canStop) return 'stop';
    return input.canStart ? 'start' : null;
  }
  if (key === 'p') {
    if (input.canPause) return 'pause';
    return input.canResume ? 'resume' : null;
  }
  return null;
}
