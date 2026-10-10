import {
  isAddressEqual,
  isHex,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem';

export interface ExpectedTx {
  from: Address;
  to: Address;
  chainId: number;
  data: Hex;
  maxGas: bigint;
}

export type TxCheck =
  | { ok: true; serialized: Hex; nonce: number }
  | { ok: false; reason: string };

const MAX_RAW_CHARS = 2048;

// The server relays a phone's transaction only if it is exactly the call the
// game expects: signed by that player's burner, to the contract, with no value.
export async function checkRawTx(raw: unknown, expected: ExpectedTx): Promise<TxCheck> {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CHARS || !isHex(raw, { strict: true })) {
    return { ok: false, reason: 'bad tx' };
  }
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    return { ok: false, reason: 'bad tx' };
  }
  if (tx.type !== 'eip1559') return { ok: false, reason: 'bad tx type' };
  if (tx.chainId !== expected.chainId) return { ok: false, reason: 'wrong chain' };
  if (!tx.to || !isAddressEqual(tx.to, expected.to)) return { ok: false, reason: 'wrong target' };
  if ((tx.value ?? 0n) !== 0n) return { ok: false, reason: 'value not allowed' };
  if ((tx.data ?? '0x').toLowerCase() !== expected.data.toLowerCase()) return { ok: false, reason: 'wrong call' };
  if (tx.gas === undefined || tx.gas > expected.maxGas) return { ok: false, reason: 'gas limit too high' };

  let from: Address;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  if (!isAddressEqual(from, expected.from)) return { ok: false, reason: 'wrong signer' };
  return { ok: true, serialized: raw, nonce: tx.nonce ?? 0 };
}

export type SendCheck =
  | { ok: true; serialized: Hex; nonce: number; to: Address; value: bigint }
  | { ok: false; reason: string };

// The second half of a cash-out: the player's own plain transfer of MON, signed by
// their burner, to whatever wallet they chose. No call data, so it cannot touch a contract's logic.
export async function checkSendTx(
  raw: unknown,
  expected: { from: Address; chainId: number; maxGas: bigint },
): Promise<SendCheck> {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CHARS || !isHex(raw, { strict: true })) {
    return { ok: false, reason: 'bad tx' };
  }
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(raw);
  } catch {
    return { ok: false, reason: 'bad tx' };
  }
  if (tx.type !== 'eip1559') return { ok: false, reason: 'bad tx type' };
  if (tx.chainId !== expected.chainId) return { ok: false, reason: 'wrong chain' };
  if (!tx.to) return { ok: false, reason: 'wrong target' };
  if ((tx.data ?? '0x') !== '0x') return { ok: false, reason: 'data not allowed' };
  const value = tx.value ?? 0n;
  if (value <= 0n) return { ok: false, reason: 'no value' };
  if (tx.gas === undefined || tx.gas > expected.maxGas) return { ok: false, reason: 'gas limit too high' };

  let from: Address;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  if (!isAddressEqual(from, expected.from)) return { ok: false, reason: 'wrong signer' };
  return { ok: true, serialized: raw, nonce: tx.nonce ?? 0, to: tx.to, value };
}
