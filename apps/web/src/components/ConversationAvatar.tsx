import type { Conversation } from '../api';

interface ConversationAvatarProps {
  conversation: Conversation;
  currentUserId?: string;
  label: string;
  size?: number;
}

function PeopleGlyph() {
  return (
    <svg className="h-[62%] w-[62%]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.5" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19c.5-4 2.3-6 5.5-6s5 2 5.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14 14c3.7-.8 6 1 6.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ConversationAvatar({
  conversation,
  currentUserId,
  label,
  size = 40,
}: ConversationAvatarProps) {
  const participants = conversation.participants?.map(participant => participant.user) ?? [];
  const other = participants.find(user => user.id !== currentUserId) ?? participants[0];

  if (conversation.type === 'direct') {
    return (
      <div
        className="shrink-0 rounded-full bg-gray-300 dark:bg-slate-700 text-gray-600 dark:text-slate-300 flex items-center justify-center font-medium overflow-hidden"
        style={{ width: size, height: size }}
        aria-label={`${label} avatar`}
      >
        {other?.avatarUrl ? (
          <img src={other.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          label.charAt(0).toUpperCase()
        )}
      </div>
    );
  }

  const urls = participants
    .filter(user => user.id !== currentUserId)
    .map(user => user.avatarUrl)
    .filter((url): url is string => !!url)
    .slice(0, 4);

  if (urls.length < 2) {
    return (
      <div
        className="shrink-0 rounded-full bg-gray-200 dark:bg-slate-700 text-gray-500 dark:text-slate-300 flex items-center justify-center"
        style={{ width: size, height: size }}
        aria-label="Group avatar"
      >
        <PeopleGlyph />
      </div>
    );
  }

  const count = urls.length;
  const diameter = size * (count === 2 ? 0.7 : count === 3 ? 0.62 : 0.56);
  const edge = size - diameter;
  const positions = count === 2
    ? [{ left: 0, top: 0 }, { left: edge, top: edge }]
    : count === 3
      ? [
          { left: edge / 2, top: 0 },
          { left: 0, top: edge },
          { left: edge, top: edge },
        ]
      : [
          { left: 0, top: 0 },
          { left: edge, top: 0 },
          { left: 0, top: edge },
          { left: edge, top: edge },
        ];

  return (
    <div
      className="relative shrink-0 rounded-full overflow-hidden bg-gray-200 dark:bg-slate-700"
      style={{ width: size, height: size }}
      aria-label="Group avatar"
    >
      {urls.map((url, index) => (
        <img
          key={`${url}-${index}`}
          src={url}
          alt=""
          className="absolute rounded-full border border-white dark:border-slate-900 object-cover"
          style={{
            ...positions[index],
            width: diameter,
            height: diameter,
            zIndex: index + 1,
          }}
        />
      ))}
    </div>
  );
}
