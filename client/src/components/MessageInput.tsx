import { useState, FormEvent, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useChat } from '../contexts/ChatContext';
import { Attachment, api as chatApi } from '../api';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export function MessageInput() {
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { sendMessage, activeConversationId, startTyping, stopTyping } = useChat();
  const inputRef = useRef<HTMLInputElement>(null);
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
    // Clear pending attachment on conversation switch
    setPendingFile(null);
    setPendingPreview(null);
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [activeConversationId, stopTyping]);

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const hasText = !!text.trim();
    const hasFile = !!pendingFile;
    if (!hasText && !hasFile || !activeConversationId || uploading) return;

    const content = text.trim();
    const fileToUpload = pendingFile;
    setText('');
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

  const handleChange = (value: string) => {
    setText(value);
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
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Type a message..."
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="on"
          className="flex-1 px-4 py-3 min-h-[44px] border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-full focus:outline-none focus:border-blue-500 dark:focus:border-blue-400 text-base"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="px-5 sm:px-6 py-3 min-h-[44px] min-w-[44px] bg-blue-500 text-white rounded-full hover:bg-blue-600 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
        >
          {uploading ? '…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
