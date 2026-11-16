import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CanvasCompositor,
  DEFAULT_COMPOSITION,
  DEFAULT_SCREEN_RECT,
  RESOLUTIONS,
  clampNormalizedRect,
  normalizedToPixels,
  splitRegions,
  type CompositionLayout,
  type NormalizedRect,
  type ResolutionPreset,
  type Size,
} from '../media/compositor.js';
import { Icon } from '../ui/Icon.js';
import { useModalFocus } from '../ui/useModalFocus.js';
import {
  LocalFaceDetector,
  initialFaceDetectorSnapshot,
  type FaceDetectorSnapshot,
} from '../media/face-detector.js';
import {
  AutoFrameController,
  initialAutoFrameSnapshot,
  type AutoFrameSnapshot,
} from '../media/auto-framer.js';
import {
  DEFAULT_MANUAL_CAMERA_FRAME,
  MAX_CAMERA_ZOOM,
  isDefaultManualCameraFrame,
  manualCameraCrop,
  normalizeManualCameraFrame,
  type ManualCameraFrame,
} from '../media/camera-framing.js';
import {
  FULL_SCREEN_FOCUS,
  SCREEN_FOCUS_PRESETS,
  ScreenFocusTransitionController,
  createEmptyScreenFocusPresets,
  initialScreenFocusTransitionSnapshot,
  isFullScreenFocus,
  normalizedFocusAspect,
  sameScreenFocus,
  saveScreenFocusPreset,
  screenFocusFromPoints,
  type NormalizedPoint,
  type ScreenFocusPresetId,
} from '../media/screen-focus.js';

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
  const faceDetector = useRef<LocalFaceDetector | null>(null);
  const autoFramer = useRef<AutoFrameController | null>(null);
  const screenFocusController = useRef<ScreenFocusTransitionController | null>(null);
  const sceneDialog = useRef<HTMLDivElement | null>(null);
  const sceneCloseButton = useRef<HTMLButtonElement | null>(null);
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
  const [screenFocus, setScreenFocus] = useState(initialScreenFocusTransitionSnapshot);
  const [screenFocusPresets, setScreenFocusPresets] = useState(createEmptyScreenFocusPresets);
  const [screenFocusSelecting, setScreenFocusSelecting] = useState(false);
  const [pip, setPip] = useState<NormalizedRect>(DEFAULT_COMPOSITION.pip);
  const [outputStatus, setOutputStatus] = useState('30 fps · ready');
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [faceDetectionEnabled, setFaceDetectionEnabled] = useState(false);
  const [faceDetection, setFaceDetection] = useState<FaceDetectorSnapshot>(initialFaceDetectorSnapshot);
  const [autoFrame, setAutoFrame] = useState<AutoFrameSnapshot>(initialAutoFrameSnapshot);
  const [manualFrame, setManualFrame] = useState<ManualCameraFrame>({ ...DEFAULT_MANUAL_CAMERA_FRAME });
  useModalFocus(sceneModalOpen, sceneDialog, sceneCloseButton);

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

  useEffect(() => {
    const framer = new AutoFrameController(snapshot => {
      setAutoFrame(snapshot);
    });
    const detector = new LocalFaceDetector(snapshot => {
      setFaceDetection(snapshot);
      if (snapshot.status === 'running' || snapshot.status === 'no-face') framer.updateFaces(snapshot.faces);
      else if (snapshot.status === 'failed' || snapshot.status === 'unsupported' || snapshot.status === 'source-lost') framer.updateFaces([]);
    });
    autoFramer.current = framer;
    faceDetector.current = detector;
    return () => {
      detector.dispose();
      framer.dispose();
      faceDetector.current = null;
      autoFramer.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new ScreenFocusTransitionController(snapshot => setScreenFocus(snapshot));
    screenFocusController.current = controller;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => controller.setReducedMotion(motion.matches);
    updateMotion();
    motion.addEventListener('change', updateMotion);
    return () => {
      motion.removeEventListener('change', updateMotion);
      controller.dispose();
      screenFocusController.current = null;
    };
  }, []);

  useEffect(() => {
    const detector = faceDetector.current;
    const framer = autoFramer.current;
    if (!detector || !framer) return;
    framer.resetSource();
    if (faceDetectionEnabled && camera) {
      framer.setEnabled(true);
      detector.start(camera);
    } else {
      detector.stop();
      framer.setEnabled(false);
    }
  }, [camera, faceDetectionEnabled]);

  useEffect(() => { engine.current?.setSources({ screen, camera }); }, [screen, camera]);
  useEffect(() => {
    screenFocusController.current?.resetSource();
    setScreenFocusPresets(createEmptyScreenFocusPresets());
    setScreenFocusSelecting(false);
  }, [screen]);
  const manualCrop = manualCameraCrop(manualFrame);
  const activeCameraCrop = faceDetectionEnabled ? autoFrame.crop : manualCrop;
  useEffect(() => {
    engine.current?.setConfig({ layout, preset, split, screen: screenRect, screenCrop: screenFocus.crop, pip, cameraCrop: activeCameraCrop });
  }, [layout, preset, split, screenRect, screenFocus, pip, activeCameraCrop]);
  useEffect(() => {
    onConfigChange?.({ layout, resolution: preset });
  }, [layout, preset, onConfigChange]);

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
      const maxSize = active.target === 'screen' ? 2 : 1;
      const next = active.mode === 'move'
        ? clampNormalizedRect({ ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy }, minSize, maxSize)
        : clampNormalizedRect({ ...active.rect, width: active.rect.width + dx, height: active.rect.height + dy }, minSize, maxSize);
      if (active.target === 'screen') setScreenRect(next);
      else setPip(next);
    };
    const end = (event: PointerEvent) => {
      if (pointer.current?.id !== event.pointerId) return;
      pointer.current = null;
      document.documentElement.removeAttribute('data-compositor-dragging');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.documentElement.removeAttribute('data-compositor-dragging');
    };
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

  function changeScreen(next: NormalizedRect) { setScreenRect(clampNormalizedRect(next, 0.2, 2)); }
  function changeManualFrame(patch: Partial<ManualCameraFrame>) {
    setFaceDetectionEnabled(false);
    setManualFrame(current => normalizeManualCameraFrame({ ...current, ...patch }));
  }
  function applyScreenFocus(focus: NormalizedRect) {
    screenFocusController.current?.transitionTo(focus);
  }
  function saveFocusPreset(id: ScreenFocusPresetId) {
    setScreenFocusPresets(current => saveScreenFocusPreset(current, id, screenFocus.target));
  }
  function stepScreenScale(delta: number) {
    setScreenRect(current => {
      const centerX = current.x + current.width / 2;
      const centerY = current.y + current.height / 2;
      const width = Math.round(Math.min(2, Math.max(0.2, current.width + delta)) * 100) / 100;
      const height = Math.round(Math.min(2, Math.max(0.2, current.height + delta)) * 100) / 100;
      return clampNormalizedRect({
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
      }, 0.2, 2);
    });
  }
  function beginPointer(target: 'pip' | 'screen', mode: 'move' | 'resize', event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const rect = target === 'screen' ? screenRect : pip;
    pointer.current = { target, mode, id: event.pointerId, x: event.clientX, y: event.clientY, rect, split };
    document.documentElement.setAttribute('data-compositor-dragging', '');
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function beginSplitPointer(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    pointer.current = { target: 'split', mode: 'split', id: event.pointerId, x: event.clientX, y: event.clientY, rect: screenRect, split };
    document.documentElement.setAttribute('data-compositor-dragging', '');
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  const size = RESOLUTIONS[preset];
  const screenDestination = screenDestinationSize(layout, size, screenRect, split);
  const pipStyle = { left: `${pip.x * 100}%`, top: `${pip.y * 100}%`, width: `${pip.width * 100}%`, height: `${pip.height * 100}%` };
  const visualScreenRect = {
    x: Math.max(0, screenRect.x),
    y: Math.max(0, screenRect.y),
    width: Math.min(1, screenRect.width),
    height: Math.min(1, screenRect.height),
  };
  const screenStyle = {
    left: `${visualScreenRect.x * 100}%`,
    top: `${visualScreenRect.y * 100}%`,
    width: `${visualScreenRect.width * 100}%`,
    height: `${visualScreenRect.height * 100}%`,
  };
  const isScreenCustom = Math.abs(screenRect.x) > 0.001 || Math.abs(screenRect.y) > 0.001 || Math.abs(screenRect.width - 1) > 0.001 || Math.abs(screenRect.height - 1) > 0.001;
  const isScreenFocused = !isFullScreenFocus(screenFocus.target);
  const faceDetectionStatus = describeCameraFraming(faceDetectionEnabled, camera, faceDetection, autoFrame, manualFrame);

  return (
    <section className="panel compositor-panel" aria-labelledby="compositor-title">
      <div className="panel-heading compositor-header">
        <div className="compositor-header__title">
          <h2 id="compositor-title">Stage preview</h2>
          <span className="badge" role="status" aria-label="Canvas output status">{outputStatus}</span>
        </div>
        <div className="compositor-header__actions">
          <button
            type="button"
            className={faceDetectionEnabled ? 'secondary button-compact face-detection-toggle face-detection-toggle--active' : 'secondary button-compact face-detection-toggle'}
            aria-pressed={faceDetectionEnabled}
            disabled={!camera}
            title={camera ? 'Keep the presenter framed using local analysis' : 'Start the camera to enable local auto framing'}
            onClick={() => setFaceDetectionEnabled(enabled => !enabled)}
          >
            <span className="face-detection-toggle__dot" aria-hidden="true" />
            Auto frame {faceDetectionEnabled ? 'on' : 'off'}
          </button>
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
            <div className="screen-editor__controls" role="group" aria-label="Screen view size controls">
              <button
                type="button"
                aria-label="Decrease screen view"
                className="screen-step-btn"
                disabled={screenRect.width <= 0.2}
                onClick={() => stepScreenScale(-0.1)}
              >
                <Icon name="minus" size={14} />
              </button>
              <button
                type="button"
                aria-label="Move screen view"
                className="screen-move"
                onPointerDown={event => beginPointer('screen', 'move', event)}
              >
                <Icon name="screen" size={13} />
                <span>{Math.round(screenRect.width * 100)}%</span>
              </button>
              <button
                type="button"
                aria-label="Increase screen view"
                className="screen-step-btn"
                disabled={screenRect.width >= 2}
                onClick={() => stepScreenScale(0.1)}
              >
                <Icon name="plus" size={14} />
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
        {screenFocusSelecting && screen && (
          <ScreenFocusSelector
            stream={screen}
            destination={screenDestination}
            onCommit={focus => {
              applyScreenFocus(focus);
              setScreenFocusSelecting(false);
            }}
            onCancel={() => setScreenFocusSelecting(false)}
          />
        )}
      </div>
      <div
        className="scene-modal-backdrop"
        hidden={!sceneModalOpen}
        onClick={event => {
          if (event.target === event.currentTarget) setSceneModalOpen(false);
        }}
      >
        <div ref={sceneDialog} className="panel scene-modal" role="dialog" aria-modal="true" aria-labelledby="scene-settings-title">
          <div className="panel-heading scene-modal__header">
            <div className="scene-modal__title-group">
              <h2 id="scene-settings-title">Scene &amp; output settings</h2>
              <span className="badge">{size.width} × {size.height} · 30 fps</span>
            </div>
            <button
              ref={sceneCloseButton}
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
            <section className="face-detection-control" aria-labelledby="face-detection-title">
              <div>
                <h3 id="face-detection-title">Camera framing</h3>
                <p>{faceDetectionStatus}</p>
              </div>
              <fieldset className="camera-framing-mode" disabled={!camera}>
                <legend>Framing mode</legend>
                <label><input type="radio" name="camera-framing-mode" checked={!faceDetectionEnabled} onChange={() => setFaceDetectionEnabled(false)} /> Manual</label>
                <label><input type="radio" name="camera-framing-mode" checked={faceDetectionEnabled} onChange={() => setFaceDetectionEnabled(true)} /> Automatic</label>
              </fieldset>
              {!faceDetectionEnabled && (
                <div className="manual-camera-controls" role="group" aria-label="Manual camera framing controls">
                  <label>
                    Camera zoom <output>{manualFrame.zoom.toFixed(1)}×</output>
                    <input
                      aria-label="Camera zoom"
                      type="range"
                      min="100"
                      max={String(MAX_CAMERA_ZOOM * 100)}
                      step="5"
                      value={Math.round(manualFrame.zoom * 100)}
                      disabled={!camera}
                      onChange={event => changeManualFrame({ zoom: Number(event.target.value) / 100 })}
                    />
                  </label>
                  <label>
                    Horizontal position <output>{Math.round(manualFrame.panX * 100)}%</output>
                    <input
                      aria-label="Camera horizontal position"
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(manualFrame.panX * 100)}
                      disabled={!camera || manualFrame.zoom <= 1}
                      onChange={event => changeManualFrame({ panX: Number(event.target.value) / 100 })}
                    />
                  </label>
                  <label>
                    Vertical position <output>{Math.round(manualFrame.panY * 100)}%</output>
                    <input
                      aria-label="Camera vertical position"
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(manualFrame.panY * 100)}
                      disabled={!camera || manualFrame.zoom <= 1}
                      onChange={event => changeManualFrame({ panY: Number(event.target.value) / 100 })}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary button-compact"
                    disabled={!camera || isDefaultManualCameraFrame(manualFrame)}
                    onClick={() => changeManualFrame(DEFAULT_MANUAL_CAMERA_FRAME)}
                  >
                    Reset manual framing
                  </button>
                </div>
              )}
              {faceDetectionEnabled && faceDetection.sampleCount > 0 && (
                <dl className="face-detection-metrics" aria-label="Face detector performance">
                  <div><dt>Faces</dt><dd>{faceDetection.faces.length}</dd></div>
                  <div><dt>Sampling</dt><dd>{faceDetection.samplingHz} Hz</dd></div>
                  <div><dt>Inference</dt><dd>{Math.round(faceDetection.averageInferenceMs ?? 0)} ms</dd></div>
                  <div><dt>Samples</dt><dd>{faceDetection.sampleCount}</dd></div>
                  <div><dt>Framing</dt><dd>{autoFrame.status}</dd></div>
                  <div><dt>Crop</dt><dd>{(1 / autoFrame.crop.width).toFixed(1)}×</dd></div>
                </dl>
              )}
            </section>
            <section className="screen-focus-control" aria-labelledby="screen-focus-title">
              <div>
                <h3 id="screen-focus-title">Screen focus</h3>
                <p role="status">
                  {!screen
                    ? 'Start screen sharing to select a focus area.'
                    : screenFocus.status === 'transitioning'
                      ? `Smoothly transitioning to a ${Math.round(screenFocus.target.width * 100)}% wide source region.`
                      : isScreenFocused
                        ? `Custom source region selected (${Math.round(screenFocus.crop.width * 100)}% wide).`
                      : 'Full shared screen is visible.'}
                </p>
              </div>
              <div className="screen-focus-control__actions">
                <button
                  type="button"
                  className="secondary button-compact"
                  disabled={!screen || layout === 'camera'}
                  onClick={() => {
                    setSceneModalOpen(false);
                    setScreenFocusSelecting(true);
                  }}
                >
                  Select focus area
                </button>
                <button
                  type="button"
                  className="secondary button-compact"
                  disabled={!screen || !isScreenFocused}
                  onClick={() => applyScreenFocus(FULL_SCREEN_FOCUS)}
                >
                  Reset screen focus
                </button>
              </div>
              <div className="screen-focus-presets" role="group" aria-label="Screen focus presets">
                <button
                  type="button"
                  className="screen-focus-preset"
                  aria-pressed={isFullScreenFocus(screenFocus.target)}
                  disabled={!screen}
                  onClick={() => applyScreenFocus(FULL_SCREEN_FOCUS)}
                >
                  Full frame
                </button>
                {SCREEN_FOCUS_PRESETS.map(item => {
                  const saved = screenFocusPresets[item.id];
                  const active = saved ? sameScreenFocus(saved, screenFocus.target) : false;
                  return (
                    <div className="screen-focus-preset-slot" key={item.id}>
                      <button
                        type="button"
                        className="screen-focus-preset"
                        aria-label={`Apply ${item.label} focus preset`}
                        aria-pressed={active}
                        disabled={!screen || !saved}
                        onClick={() => {
                          if (saved) applyScreenFocus(saved);
                        }}
                      >
                        {item.label}
                      </button>
                      <button
                        type="button"
                        className="screen-focus-preset-save"
                        aria-label={`Save current focus as ${item.label} preset`}
                        disabled={!screen || !isScreenFocused}
                        onClick={() => saveFocusPreset(item.id)}
                      >
                        {saved ? 'Update' : 'Save'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="screen-focus-control__note">Selection uses only this shared-screen preview. Screeva does not track the system pointer.</p>
            </section>
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

interface ScreenFocusSelectorProps {
  stream: MediaStream;
  destination: Size;
  onCommit: (focus: NormalizedRect) => void;
  onCancel: () => void;
}

interface FocusSelectionGeometry {
  focus: NormalizedRect;
  left: number;
  top: number;
  width: number;
  height: number;
}

function ScreenFocusSelector({ stream, destination, onCommit, onCancel }: ScreenFocusSelectorProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<{ id: number; start: NormalizedPoint } | null>(null);
  const cancel = useRef(onCancel);
  const [selection, setSelection] = useState<FocusSelectionGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  cancel.current = onCancel;

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    node.srcObject = stream;
    void node.play().catch(() => undefined);
    const track = stream.getVideoTracks()[0];
    const ended = () => cancel.current();
    track?.addEventListener('ended', ended);
    return () => {
      track?.removeEventListener('ended', ended);
      node.pause();
      node.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    document.documentElement.setAttribute('data-compositor-dragging', '');
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancel.current();
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      document.documentElement.removeAttribute('data-compositor-dragging');
    };
  }, []);

  function geometry(element: HTMLDivElement, point: { clientX: number; clientY: number }) {
    const bounds = element.getBoundingClientRect();
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    const sourceWidth = video.current?.videoWidth || settings?.width || 1;
    const sourceHeight = video.current?.videoHeight || settings?.height || 1;
    const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight);
    const contentWidth = sourceWidth * scale;
    const contentHeight = sourceHeight * scale;
    const contentLeft = (bounds.width - contentWidth) / 2;
    const contentTop = (bounds.height - contentHeight) / 2;
    return {
      bounds,
      source: { width: sourceWidth, height: sourceHeight },
      contentLeft,
      contentTop,
      contentWidth,
      contentHeight,
      point: {
        x: Math.min(1, Math.max(0, (point.clientX - bounds.left - contentLeft) / contentWidth)),
        y: Math.min(1, Math.max(0, (point.clientY - bounds.top - contentTop) / contentHeight)),
      },
    };
  }

  function focusForEvent(element: HTMLDivElement, start: NormalizedPoint, event: ReactPointerEvent<HTMLDivElement>) {
    const measured = geometry(element, event);
    const focus = screenFocusFromPoints(start, measured.point, normalizedFocusAspect(measured.source, destination));
    if (!focus) return null;
    return {
      focus,
      left: measured.contentLeft + focus.x * measured.contentWidth,
      top: measured.contentTop + focus.y * measured.contentHeight,
      width: focus.width * measured.contentWidth,
      height: focus.height * measured.contentHeight,
    };
  }

  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    setError(null);
    setSelection(null);
    drag.current = { id: event.pointerId, start: geometry(event.currentTarget, event).point };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    setSelection(focusForEvent(event.currentTarget, active.start, event));
  }

  function end(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const next = focusForEvent(event.currentTarget, active.start, event);
    drag.current = null;
    if (!next) {
      setSelection(null);
      setError('Drag a larger area to set screen focus.');
      return;
    }
    onCommit(next.focus);
  }

  return (
    <div className="screen-focus-selector" role="region" aria-label="Select screen focus area">
      <video ref={video} muted playsInline aria-label="Full shared screen for focus selection" />
      <div
        className="screen-focus-selector__pointer"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          setSelection(null);
        }}
      >
        {selection && (
          <div
            className="screen-focus-selection"
            style={{ left: selection.left, top: selection.top, width: selection.width, height: selection.height }}
          />
        )}
      </div>
      <div className="screen-focus-selector__instructions">
        <span>{error ?? 'Drag over the shared screen to select the recorded focus area.'}</span>
        <button type="button" className="secondary button-compact" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function screenDestinationSize(
  layout: CompositionLayout,
  output: Size,
  screen: NormalizedRect,
  split: number,
): Size {
  if (layout === 'split') {
    const region = splitRegions(output, split).screen;
    return { width: region.width, height: region.height };
  }
  if (layout === 'camera') return { width: 0, height: 0 };
  const region = normalizedToPixels(screen, output);
  return { width: region.width, height: region.height };
}

function describeCameraFraming(
  enabled: boolean,
  camera: MediaStream | null,
  snapshot: FaceDetectorSnapshot,
  framing: AutoFrameSnapshot,
  manual: ManualCameraFrame,
): string {
  if (!camera) return 'Start the camera to adjust manual framing or enable local auto framing.';
  if (!enabled) return `Manual framing at ${manual.zoom.toFixed(1)}×. Camera frames are not analyzed.`;
  if (framing.status === 'holding') return 'Face temporarily lost; holding the last stable framing.';
  if (framing.status === 'recentering') return 'Face lost; smoothly returning to the full camera frame.';
  switch (snapshot.status) {
    case 'starting': return 'Starting the local detector and waiting for camera frames.';
    case 'running': return `${snapshot.faces.length} face${snapshot.faces.length === 1 ? '' : 's'} detected; framing is following the primary presenter.`;
    case 'no-face': return 'Running locally; no face has been detected yet.';
    case 'unsupported': return 'Unavailable: the packaged local detector could not start in this browser.';
    case 'source-lost': return 'Stopped because the camera source ended.';
    case 'failed': return snapshot.error ?? 'Local auto framing failed.';
    case 'idle': return 'Ready to start local auto framing.';
  }
}
