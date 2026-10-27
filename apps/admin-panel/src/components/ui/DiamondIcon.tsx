/**
 * Diamond: the play-only balance (users.locked_coins). Pays contest entry fees,
 * comes from coin packages and free rewards, never withdrawn. DP coin
 * (dpcoin − locked_coins) is the withdrawable prize balance.
 *
 * Same drawing as the app's src/components/ui/DiamondIcon.tsx and
 * public/diamond.svg. Takes the lucide icon props it is used with (size,
 * className), so it can stand in for a lucide icon, e.g. on a StatCard.
 */
const OUTLINE = "M6 3 H18 L22 9 L12 21 L2 9 Z";
const FACETS: [string, string, number][] = [
  ["M6 3 L12 3 L9 9 Z", "#FFFFFF", 0.55],
  ["M12 3 L18 3 L15 9 Z", "#FFFFFF", 0.35],
  ["M2 9 L6 3 L9 9 Z", "#FFFFFF", 0.25],
  ["M12 3 L15 9 L9 9 Z", "#FFFFFF", 0.15],
  ["M18 3 L22 9 L15 9 Z", "#000000", 0.12],
  ["M2 9 L9 9 L12 21 Z", "#FFFFFF", 0.2],
  ["M15 9 L22 9 L12 21 Z", "#000000", 0.22],
];

export const DIAMOND_COLOR = "#22D3EE";

export function DiamondIcon({ size = 16, color, className }: { size?: number; color?: string; className?: string }) {
  // Without an explicit colour it follows `currentColor`, like a lucide icon.
  const fill = color ?? (className ? "currentColor" : DIAMOND_COLOR);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} role="img" aria-label="Diamond">
      <path d={OUTLINE} fill={fill} />
      {FACETS.map(([d, f, o]) => (
        <path key={d} d={d} fill={f} fillOpacity={o} />
      ))}
      <path d={OUTLINE} fill="none" stroke={fill} strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
}

export default DiamondIcon;
