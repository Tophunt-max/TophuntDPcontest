import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Alert } from '@/src/lib/appAlert';
import { Avatar } from '@/src/components/ui/Avatar';
import { useAuth } from '@/src/hooks/useAuth';
import { commentService, Comment } from '@/src/services/comments/commentService';
import {
  mergeComments,
  relativeTime,
  validateCommentDraft,
  MAX_COMMENT_LEN,
} from '@/src/services/comments/commentUtils';

const PAGE_SIZE = 20;
const ACCENT = '#FF3B30';
const FONT_SANS = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  default: undefined,
}) as any;

interface Props {
  /** `blog_posts.id` — NOT the slug. The Worker keys comments on the row id. */
  postId: string;
  isDark: boolean;
}

/**
 * Reader comments under a blog article.
 *
 * Why this is a separate component instead of the app's `CommentSheet`:
 *
 *  - `CommentSheet` is a gesture-driven bottom sheet in a `Portal`. On an article
 *    page the thread is part of the document — a reader scrolls into it, and on
 *    the web it has to be linkable and printable content, not an overlay.
 *  - it renders a `FlatList`. This sits inside `BlogDetailScreen`'s `ScrollView`,
 *    and nesting same-axis virtualised lists breaks scrolling and measurement, so
 *    the page is rendered with `.map()` and an explicit "Load older comments"
 *    button. That is also the better affordance here: infinite scroll fights the
 *    "Explore more posts" footer below it.
 *  - it is styled with the in-app Urbanist type ramp; the article is editorial and
 *    uses the system sans stack.
 *
 * The DATA layer is shared, though — same `commentService`, same idempotent
 * clientId, same optimistic insert/rollback — so blog comments behave exactly
 * like app comments and only one client talks to the Worker.
 *
 * Deliberately NOT subscribed to `commentService.onCommentEvent`: for a
 * non-match target that helper degrades to an 8-second poll, which is right for
 * an open comment sheet and wrong for an article that may sit open in a tab for
 * an hour. The thread refreshes when the reader posts or asks for more.
 */
