/**
 * agentSetupBlob — the tool-less "ChatGPT / Any LLM" REST onboarding blob
 * (openchat-bbr). Self-contained prose you can paste into any chatbot
 * (ChatGPT, Claude, Gemini, any LLM that can make HTTPS requests). No MCP
 * server, no shell, no file writes, no external guide required — the key is
 * inlined and the REST cheatsheet is included.
 *
 * Keep this identical to the mobile client's copy at
 * openchat-mobile/src/utils/agentSetupBlob.ts.
 */
export function buildAgentSetupBlob(key: string, baseUrl: string): string {
  return `You can now read and send messages on my OpenChat account by calling its REST API directly. No setup or tools to install — just make HTTPS requests with the header below.

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

Copy-paste example (send a message):
    curl -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
      -d '{"content":"Hello from my agent"}' \\
      ${baseUrl}/api/chat/conversations/CONVERSATION_ID/messages

Treat the key as a secret — don't print it back or commit it anywhere.
To begin: call GET /api/chat/conversations, show me the list, and ask which conversation I want you to use.`;
}
