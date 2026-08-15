/**
 * Cross-platform icon system (web + Android + iOS).
 *
 * WHY: @expo/vector-icons renders glyphs from icon FONTS. On the web export the
 * font @font-face frequently fails to load, so icons showed as blank boxes.
 * This module is a DROP-IN replacement that keeps the exact same API
 * (`<Ionicons name="search" size={20} color="#fff" />`) but renders
 * `lucide-react-native` SVG icons underneath — SVG renders identically on every
 * platform with no font loading, so icons always show.
 *
 * To migrate a file, only the import path changes:
 *   - import { Ionicons } from '@/src/lib/icons'
 *   + import { Ionicons } from '@/src/lib/icons'
 *
 * If a name isn't mapped yet, a neutral fallback icon renders (never a crash).
 * Add missing names to the maps below.
 */
import React from 'react';
import type { StyleProp, ViewStyle, TextStyle } from 'react-native';
import * as L from 'lucide-react-native';

export interface IconProps {
  name?: string;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
  [key: string]: any;
}

type LucideIcon = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number; style?: any }>;

const Fallback: LucideIcon = (L as any).Circle;

// Resolve a lucide component by PascalCase name, falling back safely.
const ic = (n: keyof typeof L): LucideIcon => ((L as any)[n] as LucideIcon) || Fallback;

