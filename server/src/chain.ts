import {
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Hex,
  type Address,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { config } from './config.js';

export const abi = parseAbi([
  'function postClue(uint32 round, uint16 group, bytes32 commit, string text)',
  'function guess(bytes32 clueId, uint8 choice)',
  'function settle((bytes32 clueId, uint8 answer, bytes32 salt, address[] winners)[] items)',
  'function fund(address bot) payable',
  'function dripMany(address[] to, uint256 each) payable',
  'function withdraw()',
  'function balanceOf(address) view returns (uint256)',
  'function clues(bytes32) view returns (address giver, uint32 round, uint16 group, bool settled, bytes32 commit)',
  'function guessOf(bytes32, address) view returns (uint256)',
  'event ClueGiven(bytes32 indexed clueId, address indexed giver, uint32 round, uint16 group, string text)',
  'event Guessed(bytes32 indexed clueId, address indexed player, uint8 choice, uint64 blockNo)',
  'event Settled(bytes32 indexed clueId, uint8 answer, uint8 humansRight, uint8 botsRightMask)',
  'event Paid(bytes32 indexed clueId, address indexed from, address indexed to, uint256 amount, uint8 reason)',
  'event Funded(address indexed from, address indexed bot, uint256 amount)',
]);

const transport = http(config.monadRpcHttp);

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport,
});

function makeWallet(pk: Hex) {
  if (!pk) return null;
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: monadTestnet, transport });
}

export const operatorWallet = makeWallet(config.operatorPk);
export const dripWallet = makeWallet(config.dripPk);
export const chhotaWallet = makeWallet(config.botChhota.pk);
export const badaWallet = makeWallet(config.botBada.pk);

const nonces = new Map<Address, number>();

async function getNonce(addr: Address): Promise<number> {
  let n = nonces.get(addr);
  if (n === undefined) {
    n = await publicClient.getTransactionCount({ address: addr });
    nonces.set(addr, n);
  }
  return n;
}

function bumpNonce(addr: Address): void {
  const n = nonces.get(addr) ?? 0;
  nonces.set(addr, n + 1);
}

export function resetNonce(addr: Address): void {
  nonces.delete(addr);
}

export const contract = config.contractAddress;
// Without a contract address the game runs off chain: same rounds, no payouts.
export const chainEnabled = Boolean(contract);

// Limits come from `forge test --gas-report` under Monad pricing (MonadNine, the
// costlier fork) plus 20%. Monad bills the limit, not the gas used.
const withMargin = (gas: bigint): bigint => (gas * 12n + 9n) / 10n;
const GUESS_GAS = withMargin(62_061n);
// Phones sign their own clue and guess, so they need the limits too.
export const PHONE_GAS = { postClue: withMargin(84_930n), guess: GUESS_GAS };
// dripMany to fresh addresses measures base + perAddress * n.
const DRIP_BASE_GAS = 22_514;
const DRIP_PER_ADDRESS_GAS = 42_656;

export async function sendGuess(
  wallet: ReturnType<typeof makeWallet>,
  clueId: Hex,
  choice: number
): Promise<Hex | null> {
  if (!wallet || !contract) return null;
  try {
    const nonce = await getNonce(wallet.account.address);
    const hash = await wallet.writeContract({
      address: contract,
      abi,
      functionName: 'guess',
      args: [clueId, choice],
      gas: GUESS_GAS,
      nonce,
    });
    bumpNonce(wallet.account.address);
    return hash;
  } catch (e) {
    console.error(`[chain] guess failed:`, e);
    resetNonce(wallet.account.address);
    return null;
  }
}

export async function sendSettle(
  items: Array<{ clueId: Hex; answer: number; salt: Hex; winners: Address[] }>
): Promise<Hex | null> {
  if (!operatorWallet || !contract) return null;
  try {
    const args = [items.map((i) => ({
      clueId: i.clueId,
      answer: i.answer,
      salt: i.salt,
      winners: i.winners,
    }))] as const;
    // Cost depends on winners and payouts per clue, so it is measured per call.
    const estimate = await publicClient.estimateContractGas({
      address: contract,
      abi,
      functionName: 'settle',
      args,
      account: operatorWallet.account,
    });
    const nonce = await getNonce(operatorWallet.account.address);
    const hash = await operatorWallet.writeContract({
      address: contract,
      abi,
      functionName: 'settle',
      args,
      gas: withMargin(estimate),
      nonce,
    });
    bumpNonce(operatorWallet.account.address);
    return hash;
  } catch (e) {
    console.error(`[chain] settle failed:`, e);
    resetNonce(operatorWallet.account.address);
    return null;
  }
}

