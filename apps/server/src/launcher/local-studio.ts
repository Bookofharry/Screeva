import { capabilitiesSchema, responseSchema } from '../../../../packages/shared/src/index.js';

export const LOCAL_STUDIO_ORIGIN = 'http://127.0.0.1:4317';
export type StudioProbe = 'ready' | 'absent' | 'starting' | 'occupied';
export interface LaunchedStudio { close(): Promise<void> }
export interface LauncherRuntime {
  probe(): Promise<StudioProbe>;
  start(): Promise<LaunchedStudio>;
  openBrowser(): Promise<void>;
  wait(signal: AbortSignal): Promise<void>;
}

/** No URL payload, path, port, command or capture request is accepted. */
export function validateLaunchArguments(args: readonly string[]): void {
  if (args.length === 0) return;
  if (args.length === 1 && (args[0] === 'screeva://open' || args[0] === 'screeva://open/')) return;
  throw new Error('Unsupported launch request. Open Screeva from its installed shortcut.');
}

export async function probeLocalStudio(fetcher: typeof fetch = fetch): Promise<StudioProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetcher(`${LOCAL_STUDIO_ORIGIN}/api/v1/capabilities`, {
      signal: controller.signal, redirect: 'error', cache: 'no-store',
    });
    try {
      if (response.status === 503) return 'starting';
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) return 'occupied';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 16_384) return 'occupied';
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const result = responseSchema(capabilitiesSchema).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return result.success && result.data.ok ? 'ready' : 'occupied';
    } finally { controller.abort(); }
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED' ? 'absent' : 'occupied';
  } finally { clearTimeout(timeout); }
}

/** Returns only the server this invocation owns. Never stops a reused service. */
export async function openLocalStudio(runtime: LauncherRuntime, signal: AbortSignal): Promise<LaunchedStudio | null> {
  let owned: LaunchedStudio | null = null;
  try {
    signal.throwIfAborted();
    let state = await runtime.probe();
    signal.throwIfAborted();
    if (state === 'occupied') throw new Error('Port 4317 is in use by an unavailable or different service. Close that service or launch Screeva manually on another port.');
    if (state === 'absent') {
      try { owned = await runtime.start(); }
      catch (error) {
        // Another launcher may have acquired the listening port first.
        if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      }
      state = 'starting';
    }
    for (let attempt = 0; state !== 'ready' && attempt < 30; attempt += 1) {
      signal.throwIfAborted();
      state = await runtime.probe();
      if (state === 'occupied') throw new Error('The local service did not return a valid Screeva response.');
      if (state !== 'ready') await runtime.wait(signal);
    }
    signal.throwIfAborted();
    if (state !== 'ready') throw new Error('Screeva did not become ready in time. Existing recordings were retained. Try launching the app again.');
    await runtime.openBrowser();
    signal.throwIfAborted();
    return owned;
  } catch (error) {
    await owned?.close();
    throw error;
  }
}
