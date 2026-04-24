import { useState, FormEvent, useRef, useEffect } from 'react';
import { useChat } from '../contexts/ChatContext';

export function MessageInput() {
  const [text, setText] = useState('');
  const { sendMessage, activeConversationId, startTyping, stopTyping } = useChat();
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const lastConversationRef = useRef<string | null>(null);

  // Focus input when conversation changes
  useEffect(() => {
    inputRef.current?.focus();
    if (lastConversationRef.current && lastConversationRef.current !== activeConversationId && typingActiveRef.current) {
      stopTyping(lastConversationRef.current);
      typingActiveRef.current = false;
    }
    lastConversationRef.current = activeConversationId;
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [activeConversationId, stopTyping]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !activeConversationId) return;

    const content = text.trim();
    setText('');
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (typingActiveRef.current) {
      stopTyping(activeConversationId);
      typingActiveRef.current = false;
    }
    await sendMessage(content);
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

  return (
    // Right padding reserves clearance so the Noos feedback widget
    // launcher (fixed, bottom-right, ~48-56px) doesn't overlap the
    // Send button. See OpenChat-u7c.
    <form onSubmit={handleSubmit} className="p-4 pr-20 sm:pr-24 border-t border-gray-200">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="px-6 py-2 bg-blue-500 text-white rounded-full hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </form>
  );
}
