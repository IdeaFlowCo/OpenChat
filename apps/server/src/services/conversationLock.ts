import type { ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { acquireContextAclLocks } from './contextAccess.js';

export async function withConversationLock<T>(conversationId: string, action: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      await acquireContextAclLocks(tx, { conversationId });
      return action(tx);
    });
  } finally { await session.close(); }
}
