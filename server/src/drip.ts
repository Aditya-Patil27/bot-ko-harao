import { setTimeout as sleep } from 'timers/promises';
import { parseEther, type Address } from 'viem';
import { config } from './config.js';
import { contract, dripWallet, publicClient, sendDripMany, waitLanded } from './chain.js';

const BATCH = 20;
// The drip wallet sits under Monad's 10 MON reserve, so a value transfer only
// succeeds if it sent nothing in the previous 3 blocks. One batch at a time, spaced out.
const GAP_MS = 2000;
const MAX_TRIES = 3;
// A burner already holding half a drip has been paid: a rejoin or a server restart must not pay it twice.
const ENOUGH = parseEther(config.dripMon) / 2n;

const queue: Address[] = [];
const tries = new Map<Address, number>();
let pumping = false;

export function queueDrip(address: Address): void {
  if (!dripWallet || !contract || queue.includes(address)) return;
  queue.push(address);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      await dripBatch(queue.splice(0, BATCH));
      await sleep(GAP_MS);
    }
  } finally {
    pumping = false;
  }
}

function requeue(addresses: Address[]): void {
  for (const a of addresses) {
    const n = (tries.get(a) ?? 0) + 1;
    tries.set(a, n);
    if (n < MAX_TRIES) queue.push(a);
    else console.error(`[drip] giving up on ${a} after ${n} tries; that phone plays off chain`);
  }
}

async function dripBatch(batch: Address[]): Promise<void> {
  let unpaid = batch;
  try {
    const balances = await Promise.all(batch.map((address) => publicClient.getBalance({ address })));
    unpaid = batch.filter((_, i) => balances[i] < ENOUGH);
    if (!unpaid.length) return;
    const hash = await sendDripMany(unpaid, config.dripMon);
    const receipt = hash ? await waitLanded(hash) : null;
    if (receipt?.status === 'success') {
      console.log(`[drip] ${unpaid.length} × ${config.dripMon} MON in block ${receipt.blockNumber}`);
      return;
    }
    console.error(`[drip] batch of ${unpaid.length} did not land, retrying`);
  } catch (e) {
    console.error('[drip] batch failed:', e);
  }
  requeue(unpaid);
}