export async function sendDripMany(
  addresses: Address[],
  eachMon: string
): Promise<Hex | null> {
  if (!dripWallet || !contract) return null;
  const each = parseEther(eachMon);
  const total = each * BigInt(addresses.length);
  try {
    const nonce = await getNonce(dripWallet.account.address);
    const hash = await dripWallet.writeContract({
      address: contract,
      abi,
      functionName: 'dripMany',
      args: [addresses, each],
      value: total,
      gas: withMargin(BigInt(DRIP_BASE_GAS + DRIP_PER_ADDRESS_GAS * addresses.length)),
      nonce,
    });
    bumpNonce(dripWallet.account.address);
    return hash;
  } catch (e) {
    console.error(`[chain] dripMany failed:`, e);
    resetNonce(dripWallet.account.address);
    return null;
  }
}

export interface Landed {
  ok: boolean;
  block: number;
  hash: Hex;
}

const RELAY_TIMEOUT_MS = 8000;
let syncSend = true;

// -32601 method not found, -32004 method not supported.
function methodMissing(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => [-32601, -32004].includes((x as { code?: number }).code ?? 0)) !== null;
}

// Relays a phone-signed transaction and waits for its receipt. Monad answers a
// sync send with the receipt; a node without that method gets send-then-wait.
export async function relayRaw(serialized: Hex): Promise<Landed> {
  let receipt: TransactionReceipt | undefined;
  if (syncSend) {
    try {
      receipt = await publicClient.sendRawTransactionSync({
        serializedTransaction: serialized as `0x02${string}`,
        throwOnReceiptRevert: false,
        timeout: RELAY_TIMEOUT_MS,
      });
    } catch (e) {
      if (!methodMissing(e)) throw e;
      syncSend = false;
    }
  }
  if (!receipt) {
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: serialized });
    receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: RELAY_TIMEOUT_MS });
  }
  return { ok: receipt.status === 'success', block: Number(receipt.blockNumber), hash: receipt.transactionHash };
}

// For the operator and drip wallets, whose sends return a hash straight away.
export async function waitLanded(hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 20_000 });
  } catch (e) {
    console.error(`[chain] no receipt for ${hash}:`, e);
    return null;
  }
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const FEE_TTL_MS = 15_000;
let fees: { at: number; value: Promise<Fees> } | null = null;

// Monad charges base fee plus tip on the gas limit, so a 2x cap on the base fee
// costs nothing extra and survives a busy block.
export function getFees(): Promise<Fees> {
  if (!fees || Date.now() - fees.at > FEE_TTL_MS) {
    const value = Promise.all([publicClient.getBlock(), publicClient.estimateMaxPriorityFeePerGas()]).then(
      ([block, tip]) => ({ maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip, maxPriorityFeePerGas: tip }),
    );
    value.catch(() => {
      fees = null;
    });
    fees = { at: Date.now(), value };
  }
  return fees.value;
}

export function getTxCount(address: Address): Promise<number> {
  return publicClient.getTransactionCount({ address });
}

// After a relay that timed out or errored, the chain says whether it landed anyway.
export async function clueOnChain(clueId: Hex): Promise<boolean> {
  if (!contract) return false;
  try {
    const [giver] = await publicClient.readContract({ address: contract, abi, functionName: 'clues', args: [clueId] });
    return BigInt(giver) !== 0n;
  } catch {
    return false;
  }
}

export async function guessOnChain(clueId: Hex, player: Address): Promise<number | null> {
  if (!contract) return null;
  try {
    const packed = await publicClient.readContract({
      address: contract,
      abi,
      functionName: 'guessOf',
      args: [clueId, player],
    });
    return packed === 0n ? null : Number(packed & 0xffn) - 1;
  } catch {
    return null;
  }
}

export async function getBotBalance(bot: Address): Promise<bigint> {
  if (!contract) return 0n;
  return publicClient.readContract({
    address: contract,
    abi,
    functionName: 'balanceOf',
    args: [bot],
  }) as Promise<bigint>;
}
