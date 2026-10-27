export type MessageBoundary = { conversationId: string; messageId: string };

export const messageOriginMatch = `OPTIONAL MATCH (turnOrigin:Message {id:$originMessageId,conversationId:$originConversationId,senderId:$userId})
  WHERE turnOrigin.deletedAt IS NULL`;
export const messageAtOrBeforeOrigin = `(m.id = turnOrigin.id OR m.createdAt < turnOrigin.createdAt)`;
export const messageBoundaryFilter = `($originMessageId IS NULL OR m.conversationId <> $originConversationId
  OR ${messageAtOrBeforeOrigin})`;
export function messageBoundaryParams(boundary?: MessageBoundary) {
  return {originMessageId:boundary?.messageId ?? null,originConversationId:boundary?.conversationId ?? null};
}
