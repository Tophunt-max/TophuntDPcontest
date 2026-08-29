/**
 * Cross-platform icon system (web + Android + iOS).
 *
 * WHY: @expo/vector-icons renders glyphs from icon FONTS. On the web export the
 * font @font-face frequently fails to load, so icons showed as blank boxes.
 * This is a DROP-IN replacement with the same API
 * (`<Ionicons name="search" size={20} color="#fff" />`) rendered as
 * `lucide-react-native` SVG icons — SVG renders identically everywhere, no font
 * loading. To migrate a file, only the import path changes:
 *   - import { Ionicons } from '@expo/vector-icons'
 *   + import { Ionicons } from '@/src/lib/icons'
 *
 * Icons are imported per-file (subpaths) so ONLY the icons we use are bundled.
 * Unmapped names fall back to a neutral Circle (never a crash).
 */
import React from 'react';
import type { StyleProp, ViewStyle, TextStyle } from 'react-native';
import Circle from 'lucide-react-native/icons/circle';
import AlarmClock from 'lucide-react-native/icons/alarm-clock';
import AlertCircle from 'lucide-react-native/icons/circle-alert';
import ArrowDown from 'lucide-react-native/icons/arrow-down';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowLeftRight from 'lucide-react-native/icons/arrow-left-right';
import ArrowRight from 'lucide-react-native/icons/arrow-right';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import AtSign from 'lucide-react-native/icons/at-sign';
import AudioLines from 'lucide-react-native/icons/audio-lines';
import Award from 'lucide-react-native/icons/award';
import Ban from 'lucide-react-native/icons/ban';
import Banknote from 'lucide-react-native/icons/banknote';
import Bell from 'lucide-react-native/icons/bell';
import Bookmark from 'lucide-react-native/icons/bookmark';
import Calendar from 'lucide-react-native/icons/calendar';
import Camera from 'lucide-react-native/icons/camera';
import ChartColumn from 'lucide-react-native/icons/chart-column';
import ChartLine from 'lucide-react-native/icons/chart-line';
import Check from 'lucide-react-native/icons/check';
import CheckCheck from 'lucide-react-native/icons/check-check';
import CheckCircle2 from 'lucide-react-native/icons/circle-check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleUser from 'lucide-react-native/icons/circle-user';
import Clapperboard from 'lucide-react-native/icons/clapperboard';
import Clock from 'lucide-react-native/icons/clock';
import Cloud from 'lucide-react-native/icons/cloud';
import CloudOff from 'lucide-react-native/icons/cloud-off';
import CircleHelp from 'lucide-react-native/icons/circle-question-mark';
import Coins from 'lucide-react-native/icons/coins';
import Compass from 'lucide-react-native/icons/compass';
import Copy from 'lucide-react-native/icons/copy';
import CreditCard from 'lucide-react-native/icons/credit-card';
import Crop from 'lucide-react-native/icons/crop';
import Crown from 'lucide-react-native/icons/crown';
import Dices from 'lucide-react-native/icons/dices';
import Download from 'lucide-react-native/icons/download';
import Expand from 'lucide-react-native/icons/expand';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import FerrisWheel from 'lucide-react-native/icons/ferris-wheel';
import File from 'lucide-react-native/icons/file';
import FileText from 'lucide-react-native/icons/file-text';
import Filter from 'lucide-react-native/icons/funnel';
import Flame from 'lucide-react-native/icons/flame';
import Frown from 'lucide-react-native/icons/face-slightly-frowning';
import Gamepad2 from 'lucide-react-native/icons/gamepad-2';
import Gem from 'lucide-react-native/icons/gem';
import Gift from 'lucide-react-native/icons/gift';
import Globe from 'lucide-react-native/icons/globe';
import Hand from 'lucide-react-native/icons/hand';
import Heart from 'lucide-react-native/icons/heart';
import HeartCrack from 'lucide-react-native/icons/heart-crack';
import HeartHandshake from 'lucide-react-native/icons/heart-handshake';
import Home from 'lucide-react-native/icons/house';
import Hourglass from 'lucide-react-native/icons/hourglass';
import Image from 'lucide-react-native/icons/image';
import Images from 'lucide-react-native/icons/images';
import IndianRupee from 'lucide-react-native/icons/indian-rupee';
import Info from 'lucide-react-native/icons/info';
import Landmark from 'lucide-react-native/icons/landmark';
import LayoutGrid from 'lucide-react-native/icons/layout-grid';
import Link from 'lucide-react-native/icons/link';
import List from 'lucide-react-native/icons/list';
import Lock from 'lucide-react-native/icons/lock';
import LockOpen from 'lucide-react-native/icons/lock-open';
import LogIn from 'lucide-react-native/icons/log-in';
import LogOut from 'lucide-react-native/icons/log-out';
import Mail from 'lucide-react-native/icons/mail';
import MapPin from 'lucide-react-native/icons/map-pin';
import Medal from 'lucide-react-native/icons/medal';
import Megaphone from 'lucide-react-native/icons/megaphone';
import Menu from 'lucide-react-native/icons/menu';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import MessagesSquare from 'lucide-react-native/icons/messages-square';
import Mic from 'lucide-react-native/icons/mic';
import Moon from 'lucide-react-native/icons/moon';
import Music from 'lucide-react-native/icons/music';
import MoreHorizontal from 'lucide-react-native/icons/ellipsis';
import MoreVertical from 'lucide-react-native/icons/ellipsis-vertical';
import Newspaper from 'lucide-react-native/icons/newspaper';
import Palette from 'lucide-react-native/icons/palette';
import PartyPopper from 'lucide-react-native/icons/party-popper';
import Pause from 'lucide-react-native/icons/pause';
import Pencil from 'lucide-react-native/icons/pencil';
import Phone from 'lucide-react-native/icons/phone';
import Play from 'lucide-react-native/icons/play';
import PlayCircle from 'lucide-react-native/icons/circle-play';
import Plus from 'lucide-react-native/icons/plus';
import PlusCircle from 'lucide-react-native/icons/circle-plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import Receipt from 'lucide-react-native/icons/receipt';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Rocket from 'lucide-react-native/icons/rocket';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
import ScanLine from 'lucide-react-native/icons/scan-line';
import Search from 'lucide-react-native/icons/search';
import Send from 'lucide-react-native/icons/send';
import Settings from 'lucide-react-native/icons/settings';
import Share2 from 'lucide-react-native/icons/share-2';
import Shield from 'lucide-react-native/icons/shield';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Smile from 'lucide-react-native/icons/face-slightly-smiling';
import Sparkles from 'lucide-react-native/icons/sparkles';
import Sprout from 'lucide-react-native/icons/sprout';
import SquarePen from 'lucide-react-native/icons/square-pen';
import Star from 'lucide-react-native/icons/star';
import Sticker from 'lucide-react-native/icons/sticker';
import Sun from 'lucide-react-native/icons/sun';
import SwitchCamera from 'lucide-react-native/icons/switch-camera';
import Swords from 'lucide-react-native/icons/swords';
import Tag from 'lucide-react-native/icons/tag';
import Tags from 'lucide-react-native/icons/tags';
import Target from 'lucide-react-native/icons/target';
import Ticket from 'lucide-react-native/icons/ticket';
import Timer from 'lucide-react-native/icons/timer';
import TrafficCone from 'lucide-react-native/icons/traffic-cone';
import Trash2 from 'lucide-react-native/icons/trash-2';
import TrendingDown from 'lucide-react-native/icons/trending-down';
import TrendingUp from 'lucide-react-native/icons/trending-up';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import Trophy from 'lucide-react-native/icons/trophy';
import Tv from 'lucide-react-native/icons/tv';
import Type from 'lucide-react-native/icons/type';
import Upload from 'lucide-react-native/icons/upload';
import UploadCloud from 'lucide-react-native/icons/cloud-upload';
import User from 'lucide-react-native/icons/user';
import Users from 'lucide-react-native/icons/users';
import Video from 'lucide-react-native/icons/video';
import VideoOff from 'lucide-react-native/icons/video-off';
import Vote from 'lucide-react-native/icons/vote';
import Volume2 from 'lucide-react-native/icons/volume-2';
import VolumeX from 'lucide-react-native/icons/volume-x';
import Wallet from 'lucide-react-native/icons/wallet';
import Wand2 from 'lucide-react-native/icons/wand-sparkles';
import Wifi from 'lucide-react-native/icons/wifi';
import WifiOff from 'lucide-react-native/icons/wifi-off';
import Wrench from 'lucide-react-native/icons/wrench';
import X from 'lucide-react-native/icons/x';
import XCircle from 'lucide-react-native/icons/circle-x';
import Zap from 'lucide-react-native/icons/zap';

