export interface MessageCapture {
  id: string; threadId: string; threadTitle: string; channel: string; text: string;
  sourceMessageId: string; sourceAt: string; capturedAt: string; createdAt: string;
  triggerText: string; captureMethod: string; destination: 'stream'|'contact'|'note';
  tags: string[]; pinned: boolean; visibility: 'private';
  contactLabel?: string;
}
export interface CaptureThread { id: string; title: string; channel: string; count: number; lastSavedAt: string; participants: string[]; contactDetails?:{label:string;value:string}[] }
export interface CapturePage { items: MessageCapture[]; nextCursor?: string }
