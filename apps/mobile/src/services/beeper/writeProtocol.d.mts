export const protocol: 'openchat.beeper.send.v1';
export const audience: 'beeper.send';
export const destination: 'https://chat.ideaflow.app';
export function deny(): never;
export function ownerId(v: unknown): v is string;
export function exact(v: unknown, names: string[]): boolean;
export type Offer = {
  protocol: typeof protocol;
  connectionId: string;
  ownerUserId: string;
  machineKey: string;
  deviceKey: string;
  accountKey: string;
  chatKey: string;
  writeGrantId: string;
  expiresAt: string;
  destination: typeof destination;
  relayTokenHash: string;
  relayBinding: string;
};
export type Display = { title: string; chatType: 'direct' | 'group'; network: 'whatsapp' };
export function publicTuple(o: Offer): string[];
export function validOffer(o: unknown): o is Offer;
export function validText(t: unknown): t is string;
export function validDisplay(d: unknown): d is Display;
export function pinBody(o: Offer, pairRoute: string): string[];
type Pins = { machineKey: string; deviceKey: string };
type Kind = 'intent' | 'receipt' | 'grant';
export function writeBox(
  pins: Pins,
  kind: Kind,
  body: unknown,
  secret: string,
  random: (count: number) => Uint8Array,
): string;
export function openWriteBox(pins: Pins, kind: Kind, frame: string, secret: string): unknown;

export function openLocalWriteIntent(pins: Pins, frame: string, deviceSecret: string): unknown;
