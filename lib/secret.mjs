// One shared policy keeps relay and review payloads from drifting apart.

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
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isExcluded(filePath, extraGlobs = []) {
  const norm = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = norm.split('/');
  for (const raw of [...DEFAULT_EXCLUDE_GLOBS, ...extraGlobs]) {
    const pattern = String(raw).replace(/\\/g, '/');
    const re = globToRegExp(pattern);
    if (pattern.includes('/')) {
      if (re.test(norm)) return true;
    } else if (segments.some((segment) => re.test(segment))) {
      return true;
    }
  }
  return false;
}

const RULES = [
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    to: '[REDACTED PRIVATE KEY]',
  },
  // Position, not alphabet: a credential in a URL's userinfo is a credential
  // whatever it looks like, and the shape rules below reach it only when it
  // carries a prefix or clears their length floor. Runs before them so no shape
  // rule can half-redact a userinfo it only partly matches. The single-component
  // form keeps a floor because a bare `git@` in an ssh URL is a user name, and
  // redacting it would cost the reader which remote the line names.
  {
    // Userinfo runs to the LAST `@` before the host, and both `:` and `@` are
    // legal inside a password. Stopping at the first of either leaves the
    // credential in the payload, or rewrites the line so it reads as redacted
    // while the tail of the credential survives.
    re: /\b([a-z][a-z0-9+.\-]*:\/\/)([^/?#\s]+)@/gi,
    to: (match, scheme, userinfo) => {
      const colon = userinfo.indexOf(':');
      if (colon !== -1) return `${scheme}${userinfo.slice(0, colon)}:[REDACTED]@`;
      return userinfo.length >= 8 ? `${scheme}[REDACTED]@` : match;
    },
  },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/g, to: '[REDACTED]' },
  { re: /\btp-[A-Za-z0-9_\-]{20,}\b/g, to: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[REDACTED]' },
  // Provider prefix tokens. A lookbehind, not \b: `_ghp_…` must still match.
  // Length floors keep prose like `xoxb-compatible` out; real tokens always
  // exceed them.
  {
    re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{20,})/g,
    to: '[REDACTED]',
  },
  // JWT/JWE: two mandatory base64url segments, then one or more trailing
  // segments (empty allowed — `alg:none` ends in a dot; JWE carries five
  // segments and a non-repeating tail would leak its ciphertext). Sits before
  // the 64-hex rule so a hex signature cannot be pre-mangled into two
  // half-redactions.
  // `={0,2}` per segment: RFC 7519 mandates paddingless base64url, but padded
  // encoders exist in the wild and a padded token would otherwise pass whole.
  { re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}(?:\.[A-Za-z0-9_-]*={0,2})+/g, to: '[REDACTED]' },
  // The `token` branch is digit-gated: without it, ordinary prose ("token
  // authentication") would be redacted; digitless tokens after the label are
  // still caught by the prefix rule above.
  {
    re: /\b(?:([Bb]earer)\s+[A-Za-z0-9._\-]{12,}|([Tt]oken)\s+(?=[A-Za-z0-9._\-]*[0-9])[A-Za-z0-9._\-]{12,})/g,
    to: (_match, bearer, token) => `${bearer || token} [REDACTED]`,
  },
  {
    re: /\b(api[_-]?key|apikey|access[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\b(\s*[:=]\s*)(['"]?)([^\s'"]{6,})\3/gi,
    to: (_match, name, separator, quote) => `${name}${separator}${quote}[REDACTED]${quote}`,
  },
  { re: /\b[A-Fa-f0-9]{64,}\b/g, to: '[REDACTED]' },
  {
    re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g,
    to: (match) => {
      if (/^[a-f0-9]+$/.test(match)) return match;
      if (!/[0-9]/.test(match) && !/[+/=]/.test(match)) return match;
      return '[REDACTED]';
    },
  },
];

export function redactSecrets(text) {
  let out = String(text ?? '');
  let count = 0;
  for (const { re, to } of RULES) {
    out = out.replace(re, (...args) => {
      const replacement = typeof to === 'function' ? to(...args) : to;
      // Several rules match a candidate and then return it unchanged. Counting
      // those reports a redaction that did not happen, and the count is what a
      // reader is shown in place of the payload.
      if (replacement !== args[0]) count++;
      return replacement;
    });
  }
  return { text: out, count };
}

export function redactCredential(text, credential) {
  const value = String(credential ?? '');
  let source = String(text ?? '');
  let exactCount = 0;
  if (value) {
    exactCount = source.split(value).length - 1;
    if (exactCount) source = source.split(value).join('[REDACTED]');
  }
  const redacted = redactSecrets(source);
  return {
    text: redacted.text,
    count: exactCount + redacted.count,
    exactCount,
    secretCount: redacted.count,
  };
}

export function filterGrepByExcludes(output, excludeGlobs = []) {
  const kept = [];
  const dropped = new Set();
  for (const line of String(output).split('\n')) {
    const match = line.match(/^([^:]+):\d+:/);
    if (match && isExcluded(match[1], excludeGlobs)) {
      dropped.add(match[1]);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), dropped: [...dropped] };
}
