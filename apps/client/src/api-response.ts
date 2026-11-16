export async function readJsonResponse(response: Response, fallback: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${fallback} The response was not JSON. Open Screeva from the loopback address shown by the local server, or use Quick browser test mode.`);
  }
}
