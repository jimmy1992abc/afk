#!/usr/bin/env node

import { canonicalBytes, checkReviewReceipts, readReceiptJson } from '../lib/gate/review-receipt.mjs';
import { readOption } from '../lib/gate/target.mjs';

const argv = process.argv.slice(2);
let result;
try {
  const option = readOption(argv, '--candidate');
  if (!option.supplied || option.duplicate || !option.value) throw new Error('--candidate requires exactly one file');
  const receiptPaths = [];
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--candidate') { index++; continue; }
    if (item.startsWith('--candidate=')) continue;
    if (item === '--receipt') {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error('--receipt requires an attempt directory');
      receiptPaths.push(next); continue;
    }
    if (item.startsWith('--receipt=')) {
      const path = item.slice('--receipt='.length);
      if (!path) throw new Error('--receipt requires an attempt directory');
      receiptPaths.push(path); continue;
    }
    throw new Error('unsupported checker option');
  }
  result = checkReviewReceipts({ candidate: readReceiptJson(option.value).value, receiptPaths });
} catch (error) {
  result = { version: 1, consistent: false, reviewsComplete: false, allRequiredApproved: false,
    candidate: null, profileDigest: null, roles: [], issues: [error.message] };
}
process.stdout.write(canonicalBytes(result));
process.exitCode = result.consistent && result.reviewsComplete ? 0 : 1;
