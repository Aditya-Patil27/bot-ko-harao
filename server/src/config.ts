import 'dotenv/config';

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '3001')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3001'),

  monadRpcHttp: env('MONAD_RPC_HTTP', 'http://localhost:8545'),
  monadRpcWss: env('MONAD_RPC_WSS', ''),
  chainId: Number(env('CHAIN_ID', '10143')),
  contractAddress: env('CONTRACT_ADDRESS', '') as `0x${string}`,
  // Where a transaction hash opens in a browser. Empty: the results carry no link.
  explorerTxUrl: env('EXPLORER_TX_URL', 'https://testnet.monadvision.com/tx/'),

  operatorPk: env('OPERATOR_PK', '') as `0x${string}`,
  dripPk: env('DRIP_PK', '') as `0x${string}`,

  botChhota: {
    pk: env('BOT_CHHOTA_PK', '') as `0x${string}`,
    baseUrl: env('BOT_CHHOTA_BASE_URL', 'https://api.groq.com/openai/v1'),
    apiKey: env('BOT_CHHOTA_API_KEY', ''),
    model: env('BOT_CHHOTA_MODEL', 'openai/gpt-oss-20b'),
    reasoning: env('BOT_CHHOTA_REASONING', 'low'),
    timeout: 4000,
    name: 'Chhota',
  },
  botBada: {
    pk: env('BOT_BADA_PK', '') as `0x${string}`,
    baseUrl: env('BOT_BADA_BASE_URL', 'https://api.groq.com/openai/v1'),
    apiKey: env('BOT_BADA_API_KEY', ''),
    model: env('BOT_BADA_MODEL', 'openai/gpt-oss-120b'),
    reasoning: env('BOT_BADA_REASONING', 'low'),
    timeout: 8000,
    name: 'Bada',
  },

  dripMon: env('DRIP_MON', '0.25'),
  payR: env('PAY_R_MON', '0.02'),
  payG: env('PAY_G_MON', '0.05'),

  writeS: Number(env('WRITE_S', '30')),
  slotS: Number(env('SLOT_S', '8')),
  slots: Number(env('SLOTS', '4')),
  revealS: 15,

  demoMode: env('DEMO_MODE', '0') === '1',
  maxPlayers: 80,
};

if (config.demoMode) {
  config.writeS = 25;
  config.slotS = 7;
  config.slots = 3;
}
