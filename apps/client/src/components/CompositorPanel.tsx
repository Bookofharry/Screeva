import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CanvasCompositor,
  DEFAULT_COMPOSITION,
  DEFAULT_SCREEN_RECT,
  RESOLUTIONS,
  clampNormalizedRect,
  type CompositionLayout,
  type NormalizedRect,
  type ResolutionPreset,
} from '../media/compositor.js';
import { Icon } from '../ui/Icon.js';

interface CompositorPanelProps {
  screen: MediaStream | null;
  camera: MediaStream | null;
  readinessSlotRef?: ((element: HTMLElement | null) => void) | undefined;
  onOutputChange?: (stream: MediaStream | null) => void;
  onConfigChange?: (config: { layout: CompositionLayout; resolution: ResolutionPreset }) => void;
}
type DragMode = 'move' | 'resize' | 'split';
type DragTarget = 'pip' | 'screen' | 'split';

const layoutPresets: ReadonlyArray<{ id: CompositionLayout; label: string; shortLabel: string }> = [
  { id: 'pip', label: 'Picture in picture', shortLabel: 'PIP' },
  { id: 'split', label: 'Split screen', shortLabel: 'Split' },
  { id: 'screen', label: 'Screen only', shortLabel: 'Screen' },
  { id: 'camera', label: 'Camera only', shortLabel: 'Camera' },
];

