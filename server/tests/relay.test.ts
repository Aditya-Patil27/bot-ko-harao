import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkRawTx, type ExpectedTx } from '../src/relay.js';

const abi = parseAbi(['function guess(bytes32 clueId, uint8 choice)']);
const CONTRACT = '0x00000000000000000000000000000000000000C0';
const CLUE = `0x${'ab'.repeat(32)}` as Hex;
const guess = (choice: number) => encodeFunctionData({ abi, functionName: 'guess', args: [CLUE, choice] });

const player = privateKeyToAccount(generatePrivateKey());
const expected: ExpectedTx = { from: player.address, to: CONTRACT, chainId: 10143, data: guess(2), maxGas: 74_474n };

const tx = {
  type: 'eip1559',
  chainId: 10143,
  to: CONTRACT,
  data: guess(2),
  value: 0n,
  gas: 74_474n,
  nonce: 3,
  maxFeePerGas: 202_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
} as const;

const reason = async (raw: unknown) => {
  const check = await checkRawTx(raw, expected);
  return check.ok ? 'ok' : check.reason;
};

describe('checkRawTx', () => {
  it('accepts the expected call from the player and reports its nonce', async () => {
    const raw = await player.signTransaction(tx);
    expect(await checkRawTx(raw, expected)).toEqual({ ok: true, serialized: raw, nonce: 3 });
  });

  it('rejects a transaction signed by someone else', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await reason(await other.signTransaction(tx))).toBe('wrong signer');
  });

  it('rejects any call that is not exactly the expected one', async () => {
    const sign = (over: object) => player.signTransaction({ ...tx, ...over });
    expect(await reason(await sign({ to: player.address }))).toBe('wrong target');
    expect(await reason(await sign({ data: guess(1) }))).toBe('wrong call');
    expect(await reason(await sign({ value: 1n }))).toBe('value not allowed');
    expect(await reason(await sign({ gas: 74_475n }))).toBe('gas limit too high');
    expect(await reason(await sign({ chainId: 1 }))).toBe('wrong chain');
  });

  it('rejects other transaction types', async () => {
    const legacy = await player.signTransaction({
      type: 'legacy',
      chainId: 10143,
      to: CONTRACT,
      data: guess(2),
      gas: 74_474n,
      nonce: 3,
      gasPrice: 102_000_000_000n,
    });
    expect(await reason(legacy)).toBe('bad tx type');
  });

  it('rejects anything that is not a signed transaction', async () => {
    expect(await reason(undefined)).toBe('bad tx');
    expect(await reason({ raw: '0x02' })).toBe('bad tx');
    expect(await reason('not hex')).toBe('bad tx');
    expect(await reason('0x02c0')).not.toBe('ok');
    expect(await reason(`0x02${'00'.repeat(2000)}`)).toBe('bad tx');
  });
});
