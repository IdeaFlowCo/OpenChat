export const protocol: 'openchat.beeper.read.v1';
export const audience: 'beeper.read';
export const destination: 'https://chat.ideaflow.app';
export type Pins = { machineKey: string; deviceKey: string };
export type Selection = Pins & {
  protocol: typeof protocol;
  audience: typeof audience;
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
