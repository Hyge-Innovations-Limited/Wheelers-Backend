import { createHmac } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Every Wheelers testnet account's keys come from one master secret and the
 * account's number, the way Stellar wallets do it (SEP-0005: SLIP-0010
 * ed25519, path m/44'/148'/index'). So no secret key is ever stored: the
 * database keeps public addresses and numbers, and the key is rebuilt, in
 * memory, only to sign. Number 0 is Wheelers' operations account.
 */

const HARDENED = 0x80000000;

function childKey(seed: Buffer, path: number[]): Buffer {
  let digest = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = digest.subarray(0, 32);
  let chain = digest.subarray(32);
  for (const index of path) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE((index + HARDENED) >>> 0);
    digest = createHmac('sha512', chain).update(Buffer.concat([Buffer.alloc(1, 0), key, counter])).digest();
    key = digest.subarray(0, 32);
    chain = digest.subarray(32);
  }
  return Buffer.from(key);
}

export function keypairAt(masterSeed: Buffer, index: number): Keypair {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new Error('Bad derivation index.');
  return Keypair.fromRawEd25519Seed(childKey(masterSeed, [44, 148, index]));
}

export function publicKeyAt(masterSeed: Buffer, index: number): string {
  return keypairAt(masterSeed, index).publicKey();
}