// --- Ionicons name -> lucide ------------------------------------------------
const ionicons: Record<string, LucideIcon> = {
  'add': ic('Plus'), 'add-outline': ic('Plus'), 'add-circle': ic('PlusCircle'), 'add-circle-outline': ic('PlusCircle'),
  'apps': ic('LayoutGrid'), 'grid': ic('LayoutGrid'), 'list': ic('List'), 'menu': ic('Menu'),
  'arrow-back': ic('ArrowLeft'), 'arrow-forward': ic('ArrowRight'), 'arrow-up': ic('ArrowUp'), 'arrow-down': ic('ArrowDown'),
  'chevron-back': ic('ChevronLeft'), 'chevron-forward': ic('ChevronRight'), 'chevron-down': ic('ChevronDown'), 'chevron-up': ic('ChevronUp'),
  'calendar': ic('Calendar'), 'calendar-outline': ic('Calendar'), 'time-outline': ic('Clock'), 'time': ic('Clock'),
  'camera': ic('Camera'), 'camera-outline': ic('Camera'), 'camera-reverse-outline': ic('SwitchCamera'),
  'card-outline': ic('CreditCard'), 'card': ic('CreditCard'), 'cash-outline': ic('Banknote'), 'cash': ic('Banknote'),
  'checkmark': ic('Check'), 'checkmark-done': ic('CheckCheck'), 'checkmark-circle': ic('CheckCircle2'), 'checkmark-circle-outline': ic('CheckCircle2'),
  'close': ic('X'), 'close-circle': ic('XCircle'), 'close-circle-outline': ic('XCircle'),
  'cloud-offline-outline': ic('CloudOff'), 'cloud-upload-outline': ic('UploadCloud'), 'cloud-done-outline': ic('Cloud'),
  'construct-outline': ic('Wrench'), 'copy-outline': ic('Copy'), 'copy': ic('Copy'),
  'document-text-outline': ic('FileText'), 'document-outline': ic('File'), 'download-outline': ic('Download'), 'download': ic('Download'),
  'expand-outline': ic('Expand'), 'eye-outline': ic('Eye'), 'eye': ic('Eye'), 'eye-off-outline': ic('EyeOff'), 'eye-off': ic('EyeOff'),
  'flame': ic('Flame'), 'flame-outline': ic('Flame'), 'flash': ic('Zap'), 'flash-outline': ic('Zap'),
  'game-controller': ic('Gamepad2'), 'game-controller-outline': ic('Gamepad2'),
  'gift': ic('Gift'), 'gift-outline': ic('Gift'), 'globe': ic('Globe'), 'globe-outline': ic('Globe'),
  'heart': ic('Heart'), 'heart-outline': ic('Heart'), 'home': ic('Home'), 'home-outline': ic('Home'),
  'hourglass': ic('Hourglass'), 'hourglass-outline': ic('Hourglass'),
  'image': ic('Image'), 'image-outline': ic('Image'), 'images-outline': ic('Images'), 'images': ic('Images'),
  'lock-closed': ic('Lock'), 'lock-closed-outline': ic('Lock'), 'lock-open-outline': ic('LockOpen'),
  'mail-outline': ic('Mail'), 'mail': ic('Mail'), 'megaphone': ic('Megaphone'), 'megaphone-outline': ic('Megaphone'),
  'mic-sharp': ic('Mic'), 'mic': ic('Mic'), 'mic-outline': ic('Mic'),
  'newspaper-outline': ic('Newspaper'), 'newspaper': ic('Newspaper'),
  'network-off': ic('WifiOff'), 'network-on': ic('Wifi'),
  'notifications': ic('Bell'), 'notifications-outline': ic('Bell'),
  'paper-plane-outline': ic('Send'), 'paper-plane': ic('Send'), 'send': ic('Send'),
  'pencil': ic('Pencil'), 'pencil-outline': ic('Pencil'), 'create-outline': ic('SquarePen'),
  'people': ic('Users'), 'people-outline': ic('Users'), 'person': ic('User'), 'person-outline': ic('User'), 'person-circle-outline': ic('CircleUser'),
  'play': ic('Play'), 'play-circle': ic('PlayCircle'), 'pause': ic('Pause'),
  'podium': ic('Award'), 'podium-outline': ic('Award'),
  'pricetags-outline': ic('Tags'), 'pricetag-outline': ic('Tag'),
  'qr-code-outline': ic('QrCode'), 'qr-code': ic('QrCode'),
  'receipt-outline': ic('Receipt'), 'receipt': ic('Receipt'),
  'refresh': ic('RefreshCw'), 'refresh-outline': ic('RefreshCw'), 'sync-outline': ic('RefreshCw'), 'reload': ic('RotateCw'),
  'rocket-outline': ic('Rocket'), 'rocket': ic('Rocket'),
  'sad-outline': ic('Frown'), 'happy-outline': ic('Smile'),
  'scan-outline': ic('ScanLine'), 'search': ic('Search'), 'search-outline': ic('Search'),
  'share-social': ic('Share2'), 'share-social-outline': ic('Share2'), 'share-outline': ic('Share2'),
  'star': ic('Star'), 'star-outline': ic('Star'),
  'ticket-outline': ic('Ticket'), 'ticket': ic('Ticket'),
  'trash-outline': ic('Trash2'), 'trash': ic('Trash2'),
  'trophy': ic('Trophy'), 'trophy-outline': ic('Trophy'),
  'videocam': ic('Video'), 'videocam-outline': ic('Video'), 'videocam-off': ic('VideoOff'),
  'wallet': ic('Wallet'), 'wallet-outline': ic('Wallet'),
  'settings': ic('Settings'), 'settings-outline': ic('Settings'), 'options': ic('SlidersHorizontal'), 'options-outline': ic('SlidersHorizontal'),
  'filter': ic('Filter'), 'funnel-outline': ic('Filter'),
  'ellipsis-horizontal': ic('MoreHorizontal'), 'ellipsis-vertical': ic('MoreVertical'),
  'log-out-outline': ic('LogOut'), 'log-in-outline': ic('LogIn'),
  'chatbubble-outline': ic('MessageCircle'), 'chatbubble-ellipses-outline': ic('MessageCircle'), 'chatbubbles-outline': ic('MessagesSquare'),
  'bookmark-outline': ic('Bookmark'), 'bookmark': ic('Bookmark'),
  'alert-circle': ic('AlertCircle'), 'alert-circle-outline': ic('AlertCircle'), 'warning': ic('TriangleAlert'), 'warning-outline': ic('TriangleAlert'),
  'information-circle': ic('Info'), 'information-circle-outline': ic('Info'),
  'location-outline': ic('MapPin'), 'location': ic('MapPin'), 'call-outline': ic('Phone'), 'call': ic('Phone'),
  'trending-up': ic('TrendingUp'), 'trending-down': ic('TrendingDown'),
  'shield-checkmark-outline': ic('ShieldCheck'), 'shield-outline': ic('Shield'),
  'moon': ic('Moon'), 'sunny': ic('Sun'), 'color-palette-outline': ic('Palette'),
};