export interface IconProps {
  name?: string;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
  [key: string]: any;
}

type LucideIcon = React.ComponentType<any>;

// name -> component lookup (built from the per-icon imports above).
const I: Record<string, LucideIcon> = { AlarmClock, AlertCircle, ArrowDown, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, AtSign, AudioLines, Award, Ban, Banknote, Bell, Bookmark, Calendar, Camera, ChartColumn, ChartLine, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleHelp, CircleUser, Clapperboard, Clock, Cloud, CloudOff, Coins, Compass, Copy, CreditCard, Crop, Crown, Dices, Download, Expand, Eye, EyeOff, FerrisWheel, File, FileText, Filter, Flame, Frown, Gamepad2, Gem, Gift, Globe, Hand, Heart, HeartCrack, HeartHandshake, Home, Hourglass, Image, Images, IndianRupee, Info, Landmark, LayoutGrid, Link, List, Lock, LockOpen, LogIn, LogOut, Mail, MapPin, Medal, Megaphone, Menu, MessageCircle, MessagesSquare, Mic, Moon, MoreHorizontal, MoreVertical, Music, Newspaper, Palette, PartyPopper, Pause, Pencil, Phone, Play, PlayCircle, Plus, PlusCircle, QrCode, Receipt, RefreshCw, Rocket, RotateCw, ScanLine, Search, Send, Settings, Share2, Shield, ShieldCheck, SlidersHorizontal, Smartphone, Smile, Sparkles, Sprout, SquarePen, Star, Sticker, Sun, SwitchCamera, Swords, Tag, Tags, Target, Ticket, Timer, TrafficCone, Trash2, TrendingDown, TrendingUp, TriangleAlert, Trophy, Tv, Type, Upload, UploadCloud, User, Users, Video, VideoOff, Volume2, VolumeX, Vote, Wallet, Wand2, Wifi, WifiOff, Wrench, X, XCircle, Zap };

