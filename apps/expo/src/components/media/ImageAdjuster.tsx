import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, Pressable, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { computeCropRect, coverBaseScale } from '@/src/lib/cropMath';

/**
 * Reposition-and-zoom a picked photo inside a fixed frame, then crop it to that
 * frame — the "adjust so the photo comes properly" step.
 *
 * Why it exists at all: `expo-image-picker`'s `allowsEditing` crop UI only runs
 * on native, so on web (where this app also ships) a picked photo could not be
 * adjusted, and a tall photo then showed oversized/cropped by the layout. This
 * component is platform-neutral — gestures via react-native-gesture-handler,
 * transform via reanimated, the actual crop via expo-image-manipulator (which
 * runs on web through a canvas) — so adjust works everywhere.
 *
 * The correctness-critical part (gesture transform -> pixel rectangle of the
 * ORIGINAL image) lives in `src/lib/cropMath.ts` and is unit-tested; everything
 * here is the shell that drives it.
 */

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const MAX_SCALE = 4;
/** Chrome above (title/cancel) and below (zoom + confirm) the frame. */
const CHROME_V = 220;

type Props = {
  /** Local uri of the picked image. */
  uri: string;
  /** Frame aspect as width / height. 9/16 for a story, 1 for an avatar. */
  aspect: number;
  onCancel: () => void;
  onDone: (uri: string) => void;
};

