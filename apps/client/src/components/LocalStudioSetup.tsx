import { useId, useState } from 'react';

export const LOCAL_STUDIO_LINK = 'screeva://open';
export const LOCAL_STUDIO_RELEASES = 'https://github.com/Bookofharry/Screeva/releases';

interface LocalStudioSetupProps { onContinue: () => void; busy?: boolean }

export function LocalStudioSetup({ onContinue, busy = false }: LocalStudioSetupProps) {
  const titleId = useId();
  const [requested, setRequested] = useState(false);
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId}>Choose how to record</h2>
      <h3>Continue in your browser</h3>
      <p>Record your screen, camera and microphone here. Download your WebM before closing or reloading this tab. Browser recordings use up to 128 MiB of memory and cannot be recovered after the tab closes.</p>
      <button type="button" onClick={onContinue}>Continue in browser</button>
      <h3>Open the local studio</h3>
      <p>The local app saves recordings as you go and supports recovery. MP4 export and finishing durable recordings require FFmpeg and FFprobe installed on your computer. Your media stays on this computer.</p>
      <div className="actions">
        {busy ? <button type="button" disabled>Open local studio</button> : (
          <a className="download-button" href={LOCAL_STUDIO_LINK} onClick={() => setRequested(true)}>Open local studio</a>
        )}
        <a href={LOCAL_STUDIO_RELEASES} target="_blank" rel="noreferrer">Get Screeva for Windows or macOS</a>
      </div>
      {busy && <p>Finish recording and stop capture before opening another studio. Download any browser recording you want to keep.</p>}
      {requested && <p role="status" aria-label="Local studio launch help">Accept your browser’s “Open Screeva” prompt. If nothing opens, the launcher may not be installed or you may have cancelled. Follow setup below, then try again. You can keep using browser recording.</p>}
      <details className="ui-disclosure settings-disclosure" open={requested}>
        <summary>First-time setup and launch help</summary>
        <div className="ui-disclosure__content">
          <ol>
            <li>Download a release that includes the local launcher. Older bundles need updating.</li>
            <li><strong>Windows:</strong> extract the folder to a permanent location, then double-click <strong>Enable Screeva links.cmd</strong> once. Double-click <strong>Start Screeva.cmd</strong> to launch directly.</li>
            <li><strong>macOS (Apple Silicon):</strong> move <strong>Screeva.app</strong> into Applications and open it once to register its launch link. Follow macOS’s normal app-opening prompts.</li>
            <li>Return here and choose <strong>Open local studio</strong>. The app opens a separate local studio when its service is ready. Capture still requires your permission.</li>
          </ol>
          <p>Keep the launcher window open while recording; stop recording before closing it. If the browser prompt is cancelled, click Open local studio again. If setup fails, launch the app directly. Linux users can run from source.</p>
          <p>Install a trusted FFmpeg distribution that includes FFprobe and make both tools available on PATH. No media tools are silently installed.</p>
        </div>
      </details>
    </section>
  );
}
