/**
 * agentSetupBlob — the tool-less REST onboarding blob (openchat-bbr / openchat-2t7).
 * Self-contained prose you can paste into any agent that can make HTTPS
 * requests (Claude Code, Cursor, Codex, ChatGPT with Code Interpreter/Actions,
 * etc.). For PLAIN chat-only ChatGPT — which can't call APIs on its own — the
 * blob also explains the one-time Custom GPT Action path using our OpenAPI spec.
 * No MCP server, no shell, no file writes, no external guide required.
 *
 * Keep this identical to the web client's copy at
 * apps/web/src/utils/agentSetupBlob.ts.
 */
export function buildAgentSetupBlob(key: string, baseUrl: string): string {
  return `You can read and send messages on my OpenChat account by calling its REST API directly. Works in any agent that can make HTTPS requests (Claude Code, Cursor, Codex, or ChatGPT with a Custom GPT / Code Interpreter).

Base URL: ${baseUrl}
Auth (send on EVERY request): Authorization: Bearer ${key}

What you can do:
• List my conversations (start here):
    GET /api/chat/conversations
• Read a conversation's messages:
    GET /api/chat/conversations/{conversationId}/messages
• Send a message — you appear AS me, not as a separate bot:
    POST /api/chat/conversations/{conversationId}/messages
    JSON body: {"content": "your message text"}
• Poll only new messages since a timestamp:
    GET /api/chat/messages/since?since=2026-01-01T00:00:00Z
• Publish an ask or offer (publishing opts it into anonymous discovery):
    POST /api/intents
    JSON body: {"kind":"ask" or "offer", "terms":"anonymous public terms", "details":"optional private context"}
• List my asks and offers, including private details and status:
    GET /api/intents
• Withdraw one of my asks or offers from discovery:
    PATCH /api/intents/{intentId}
    JSON body: {"status":"withdrawn"}
• List quiet matches (only anonymous terms and kind are shown until both sides approve):
    GET /api/matches
• Approve or decline a match (mutual approval creates or reuses a normal DM; no opener is sent):
    POST /api/matches/{matchId}/respond
    JSON body: {"decision":"approve" or "decline"}

Copy-paste example (send a message):
    curl -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
      -d '{"content":"Hello from my agent"}' \\
      ${baseUrl}/api/chat/conversations/CONVERSATION_ID/messages

If you're plain ChatGPT (no tools) and can't make HTTP requests yourself:
create a Custom GPT → Configure → Create new Action → "Import from URL"
${baseUrl}/api/openapi.json → set Authentication = API Key, Auth Type = Bearer,
and paste the key above. After that you can do everything listed here from chat.

Treat the key as a secret — don't print it back or commit it anywhere.
To begin: call GET /api/chat/conversations, show me the list, and ask which conversation I want you to use.`;
}
