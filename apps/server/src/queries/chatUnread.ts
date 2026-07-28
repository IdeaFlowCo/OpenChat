const visibleConversationPredicate = `
  WHERE NOT (
    c.type = 'direct'
    AND EXISTS {
      MATCH (other:User)-[:PARTICIPATES_IN]->(c)
      WHERE other.id <> $userId
        AND (other)-[:BLOCKED]->(u)
    }
  )`;

export const CONVERSATIONS_QUERY = `
  MATCH (u:User {id: $userId})-[myRel:PARTICIPATES_IN]->(c:Conversation)
  ${visibleConversationPredicate}
  CALL {
    WITH c
    OPTIONAL MATCH (c)<-[:IN_CONVERSATION]-(m:Message)
    WITH m ORDER BY m.createdAt DESC
    RETURN collect(m)[0] AS lastMessage
  }
  CALL {
    WITH c
    MATCH (participant:User)-[rel:PARTICIPATES_IN]->(c)
    RETURN collect({user: participant {.id, .name, .email, .presenceStatus, .statusMessage, .lastSeenAt, .isBot}, role: rel.role}) AS participants
  }
  CALL {
    WITH c
    OPTIONAL MATCH (bot:User)-[:PARTICIPATES_IN]->(c)
    WHERE bot.isBot = true
    RETURN count(bot) > 0 AS containsBot
  }
  CALL {
    WITH c, myRel
    MATCH (m:Message)
    USING INDEX m:Message(conversationId)
    WHERE m.conversationId = c.id
      AND m.createdAt > coalesce(myRel.lastReadAt, datetime({epochMillis: 0}))
      AND m.senderId <> $userId
      AND m.deletedAt IS NULL
    RETURN count(m) AS unreadCount
  }
  RETURN c {
    .*,
    lastMessage: lastMessage { .content, .senderId, .createdAt },
    participants: participants,
    containsBot: containsBot,
    // OpenChat-aes: per-user mute state on the PARTICIPATES_IN edge.
    // Returns ISO timestamp, the literal 'always', or null.
    mutedUntil: myRel.mutedUntil,
    lastReadAt: myRel.lastReadAt,
    unreadCount: unreadCount
  } AS conversation
  ORDER BY c.lastMessageAt DESC
`;

export const UNREAD_TOTAL_QUERY = `
  MATCH (u:User {id: $userId})-[myRel:PARTICIPATES_IN]->(c:Conversation)
  ${visibleConversationPredicate}
  MATCH (m:Message {conversationId: c.id})
  WHERE m.createdAt > coalesce(myRel.lastReadAt, datetime({epochMillis: 0}))
    AND m.senderId <> $userId
    AND m.deletedAt IS NULL
  RETURN count(m) AS unreadTotal
`;
