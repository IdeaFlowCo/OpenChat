export const PROTOCOL: string;
export const REQUEST_LIFETIME: number;
export const MAX_FRAME: number;
export const MAX_PROMPT: number;
export const MAX_RESULT: number;
type Random = (size: number) => Uint8Array;
export interface Identity {
  publicKey: string;
  secretKey: string;
}
export interface Grant {
  route: string;
  machine: string;
  device: string;
}
export interface Offer extends Grant {
  token: string;
  until: number;
}
export function hex(bytes: Uint8Array): string;
export function validHex(value: unknown, size: number): boolean;
export function identity(random: Random): Identity;
export function seal(
  grant: Grant,
  direction: 'request' | 'reply',
  secret: string,
  message: unknown,
  random: Random,
): string;
export function open(grant: Grant, direction: 'request' | 'reply', secret: string, frame: unknown): unknown;
export function parseOffer(text: string, device: string, now: number): Offer;
