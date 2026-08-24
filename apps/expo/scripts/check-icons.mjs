/**
 * Directional-arrow consistency gate for CI.
 *
 * Every arrow and chevron in the app renders one of two SVGs from
 * `assets/svgs/` (`left_arrow.svg`, `arrow_right.svg`) through
 * `src/components/ui/ArrowIcon.tsx`. Before that was true the app had four
 * different back arrows — `chevron-back` and `arrow-back` from the Ionicons
 * shim, `Left_Arrow` imported straight from assets, and `@expo/vector-icons` in
 * ChatHeader — which is easy to reintroduce by copy-pasting an existing screen.
 *
 * Two things are checked:
 *   1. No directional icon name is requested from the Ionicons shim.
 *   2. Nothing imports or renders the raw arrow assets except ArrowIcon.
 *
 * CI cannot run `expo lint` as a gate because the project carries pre-existing
 * lint errors, so this runs as its own step. Same idea as scripts/typecheck.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['app', 'components', 'src'];
const EXTENSIONS = /\.tsx?$/;

/** ArrowIcon is the intended owner of the raw assets. */
const ASSET_OWNER = 'src/components/ui/ArrowIcon.tsx';
/** The shim maps these names; it is a library, not a call site. */
const SHIM = 'src/lib/icons.tsx';

const RULES = [
    {
        // `name="chevron-back"`, `name='arrow-forward'`, `name={"caret-back"}`
        pattern: /name=(?:["']|\{")(?:chevron|arrow|caret)-(?:back|forward|left|right)(?:["']|"\})/g,
        skip: (rel) => rel === SHIM,
        fix: 'Use <BackButton /> for back navigation, or <ArrowIcon variant="chevron"|"arrow" direction="left"|"right" />.',
    },
    {
        // Importing or rendering the raw assets instead of going through ArrowIcon.
        pattern: /\b(?:Left_Arrow|Arrow_Right)\b/g,
        skip: () => false,
        fix: `Import ArrowIcon instead; ${ASSET_OWNER} owns the raw arrow assets.`,
    },
];

/**
 * Blanks out comments while preserving every byte offset, so a rule can never
 * fire on prose (this file's own header would otherwise trip rule 2) and
 * reported line numbers still match the real file.
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (EXTENSIONS.test(entry)) out.push(full);
    }
    return out;
}

const files = SCAN_DIRS.flatMap((dir) => {
    try {
        return walk(join(ROOT, dir));
    } catch {
        return []; // directory is optional
    }
});

const violations = [];

for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === ASSET_OWNER) continue;

    const code = stripComments(readFileSync(file, 'utf8'));

    for (const rule of RULES) {
        if (rule.skip(rel)) continue;
        for (const match of code.matchAll(rule.pattern)) {
            violations.push({
                rel,
                line: code.slice(0, match.index).split('\n').length,
                found: match[0],
                fix: rule.fix,
            });
        }
    }
}

if (violations.length > 0) {
    console.error(`\n❌ ${violations.length} directional-arrow violation(s):\n`);
    for (const v of violations) {
        console.error(`  ${v.rel}:${v.line}  ${v.found}`);
        console.error(`     → ${v.fix}\n`);
    }
    process.exit(1);
}

console.log(`✅ Arrow icons consistent — ${files.length} files scanned, all arrows route through ArrowIcon.`);
