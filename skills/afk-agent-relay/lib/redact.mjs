// redact.mjs — secret redaction + default exclude globs.
//
// Secrets must never leave the machine. Two layers, both best-effort
// defense-in-depth (NOT a guarantee):
//   1. exclude obvious secret-bearing files entirely (gather refuses them);
//   2. redact secret-shaped substrings from whatever text is still sent.

// Files we never send, even if a caller points --files / --logs at them.
// Patterns without a slash match the basename; patterns with a slash (incl.
// `**`) match the full forward-slashed relative path.
export const DEFAULT_EXCLUDE_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'auth.json',
  '*credentials*',
  '*secrets*',
];

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; // ** — cross directory separators
        i++;
        if (glob[i + 1] === '/') i++; // let **/ match zero leading dirs
      } else {
        re += '[^/]*'; // * — within a single path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export function isExcluded(filePath, extraGlobs = []) {
  const norm = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = norm.split('/');
  for (const raw of [...DEFAULT_EXCLUDE_GLOBS, ...extraGlobs]) {
    const p = String(raw).replace(/\\/g, '/');
    const re = globToRegExp(p);
    if (p.includes('/')) {
      // path-shaped pattern → match the whole relative path
      if (re.test(norm)) return true;
    } else if (segments.some((s) => re.test(s))) {
      // name-shaped pattern → match ANY path segment (file OR directory), so a
      // `secrets/` dir is excluded even when its files have innocuous names.
      return true;
    }
  }
  return false;
}

// Secret-shaped substrings → [REDACTED]. Ordered most-specific first.
// Long-blob thresholds are deliberately high (hex >= 64; base64 >= 40 with a
// pure-lowercase-hex skip) so 40-char git SHAs and ordinary identifiers in a
// diff survive — over-redaction would gut the brief.
const RULES = [
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    to: '[REDACTED PRIVATE KEY]',
  },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/g, to: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[REDACTED]' },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}/g, to: 'Bearer [REDACTED]' },
  {
    // key/value secrets: keep the field name, redact the value.
    re: /\b(api[_-]?key|apikey|access[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\b(\s*[:=]\s*)(['"]?)([^\s'"]{6,})\3/gi,
    to: (_m, name, sep, q) => `${name}${sep}${q}[REDACTED]${q}`,
  },
  { re: /\b[A-Fa-f0-9]{64,}\b/g, to: '[REDACTED]' },
  {
    // Standalone long base64-ish blobs (encoded tokens/keys). Boundaries exclude
    // adjacent base64 chars so we match a whole token, not a slice. Two skips
    // keep ordinary content intact: a pure lowercase-hex run is a git SHA / hex
    // id (64+ hex is already covered above), and a run with NO digit and NO
    // base64 special char is a plain word/identifier — real base64 secrets carry
    // digits or +/=.
    re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g,
    to: (m) => {
      if (/^[a-f0-9]+$/.test(m)) return m; // git SHA / lowercase-hex identifier
      if (!/[0-9]/.test(m) && !/[+/=]/.test(m)) return m; // word-like, not a token
      return '[REDACTED]';
    },
  },
];

export function redactSecrets(text) {
  let out = String(text ?? '');
  let count = 0;
  for (const { re, to } of RULES) {
    out = out.replace(re, (...args) => {
      count++;
      return typeof to === 'function' ? to(...args) : to;
    });
  }
  return { text: out, count };
}