const clampJS = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const ImageAdjuster: React.FC<Props> = ({ uri, aspect, onCancel, onDone }) => {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Probe the natural pixel size once — the crop maths need it, and it is also
  // how the image is laid out at "cover".
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ref = await ImageManipulator.manipulate(uri).renderAsync();
        if (alive) setSize({ w: ref.width, h: ref.height });
        // renderAsync holds a native bitmap; free it, we only needed the size.
        try { ref.release?.(); } catch { /* fine */ }
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [uri]);

  // Frame: the largest box of the requested aspect that fits the available area.
  const frame = useMemo(() => {
    const availW = SCREEN_W - 24;
    const availH = SCREEN_H - CHROME_V;
    let fw = availW;
    let fh = fw / aspect;
    if (fh > availH) {
      fh = availH;
      fw = fh * aspect;
    }
    return { w: Math.round(fw), h: Math.round(fh) };
  }, [aspect]);

  // Image display size at "cover" (scale 1 fills the frame exactly).
  const display = useMemo(() => {
    if (!size) return null;
    const base = coverBaseScale(size.w, size.h, frame.w, frame.h);
    return { w: size.w * base, h: size.h * base };
  }, [size, frame]);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const dispW = display?.w ?? 0;
  const dispH = display?.h ?? 0;

  // How far the image may move before a gap shows, recomputed reactively as the
  // user zooms. Pure arithmetic, so it is safe in a worklet.
  const maxTx = useDerivedValue(() => Math.max(0, (dispW * scale.value - frame.w) / 2));
  const maxTy = useDerivedValue(() => Math.max(0, (dispH * scale.value - frame.h) / 2));

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      tx.value = clampW(savedTx.value + e.translationX, -maxTx.value, maxTx.value);
      ty.value = clampW(savedTy.value + e.translationY, -maxTy.value, maxTy.value);
    })
    .onEnd(() => {
      'worklet';
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      'worklet';
      scale.value = clampW(savedScale.value * e.scale, 1, MAX_SCALE);
      // Re-clamp the pan so zooming out never opens a gap at the edges.
      tx.value = clampW(tx.value, -maxTx.value, maxTx.value);
      ty.value = clampW(ty.value, -maxTy.value, maxTy.value);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const gesture = Gesture.Simultaneous(panGesture, pinchGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    // Translate is listed BEFORE scale on purpose: that keeps the drag in screen
    // pixels regardless of zoom, which is the model cropMath assumes.
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  // Zoom buttons — the only way to zoom with a mouse on web, where there is no
  // pinch. Kept in sync with the gesture via the same shared values.
  const zoomBy = (factor: number) => {
    const next = clampJS(scale.value * factor, 1, MAX_SCALE);
    scale.value = next;
    savedScale.value = next;
    const mx = Math.max(0, (dispW * next - frame.w) / 2);
    const my = Math.max(0, (dispH * next - frame.h) / 2);
    tx.value = clampJS(tx.value, -mx, mx);
    ty.value = clampJS(ty.value, -my, my);
    savedTx.value = tx.value;
    savedTy.value = ty.value;
  };

  const confirm = async () => {
    if (!size || busy) return;
    setBusy(true);
    try {
      const rect = computeCropRect({
        imageW: size.w,
        imageH: size.h,
        frameW: frame.w,
        frameH: frame.h,
        scale: scale.value,
        translateX: tx.value,
        translateY: ty.value,
      });
      const cropped = await ImageManipulator.manipulate(uri)
        .crop({ originX: rect.originX, originY: rect.originY, width: rect.width, height: rect.height })
        .renderAsync();
      const out = await cropped.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
      try { cropped.release?.(); } catch { /* fine */ }
      onDone(out.uri);
    } catch {
      // Cropping failed (rare) — fall back to the original so the upload still
      // proceeds rather than trapping the user on this screen.
      onDone(uri);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cancel">
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Adjust photo</Text>
        <View style={{ width: 56 }} />
      </View>

      <View style={styles.frameArea}>
        {!size || !display ? (
          failed ? (
            <Text style={styles.error}>Could not load that image.</Text>
          ) : (
            <ActivityIndicator color="#fff" size="large" />
          )
        ) : (
          <GestureDetector gesture={gesture}>
            <View style={[styles.frame, { width: frame.w, height: frame.h }]}>
              <Animated.View
                style={[
                  {
                    position: 'absolute',
                    left: (frame.w - dispW) / 2,
                    top: (frame.h - dispH) / 2,
                    width: dispW,
                    height: dispH,
                  },
                  animatedStyle,
                ]}
              >
                <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
              </Animated.View>
              {/* Grid, purely cosmetic, to help line the subject up. */}
              <View pointerEvents="none" style={styles.gridV} />
              <View pointerEvents="none" style={styles.gridH} />
            </View>
          </GestureDetector>
        )}
      </View>

      <View style={styles.controls}>
        <View style={styles.zoomRow}>
          <Pressable onPress={() => zoomBy(1 / 1.25)} style={styles.zoomBtn} accessibilityRole="button" accessibilityLabel="Zoom out">
            <Text style={styles.zoomLabel}>−</Text>
          </Pressable>
          <Text style={styles.hint}>Drag to move · pinch or use −/+ to zoom</Text>
          <Pressable onPress={() => zoomBy(1.25)} style={styles.zoomBtn} accessibilityRole="button" accessibilityLabel="Zoom in">
            <Text style={styles.zoomLabel}>+</Text>
          </Pressable>
        </View>
        <Pressable onPress={confirm} disabled={busy || !size} style={[styles.doneBtn, (busy || !size) && styles.doneBtnDisabled]} accessibilityRole="button" accessibilityLabel="Use photo">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.doneText}>Use photo</Text>}
        </Pressable>
      </View>
    </View>
  );
};

/** Worklet clamp — inlined so the gesture callbacks stay on the UI thread. */
function clampW(v: number, lo: number, hi: number): number {
  'worklet';
  return Math.min(Math.max(v, lo), hi);
}

export default ImageAdjuster;

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', zIndex: 1000, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12 },
  cancel: { color: '#fff', fontSize: 16, width: 56 },
  title: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  frameArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { overflow: 'hidden', borderRadius: 8, backgroundColor: '#111' },
  gridV: { position: 'absolute', left: '33.33%', right: '33.33%', top: 0, bottom: 0, borderLeftWidth: 1, borderRightWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  gridH: { position: 'absolute', top: '33.33%', bottom: '33.33%', left: 0, right: 0, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  controls: { paddingHorizontal: 16, paddingBottom: 36, paddingTop: 8 },
  zoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  zoomBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  zoomLabel: { color: '#fff', fontSize: 24, fontFamily: 'Urbanist-Bold', lineHeight: 26 },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 12, flex: 1, textAlign: 'center', paddingHorizontal: 8 },
  doneBtn: { backgroundColor: '#ff4466', height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  doneBtnDisabled: { opacity: 0.6 },
  doneText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  error: { color: 'rgba(255,255,255,0.8)', fontSize: 14, paddingHorizontal: 24, textAlign: 'center' },
});
