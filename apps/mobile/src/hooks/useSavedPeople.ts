import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PrivateThing } from '../api/client';

type Snapshot = { ownerId: string; people: PrivateThing[]; loaded: number; total: number | null; complete: boolean; loading: boolean; error: string };
type Checkpoint = { rows: Map<string, PrivateThing>; after?: string; cursors: Set<string>; total?: number; changed?: boolean };
const empty = (ownerId: string): Snapshot => ({ ownerId, people: [], loaded: 0, total: null, complete: false, loading: false, error: '' });

export function useSavedPeople(ownerId: string) {
  const [snapshot, setSnapshot] = useState(() => empty(ownerId));
  const scope = useRef({ ownerId, run: 0, checkpoint: null as Checkpoint | null, loading: false });
  if (scope.current.ownerId !== ownerId) scope.current = { ownerId, run: scope.current.run + 1, checkpoint: null, loading: false };
  const ownerScope = scope.current;
  const cancel = useCallback(() => {
    ownerScope.run += 1;
    ownerScope.loading = false;
    setSnapshot(previous => previous.ownerId === ownerId ? { ...previous, loading: false } : empty(ownerId));
  }, [ownerId, ownerScope]);
  useEffect(() => () => { ownerScope.run += 1; ownerScope.loading = false; }, [ownerScope]);

  const refresh = useCallback(async () => {
    if (ownerScope.loading || scope.current !== ownerScope || ownerId === 'signed-out') return;
    ownerScope.loading = true;
    const run = ++ownerScope.run;
    const current = () => scope.current === ownerScope && ownerScope.run === run;
    let checkpoint: Checkpoint = ownerScope.checkpoint ?? { rows: new Map<string, PrivateThing>(), cursors: new Set<string>() };
    ownerScope.checkpoint = checkpoint;
    setSnapshot(previous => ({ ...(previous.ownerId === ownerId ? previous : empty(ownerId)), loading: true, complete: false, error: '' }));
    let reconciliations = 0;
    try {
      for (;;) {
        const page = await api.listPrivateThings('', 'person', { after: checkpoint.after, limit: 100, summary: true });
        if (!current()) return;
        if ((page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) || !Number.isSafeInteger(page.total) || page.total < 0) throw new Error('Invalid people page');
        if (page.nextCursor && checkpoint.cursors.has(page.nextCursor)) throw new Error('Repeated people cursor');
        if (checkpoint.total !== undefined && checkpoint.total !== page.total) checkpoint.changed = true;
        checkpoint.total = page.total;
        for (const person of page.things) checkpoint.rows.set(person.id, person);
        const ended = page.nextCursor === null;
        const complete = ended && checkpoint.rows.size === page.total && !checkpoint.changed;
        if (page.nextCursor) checkpoint.cursors.add(page.nextCursor);
        checkpoint.after = page.nextCursor ?? undefined;
        const received = new Map(checkpoint.rows);
        setSnapshot(previous => {
          const rows = new Map((complete || previous.ownerId !== ownerId ? [] : previous.people).map(person => [person.id, person]));
          for (const [id, person] of received) rows.set(id, person);
          return { ownerId, people: [...rows.values()], loaded: received.size, total: page.total, complete, loading: !complete, error: '' };
        });
        if (complete) { ownerScope.checkpoint = null; break; }
        if (ended) {
          // A cursor can miss inserts behind it or retain deleted rows. Never
          // acknowledge that traversal; reconcile once from the beginning.
          ownerScope.checkpoint = null;
          if (reconciliations++ >= 1) throw new Error('People changed during reconciliation');
          checkpoint = { rows: new Map(), cursors: new Set() };
          ownerScope.checkpoint = checkpoint;
        }
      }
    } catch {
      if (current()) setSnapshot(previous => ({ ...previous, loading: false, complete: false, error: 'Could not load all saved people. Retry to continue.' }));
    } finally {
      if (current()) ownerScope.loading = false;
    }
  }, [ownerId, ownerScope]);

  const addPerson = useCallback((person: PrivateThing) => {
    if (scope.current !== ownerScope) return;
    ownerScope.run += 1;
    ownerScope.loading = false;
    ownerScope.checkpoint = null;
    setSnapshot(previous => {
      const value = previous.ownerId === ownerId ? previous : empty(ownerId);
      return { ...value, people: [person, ...value.people.filter(row => row.id !== person.id)], loading: false, complete: false };
    });
  }, [ownerId, ownerScope]);

  return { ...(snapshot.ownerId === ownerId ? snapshot : empty(ownerId)), refresh, cancel, addPerson };
}
