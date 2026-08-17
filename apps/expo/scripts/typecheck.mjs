/**
 * App type-check gate for CI.
 *
 * Runs `tsc --noEmit` but only FAILS on errors in our own code. A couple of
 * third-party packages (react-native-gifted-chat, react-native-country-codes-
 * picker) ship React-19-incompatible `.tsx` source that TypeScript type-checks
 * when imported — those are out of our control, so their `node_modules/...`
 * errors are reported for visibility but don't fail the build.
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('tsc', ['--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: true,
});
const output = `${res.stdout || ''}${res.stderr || ''}`;
const errorLines = output.split('\n').filter((l) => l.includes('error TS'));
const ours = errorLines.filter((l) => !l.startsWith('node_modules/'));
const thirdParty = errorLines.filter((l) => l.startsWith('node_modules/'));

if (thirdParty.length > 0) {
  console.log(`ℹ️  Ignoring ${thirdParty.length} pre-existing type error(s) in third-party node_modules.`);
}

if (ours.length > 0) {
  console.error('\n❌ App type errors:\n');
  console.error(ours.join('\n'));
  console.error(`\n${ours.length} type error(s) in app code.`);
  process.exit(1);
}

console.log('✅ App type-check passed.');