// Resolve an icon by its lucide PascalCase name, falling back safely.
const ic = (n: string): LucideIcon => I[n] || Circle;

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
  // Added after an audit (scripts/audit-icon-names.mjs) found these in use and
  // resolving to the blank-Circle fallback. `crop-outline` was the worst of them:
  // it is the "Adjust photo" button on THREE screens — story create, contest
  // photo setup and profile edit — so all three showed a meaningless circle.
  'crop-outline': ic('Crop'), 'crop': ic('Crop'),
  // Exchange the soundtrack on a story for another track.
  'swap-horizontal': ic('ArrowLeftRight'), 'swap-horizontal-outline': ic('ArrowLeftRight'),
  'compass-outline': ic('Compass'), 'compass': ic('Compass'),
  'help': ic('CircleHelp'), 'help-outline': ic('CircleHelp'), 'help-circle-outline': ic('CircleHelp'),
  'hand-left': ic('Hand'), 'hand-left-outline': ic('Hand'), 'hand-right': ic('Hand'),
  'ban-outline': ic('Ban'), 'ban': ic('Ban'),
  // Story editor toolbar.
  'musical-notes': ic('Music'), 'musical-notes-outline': ic('Music'),
  'at-outline': ic('AtSign'), 'at': ic('AtSign'),
  'text-outline': ic('Type'), 'text': ic('Type'),
  'happy': ic('Smile'), 'sticker-outline': ic('Sticker'),
  'volume-high': ic('Volume2'), 'volume-high-outline': ic('Volume2'),
  'volume-mute': ic('VolumeX'), 'volume-mute-outline': ic('VolumeX'),
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
  'play': ic('Play'), 'play-circle': ic('PlayCircle'), 'pause': ic('Pause'), 'pause-circle': ic('PauseCircle'),
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
  'vote-outline': ic('Vote'), 'vote': ic('Vote'),
  'music': ic('Music'), 'music-note': ic('Music'), 'waveform': ic('AudioLines'),
  'sticker-emoji': ic('Sticker'), 'at': ic('AtSign'), 'format-text': ic('Type'), 'crop': ic('Crop'),
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
    const Glyph = (name && map[name]) || Circle;
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
