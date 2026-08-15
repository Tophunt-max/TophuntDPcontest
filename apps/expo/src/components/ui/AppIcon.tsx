// AppIcon — the app's single, cross-platform icon primitive (same approach as
// the Voxcall app). Renders real vector icons that display identically on
// Android, iOS and web, backed by @expo/vector-icons
// (MaterialCommunityIcons / Feather / FontAwesome5) — open-source, license-free.
//
// The icon fonts are preloaded in app/_layout.tsx so glyphs render on web too.
//
// Usage:
//   <AppIcon name="gift" size={20} color="#A00EE7" />
//
// Add a new icon by mapping a semantic name to a glyph in ICON_MAP below.

import React from "react";
import type { StyleProp, TextStyle } from "react-native";
import { MaterialCommunityIcons, Feather, FontAwesome5 } from "@expo/vector-icons";

export type AppIconName =
  | "gift" | "celebrate" | "star" | "star-outline" | "sparkles"
  | "timer" | "hourglass" | "alarm" | "calendar"
  | "lock" | "crown" | "coin" | "money" | "diamond"
  | "fire" | "zap" | "rocket" | "target" | "trophy"
  | "medal" | "medal-gold" | "medal-silver" | "medal-bronze"
  | "mic" | "video" | "video-off" | "tv" | "mute" | "phone"
  | "dice" | "spin" | "refresh" | "blocked" | "sprout"
  | "close" | "check" | "warning" | "info" | "camera"
  | "link" | "share" | "users" | "bell" | "shield" | "wrench"
  | "heart-broken" | "wave" | "thanks"
  | "sad" | "search" | "heart" | "heart-outline" | "clock" | "chat"
  | "ticket" | "edit" | "wand" | "device" | "bank" | "money-send"
  | "traffic" | "male" | "female" | "card" | "settings";

type Family = "mci" | "fe" | "fa5";

// [family, glyph] — glyph names verified against the installed glyph maps.
const ICON_MAP: Record<AppIconName, [Family, string]> = {
  gift:          ["mci", "gift-outline"],
  celebrate:     ["mci", "party-popper"],
  star:          ["mci", "star"],
  "star-outline":["mci", "star-outline"],
  sparkles:      ["mci", "star-four-points"],
  timer:         ["mci", "timer-outline"],
  hourglass:     ["mci", "timer-sand"],
  alarm:         ["mci", "alarm"],
  calendar:      ["mci", "calendar-month"],
  lock:          ["mci", "lock"],
  crown:         ["mci", "crown"],
  coin:          ["fa5", "coins"],
  money:         ["mci", "cash-multiple"],
  diamond:       ["mci", "diamond-stone"],
  fire:          ["mci", "fire"],
  zap:           ["mci", "lightning-bolt"],
  rocket:        ["mci", "rocket-launch"],
  target:        ["mci", "target"],
  trophy:        ["mci", "trophy"],
  medal:         ["mci", "medal"],
  "medal-gold":  ["mci", "medal"],
  "medal-silver":["mci", "medal"],
  "medal-bronze":["mci", "medal"],
  mic:           ["mci", "microphone"],
  video:         ["mci", "video"],
  "video-off":   ["mci", "video-off"],
  tv:            ["mci", "television"],
  mute:          ["mci", "volume-off"],
  phone:         ["mci", "phone"],
  dice:          ["mci", "dice-multiple"],
  spin:          ["mci", "ferris-wheel"],
  refresh:       ["mci", "refresh"],
  blocked:       ["mci", "cancel"],
  sprout:        ["mci", "sprout"],
  close:         ["fe", "x"],
  check:         ["mci", "check"],
  warning:       ["fe", "alert-triangle"],
  info:          ["fe", "info"],
  camera:        ["fe", "camera"],
  link:          ["fe", "link"],
  share:         ["fe", "share-2"],
  users:         ["fe", "users"],
  bell:          ["fe", "bell"],
  shield:        ["mci", "shield-check"],
  wrench:        ["mci", "wrench"],
  "heart-broken":["mci", "heart-broken"],
  wave:          ["mci", "hand-wave"],
  thanks:        ["mci", "hand-heart"],
  sad:           ["mci", "emoticon-sad-outline"],
  search:        ["fe", "search"],
  heart:         ["mci", "heart"],
  "heart-outline":["mci", "heart-outline"],
  clock:         ["mci", "clock-outline"],
  chat:          ["fe", "message-circle"],
  ticket:        ["mci", "ticket-outline"],
  edit:          ["fe", "edit-2"],
  wand:          ["mci", "auto-fix"],
  device:        ["mci", "cellphone"],
  bank:          ["mci", "bank"],
  "money-send":  ["mci", "bank-transfer"],
  traffic:       ["mci", "traffic-light"],
  male:          ["mci", "human-male"],
  female:        ["mci", "human-female"],
  card:          ["fe", "credit-card"],
  settings:      ["fe", "settings"],
};

export interface AppIconProps {
  name: AppIconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}

export function AppIcon({ name, size = 20, color = "#111329", style }: AppIconProps) {
  const [family, glyph] = ICON_MAP[name] ?? ICON_MAP.star;
  if (family === "fe") return <Feather name={glyph as any} size={size} color={color} style={style} />;
  if (family === "fa5") return <FontAwesome5 name={glyph as any} size={size} color={color} style={style} />;
  return <MaterialCommunityIcons name={glyph as any} size={size} color={color} style={style} />;
}

export default AppIcon;
