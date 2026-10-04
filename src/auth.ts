import type { AsyncEntry } from '@napi-rs/keyring';
import { FigmaClient } from './figma.js';

export async function credentialEntry(): Promise<AsyncEntry> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('figma-listen', 'figma-access-token',
      process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
  } catch {
    throw new Error('System credential store unavailable. Export FIGMA_ACCESS_TOKEN instead. Linux auth requires a running Secret Service.');
  }
}
export async function loadToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env.FIGMA_ACCESS_TOKEN?.trim();
  if (configured) return configured;
  try {
    const saved = await (await credentialEntry()).getPassword();
    if (saved?.trim()) return saved.trim();
  } catch { /* Environment authentication still works without the optional keyring dependency. */ }
  throw new Error('No Figma token. Export FIGMA_ACCESS_TOKEN or run figma-listen auth.');
}
/** A terminal-only hidden prompt; secrets never enter stdout or command arguments. */
export async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('auth needs an interactive terminal. Use FIGMA_ACCESS_TOKEN for headless setup.');
  process.stderr.write('Paste your Figma personal access token (hidden): ');
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', receive); input.off('end', ended); input.setRawMode(wasRaw); input.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const ended = () => finish(new Error('Token input ended'));
    const receive = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Authentication cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0,-1);
        else if (char >= ' ' && value.length < 8192) value += char;
      }
    };
    input.on('data', receive); input.once('end', ended);
  });
}
export async function authenticate(): Promise<void> {
  const token = await promptToken();
  if (!token) throw new Error('Token cannot be empty');
  const figma = new FigmaClient(token);
  try {
    const user = await figma.me();
    await (await credentialEntry()).setPassword(token);
    process.stderr.write(`Connected as ${user.handle ?? user.id}. Token saved in the system credential store.\n`);
    if (process.env.FIGMA_ACCESS_TOKEN) process.stderr.write('FIGMA_ACCESS_TOKEN is set and will take precedence over this saved token.\n');
  } finally { figma.close(); }
}
