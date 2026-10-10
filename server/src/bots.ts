import OpenAI from 'openai';
import { config } from './config.js';
import { sendGuess, chhotaWallet, badaWallet } from './chain.js';
import type { SlotData } from './game.js';
import type { Hex } from 'viem';

interface BotConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoning: string;
  timeout: number;
  wallet: typeof chhotaWallet;
}

interface BotAnswer {
  id: string;
  choice: number;
}

const SYSTEM_PROMPT_TPL =
  'You are {name}, playing a party word game against a room of people at a hackathon in Pune, India. Each clue was written by a player to point to exactly one of four options. Pick the option the writer meant. Answer every clue, even if unsure. Reply with JSON only: {"answers":[{"id":"<id>","choice":<0-3>}]}';

function buildUserMessage(slot: SlotData): string {
  return slot.clues
    .map(
      (c) =>
        `${c.clueId} | ${c.text} | ${c.options.map((o, i) => `${i}:${o}`).join(' ')}`
    )
    .join('\n');
}

function parseAnswers(text: string): BotAnswer[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const obj = JSON.parse(match[0]);
    if (Array.isArray(obj.answers)) {
      return obj.answers
        .filter((a: any) => a.id !== undefined && typeof a.choice === 'number')
        .map((a: any) => ({ id: String(a.id), choice: Number(a.choice) }));
    }
  } catch {}
  return [];
}

async function callLLM(
  botCfg: BotConfig,
  slot: SlotData
): Promise<{ answers: BotAnswer[]; thinkMs: number }> {
  const client = new OpenAI({
    baseURL: botCfg.baseUrl,
    apiKey: botCfg.apiKey,
  });

  const systemPrompt = SYSTEM_PROMPT_TPL.replace('{name}', botCfg.name);
  const userMsg = buildUserMessage(slot);
  const start = Date.now();

  try {
    const resp = await Promise.race([
      client.chat.completions.create({
        model: botCfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 2000,
        ...(botCfg.reasoning ? { reasoning_effort: botCfg.reasoning as any } : {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), botCfg.timeout)
      ),
    ]);

    const thinkMs = Date.now() - start;
    const content = resp.choices?.[0]?.message?.content ?? '';
    return { answers: parseAnswers(content), thinkMs };
  } catch (e: any) {
    console.error(`[bot:${botCfg.name}] LLM error: ${e.message}`);
    return { answers: [], thinkMs: Date.now() - start };
  }
}

async function submitGuesses(
  botCfg: BotConfig,
  answers: BotAnswer[]
): Promise<void> {
  for (const a of answers) {
    if (a.choice < 0 || a.choice > 3) continue;
    await sendGuess(botCfg.wallet, a.id as Hex, a.choice);
  }
}

export interface BotResult {
  name: string;
  answers: BotAnswer[];
  thinkMs: number;
}

export async function runBot(
  which: 'chhota' | 'bada',
  slot: SlotData
): Promise<BotResult> {
  const botCfg: BotConfig =
    which === 'chhota'
      ? { ...config.botChhota, wallet: chhotaWallet }
      : { ...config.botBada, wallet: badaWallet };

  const { answers, thinkMs } = await callLLM(botCfg, slot);
  console.log(
    `[bot:${botCfg.name}] ${answers.length}/${slot.clues.length} answers in ${thinkMs}ms`
  );

  await submitGuesses(botCfg, answers);
  return { name: botCfg.name, answers, thinkMs };
}

export async function runBothBots(slot: SlotData): Promise<BotResult[]> {
  return Promise.all([runBot('chhota', slot), runBot('bada', slot)]);
}
