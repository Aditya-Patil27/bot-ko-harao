import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Hex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { config } from './config.js';

const abi = parseAbi([
  'function postClue(uint32 round, uint16 group, bytes32 commit, string text)',
  'function guess(bytes32 clueId, uint8 choice)',
  'function settle((bytes32 clueId, uint8 answer, bytes32 salt, address[] winners)[] items)',
  'function fund(address bot) payable',
  'function dripMany(address[] to, uint256 each) payable',
  'function withdraw()',
  'function balanceOf(address) view returns (uint256)',
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
      gas: 60_077n,
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
    const nonce = await getNonce(operatorWallet.account.address);
    const hash = await operatorWallet.writeContract({
      address: contract,
      abi,
      functionName: 'settle',
      args: [items.map((i) => ({
        clueId: i.clueId,
        answer: i.answer,
        salt: i.salt,
        winners: i.winners,
      }))],
      gas: 200_000n,
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
      gas: BigInt(50_000 + 35_000 * addresses.length),
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

export async function getBotBalance(bot: Address): Promise<bigint> {
  if (!contract) return 0n;
  return publicClient.readContract({
    address: contract,
    abi,
    functionName: 'balanceOf',
    args: [bot],
  }) as Promise<bigint>;
}