export function CompositorPanel({
  screen,
  camera,
  readinessSlotRef,
  onOutputChange,
  onConfigChange,
}: CompositorPanelProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const engine = useRef<CanvasCompositor | null>(null);
  const pointer = useRef<{
    target: DragTarget;
    mode: DragMode;
    id: number;
    x: number;
    y: number;
    rect: NormalizedRect;
    split: number;
  } | null>(null);
  const [layout, setLayout] = useState<CompositionLayout>(DEFAULT_COMPOSITION.layout);
  const [preset, setPreset] = useState<ResolutionPreset>(DEFAULT_COMPOSITION.preset);
  const [split, setSplit] = useState(DEFAULT_COMPOSITION.split);
  const [screenRect, setScreenRect] = useState<NormalizedRect>(DEFAULT_COMPOSITION.screen);
  const [pip, setPip] = useState<NormalizedRect>(DEFAULT_COMPOSITION.pip);
  const [outputStatus, setOutputStatus] = useState('30 fps · ready');
  const [sceneModalOpen, setSceneModalOpen] = useState(false);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    try {
      const compositor = new CanvasCompositor(node);
      engine.current = compositor;
      compositor.start();
      try {
        const output = compositor.getOutputStream();
        setOutputStatus('30 fps · ready');
        onOutputChange?.(output);
      } catch {
        setOutputStatus('Preview ready · captureStream unavailable');
        onOutputChange?.(null);
      }
      return () => {
        onOutputChange?.(null);
        compositor.dispose();
        engine.current = null;
      };
    } catch {
      setOutputStatus('Canvas 2D context is unavailable in this browser');
      onOutputChange?.(null);
      return;
    }
  }, [onOutputChange]);

  useEffect(() => { engine.current?.setSources({ screen, camera }); }, [screen, camera]);
  useEffect(() => {
    engine.current?.setConfig({ layout, preset, split, screen: screenRect, pip });
    onConfigChange?.({ layout, resolution: preset });
  }, [layout, preset, split, screenRect, pip, onConfigChange]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = pointer.current; const stage = canvas.current;
      if (!active || active.id !== event.pointerId || !stage) return;
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const dx = (event.clientX - active.x) / bounds.width; const dy = (event.clientY - active.y) / bounds.height;
      if (active.target === 'split') {
        const nextSplit = Math.min(0.8, Math.max(0.2, active.split + dx));
        setSplit(nextSplit);
        return;
      }
      const minSize = active.target === 'screen' ? 0.2 : 0.12;
      const next = active.mode === 'move'
        ? clampNormalizedRect({ ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy }, minSize)
        : clampNormalizedRect({ ...active.rect, width: active.rect.width + dx, height: active.rect.height + dy }, minSize);
      if (active.target === 'screen') setScreenRect(next);
      else setPip(next);
    };
    const end = (event: PointerEvent) => { if (pointer.current?.id === event.pointerId) pointer.current = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, []);

  useEffect(() => {
    if (!sceneModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSceneModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sceneModalOpen]);

  function changePip(next: NormalizedRect) { setPip(clampNormalizedRect(next)); }
  function changeScreen(next: NormalizedRect) { setScreenRect(clampNormalizedRect(next, 0.2)); }
  function beginPointer(target: 'pip' | 'screen', mode: 'move' | 'resize', event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const rect = target === 'screen' ? screenRect : pip;
    pointer.current = { target, mode, id: event.pointerId, x: event.clientX, y: event.clientY, rect, split };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function beginSplitPointer(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    pointer.current = { target: 'split', mode: 'split', id: event.pointerId, x: event.clientX, y: event.clientY, rect: screenRect, split };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  const size = RESOLUTIONS[preset];
  const pipStyle = { left: `${pip.x * 100}%`, top: `${pip.y * 100}%`, width: `${pip.width * 100}%`, height: `${pip.height * 100}%` };
  const screenStyle = { left: `${screenRect.x * 100}%`, top: `${screenRect.y * 100}%`, width: `${screenRect.width * 100}%`, height: `${screenRect.height * 100}%` };
  const isScreenCustom = screenRect.x > 0.001 || screenRect.y > 0.001 || screenRect.width < 0.999 || screenRect.height < 0.999;

  return (
    <section className="panel compositor-panel" aria-labelledby="compositor-title">
      <div className="panel-heading compositor-header">
        <div className="compositor-header__title">
          <h2 id="compositor-title">Stage preview</h2>
          <span className="badge" role="status" aria-label="Canvas output status">{outputStatus}</span>
        </div>
        <div className="compositor-header__actions">
          <div className="layout-presets" role="group" aria-label="Scene composition presets">
            {layoutPresets.map(item => (
              <button
                key={item.id}
                type="button"
                className={layout === item.id ? 'layout-preset layout-preset--active' : 'layout-preset'}
                aria-pressed={layout === item.id}
                onClick={() => setLayout(item.id)}
              >
                {item.shortLabel}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="secondary button-compact stage-settings-pill"
            aria-haspopup="dialog"
            aria-expanded={sceneModalOpen}
            onClick={() => setSceneModalOpen(open => !open)}
          >
            <Icon name="sliders" size={14} />
            <span>{preset} · Scene settings</span>
          </button>
        </div>
      </div>
      <div className="compositor-stage">
        <canvas ref={canvas} aria-label="Composed video preview" />
        <button
          type="button"
          className="stage-floating-trigger"
          aria-label="Scene & output settings"
          aria-haspopup="dialog"
          aria-expanded={sceneModalOpen}
          title="Scene & output settings"
          onClick={() => setSceneModalOpen(open => !open)}
        >
          <Icon name="sliders" size={18} />
        </button>
        {(layout === 'pip' || layout === 'screen') && screen && (
          <div className={isScreenCustom ? 'screen-editor screen-editor--custom' : 'screen-editor'} style={screenStyle}>
            <div className="screen-editor__controls">
              <button
                type="button"
                aria-label="Move screen view"
                className="screen-move"
                onPointerDown={event => beginPointer('screen', 'move', event)}
              >
                Move screen
              </button>
              {isScreenCustom && (
                <button
                  type="button"
                  aria-label="Reset screen view"
                  className="screen-reset"
                  onClick={() => changeScreen(DEFAULT_SCREEN_RECT)}
                >
                  Reset
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Resize screen view"
              className="screen-resize"
              onPointerDown={event => beginPointer('screen', 'resize', event)}
            >
              ↘
            </button>
          </div>
        )}
        {layout === 'split' && screen && camera && (
          <button
            type="button"
            aria-label="Resize split screen"
            className="split-resize"
            style={{ left: `${split * 100}%` }}
            onPointerDown={beginSplitPointer}
          >
            ↔
          </button>
        )}
        {layout === 'pip' && camera && <div className="pip-editor" style={pipStyle}>
          <button type="button" aria-label="Move webcam overlay" className="pip-move" onPointerDown={event => beginPointer('pip', 'move', event)}>Move webcam</button>
          <button type="button" aria-label="Resize webcam overlay" className="pip-resize" onPointerDown={event => beginPointer('pip', 'resize', event)}>↘</button>
        </div>}
      </div>
      <div
        className="scene-modal-backdrop"
        hidden={!sceneModalOpen}
        onClick={event => {
          if (event.target === event.currentTarget) setSceneModalOpen(false);
        }}
      >
        <div className="panel scene-modal" role="dialog" aria-modal="true" aria-labelledby="scene-settings-title">
          <div className="panel-heading scene-modal__header">
            <div className="scene-modal__title-group">
              <h2 id="scene-settings-title">Scene &amp; output settings</h2>
              <span className="badge">{size.width} × {size.height} · 30 fps</span>
            </div>
            <button
              type="button"
              className="secondary button-compact scene-modal__close"
              aria-label="Close scene settings"
              onClick={() => setSceneModalOpen(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="compositor-toolbar">
            <div className="compositor-controls">
              <label>Layout<select value={layout} onChange={event => setLayout(event.target.value as CompositionLayout)}>
                <option value="screen">Screen only</option><option value="camera">Camera only</option><option value="pip">Picture in picture</option><option value="split">Split screen</option>
              </select></label>
              <label>Resolution<select value={preset} onChange={event => setPreset(event.target.value as ResolutionPreset)}>
                <option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option>
              </select></label>
              {layout === 'split' && <label>Screen proportion <output>{Math.round(split * 100)}%</output><input aria-label="Screen proportion" type="range" min="20" max="80" value={Math.round(split * 100)} onChange={event => setSplit(Number(event.target.value) / 100)} /></label>}
            </div>
            {(layout === 'pip' || layout === 'screen') && <fieldset className="pip-controls"><legend>Screen view geometry</legend>
              <div className="pip-controls__grid">
                <label>Horizontal <output>{Math.round(screenRect.x * 100)}%</output><input aria-label="Screen horizontal position" type="range" min="0" max={Math.round((1 - screenRect.width) * 100)} value={Math.round(screenRect.x * 100)} onChange={event => changeScreen({ ...screenRect, x: Number(event.target.value) / 100 })} /></label>
                <label>Vertical <output>{Math.round(screenRect.y * 100)}%</output><input aria-label="Screen vertical position" type="range" min="0" max={Math.round((1 - screenRect.height) * 100)} value={Math.round(screenRect.y * 100)} onChange={event => changeScreen({ ...screenRect, y: Number(event.target.value) / 100 })} /></label>
                <label>Width <output>{Math.round(screenRect.width * 100)}%</output><input aria-label="Screen view width" type="range" min="20" max="100" value={Math.round(screenRect.width * 100)} onChange={event => changeScreen({ ...screenRect, width: Number(event.target.value) / 100 })} /></label>
                <label>Height <output>{Math.round(screenRect.height * 100)}%</output><input aria-label="Screen view height" type="range" min="20" max="100" value={Math.round(screenRect.height * 100)} onChange={event => changeScreen({ ...screenRect, height: Number(event.target.value) / 100 })} /></label>
              </div>
            </fieldset>}
            {layout === 'pip' && <fieldset className="pip-controls"><legend>Webcam overlay geometry</legend>
              <div className="pip-controls__grid">
                <label>Horizontal <output>{Math.round(pip.x * 100)}%</output><input aria-label="Webcam horizontal position" type="range" min="0" max={Math.round((1 - pip.width) * 100)} value={Math.round(pip.x * 100)} onChange={event => changePip({ ...pip, x: Number(event.target.value) / 100 })} /></label>
                <label>Vertical <output>{Math.round(pip.y * 100)}%</output><input aria-label="Webcam vertical position" type="range" min="0" max={Math.round((1 - pip.height) * 100)} value={Math.round(pip.y * 100)} onChange={event => changePip({ ...pip, y: Number(event.target.value) / 100 })} /></label>
                <label>Width <output>{Math.round(pip.width * 100)}%</output><input aria-label="Webcam overlay width" type="range" min="15" max="60" value={Math.round(pip.width * 100)} onChange={event => changePip({ ...pip, width: Number(event.target.value) / 100 })} /></label>
                <label>Height <output>{Math.round(pip.height * 100)}%</output><input aria-label="Webcam overlay height" type="range" min="15" max="60" value={Math.round(pip.height * 100)} onChange={event => changePip({ ...pip, height: Number(event.target.value) / 100 })} /></label>
              </div>
            </fieldset>}
            <div ref={readinessSlotRef} className="scene-modal__readiness" />
          </div>
          <div className="scene-modal__footer">
            <button type="button" onClick={() => setSceneModalOpen(false)}>
              Done
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
