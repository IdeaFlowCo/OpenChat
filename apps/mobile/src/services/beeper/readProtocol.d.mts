export const protocol: 'openchat.beeper.read.v1';
export const audience: 'beeper.read';
export const imessageProtocol: 'openchat.beeper.imessage.read.v1';
export const imessageAudience: 'beeper.imessage.read';
export type Network = 'whatsapp' | 'imessage';
export function readContract(network?: Network): { protocol: typeof protocol | typeof imessageProtocol; audience: typeof audience | typeof imessageAudience; network?: 'imessage' };
export function selectionNetwork(s: unknown): Network | null;
export const destination: 'https://chat.ideaflow.app';
export type Pins = { machineKey: string; deviceKey: string; network?: Network };
export type Selection = Pins & {
  protocol: typeof protocol | typeof imessageProtocol;
  audience: typeof audience | typeof imessageAudience;
  network?: 'imessage';
  destination: typeof destination;
  ownerId: string;
  pairRoute: string;
  route: string;
  grantId: string;
  accountKey: string;
  chatKey: string;
  expiresAt: number;
};
export function validSelection(v: unknown): v is Selection;
export function sameSelection(a: Selection, b: Selection): boolean;
export function isHex(s: unknown, n: number): s is string;
export function sealReadEnvelope(
  pins: Pins,
  purpose: 'grant' | 'read',
  value: unknown,
  secret: string,
  random: (n: number) => Uint8Array,
): string;
export function openReadEnvelope(
  pins: Pins,
  purpose: 'grant' | 'read',
  wire: string,
  secret: string,
): unknown;
