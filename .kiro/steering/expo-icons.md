---
inclusion: fileMatch
fileMatchPattern: 'apps/expo/**'
---

# Expo app — shared icons

Two icon families are owned by one component each. Do not use the Ionicons shim
for them, and do not import their raw assets.

| Family | Owner | Assets |
|---|---|---|
| Arrows / chevrons | `src/components/ui/ArrowIcon.tsx` | `left_arrow.svg`, `arrow_right.svg` |
| Close / dismiss | `src/components/ui/CloseIcon.tsx` | `close.svg`, `close_circle_outline.svg` |

## Use

| Need | Use |
|---|---|
| Back button in a screen header | `<BackButton />` |
| Row disclosure indicator (`>`) | `<ArrowIcon direction="right" />` |
| "Proceed" arrow in a CTA (`→`) | `<ArrowIcon variant="arrow" />` |
| Calendar / carousel stepper | `<ArrowIcon direction="left" \| "right" />` |
| Dismiss a screen, sheet or banner | `<CloseIcon />` |
| Clear a field, remove a chip | `<CloseIcon variant="circle" />` |

```tsx
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
```

## Do not

```tsx
<Ionicons name="chevron-back" />      // ❌ blocked by npm run check:icons
<Ionicons name="arrow-forward" />     // ❌
<Ionicons name="close-circle" />      // ❌
import { Left_Arrow } from '@/assets/svgs';  // ❌ ArrowIcon owns the assets
```

## Close is not back

A close (`X`) button dismisses the thing in front of you; a back chevron
navigates to the previous screen. The story viewers and `wallet/store` use `X`
because they are overlays, and swapping in a chevron would misrepresent what the
control does. Keep the two distinct.

`CloseIcon` is deliberately icon-only, with no pressable wrapper: close controls
sit in wildly different layouts (a story overlay, an inline text field, a banner
row), each with its own hit area and handler. Only the glyph is shared. The
wrapper must carry `accessibilityRole="button"` and an `accessibilityLabel`.

## The two variants are not interchangeable

- `variant="chevron"` → `assets/svgs/left_arrow.svg`, a bare `<`. Navigation and
  disclosure: "go back", "this row opens".
- `variant="arrow"` → `assets/svgs/arrow_right.svg`, a `→` with a shaft. Reads as
  "proceed", which is why it belongs in call-to-action buttons.

Each asset covers both directions by being mirrored on the X axis, so there is no
second file to drift out of sync.

## Gotchas

- Both assets stroke with `currentColor`. Theme them with `color`; `fill` does
  nothing. `left_arrow.svg` used to hardcode `stroke="#2F2F31"`, which silently
  ignored the `color` 14 screens were passing and rendered a near-invisible grey
  on the dark theme.
- `size` is the bounding box and, because both assets preserve their aspect
  ratio, also the rendered glyph height. The chevron's viewBox is 10x16 so it is
  ~0.63x as wide as it is tall; the arrow's is square.
- Arrows are decorative and hidden from screen readers. The label or the
  pressable around them must carry the meaning — `BackButton` already does.

## Enforcement

`npm run check:icons` (`apps/expo/scripts/check-icons.mjs`) fails the build on
either violation and runs in the `expo` CI job. Close/dismiss (`X`) buttons are
not arrows and are out of scope.
