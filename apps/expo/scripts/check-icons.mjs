/**
 * Shared-icon consistency gate for CI.
 *
 * Two icon families are owned by a single component each, and every call site
 * must go through it:
 *
 *   arrows / chevrons  ->  src/components/ui/ArrowIcon.tsx
 *                          (left_arrow.svg, arrow_right.svg)
 *   close / dismiss    ->  src/components/ui/CloseIcon.tsx
 *                          (close.svg, close_circle_outline.svg)
 *
 * Both families had drifted badly before this. Back arrows came from four
 * sources — `chevron-back`/`arrow-back` via the Ionicons shim, `Left_Arrow`
 * imported straight from assets, and `@expo/vector-icons` in ChatHeader — and
 * the 16 close buttons mixed `close` and `close-circle` at seven sizes. Both are
 * easy to reintroduce by copy-pasting an existing screen.
 *
 * Two things are checked:
 *   1. No owned icon name is requested from the Ionicons shim.
 *   2. Nothing imports or renders the raw assets except their owner component.
 *
 * CI cannot run `expo lint` as a gate because the project carries pre-existing
 * lint errors, so this runs as its own step. Same idea as scripts/typecheck.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['app', 'components', 'src'];
const EXTENSIONS = /\.tsx?$/;

const ARROW_OWNER = 'src/components/ui/ArrowIcon.tsx';
const CLOSE_OWNER = 'src/components/ui/CloseIcon.tsx';
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
        // `name="close"`, `name="close-circle"`, `name="close-circle-outline"`
        pattern: /name=(?:["']|\{")close(?:-circle)?(?:-outline)?(?:["']|"\})/g,
        skip: (rel) => rel === SHIM,
        fix: 'Use <CloseIcon variant="plain"|"circle" /> instead of an Ionicons close glyph.',
    },
    {
        // Raw assets must only be touched by the component that owns them.
        pattern: /\b(?:Left_Arrow|Arrow_Right)\b/g,
        skip: (rel) => rel === ARROW_OWNER,
        fix: `Import ArrowIcon instead; ${ARROW_OWNER} owns the raw arrow assets.`,
    },
    {
        pattern: /\b(?:Close_X|Close_Circle_Outline)\b/g,
        skip: (rel) => rel === CLOSE_OWNER,
        fix: `Import CloseIcon instead; ${CLOSE_OWNER} owns the raw close assets.`,
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
    console.error(`\n❌ ${violations.length} shared-icon violation(s):\n`);
    for (const v of violations) {
        console.error(`  ${v.rel}:${v.line}  ${v.found}`);
        console.error(`     → ${v.fix}\n`);
    }
    process.exit(1);
}

console.log(
    `✅ Shared icons consistent — ${files.length} files scanned; arrows route through ArrowIcon, close glyphs through CloseIcon.`,
);
