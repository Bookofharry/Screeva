import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

declare global {
  interface Window {
    audioMixerTest: {
      destinations: MediaStream[];
      streams: MediaStream[];
      speakerConnections: number;
      setMuted(streamIndex: number, muted: boolean): void;
      states(): MediaStreamTrackState[];
    };
  }
}

async function installSyntheticAudio(page: Page) {
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    const destinations: MediaStream[] = [];
    const contexts: AudioContext[] = [];
    let speakerConnections = 0;
    const nativeConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: Parameters<AudioNode['connect']>) {
      if (args[0] instanceof AudioDestinationNode) speakerConnections++;
      return nativeConnect.apply(this, args);
    } as AudioNode['connect'];
    const createDestination = AudioContext.prototype.createMediaStreamDestination;
    AudioContext.prototype.createMediaStreamDestination = function (this: AudioContext) {
      const destination = createDestination.call(this);
      destinations.push(destination.stream);
      return destination;
    };

    navigator.mediaDevices.enumerateDevices = async () => [
      { deviceId: 'synthetic-mic', groupId: 'synthetic', kind: 'audioinput', label: 'Synthetic tone microphone', toJSON: () => ({}) },
    ];

    function audioTrack(frequency: number) {
      const context = new AudioContext(); contexts.push(context);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.35;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      const track = destination.stream.getAudioTracks()[0]!;
      const stop = track.stop.bind(track);
      track.stop = () => {
        try { oscillator.stop(); } catch { /* already stopped */ }
        stop();
        void context.close();
      };
      return track;
    }

    function microphoneStream() {
      const stream = new MediaStream([audioTrack(440)]);
      streams.push(stream);
      return stream;
    }

    function displayStream() {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#204c71'; drawing.fillRect(0, 0, canvas.width, canvas.height);
      const video = canvas.captureStream(5).getVideoTracks()[0]!;
      const stream = new MediaStream([video, audioTrack(660)]);
      streams.push(stream);
      return stream;
    }

    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints?.audio) throw new DOMException('Video is not used in audio mixer tests', 'NotSupportedError');
      return microphoneStream();
    };
    navigator.mediaDevices.getDisplayMedia = async () => displayStream();
    window.audioMixerTest = {
      destinations,
      streams,
      get speakerConnections() { return speakerConnections; },
      setMuted: (streamIndex, muted) => {
        const track = streams[streamIndex]?.getAudioTracks()[0];
        if (!track) return;
        Object.defineProperty(track, 'muted', { configurable: true, value: muted });
        track.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
      },
      states: () => streams.flatMap(stream => stream.getTracks()).map(track => track.readyState),
    };
    window.addEventListener('unload', () => contexts.forEach(context => { void context.close(); }));
  });
}

async function enableAudioIfNeeded(page: Page) {
  const button = page.getByRole('button', { name: 'Enable audio processing' });
  if (await button.isVisible()) await button.click();
}

async function meterValue(page: Page, label: string) {
  return page.getByLabel(label).evaluate((meter: HTMLMeterElement) => meter.value);
}

async function mixedOutputLevel(page: Page) {
  return page.evaluate(async () => {
    const mixed = window.audioMixerTest.destinations[0];
    if (!mixed) return -1;
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(mixed);
    const analyser = context.createAnalyser();
    const sink = context.createMediaStreamDestination();
    analyser.fftSize = 256;
    source.connect(analyser).connect(sink);
    await new Promise(resolve => setTimeout(resolve, 150));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    const level = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    source.disconnect(); analyser.disconnect();
    await context.close();
    return level;
  });
}

test('synthetic microphone drives a live meter with independent gain and mute', async ({ page }) => {
  await installSyntheticAudio(page);
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Mixed audio output status' })).toContainText(/ready|paused/);
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('No audio routed');
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await enableAudioIfNeeded(page);
  await expect(page.getByRole('status', { name: 'Mixed audio output status' })).toContainText('ready');
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone only');
  await expect.poll(() => meterValue(page, 'Microphone live level')).toBeGreaterThan(0.05);
  await expect.poll(() => mixedOutputLevel(page), { timeout: 10000 }).toBeGreaterThan(0.01);
  const full = await meterValue(page, 'Microphone live level');
  await page.getByLabel('Microphone gain').fill('50');
  await expect.poll(() => meterValue(page, 'Microphone live level')).toBeLessThan(full * 0.75);
  await page.getByLabel('Mute microphone').check();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('No audio routed');
  await expect.poll(() => meterValue(page, 'Microphone live level')).toBe(0);
  await expect.poll(() => mixedOutputLevel(page)).toBeLessThan(0.001);
  await page.getByLabel('Mute microphone').uncheck();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone only');
  expect(await page.evaluate(() => window.audioMixerTest.speakerConnections)).toBe(0);
  await page.getByRole('button', { name: 'Stop microphone', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('No audio routed');
  expect(await page.evaluate(() => window.audioMixerTest.states().every(state => state === 'ended'))).toBe(true);
});

test('combined synthetic sources isolate controls and survive mute, replacement and source loss', async ({ page }) => {
  await installSyntheticAudio(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await enableAudioIfNeeded(page);
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone + display audio');
  await expect.poll(() => meterValue(page, 'Microphone live level')).toBeGreaterThan(0.05);
  await expect.poll(() => meterValue(page, 'Display audio live level')).toBeGreaterThan(0.05);

  await page.getByLabel('Mute microphone').check();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Display audio only');
  await expect.poll(() => meterValue(page, 'Microphone live level')).toBe(0);
  await expect.poll(() => meterValue(page, 'Display audio live level')).toBeGreaterThan(0.05);

  await page.evaluate(() => window.audioMixerTest.setMuted(1, true));
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('No audio routed');
  await page.evaluate(() => window.audioMixerTest.setMuted(1, false));
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Display audio only');

  await page.getByLabel('Mute microphone').uncheck();
  await page.getByRole('button', { name: 'Switch microphone', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone + display audio');
  expect(await page.evaluate(() => window.audioMixerTest.streams[0]?.getAudioTracks()[0]?.readyState)).toBe('ended');
  expect(await page.evaluate(() => window.audioMixerTest.streams[2]?.getAudioTracks()[0]?.readyState)).toBe('live');

  await page.getByRole('button', { name: 'Stop display', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('Microphone only');
  await page.getByRole('button', { name: 'Stop microphone', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio mix mode' })).toHaveText('No audio routed');
  expect(await page.evaluate(() => window.audioMixerTest.states().every(state => state === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.audioMixerTest.speakerConnections)).toBe(0);
});

test('unsupported Web Audio reports an error without disabling capture', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined }); });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Web Audio mixing is unavailable');
  await expect(page.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start microphone', exact: true })).toBeEnabled();
});
