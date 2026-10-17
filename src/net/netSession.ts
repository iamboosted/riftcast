import type { Element } from '../sim/types';
import type { Session } from './session';
import { HostSession } from './host';
import { ClientSession } from './client';
import { TrysteroTransport } from './trystero';
import { makeRoomCode } from './protocol';

/** Lazy-loaded entry so solo play never downloads the WebRTC stack. */
export async function createHost(name: string, g: [Element, Element], boons: string[]): Promise<Session> {
  const code = makeRoomCode();
  const t = new TrysteroTransport(code);
  return new HostSession(t, name, g, code, undefined, boons);
}

export async function joinRoom(code: string, name: string, g: [Element, Element]): Promise<Session> {
  const t = new TrysteroTransport(code);
  const s = new ClientSession(t, name, g, code);
  // wait for the host's welcome (signalling can take a few seconds)
  await new Promise<void>((resolve, reject) => {
    const start = performance.now();
    const iv = setInterval(() => {
      if (s.connected) {
        clearInterval(iv);
        resolve();
      } else if (performance.now() - start > 25000) {
        clearInterval(iv);
        t.close();
        reject(new Error('timeout'));
      } else s.sayHello();
    }, 400);
  });
  return s;
}