export default function BlogComments({ postId, isDark }: Props) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const textColor = isDark ? '#FFFFFF' : '#111114';
  const subTextColor = isDark ? '#9B9BA3' : '#6A6A73';
  const borderColor = isDark ? '#232327' : '#EEEEF2';
  const fieldBg = isDark ? '#151517' : '#F7F7FA';

  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [focused, setFocused] = useState(false);

  const loadFirstPage = useCallback(
    async (showSpinner = true) => {
      if (!postId) return;
      if (showSpinner) setLoading(true);
      try {
        const page = await commentService.getComments(postId, 'blog', null, PAGE_SIZE);
        // Merge rather than replace: this also runs right after a post, when the
        // reader may already have pulled in older pages that the newest page does
        // not contain. The confirmed row overwrites its optimistic placeholder by
        // id (they share the clientId), so nothing duplicates.
        setComments((prev) => mergeComments(prev, page.items));
        setNextCursor(page.nextCursor);
        if (typeof page.total === 'number') setTotal(page.total);
        setLoadError(null);
      } catch (e: any) {
        // Same distinction the blog list learned to make: "could not load" and
        // "there is nothing here" are different facts and must look different.
        setLoadError(e?.message || 'Comments could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [postId],
  );

  useEffect(() => {
    setComments([]);
    setTotal(null);
    setNextCursor(null);
    loadFirstPage(true);
  }, [postId, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await commentService.getComments(postId, 'blog', nextCursor, PAGE_SIZE);
      setComments((prev) => mergeComments(prev, page.items));
      setNextCursor(page.nextCursor);
    } catch (e: any) {
      Alert.alert('Could not load more', e?.message || 'Please try again.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, postId]);

  const onPost = useCallback(async () => {
    if (posting) return;
    const check = validateCommentDraft(draft);
    if (!check.ok) {
      if (draft.trim()) Alert.alert('Comment not sent', check.error || 'Please try again.');
      return;
    }
    if (!user) {
      router.push('/auth/login');
      return;
    }
    const clientId = commentService.clientToken();
    const optimistic: Comment = {
      id: clientId,
      postId,
      userId: user.uid,
      username: user.displayName || 'You',
      userAvatar: user.photoURL || null,
      text: check.text,
      createdAt: Date.now(),
      likes: 0,
      likedByMe: false,
      pending: true,
    };
    // Argument order matters: `mergeComments` forces `pending: false` on the
    // INCOMING side (that is how a server echo clears the placeholder), so the
    // optimistic row has to be the existing side to keep its "Posting…" state.
    setComments((prev) => mergeComments([optimistic], prev));
    setTotal((t) => (t == null ? t : t + 1));
    setDraft('');
    setPosting(true);
    try {
      await commentService.addComment(postId, check.text, 'blog', clientId);
      // The server stores the comment under `clientId`, so the confirmed row
      // merges over the placeholder by id instead of duplicating it.
      await loadFirstPage(false);
    } catch (e: any) {
      setComments((prev) => prev.filter((cm) => cm.id !== clientId));
      setTotal((t) => (t == null ? t : Math.max(0, t - 1)));
      setDraft(check.text); // give the text back rather than losing it
      Alert.alert('Could not post', e?.message || 'Please try again.');
    } finally {
      setPosting(false);
    }
  }, [draft, posting, user, postId, router, loadFirstPage]);

  const onToggleLike = useCallback(
    async (comment: Comment) => {
      if (comment.pending) return;
      if (!user) {
        router.push('/auth/login');
        return;
      }
      const next = !comment.likedByMe;
      setComments((prev) =>
        prev.map((cm) =>
          cm.id === comment.id
            ? { ...cm, likedByMe: next, likes: Math.max(0, (cm.likes || 0) + (next ? 1 : -1)) }
            : cm,
        ),
      );
      try {
        const res = await commentService.likeComment(comment.id, 'blog');
        setComments((prev) =>
          prev.map((cm) => (cm.id === comment.id ? { ...cm, likedByMe: res.liked, likes: res.likeCount } : cm)),
        );
      } catch {
        setComments((prev) =>
          prev.map((cm) =>
            cm.id === comment.id ? { ...cm, likedByMe: comment.likedByMe, likes: comment.likes } : cm,
          ),
        );
      }
    },
    [user, router],
  );

  const onDelete = useCallback(
    (comment: Comment) => {
      Alert.alert('Delete comment?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const snapshot = comments;
            const snapshotTotal = total;
            setComments((prev) => prev.filter((cm) => cm.id !== comment.id));
            setTotal((t) => (t == null ? t : Math.max(0, t - 1)));
            try {
              await commentService.deleteComment(postId, comment.id, 'blog');
            } catch (e: any) {
              setComments(snapshot);
              setTotal(snapshotTotal);
              Alert.alert('Could not delete', e?.message || 'Please try again.');
            }
          },
        },
      ]);
    },
    [comments, total, postId],
  );

  const onReport = useCallback((comment: Comment) => {
    // Public UGC on an indexed page needs a reporting path, not just an admin
    // queue nobody is told about. This files a moderation report; it deliberately
    // does not hide the comment locally, because "reported" must not read as
    // "removed".
    Alert.alert('Report comment?', 'Our team will review it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: async () => {
          try {
            await commentService.reportComment(comment.id, 'blog');
            Alert.alert('Thanks', 'Report submitted.');
          } catch (e: any) {
            Alert.alert('Could not report', e?.message || 'Please try again.');
          }
        },
      },
    ]);
  }, []);

  const headingCount = total ?? comments.length;
  const canSend = draft.trim().length > 0 && !posting;

  return (
    <View style={[styles.wrap, { borderTopColor: borderColor }]}>
      <Text style={[styles.heading, { color: textColor, fontFamily: FONT_SANS }]}>
        {headingCount > 0 ? `Comments (${headingCount})` : 'Comments'}
      </Text>

      {/* ---- composer (above the thread: no scrolling past 20 comments to reply) ---- */}
      {authLoading ? null : user ? (
        <View style={styles.composer}>
          <Avatar uri={user.photoURL} name={user.displayName || 'Me'} size={38} />
          <View style={{ flex: 1 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Share your thoughts…"
              placeholderTextColor={subTextColor}
              multiline
              maxLength={MAX_COMMENT_LEN}
              accessibilityLabel="Write a comment"
              style={[
                styles.input,
                {
                  color: textColor,
                  backgroundColor: fieldBg,
                  borderColor: focused ? ACCENT : borderColor,
                  fontFamily: FONT_SANS,
                },
                Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null,
              ]}
            />
            <View style={styles.composerFooter}>
              <Text style={[styles.counter, { color: subTextColor, fontFamily: FONT_SANS }]}>
                {draft.trim().length}/{MAX_COMMENT_LEN}
              </Text>
              <TouchableOpacity
                onPress={onPost}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                style={[styles.sendBtn, { opacity: canSend ? 1 : 0.5 }]}
              >
                {posting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={[styles.sendText, { fontFamily: FONT_SANS }]}>Post comment</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : (
        <View style={[styles.signIn, { backgroundColor: fieldBg, borderColor }]}>
          <Text style={[styles.signInText, { color: subTextColor, fontFamily: FONT_SANS }]}>
            Sign in to join the conversation.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/auth/login')}
            accessibilityRole="button"
            style={styles.sendBtn}
          >
            <Text style={[styles.sendText, { fontFamily: FONT_SANS }]}>Sign in</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ---- thread ---- */}
      {loading ? (
        <ActivityIndicator color={ACCENT} style={{ marginTop: 26 }} />
      ) : loadError && comments.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={[styles.stateText, { color: subTextColor, fontFamily: FONT_SANS }]}>{loadError}</Text>
          <TouchableOpacity onPress={() => loadFirstPage(true)} accessibilityRole="button" style={styles.sendBtn}>
            <Text style={[styles.sendText, { fontFamily: FONT_SANS }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : comments.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={[styles.stateText, { color: subTextColor, fontFamily: FONT_SANS }]}>
            No comments yet. Be the first to comment.
          </Text>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {comments.map((cm) => {
            const mine = !!user && cm.userId === user.uid;
            const liked = !!cm.likedByMe;
            return (
              <View key={cm.id} style={[styles.item, cm.pending && { opacity: 0.55 }]}>
                <Avatar uri={cm.userAvatar} name={cm.username} size={38} />
                <View style={{ flex: 1 }}>
                  <View style={styles.itemHead}>
                    <Text style={[styles.itemName, { color: textColor, fontFamily: FONT_SANS }]} numberOfLines={1}>
                      {cm.username || 'TopHunt reader'}
                    </Text>
                    <Text style={[styles.itemTime, { color: subTextColor, fontFamily: FONT_SANS }]}>
                      {cm.pending ? 'Posting…' : relativeTime(cm.createdAt)}
                    </Text>
                  </View>
                  {/* Plain text on purpose. Links in reader comments on an indexed
                      page are an SEO/spam liability, so nothing here is turned
                      into an anchor. */}
                  <Text style={[styles.itemText, { color: textColor, fontFamily: FONT_SANS }]}>{cm.text}</Text>
                  <View style={styles.itemActions}>
                    <TouchableOpacity
                      onPress={() => onToggleLike(cm)}
                      accessibilityRole="button"
                      accessibilityLabel={liked ? 'Unlike comment' : 'Like comment'}
                      hitSlop={8}
                    >
                      <Text style={[styles.actionText, { color: liked ? ACCENT : subTextColor, fontFamily: FONT_SANS }]}>
                        {liked ? '\u2665' : '\u2661'}
                        {(cm.likes || 0) > 0 ? `  ${cm.likes}` : ''}
                      </Text>
                    </TouchableOpacity>
                    {mine ? (
                      <TouchableOpacity onPress={() => onDelete(cm)} accessibilityRole="button" hitSlop={8}>
                        <Text style={[styles.actionText, { color: subTextColor, fontFamily: FONT_SANS }]}>Delete</Text>
                      </TouchableOpacity>
                    ) : user ? (
                      <TouchableOpacity onPress={() => onReport(cm)} accessibilityRole="button" hitSlop={8}>
                        <Text style={[styles.actionText, { color: subTextColor, fontFamily: FONT_SANS }]}>Report</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}

          {nextCursor ? (
            <TouchableOpacity
              onPress={loadMore}
              disabled={loadingMore}
              accessibilityRole="button"
              style={[styles.loadMore, { borderColor }]}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color={ACCENT} />
              ) : (
                <Text style={[styles.loadMoreText, { color: textColor, fontFamily: FONT_SANS }]}>
                  Load older comments
                </Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 34, paddingTop: 24, borderTopWidth: 1 },
  heading: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: 16 },
  composer: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  input: {
    minHeight: 84,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 12,
  },
  counter: { fontSize: 12.5 },
  sendBtn: {
    backgroundColor: ACCENT,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    minWidth: 108,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },
  signIn: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 12,
    alignItems: 'flex-start',
  },
  signInText: { fontSize: 14.5 },
  stateBox: { marginTop: 22, gap: 14, alignItems: 'flex-start' },
  stateText: { fontSize: 14.5 },
  item: { flexDirection: 'row', gap: 12, paddingVertical: 16 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  itemName: { fontSize: 14.5, fontWeight: '700', flexShrink: 1 },
  itemTime: { fontSize: 12.5 },
  itemText: { fontSize: 15, lineHeight: 22 },
  itemActions: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 8 },
  actionText: { fontSize: 13, fontWeight: '600' },
  loadMore: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  loadMoreText: { fontSize: 14, fontWeight: '700' },
});
