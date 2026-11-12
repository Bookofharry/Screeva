import { useEffect, useRef, useState } from 'react';

interface StreamPreviewProps { stream: MediaStream | null; label: string }

export function StreamPreview({ stream, label }: StreamPreviewProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const generation = useRef(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let disposed = false;
    ++generation.current;
    setError('');
    element.muted = true;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {
      if (!disposed) setError('Preview playback was blocked. Retry preview or stop capture.');
    });
    return () => {
      disposed = true;
      ++generation.current;
      element.pause();
      element.srcObject = null;
      // The manager owns track lifetime, not the preview element.
    };
  }, [stream]);

  async function retry() {
    const attempt = generation.current;
    try { await video.current?.play(); if (attempt === generation.current) setError(''); }
    catch { if (attempt === generation.current) setError('Preview playback is unavailable. Stop capture and try again.'); }
  }

  return <div className="preview" hidden={!stream && !error}>
    <video ref={video} aria-label={label} autoPlay muted playsInline onError={event => { if (stream && event.currentTarget.srcObject === stream) setError('Preview could not be displayed. Capture may still be active; stop it or try another source.'); }} />
    {error && stream && <div><p role="alert" className="error">{error}</p><button className="secondary" onClick={() => { void retry(); }}>Retry {label.toLowerCase()}</button></div>}
  </div>;
}
