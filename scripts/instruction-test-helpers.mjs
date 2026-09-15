import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('..', import.meta.url));
export const readInstruction = (path) => readFileSync(resolve(repository, path), 'utf8').replace(/\r\n/g, '\n');

export function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.replace(/^#{1,6} /, '') === heading);
  assert.notEqual(start, -1, `missing instruction section: ${heading}`);
  const level = lines[start].match(/^#+/)?.[0].length;
  assert.ok(level, `not a heading: ${heading}`);
  const next = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

export function localLinks(text) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]).filter((target) => !/^(?:[a-z]+:|\/\/)/i.test(target));
}

export function anchors(text) {
  const counts = new Map();
  const result = new Set([...text.matchAll(/<a id="([^"]+)"\s*><\/a>/g)].map((match) => match[1]));
  for (const match of text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) || 0;
    result.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return result;
}

export function checkInstructionLink(source, target, read = readInstruction) {
  const [path, fragment] = target.split('#');
  const destination = path ? resolve(repository, dirname(source), path) : resolve(repository, source);
  const text = read(destination);
  if (fragment) assert.ok(anchors(text).has(fragment), `${source}: missing fragment ${target}`);
  return destination;
}

export function assertRoute(text, target) {
  assert.ok(localLinks(text).includes(target), `missing explicit route: ${target}`);
}