// --- MaterialCommunityIcons name -> lucide ---------------------------------
const mci: Record<string, LucideIcon> = {
  'crown': ic('Crown'), 'crown-outline': ic('Crown'),
  'image-filter-hdr': ic('Image'), 'image-multiple': ic('Images'), 'image-multiple-outline': ic('Images'),
  'movie-open-play': ic('Clapperboard'), 'movie-open-star': ic('Clapperboard'), 'movie-open': ic('Clapperboard'),
  'sword-cross': ic('Swords'), 'sword': ic('Swords'),
  'rocket-launch': ic('Rocket'), 'rocket-launch-outline': ic('Rocket'),
  'gift-outline': ic('Gift'), 'gift': ic('Gift'), 'party-popper': ic('PartyPopper'),
  'star': ic('Star'), 'star-outline': ic('Star'), 'star-four-points': ic('Sparkles'),
  'timer-outline': ic('Timer'), 'timer-sand': ic('Hourglass'), 'alarm': ic('AlarmClock'),
  'calendar-month': ic('Calendar'), 'calendar': ic('Calendar'),
  'lock': ic('Lock'), 'lock-outline': ic('Lock'),
  'coins': ic('Coins'), 'cash-multiple': ic('Banknote'), 'cash': ic('Banknote'), 'currency-inr': ic('IndianRupee'),
  'diamond-stone': ic('Gem'), 'diamond': ic('Gem'),
  'fire': ic('Flame'), 'lightning-bolt': ic('Zap'), 'target': ic('Target'),
  'trophy': ic('Trophy'), 'trophy-outline': ic('Trophy'), 'medal': ic('Medal'), 'medal-outline': ic('Medal'),
  'microphone': ic('Mic'), 'microphone-outline': ic('Mic'),
  'video': ic('Video'), 'video-off': ic('VideoOff'), 'television': ic('Tv'),
  'volume-off': ic('VolumeX'), 'volume-high': ic('Volume2'),
  'phone': ic('Phone'), 'dice-multiple': ic('Dices'), 'ferris-wheel': ic('FerrisWheel'),
  'refresh': ic('RefreshCw'), 'cancel': ic('Ban'), 'sprout': ic('Sprout'), 'check': ic('Check'), 'check-circle': ic('CircleCheck'),
  'shield-check': ic('ShieldCheck'), 'wrench': ic('Wrench'),
  'heart-broken': ic('HeartCrack'), 'hand-wave': ic('Hand'), 'hand-heart': ic('HeartHandshake'),
  'emoticon-sad-outline': ic('Frown'), 'emoticon-happy-outline': ic('Smile'),
  'heart': ic('Heart'), 'heart-outline': ic('Heart'), 'clock-outline': ic('Clock'), 'clock': ic('Clock'),
  'ticket-outline': ic('Ticket'), 'auto-fix': ic('Wand2'), 'cellphone': ic('Smartphone'),
  'bank': ic('Landmark'), 'bank-transfer': ic('ArrowLeftRight'), 'traffic-light': ic('TrafficCone'),
  'human-male': ic('User'), 'human-female': ic('User'), 'account': ic('User'), 'account-outline': ic('User'),
  'network-off': ic('WifiOff'), 'network': ic('Wifi'), 'wifi-off': ic('WifiOff'),
  'chart-line': ic('ChartLine'), 'chart-bar': ic('ChartColumn'),
};

// --- FontAwesome5 name -> lucide -------------------------------------------
const fa5: Record<string, LucideIcon> = {
  'coins': ic('Coins'), 'trophy': ic('Trophy'), 'medal': ic('Medal'), 'crown': ic('Crown'),
  'fire': ic('Flame'), 'gift': ic('Gift'), 'star': ic('Star'), 'wallet': ic('Wallet'),
};

// --- Feather name -> lucide (Feather IS lucide's ancestor; names ~match) ----
const feather: Record<string, LucideIcon> = {
  'x': ic('X'), 'alert-triangle': ic('TriangleAlert'), 'info': ic('Info'), 'camera': ic('Camera'),
  'link': ic('Link'), 'share-2': ic('Share2'), 'users': ic('Users'), 'bell': ic('Bell'),
  'search': ic('Search'), 'message-circle': ic('MessageCircle'), 'edit-2': ic('Pencil'), 'edit': ic('Pencil'),
  'credit-card': ic('CreditCard'), 'settings': ic('Settings'), 'check': ic('Check'), 'chevron-right': ic('ChevronRight'),
  'chevron-left': ic('ChevronLeft'), 'heart': ic('Heart'), 'star': ic('Star'), 'trash-2': ic('Trash2'),
  'download': ic('Download'), 'upload': ic('Upload'), 'plus': ic('Plus'), 'user': ic('User'),
};

function makeIconSet(map: Record<string, LucideIcon>) {
  const Comp = ({ name, size = 24, color = '#000000', style }: IconProps) => {
    const Glyph = (name && map[name]) || Fallback;
    return <Glyph size={size} color={color} style={style as any} />;
  };
  // Kept for `keyof typeof X.glyphMap` compatibility in existing callers.
  (Comp as any).glyphMap = map;
  return Comp as React.FC<IconProps> & { glyphMap: Record<string, LucideIcon> };
}

export const Ionicons = makeIconSet(ionicons);
export const MaterialCommunityIcons = makeIconSet(mci);
export const FontAwesome5 = makeIconSet(fa5);
export const Feather = makeIconSet(feather);

export default { Ionicons, MaterialCommunityIcons, FontAwesome5, Feather };
