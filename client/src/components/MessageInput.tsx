import { useState, FormEvent, useRef, useEffect } from 'react';
import { useChat } from '../contexts/ChatContext';

export function MessageInput() {
  const [text, setText] = useState('');
  const { sendMessage, activeConversationId } = useChat();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when conversation changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeConversationId]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !activeConversationId) return;

    const content = text.trim();
    setText('');
    await sendMessage(content);
  };

  if (!activeConversationId) {
    return null;
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 border-t border-gray-200">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
