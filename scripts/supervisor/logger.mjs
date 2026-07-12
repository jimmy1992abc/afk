import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendBoundedLog(path, event, options = {}) {
  const maxBytes = options.maxBytes ?? 1_048_576;
  const copies = options.copies ?? 3;
  await mkdir(dirname(path), { recursive: true });
  try {
    const info = await stat(path);
    if (info.size >= maxBytes) {
      await rm(`${path}.${copies}`, { force: true });
      for (let index = copies - 1; index >= 1; index -= 1) {
        try { await rename(`${path}.${index}`, `${path}.${index + 1}`); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await rename(path, `${path}.1`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}
