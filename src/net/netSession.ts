import type { Element } from '../sim/types';
import type { Session } from './session';

// Placeholder until the P2P transport lands.
export async function createHost(_name: string, _g: [Element, Element], _boons: string[]): Promise<Session> {
  throw new Error('co-op not available yet');
}
export async function joinRoom(_code: string, _name: string, _g: [Element, Element]): Promise<Session> {
  throw new Error('co-op not available yet');
}
