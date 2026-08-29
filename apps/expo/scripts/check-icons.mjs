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
 * Three things are checked:
 *   1. No owned icon name is requested from the Ionicons shim.
 *   2. Nothing imports or renders the raw assets except their owner component.
 *   3. Every icon NAME used anywhere actually resolves in src/lib/icons.tsx.
 *
 * Check 3 exists because the shim falls back to a neutral `Circle` for an unknown
 * name. That fallback is the right runtime behaviour — a typo must never crash a
 * screen — but it is SILENT, so an unmapped name renders as a meaningless circle
 * and reads as a deliberate design choice. Eight of them had accumulated,
 * including `crop-outline`, which is the "Adjust photo" button on three separate
 * screens: story create, contest photo setup and profile edit all showed a bare
 * circle where a crop icon belonged.
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

// --- check 3: every icon name resolves ------------------------------------
//
// The name -> component maps live in the shim as object literals, so they are
// read out of its source rather than imported: importing it would pull in
// `lucide-react-native` and React Native itself into a plain Node script.

/** Quoted keys of one `const <name>: Record<string, LucideIcon> = { … }` block. */
function shimMapKeys(source, varName) {
    const start = source.indexOf(`const ${varName}: Record<string, LucideIcon> = {`);
    if (start === -1) return null;
    let depth = 0;
    let i = source.indexOf('{', start);
    const from = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return new Set([...source.slice(from, i + 1).matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]));
}

const shimSource = readFileSync(join(ROOT, SHIM), 'utf8');
const NAME_MAPS = {
    Ionicons: shimMapKeys(shimSource, 'ionicons'),
    MaterialCommunityIcons: shimMapKeys(shimSource, 'mci'),
    FontAwesome5: shimMapKeys(shimSource, 'fa5'),
    Feather: shimMapKeys(shimSource, 'feather'),
};

for (const [set, keys] of Object.entries(NAME_MAPS)) {
    if (!keys) {
        console.error(`❌ Could not parse the ${set} map out of ${SHIM}. Did its shape change?`);
        process.exit(1);
    }
}

const SETS = Object.keys(NAME_MAPS).join('|');

/** `name="play"` or `name={"play"}` — a single literal. */
const USAGE_LITERAL = new RegExp(`<(${SETS})\\b[^>]*?\\bname=\\{?["']([^"']+)["']`, 'gs');

/**
 * `name={cond ? 'pause-circle' : 'play-circle'}` — EVERY literal in the expression.
 *
 * This was the blind spot: `USAGE_LITERAL` needs a quote immediately after
 * `name=`, so a ternary matched nothing at all and neither branch was checked. A
 * conditional icon is the most likely place to find an unmapped name — play/pause
 * and mute/unmute pairs are exactly how toggles are written — and `pause-circle`
 * reached the story music picker that way, rendering as a blank circle.
 *
 * `[^}]*` stops at the first closing brace, so a name built from a template or a
 * nested expression is skipped rather than guessed at. Missing one is acceptable;
 * inventing a violation is not.
 */
const USAGE_EXPR = new RegExp(`<(${SETS})\\b[^>]*?\\bname=\\{([^}]*)\\}`, 'gs');
const QUOTED = /['"]([^'"]+)['"]/g;

/** Same (file, line, name) reported by both patterns is one problem, not two. */
const seen = new Set();
function checkName(rel, code, index, set, name) {
    if (NAME_MAPS[set].has(name)) return;
    const line = code.slice(0, index).split('\n').length;
    const key = `${rel}:${line}:${set}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
        rel,
        line,
        found: `<${set} name="${name}">`,
        fix: `"${name}" is not in the ${set} map, so it renders as a blank circle. Add it to ${SHIM}.`,
    });
}

for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === SHIM) continue;
    const code = stripComments(readFileSync(file, 'utf8'));

    for (const match of code.matchAll(USAGE_LITERAL)) {
        checkName(rel, code, match.index, match[1], match[2]);
    }
    for (const match of code.matchAll(USAGE_EXPR)) {
        const [, set, expr] = match;
        for (const lit of expr.matchAll(QUOTED)) {
            checkName(rel, code, match.index, set, lit[1]);
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
