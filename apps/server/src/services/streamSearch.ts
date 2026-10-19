/**
 * Stream search + per-viewer display state shared by every Stream read
 * (personal Stream, chat-scoped Stream, and conversation content).
 */

/** Tags are stored without '#', so a "#event" query must still match tag
 * "event" (OpenChat-2pj3). Reply-tag entries carry the parent's text, which
 * usually lacks the hashtag, so the tag list is their only match. */
export function streamTagQuery(q: string): string {
  return q.trim().replace(/^#+/, '');
}

/** Cypher predicate over `t` and a tag-list expression. Params: $q, $tagQ. */
export function streamSearchPredicate(tagsExpr = 'coalesce(t.tags, [])', q = '$q', tagQ = '$tagQ'): string {
  return `(toLower(t.text) CONTAINS toLower(${q}) OR any(tag IN ${tagsExpr} WHERE toLower(tag) CONTAINS toLower(${tagQ})))`;
}

/** Collapse is the viewer's own display preference (OpenChat-q60e), so it is a
 * relationship from the viewer, not a property of the shared Thought. */
export const COLLAPSED_REL = 'COLLAPSED_THOUGHT';
export function readableStreamExpr(thought = 't', viewerParam = '$userId'): string {
  return `((${thought}.lane IS NULL OR ${thought}.lane <> 'context') AND ${thought}.deletedAt IS NULL
    AND (${thought}.userId = ${viewerParam}
      OR EXISTS { MATCH (${thought})-[:PINNED_IN]->(:Conversation)<-[:PARTICIPATES_IN]-(:User {id: ${viewerParam}}) }
      OR (${thought}.captureMethod IN ['inline-tag', 'reply-tag'] AND EXISTS {
        MATCH (${thought})-[:FROM_MESSAGE]->(source:Message)
        MATCH (:User {id: ${viewerParam}})-[:PARTICIPATES_IN]->(:Conversation {id: source.conversationId})
      })))`;
}

export function streamAliasExpr(alias = 'alias'): string {
  return `(${alias} = t OR (${alias}.userId = t.userId AND ${alias}.text = t.text
    AND EXISTS { MATCH (t)-[:FROM_MESSAGE]->(:Message)<-[:FROM_MESSAGE]-(${alias}) }))`;
}

export function collapsedExpr(viewerParam = '$userId'): string {
  return `EXISTS { MATCH (:User {id: ${viewerParam}})-[:${COLLAPSED_REL}]->(alias:Thought)
    WHERE ${streamAliasExpr()} AND ${readableStreamExpr('alias', viewerParam)} }`;
}
