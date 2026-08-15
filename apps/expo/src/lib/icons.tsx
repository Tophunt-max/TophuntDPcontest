/**
 * Font-free icon shim (works identically on web / Android / iOS).
 *
 * @expo/vector-icons renders glyphs from icon FONTS, which are unreliable on
 * web (blank icons until/if the font loads). This module re-implements the
 * families the app uses (Ionicons / MaterialCommunityIcons / FontAwesome5, …)
 * on top of `lucide-react-native`, which draws pure SVG via react-native-svg —
 * no fonts, so icons always render everywhere.
 *
 * metro.config.js aliases `@expo/vector-icons` to this file, so every existing
 * `<Ionicons name="trophy" />` in the app automatically uses these SVG icons
 * with zero code changes.
 */
import React from "react";
import { View } from "react-native";
import {
  Plus, PlusCircle, ArrowLeft, ArrowRight, Calendar, Camera, SwitchCamera, CreditCard,
  Banknote, Check, CheckCircle2, ChevronLeft, ChevronDown, ChevronRight, X, XCircle,
  CloudOff, Coins, Wrench, Copy, Crown, FileText, Download, Mail, Eye, EyeOff,
  Zap, Gift, Globe, Heart, Home, Image as ImageIcon, Images, Lock, Megaphone,
  Mic, Newspaper, Send, Pencil, Users, User, Phone, Play, PlayCircle, Medal, Tags, QrCode,
  Receipt, RefreshCw, Rocket, Frown, ScanLine, Search, Share2, Star, Swords, Trash2,
  Trophy, Video, Wallet, Film, Clapperboard, Bell, Settings, MessageCircle,
  MoreHorizontal, MoreVertical, Bookmark, ThumbsUp, Flag, LogOut, MapPin, Clock, Filter,
  Menu, Compass, Circle,
} from "lucide-react-native";

type IconCmp = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

// name (as used across the app, from any family) -> lucide component.
const MAP: Record<string, IconCmp> = {
  // navigation / arrows
  "add": Plus, "add-circle": PlusCircle, "arrow-back": ArrowLeft, "arrow-forward": ArrowRight,
  "chevron-back": ChevronLeft, "chevron-down": ChevronDown, "chevron-forward": ChevronRight,
  "chevron-up": ChevronDown, "close": X, "close-circle": XCircle, "menu": Menu,
  // status / actions
  "checkmark": Check, "checkmark-circle": CheckCircle2, "refresh": RefreshCw,
  "copy-outline": Copy, "copy": Copy, "download-outline": Download, "download": Download,
  "trash-outline": Trash2, "trash": Trash2, "pencil": Pencil, "pencil-outline": Pencil,
  "search": Search, "filter": Filter, "eye-outline": Eye, "eye": Eye, "eye-off-outline": EyeOff,
  "share-social": Share2, "share-social-outline": Share2, "share-outline": Share2,
  "flag": Flag, "flag-outline": Flag, "log-out-outline": LogOut, "ellipsis-horizontal": MoreHorizontal,
  "ellipsis-vertical": MoreVertical, "bookmark": Bookmark, "bookmark-outline": Bookmark,
  // content / media
  "image": ImageIcon, "image-outline": ImageIcon, "images-outline": Images, "image-multiple": Images,
  "image-filter-hdr": ImageIcon, "camera": Camera, "camera-outline": Camera,
  "camera-reverse-outline": SwitchCamera, "videocam": Video, "movie-open-star": Film,
  "movie-open-play": Clapperboard, "play": Play, "play-circle": PlayCircle, "mic-sharp": Mic,
  "mic": Mic, "newspaper-outline": Newspaper, "document-text-outline": FileText,
  // money / rewards
  "coins": Coins, "cash-outline": Banknote, "card-outline": CreditCard, "wallet-outline": Wallet,
  "wallet": Wallet, "gift": Gift, "gift-outline": Gift, "trophy": Trophy, "crown": Crown,
  "podium": Medal, "medal": Medal, "star": Star, "pricetags-outline": Tags, "receipt-outline": Receipt,
  "qr-code-outline": QrCode, "flash": Zap,
  // people / social
  "person": User, "person-outline": User, "people": Users, "people-outline": Users, "home": Home,
  "heart": Heart, "heart-outline": Heart, "thumbs-up": ThumbsUp, "chatbubble-outline": MessageCircle,
  "chatbubbles-outline": MessageCircle, "notifications-outline": Bell, "notifications": Bell,
  "settings-outline": Settings, "location-outline": MapPin, "time-outline": Clock,
  // brand (lucide removed brand logos — use neutral glyphs)
  "facebook": Globe, "instagram": Globe, "twitter": Globe, "globe": Globe, "mail": Mail,
  "email": Mail, "phone": Phone,
  // misc
  "megaphone": Megaphone, "rocket-launch": Rocket, "rocket-outline": Rocket, "sword-cross": Swords,
  "construct-outline": Wrench, "lock-closed-outline": Lock, "cloud-offline-outline": CloudOff,
  "sad-outline": Frown, "scan-outline": ScanLine, "compass": Compass, "compass-outline": Compass,
  "paper-plane-outline": Send, "calendar": Calendar, "calendar-outline": Calendar,
};

export interface IconProps {
  name?: string;
  size?: number;
  color?: string;
  style?: any;
}

/** Shared SVG-backed icon. Unknown names fall back to a neutral glyph (never blank). */
function IconShim({ name, size = 24, color = "#000", style }: IconProps) {
  const Cmp = (name && MAP[name]) || Circle;
  return (
    <View style={style}>
      <Cmp size={size} color={color} />
    </View>
  );
}

// Every @expo/vector-icons family the app might import resolves to the same
// SVG shim (names are shared across the MAP). Default export = Ionicons-style.
export const Ionicons = IconShim;
export const MaterialCommunityIcons = IconShim;
export const MaterialIcons = IconShim;
export const FontAwesome = IconShim;
export const FontAwesome5 = IconShim;
export const Feather = IconShim;
export const AntDesign = IconShim;
export const Entypo = IconShim;
export const Octicons = IconShim;
export const SimpleLineIcons = IconShim;
export const Fontisto = IconShim;
export const Foundation = IconShim;
export const EvilIcons = IconShim;
export const Zocial = IconShim;
export default IconShim;
