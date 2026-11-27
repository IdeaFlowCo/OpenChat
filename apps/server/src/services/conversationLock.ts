import type { ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { acquireContextAclLocks } from './contextAccess.js';

export async function withConversationLock<T>(conversationId: string, action: (tx: ManagedTransaction) => Promise<T>, userIds: string[] = []): Promise<T> {
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      await acquireContextAclLocks(tx, { userIds,conversationId });
      return action(tx);
    });
  } finally { await session.close(); }
}
