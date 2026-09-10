import { TextDecoder } from 'node:util';

export function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

export function utf8Prefix(text, maxBytes) {
  const value = String(text);
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.max(0, maxBytes); end >= Math.max(0, maxBytes - 3); end--) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // A UTF-8 boundary is at most three bytes before the requested prefix.
    }
  }
  return '';
}

export function truncateWithMarker(text, maxBytes, makeMarker) {
  const value = String(text);
  const originalBytes = byteLength(value);
  if (originalBytes <= maxBytes) return { text: value, truncated: false, omittedBytes: 0 };

  let omittedBytes = originalBytes;
  for (let attempt = 0; attempt < 8; attempt++) {
    const marker = String(makeMarker(omittedBytes));
    const available = maxBytes - byteLength(marker);
    if (available < 0) return { text: '', truncated: true, omittedBytes: originalBytes, markerFits: false };
    const prefix = utf8Prefix(value, available);
    const nextOmitted = originalBytes - byteLength(prefix);
    if (nextOmitted === omittedBytes) {
      return { text: prefix + marker, truncated: true, omittedBytes, markerFits: true };
    }
    omittedBytes = nextOmitted;
  }
  const marker = String(makeMarker(omittedBytes));
  const prefix = utf8Prefix(value, Math.max(0, maxBytes - byteLength(marker)));
  return {
    text: prefix + marker,
    truncated: true,
    omittedBytes: originalBytes - byteLength(prefix),
    markerFits: byteLength(marker) <= maxBytes,
  };
}
