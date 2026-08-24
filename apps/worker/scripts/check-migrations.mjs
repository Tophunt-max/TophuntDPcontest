#!/usr/bin/env node
/**
 * Migration safety gate.
 *
 * Migrations here are applied automatically at runtime (src/db/autoMigrate.ts)
 * and recorded in `d1_migrations` by filename. Two consequences follow, and CI
 * should enforce both:
 *
 *  1. AN APPLIED MIGRATION IS IMMUTABLE. Editing a file that production has
 *     already run does nothing to production — its row is already recorded — so
 *     the change silently exists only on fresh databases. That divergence is
 *     invisible until something breaks weeks later.
 *
 *  2. NUMBERING MUST BE UNIQUE AND ORDERED. Two files sharing a prefix (from a
 *     merge of two branches that both added `0031_`) apply in an arbitrary order.
 *
 * Run with a base ref to enable the immutability check:
 *   node scripts/check-migrations.mjs --base origin/main
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');
const REPO_RELATIVE = 'apps/worker/migrations';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : process.env.MIGRATION_BASE_REF || '';

const errors = [];
const warnings = [];

// ---------------------------------------------------------------------------
// 1. Filenames: unique, ordered, non-empty
// ---------------------------------------------------------------------------
const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) errors.push('No .sql migrations found.');

const seenPrefix = new Map();
for (const file of files) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
  if (!match) {
    errors.push(
      `${file}: name must be NNNN_snake_case.sql (four digits, then lowercase words).`,
    );
    continue;
  }
  const prefix = match[1];
  if (seenPrefix.has(prefix)) {
    errors.push(
      `Duplicate migration number ${prefix}: "${seenPrefix.get(prefix)}" and "${file}". ` +
        'Two migrations with the same number apply in an arbitrary order — renumber the newer one.',
    );
  } else {
    seenPrefix.set(prefix, file);
  }

  const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
  if (!body) errors.push(`${file}: file is empty.`);

  // The runtime splitter strips `--` comments and splits on `;`, which breaks on
  // a trigger body or a semicolon inside a string literal. Catch it here rather
  // than as a half-applied migration in production.
  if (/CREATE\s+TRIGGER/i.test(body)) {
    errors.push(
      `${file}: CREATE TRIGGER is not supported. The runtime migration splitter ` +
        'splits on ";", which cuts a trigger body in half (see src/db/autoMigrate.ts).',
    );
  }
  // A `;` INSIDE a string literal is the other case the naive splitter mangles.
  // Detected by quote parity on each line: an odd number of single quotes before
  // the semicolon means we are inside a literal at that point.
  body.split('\n').forEach((line, index) => {
    const code = line.split('--')[0];
    for (let i = 0; i < code.length; i++) {
      if (code[i] !== ';') continue;
      const quotesBefore = (code.slice(0, i).match(/'/g) || []).length;
      if (quotesBefore % 2 === 1) {
        errors.push(
          `${file}:${index + 1}: a ";" appears inside a string literal. The runtime ` +
            'migration splitter splits on ";" regardless of quoting, so this statement ' +
            'would be cut in half (see src/db/autoMigrate.ts).',
        );
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Immutability of already-committed migrations
// ---------------------------------------------------------------------------
if (baseRef) {
  let changed = [];
  try {
    // Run from the repository root: git pathspecs are resolved relative to the
    // CURRENT directory, so passing a repo-relative path while cwd is
    // apps/worker silently matches nothing — and a check that silently matches
    // nothing always passes, which is the worst possible failure mode for a gate.
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    // Compare the base ref against the WORKING TREE, not against HEAD. In CI the
    // tree is clean so the two are equivalent, but locally this also catches an
    // uncommitted edit to an applied migration — which is exactly when a
    // developer still has the chance to undo it.
    const out = execFileSync(
      'git',
      ['diff', '--name-status', baseRef, '--', REPO_RELATIVE],
      { encoding: 'utf8', cwd: repoRoot },
    );
    changed = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        return { status, file: rest[rest.length - 1] };
      });
  } catch (e) {
    warnings.push(
      `Could not diff against ${baseRef} (${e.message.split('\n')[0]}). ` +
        'Skipping the immutability check.',
    );
  }

  for (const { status, file } of changed) {
    // A = added (fine), M = modified, D = deleted, R = renamed.
    if (status.startsWith('A')) continue;
    const name = path.basename(file);
    errors.push(
      `${name} was ${status.startsWith('D') ? 'deleted' : status.startsWith('R') ? 'renamed' : 'modified'}. ` +
        'Migrations already merged to main have been applied in production and are ' +
        'immutable — the edit would only ever affect fresh databases. Add a NEW migration instead.',
    );
  }
}

// ---------------------------------------------------------------------------
for (const warning of warnings) console.warn(`⚠️  ${warning}`);

if (errors.length > 0) {
  console.error('\n❌ Migration check failed:\n');
  for (const error of errors) console.error(`  • ${error}`);
  console.error('');
  process.exit(1);
}

console.log(
  `✅ Migrations OK — ${files.length} file(s), numbering unique and ordered` +
    (baseRef ? `, none modified since ${baseRef}.` : '.'),
);
