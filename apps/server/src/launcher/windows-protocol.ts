import path from 'node:path';

export const SCREEVA_PROTOCOL_KEY = 'HKCU\\Software\\Classes\\screeva';

export function windowsProtocolCommand(executable: string, entry: string): string {
  for (const value of [executable, entry]) {
    if (!path.win32.isAbsolute(value) || /["\r\n\0%]/.test(value)) throw new Error('Unsupported installation path.');
  }
  // Direct executable activation; cmd.exe and shell expansion are never involved.
  return `"${executable}" "${entry}" "%1"`;
}

export function windowsProtocolRegistration(command: string): string[][] {
  return [
    ['add', SCREEVA_PROTOCOL_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:Screeva local studio', '/f'],
    ['add', SCREEVA_PROTOCOL_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['add', `${SCREEVA_PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ];
}
