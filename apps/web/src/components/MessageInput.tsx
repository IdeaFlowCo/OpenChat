import { useState, FormEvent, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useChat } from '../contexts/ChatContext';
import { Attachment, api as chatApi } from '../api';
import { userDisplayName } from '../utils/userDisplay';
import { MentionAutocomplete, MentionCandidate } from './MentionAutocomplete';

// Match an in-progress @mention immediately before the cursor (bmp.8):
// start-of-string or whitespace, then @, then the typed prefix (no spaces).
const MENTION_RE = /(?:^|\s)@([^\s@]*)$/;

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export function MessageInput() {
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Voice recording state (bmp.7 / OpenChat-xxc).
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  // Hands-free (tap-to-toggle) vs hold-to-record (openchat-9de). When the
  // recording bar is shown in hands-free mode, the user explicitly taps
  // Stop/Cancel; in hold mode, releasing the mic finalizes the recording.
  const [handsFree, setHandsFree] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordStartRef = useRef<number>(0);
  const recordTimerRef = useRef<number | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const cancelRecordRef = useRef(false);
  // Tap-vs-hold discrimination (openchat-9de). A press shorter than this
  // (ms) counts as a tap → flip into hands-free mode and keep recording on
  // release. A longer press is a hold → release finalizes + sends.
  const TAP_THRESHOLD_MS = 250;
  const pressStartRef = useRef<number>(0);
  const handsFreeRef = useRef(false);
  // Guard so a touch device that fires BOTH pointer and mouse events for one
  // physical press doesn't start recording twice / toggle modes spuriously.
  const pressActiveRef = useRef(false);
  // If the user releases a HOLD before async getUserMedia resolves, record
  // the intent here so startRecording can stop immediately once the recorder
  // exists (instead of leaving a recorder running that nothing will stop).
  const pendingStopRef = useRef<null | 'send' | 'cancel'>(null);
  const voiceSupported = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const { sendMessage, activeConversationId, startTyping, stopTyping, replyTo, setReplyTo, currentUser, contacts, conversations } = useChat();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // @mention autocomplete state (bmp.8). Active only in group conversations.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const isGroup = activeConv?.type === 'group';
  const participants = activeConv?.participants ?? [];
  const typingTimeoutRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const lastConversationRef = useRef<string | null>(null);

  // Focus input when conversation changes — but ONLY on devices with a real
  // pointer (desktop / hover-capable). On touch devices, autofocus opens the
  // soft keyboard immediately on conversation open, which triggers the entire
  // visualViewport-resize cascade during navigation — flicker, scroll jumps,
  // layout shift. Let touch users explicitly tap the composer themselves.
  // Per codex review 2026-05-30 of OpenChat-ka1.
  useEffect(() => {
    const isPointerCoarse =
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    if (!isPointerCoarse) {
      inputRef.current?.focus();
    }
    if (lastConversationRef.current && lastConversationRef.current !== activeConversationId && typingActiveRef.current) {
      stopTyping(lastConversationRef.current);
      typingActiveRef.current = false;
    }
    lastConversationRef.current = activeConversationId;
    // Clear pending attachment + mention state on conversation switch
    setPendingFile(null);
    setPendingPreview(null);
    setMentionQuery(null);
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [activeConversationId, stopTyping]);

  // Focus the composer when the user picks a message to reply to (bmp.2).
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be picked again
    e.target.value = '';

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      alert('Only images (JPEG, PNG, GIF, WEBP) are supported.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert('Image must be smaller than 20 MB.');
      return;
    }
    setPendingFile(file);
    const url = URL.createObjectURL(file);
    setPendingPreview(url);
  };

  const clearPendingFile = () => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
  };

  // ── Voice recording (bmp.7) ──────────────────────────────────────────────
  const stopTracks = () => {
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    if (recordTimerRef.current) { window.clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
  };

  const sendVoice = async (blob: Blob, durationMs: number) => {
    if (!activeConversationId) return;
    setUploading(true);
    try {
      const mimeType = blob.type || 'audio/webm';
      const { putUrl, getUrl } = await chatApi.presignAttachment({
        filename: 'voice.webm',
        mimeType,
        sizeBytes: blob.size,
      });
      const putRes = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      const attachment: Attachment = { url: getUrl, mimeType, type: 'audio', durationMs };
      await sendMessage('', [attachment]);
    } catch (err) {
      console.error('[MessageInput] voice send failed:', err);
      toast.error('Voice message not sent — check your connection.');
    } finally {
      setUploading(false);
    }
  };

  const startRecording = async () => {
    if (!voiceSupported || recording || uploading || !activeConversationId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      cancelRecordRef.current = false;
      recordChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) recordChunksRef.current.push(ev.data); };
      mr.onstop = () => {
        const durationMs = Date.now() - recordStartRef.current;
        stopTracks();
        setRecording(false);
        setRecordSeconds(0);
        setHandsFree(false);
        handsFreeRef.current = false;
        if (cancelRecordRef.current) return;
        if (durationMs < 500) return; // ignore accidental taps
        const blob = new Blob(recordChunksRef.current, { type: mr.mimeType || 'audio/webm' });
        void sendVoice(blob, durationMs);
      };
      recordStartRef.current = Date.now();
      mr.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartRef.current) / 1000));
      }, 250);
      // The user may have already released a HOLD while getUserMedia was still
      // resolving — honor that now rather than leaving the recorder running.
      if (pendingStopRef.current) {
        const intent = pendingStopRef.current;
        pendingStopRef.current = null;
        stopRecording(intent === 'cancel');
      }
    } catch (err) {
      // Most commonly a permission denial (NotAllowedError) — give a friendly
      // nudge rather than a generic failure. (openchat-9de)
      console.error('[MessageInput] mic error:', err);
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast.error(denied
        ? 'Microphone access was blocked. Enable it in your browser settings to record voice messages.'
        : 'Could not access the microphone.');
      stopTracks();
      setRecording(false);
      setHandsFree(false);
      handsFreeRef.current = false;
      pressActiveRef.current = false;
    }
  };

  const stopRecording = (cancel = false) => {
    cancelRecordRef.current = cancel;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    else {
      stopTracks();
      setRecording(false);
      setRecordSeconds(0);
      setHandsFree(false);
      handsFreeRef.current = false;
    }
  };

  // ── Tap-to-toggle vs hold-to-record (openchat-9de) ──────────────────────
  // Press-and-hold: start recording on press, finalize + send on release.
  // Quick tap (< TAP_THRESHOLD_MS): flip into hands-free mode and keep
  // recording; the user then taps Stop (send) or Cancel in the recording bar.
  const handleMicPressStart = () => {
    if (pressActiveRef.current) return; // de-dupe pointer + mouse double-fire
    if (recording || uploading || !activeConversationId) return;
    pressActiveRef.current = true;
    pressStartRef.current = Date.now();
    handsFreeRef.current = false;
    pendingStopRef.current = null;
    void startRecording();
  };

  const handleMicPressEnd = () => {
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    // Already in hands-free mode (e.g. release after a prior tap): ignore —
    // the recording bar's own Stop/Cancel buttons drive it from here.
    if (handsFreeRef.current) return;
    const heldMs = Date.now() - pressStartRef.current;
    if (heldMs < TAP_THRESHOLD_MS) {
      // Treat as a tap → stay recording hands-free.
      handsFreeRef.current = true;
      setHandsFree(true);
    } else {
      // Treat as a hold → release finalizes and sends. If getUserMedia is
      // still resolving (no recorder yet), defer the stop so startRecording
      // can honor it the moment the recorder exists.
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        stopRecording(false);
      } else {
        pendingStopRef.current = 'send';
      }
    }
  };

  useEffect(() => () => stopTracks(), []);

  const handleSubmit = async (e: FormEvent | React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const hasText = !!text.trim();
    const hasFile = !!pendingFile;
    if (!hasText && !hasFile || !activeConversationId || uploading) return;

    const content = text.trim();
    const fileToUpload = pendingFile;
    setText('');
    setMentionQuery(null);
    clearPendingFile();

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (typingActiveRef.current) {
      stopTyping(activeConversationId);
      typingActiveRef.current = false;
    }

    try {
      let attachments: Attachment[] | undefined;
      if (fileToUpload) {
        setUploading(true);
        try {
          // Get presigned PUT URL
          const { putUrl, getUrl } = await chatApi.presignAttachment({
            filename: fileToUpload.name,
            mimeType: fileToUpload.type,
            sizeBytes: fileToUpload.size,
          });
          // Upload
          const putRes = await fetch(putUrl, {
            method: 'PUT',
            headers: { 'Content-Type': fileToUpload.type },
            body: fileToUpload,
          });
          if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
          attachments = [{ url: getUrl, mimeType: fileToUpload.type }];
        } finally {
          setUploading(false);
        }
      }
      await sendMessage(content, attachments);
    } catch (err) {
      // Both the WebSocket path and its REST fallback have to fail for this to
      // throw (e.g. the user is fully offline). Don't lose what they typed:
      // restore it to the composer and tell them, so they can retry instead of
      // the message vanishing silently. See OpenChat-5q1.
      console.error('[MessageInput] send failed:', err);
      setText((current) => (current ? current : content));
      toast.error('Message not sent — check your connection and try again.');
    }
  };

  // Enter sends; Shift+Enter inserts a newline. The isComposing guard is
  // important for IME users (e.g. Chinese/Japanese input): pressing Enter to
  // confirm an IME candidate must NOT send the message. keyCode 229 is the
  // legacy signal for the same "still composing" state.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && mentionQuery !== null) {
      e.preventDefault();
      setMentionQuery(null);
      return;
    }
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault();
      void handleSubmit(e);
    }
  };

  const selectMention = (candidate: MentionCandidate) => {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);
    const m = before.match(MENTION_RE);
    if (!m) { setMentionQuery(null); return; }
    // Replace the "@prefix" token (m[0] may include a leading space) with "@Name ".
    const lead = m[0].startsWith('@') ? '' : m[0][0]; // preserve the leading whitespace if any
    const start = before.length - m[0].length + lead.length;
    const next = before.slice(0, start) + `@${candidate.displayName} ` + after;
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + candidate.displayName.length + 2; // @ + name + space
      el?.setSelectionRange(pos, pos);
    });
  };

  const updateMentionQuery = (value: string) => {
    if (!isGroup) { setMentionQuery(null); return; }
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? value.length;
    const m = value.slice(0, cursor).match(MENTION_RE);
    setMentionQuery(m ? m[1] : null);
  };

  const handleChange = (value: string) => {
    setText(value);
    updateMentionQuery(value);
    if (!activeConversationId) return;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (!value.trim()) {
      if (typingActiveRef.current) {
        stopTyping(activeConversationId);
        typingActiveRef.current = false;
      }
      return;
    }

    if (!typingActiveRef.current) {
      startTyping(activeConversationId);
      typingActiveRef.current = true;
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      stopTyping(activeConversationId);
      typingActiveRef.current = false;
    }, 1500);
  };

  if (!activeConversationId) {
    return null;
  }

  const canSend = (!!text.trim() || !!pendingFile) && !uploading;

  return (
    // Right padding reserves clearance so the Noos feedback widget
    // launcher (fixed, bottom-right, ~48-56px) doesn't overlap the
    // Send button. See OpenChat-u7c.
    // pb-safe lifts the composer above the iOS home indicator. See OpenChat-sjr.
    <form
      onSubmit={handleSubmit}
      className="p-3 sm:p-4 pr-20 sm:pr-24 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 pb-[max(env(safe-area-inset-bottom,0),0.75rem)]"
    >
      {/* Reply / quote preview (openchat-bmp.2). Sending consumes replyTo. */}
      {replyTo && (
        <div className="flex items-center gap-2 mb-2 p-2 bg-gray-50 dark:bg-slate-800 rounded-lg border-l-2 border-blue-500">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 truncate">
              Replying to {replyTo.sender
                ? userDisplayName(replyTo.sender, currentUser)
                : contacts.find(c => c.id === replyTo.senderId)?.name
                  || (replyTo.senderId === currentUser?.userId ? 'yourself' : 'message')}
            </div>
            <div className="text-xs text-gray-500 dark:text-slate-400 truncate">
              {replyTo.content || 'Attachment'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200 text-xl leading-none px-2"
            aria-label="Cancel reply"
          >
            ×
          </button>
        </div>
      )}
      {/* Pending image preview (OpenChat-6bg) */}
      {pendingPreview && (
        <div className="flex items-center gap-2 mb-2 p-2 bg-gray-50 dark:bg-slate-800 rounded-lg">
          <img src={pendingPreview} alt="Attachment preview" className="w-12 h-12 rounded object-cover" />
          <span className="flex-1 text-sm text-gray-600 dark:text-slate-400 truncate">
            {pendingFile?.name}
          </span>
          <button
            type="button"
            onClick={clearPendingFile}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200 text-xl leading-none px-2"
            aria-label="Remove attachment"
          >
            ×
          </button>
        </div>
      )}
      {/* @mention autocomplete (bmp.8) — group chats only */}
      {isGroup && mentionQuery !== null && (
        <MentionAutocomplete
          query={mentionQuery}
          participants={participants}
          excludeUserId={currentUser?.userId}
          onSelect={selectMention}
        />
      )}
      {recording ? (
        <div className="flex items-center gap-3 rounded-3xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            Recording {Math.floor(recordSeconds / 60)}:{(recordSeconds % 60).toString().padStart(2, '0')}
          </span>
          <div className="flex-1" />
          {handsFree ? (
            // Hands-free (tap-to-toggle): explicit Stop/Cancel controls.
            <>
              <button
                type="button"
                onClick={() => stopRecording(true)}
                className="rounded-full px-3 py-2 text-sm font-medium text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => stopRecording(false)}
                aria-label="Stop and send voice message"
                className="rounded-full bg-blue-500 px-5 py-2 text-sm font-medium text-white hover:bg-blue-600"
              >
                Stop
              </button>
            </>
          ) : (
            // Hold-to-record: the user is holding the mic; release sends.
            <span className="text-xs text-gray-500 dark:text-slate-400">
              Release to send · tap for hands-free
            </span>
          )}
        </div>
      ) : (
      <div className="flex gap-2 items-end">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        {/* Attach button (OpenChat-6bg) */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Attach image"
          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200 disabled:opacity-40 transition-colors"
        >
          <span className="text-xl">📎</span>
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          enterKeyHint="enter"
          autoComplete="off"
          autoCorrect="on"
          className="flex-1 resize-none px-4 py-3 min-h-[44px] max-h-40 overflow-y-auto leading-6 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-3xl focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 text-base"
        />
        {/* Mic when composer is empty (voice — bmp.7). Press-and-hold to
            record-then-send; quick tap for hands-free recording (openchat-9de).
            Pointer events cover mouse + touch + pen; the press guard de-dupes
            the legacy mouse events some touch browsers also fire. */}
        {voiceSupported && !text.trim() && !pendingFile ? (
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); handleMicPressStart(); }}
            onPointerUp={(e) => { e.preventDefault(); handleMicPressEnd(); }}
            onPointerLeave={handleMicPressEnd}
            onPointerCancel={handleMicPressEnd}
            disabled={uploading}
            aria-label="Record voice message — hold to record, tap for hands-free"
            className="px-4 py-3 min-h-[44px] min-w-[44px] bg-blue-500 text-white rounded-full hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50 font-medium transition-colors touch-none select-none"
          >
            {uploading ? '…' : '🎤'}
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="px-5 sm:px-6 py-3 min-h-[44px] min-w-[44px] bg-blue-500 text-white rounded-full hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
          >
            {uploading ? '…' : 'Send'}
          </button>
        )}
      </div>
      )}
    </form>
  );
}
