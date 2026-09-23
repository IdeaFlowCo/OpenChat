import { User } from '../api';

export interface CurrentUserLike {
  userId: string;
  email: string;
  name?: string;
}

export function isSelfUser(user: Pick<User, 'id'> | null | undefined, currentUser: CurrentUserLike | null | undefined): boolean {
  return !!user && !!currentUser && user.id === currentUser.userId;
}

export const LEGACY_PLACEHOLDER_EMAIL_DOMAIN = 'users.openchat.invalid';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`);
}

export function userBaseName(user: Pick<User, 'name' | 'email'> | CurrentUserLike): string {
  if (user.name) return user.name;
  if (user.email && !isPlaceholderEmail(user.email)) return user.email;
  return 'OpenChat member';
}

export function userDisplayName(
  user: Pick<User, 'id' | 'name' | 'email'>,
  currentUser: CurrentUserLike | null | undefined
): string {
  const base = userBaseName(user);
  return isSelfUser(user, currentUser) ? `${base} (You)` : base;
}

export function currentUserAsContact(currentUser: CurrentUserLike): User {
  return {
    id: currentUser.userId,
    email: currentUser.email,
    name: currentUser.name || currentUser.email,
  };
}

export function isSelfSearch(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized === 'self' || normalized === 'me';
}

export function rankSelfFirst<T extends Pick<User, 'id'>>(
  users: T[],
  currentUser: CurrentUserLike | null | undefined
): T[] {
  if (!currentUser) return users;
  return [...users].sort((a, b) => {
    const aSelf = a.id === currentUser.userId;
    const bSelf = b.id === currentUser.userId;
    if (aSelf === bSelf) return 0;
    return aSelf ? -1 : 1;
  });
}
