import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

function defaultIdentity(stat) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint') return null;
  if (stat.dev <= 0n || stat.ino <= 0n) return null;
  return `${stat.dev}:${stat.ino}`;
}

export function readConfinedUtf8File(requested, options = {}) {
  const {
    root,
    base = root,
    approve = () => ({ ok: true }),
    beforeOpen = () => {},
    readImpl = (fd) => readFileSync(fd, 'utf8'),
    identityOf = defaultIdentity,
    lstatImpl = (path) => lstatSync(path, { bigint: true }),
    realpathImpl = realpathSync,
    openImpl = openSync,
    fstatImpl = (fd) => fstatSync(fd, { bigint: true }),
    closeImpl = closeSync,
  } = options;

  if (!root) return { ok: false, code: 'root_unresolved' };
  let canonicalRoot;
  try {
    canonicalRoot = realpathImpl(resolve(root));
  } catch {
    return { ok: false, code: 'root_unresolved' };
  }

  const lexicalPath = resolve(base || root, requested);
  const lexicalInside = inside(resolve(root), lexicalPath);
  let inspected;
  try {
    inspected = lstatImpl(lexicalPath);
  } catch (error) {
    return {
      ok: false,
      code: ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'missing_file' : 'unresolvable_file',
    };
  }
  if (inspected.isSymbolicLink()) return { ok: false, code: 'symlink' };
  if (!inspected.isFile()) return { ok: false, code: 'non_regular' };

  let canonicalPath;
  try {
    canonicalPath = realpathImpl(lexicalPath);
  } catch {
    return { ok: false, code: 'unresolvable_file' };
  }
  if (!inside(canonicalRoot, canonicalPath)) {
    return { ok: false, code: lexicalInside ? 'ancestor_symlink_escape' : 'outside_path' };
  }

  const relativePath = relative(canonicalRoot, canonicalPath);
  const inspectedIdentity = identityOf(inspected);
  if (!inspectedIdentity) return { ok: false, code: 'identity_unavailable' };
  beforeOpen({ absolutePath: canonicalPath, relativePath, stat: inspected });

  let fd;
  try {
    fd = openImpl(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    const changed = ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error?.code);
    return { ok: false, code: changed ? 'changed_during_read' : 'unreadable_file' };
  }

  let result;
  try {
    const opened = fstatImpl(fd);
    if (!opened.isFile()) result = { ok: false, code: 'non_regular' };
    else {
      const openedIdentity = identityOf(opened);
      if (!openedIdentity) result = { ok: false, code: 'identity_unavailable' };
      else if (openedIdentity !== inspectedIdentity) result = { ok: false, code: 'changed_during_read' };
      else {
        const approval = approve({ absolutePath: canonicalPath, relativePath, stat: opened });
        if (!approval?.ok) {
          result = { ok: false, code: approval?.code || 'rejected', relativePath };
        } else {
          result = { ok: true, content: readImpl(fd), relativePath, stat: opened };
        }
      }
    }
  } catch {
    result = { ok: false, code: 'unreadable_file' };
  } finally {
    try {
      closeImpl(fd);
    } catch {
      if (result?.ok) result = { ok: false, code: 'unreadable_file' };
    }
  }
  return result;
}
