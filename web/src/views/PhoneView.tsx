import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type SubmitEvent, type ReactNode, type RefObject } from 'react';
import { encodeFunctionData, formatEther, isAddress, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  CircleNotch,
  HandTap,
  Lightning,
  PencilSimple,
  Television,
  UsersThree,
  Wallet,
  WifiSlash,
  type Icon,
} from '@phosphor-icons/react';
import { useWs } from '../hooks/useWs';
import { TimerBar, useCountdown } from '../components/Timer';
import { BotTile, botOf } from '../components/Bot';

type Phase = 'LOBBY' | 'WRITE' | 'GUESS' | 'REVEAL';

interface Deal {
  round: number;
  group: number;
  options: string[];
  mine: number;
  commit: Hex;
}

// Sent by the server on join when the game is on chain. `nonce` moves as this phone transacts.
interface ChainConfig {
  id: number;
  contract: Hex;
  gas: { postClue: string; guess: string; withdraw?: string; send?: string };
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  nonce: number;
}

const GAME_ABI = parseAbi([
  'function postClue(uint32 round, uint16 group, bytes32 commit, string text)',
  'function guess(bytes32 clueId, uint8 choice)',
  'function withdraw()',
]);

interface Slot {
  round: number;
  slot: number;
  slots: number;
  clueId?: string;
  text?: string;
  options?: string[];
}

interface Result {
  payouts?: { label: string; amount: string }[];
  balance?: string;
  // Explorer page of the transaction that paid this round out.
  txUrl?: string;
}

const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
const MAX_CHARS = 40;
const MAX_WORDS = 6;
const KEY_SLOT = 'bkh:key';
const NAME_SLOT = 'bkh:name';
// MON this burner has withdrawn from the game but not yet sent on to the player's wallet, in wei.
const OWED_SLOT = 'bkh:owed';
const PAYTO_SLOT = 'bkh:payto';

const STEPS: { title: string; body: string }[] = [
  { title: 'Write a clue', body: 'You get a secret word. Hint at it without saying it.' },
  { title: 'Guess fast', body: "Pick the word behind other people's clues." },
  { title: 'Beat the bots', body: 'Two AIs guess the same clues. Fool them and you win.' },
];

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the burner lives for this tab only.
  }
}

// Burner wallet: created in the browser, never leaves it. The address is the player ID.
function burner(): PrivateKeyAccount {
  let key = load(KEY_SLOT);
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    key = generatePrivateKey();
    save(KEY_SLOT, key);
  }
  return privateKeyToAccount(key as Hex);
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function readChain(raw: any): ChainConfig | null {
  if (!raw || typeof raw.contract !== 'string' || typeof raw.nonce !== 'number' || !raw.gas) return null;
  return raw as ChainConfig;
}

// A zero-value call to the game contract, signed here. The server only relays it.
function signCall(account: PrivateKeyAccount, chain: ChainConfig, gas: string, data: Hex) {
  return account.signTransaction({
    type: 'eip1559',
    chainId: chain.id,
    to: chain.contract,
    data,
    value: 0n,
    gas: BigInt(gas),
    nonce: chain.nonce,
    maxFeePerGas: BigInt(chain.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(chain.maxPriorityFeePerGas),
  });
}

// Posts a move with its signed transaction. A 502 means the transaction did not
// land and carries the nonce to use: sign once more, then send the move unsigned
// so it still counts for the round, without a payout.
async function postMove(
  path: string,
  body: object,
  chain: ChainConfig | null,
  sign: ((chain: ChainConfig) => Promise<Hex>) | null,
) {
  for (let attempt = 0; chain && sign && attempt < 2; attempt++) {
    let rawTx: Hex;
    try {
      rawTx = await sign(chain);
    } catch {
      break;
    }
    const res = await postJson(path, { ...body, rawTx });
    if (typeof res.data.nonce === 'number') chain.nonce = res.data.nonce;
    if (res.status !== 502) return res;
  }
  return postJson(path, body);
}

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function joinError(error?: string) {
  if (error === 'invalid name') return 'Use letters, numbers, spaces, - or _. Max 16.';
  if (error === 'room is full') return 'The room is full. Watch the big screen and jump in next time.';
  return 'Could not join. Check your connection and try again.';
}

function clueError(reason?: string) {
  if (!reason || reason === 'empty') return 'Write something first.';
  if (reason.startsWith('too long')) return `Keep it under ${MAX_CHARS} characters.`;
  if (reason.startsWith('too many words')) return `${MAX_WORDS} words max.`;
  const opt = reason.match(/^contains option "(.+)"$/);
  if (opt) return `“${opt[1]}” is one of the four words. Describe it another way.`;
  if (reason === 'banned word') return "That word isn't allowed. Try another clue.";
  if (reason === 'not in write phase') return 'Time is up for this round.';
  if (reason === 'already submitted') return 'Your clue for this round is already in.';
  return 'Could not send your clue. Try again.';
}

export function PhoneView() {
  const [account] = useState(burner);
  const address = account.address;
  const chainRef = useRef<ChainConfig | null>(null);
  const [name, setName] = useState(() => load(NAME_SLOT) ?? '');
  const [playerId, setPlayerId] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState('');

  const [phase, setPhase] = useState<Phase>('LOBBY');
  const [round, setRound] = useState(0);
  const [endsAt, setEndsAt] = useState(0);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [clue, setClue] = useState('');
  const [clueErr, setClueErr] = useState('');
  const [sending, setSending] = useState(false);
  const [lockedClue, setLockedClue] = useState('');

  const [slot, setSlot] = useState<Slot | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [guessErr, setGuessErr] = useState('');
  const [stat, setStat] = useState<{ ms: number; block: number } | null>(null);

  const [result, setResult] = useState<Result | null>(null);

  const { secs, frac } = useCountdown(endsAt);

  const onMessage = useCallback((type: string, data: any) => {
    switch (type) {
      case 'phase':
        setPhase(data.name);
        setRound(data.round);
        setEndsAt(data.endsAt);
        if (data.name === 'WRITE') {
          setLockedClue('');
          setClue('');
          setClueErr('');
          setResult(null);
        }
        break;
      case 'deal':
        setDeal({ round: data.round, group: data.group, options: data.options, mine: data.mine, commit: data.commit });
        break;
      case 'slot':
        setSlot(data);
        setEndsAt(data.endsAt);
        setPick(null);
        setGuessErr('');
        break;
      case 'result':
        setResult(data);
        break;
    }
  }, []);

  const { connected, send } = useWs('phone', onMessage);

  // Tell the server which socket is ours, again after every reconnect.
  useEffect(() => {
    if (connected && playerId) send('identify', { playerId });
  }, [connected, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up the current phase after a reload or reconnect.
  useEffect(() => {
    if (!connected) return;
    fetch('/state')
      .then((r) => r.json())
      .then((s) => {
        setPhase(s.phase);
        setRound(s.round);
        setEndsAt(s.endsAt);
      })
      .catch(() => {});
  }, [connected]);

  const join = useCallback(
    async (wanted: string) => {
      setJoining(true);
      setJoinErr('');
      try {
        const { ok, status, data } = await postJson('/join', { name: wanted, address });
        if (ok || (status === 409 && data.playerId)) {
          const finalName = data.name ?? wanted;
          setName(finalName);
          save(NAME_SLOT, finalName);
          chainRef.current = readChain(data.chain);
          setPlayerId(data.playerId);
        } else {
          setJoinErr(joinError(data.error));
        }
      } catch {
        setJoinErr(joinError());
      } finally {
        setJoining(false);
      }
    },
    [address],
  );

  // Same phone, same burner: rejoin silently after a reload.
  useEffect(() => {
    const saved = load(NAME_SLOT);
    if (connected && !playerId && saved && NAME_RE.test(saved)) join(saved);
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  function onJoin(e: SubmitEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) {
      setJoinErr(joinError('invalid name'));
      return;
    }
    join(trimmed);
  }

  async function onClue(e: SubmitEvent) {
    e.preventDefault();
    const text = clue.trim();
    if (!text) return setClueErr(clueError('empty'));
    if (countWords(text) > MAX_WORDS) return setClueErr(clueError('too many words'));
    setSending(true);
    setClueErr('');
    try {
      const sign =
        deal && deal.commit
          ? (chain: ChainConfig) =>
              signCall(
                account,
                chain,
                chain.gas.postClue,
                encodeFunctionData({
                  abi: GAME_ABI,
                  functionName: 'postClue',
                  args: [deal.round, deal.group, deal.commit, text],
                }),
              )
          : null;
      const { ok, data } = await postMove('/clue/submit', { playerId, text }, chainRef.current, sign);
      if (ok) setLockedClue(text);
      else setClueErr(clueError(data.error));
    } catch {
      setClueErr(clueError());
    } finally {
      setSending(false);
    }
  }

  async function onGuess(choice: number) {
    if (pick !== null || !slot?.clueId) return;
    setPick(choice);
    setGuessErr('');
    navigator.vibrate?.(12);
    const clueId = slot.clueId as Hex;
    const sign = (chain: ChainConfig) =>
      signCall(
        account,
        chain,
        chain.gas.guess,
        encodeFunctionData({ abi: GAME_ABI, functionName: 'guess', args: [clueId, choice] }),
      );
    try {
      const { ok, status, data } = await postMove('/guess', { playerId, clueId, choice }, chainRef.current, sign);
      if (!ok && status !== 409) {
        setPick(null);
        setGuessErr(data.error === 'not in guess phase' ? 'Too late for this one.' : "That didn't land. Tap again.");
        return;
      }
      if (typeof data.ms === 'number' && typeof data.block === 'number') setStat({ ms: data.ms, block: data.block });
    } catch {
      setPick(null);
      setGuessErr("That didn't land. Tap again.");
    }
  }

  const timed = playerId && phase !== 'LOBBY' && endsAt > 0;
  const cash =
    result?.balance && result.balance !== '0' ? (
      <CashOut account={account} playerId={playerId} chainRef={chainRef} />
    ) : null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[max(env(safe-area-inset-top),8px)] pb-[max(env(safe-area-inset-bottom),16px)]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3">
        <span className="display text-2xl leading-none uppercase">
          Bot ko <span className="cap-box inline-block rounded-md bg-ink px-[0.3em] text-sun [--pad:0.22em]">Harao</span>
        </span>
        <span className="flex items-center gap-2 text-sm font-bold">
          {!connected && playerId && (
            <span className="flex items-center gap-1.5 rounded-full border-2 border-ink bg-sun px-2.5 py-1" role="status">
              <WifiSlash size={16} weight="bold" aria-hidden />
              Reconnecting
            </span>
          )}
          {playerId && round > 0 && (
            <span className="rounded-full bg-ink px-3 py-1.5 font-mono text-xs leading-none text-paper uppercase">
              Round {round}
            </span>
          )}
        </span>
      </header>

      {timed && (
        <div className="flex shrink-0 items-center gap-3">
          <TimerBar frac={frac} urgent={secs <= 5} className="h-4 min-w-0 flex-1" />
          <span
            className={`grid h-9 min-w-11 place-items-center rounded-lg border-[3px] border-ink px-1 font-mono text-lg leading-none font-bold tabular-nums ${
              secs <= 5 ? 'bg-chhota' : 'bg-card'
            }`}
          >
            {secs}
          </span>
        </div>
      )}

      <main className="flex flex-1 flex-col pt-5">
        {!playerId ? (
          <form onSubmit={onJoin} noValidate className="flex flex-1 flex-col">
            <div className="flex flex-1 flex-col justify-center pb-8">
              <div className="relative">
                <p lang="hi" className="display text-[clamp(4rem,21vw,5.75rem)] leading-[1.12]">
                  <span className="block">बॉट को</span>
                  <span className="inline-block -rotate-2 rounded-2xl bg-ink px-[0.14em] pt-[0.48em] pb-[0.05em] leading-[0.7] text-sun">
                    हराओ
                  </span>
                </p>
                <span className="absolute top-1 right-0 flex flex-col items-end gap-2" aria-hidden>
                  <BotTile bot="Chhota" className="size-16 rotate-6 shadow-hard-sm" />
                  <BotTile bot="Bada" className="mr-7 size-20 -rotate-3 shadow-hard-sm" />
                </span>
              </div>
              <h1 className="display mt-4 text-4xl leading-none uppercase">Beat the bot.</h1>
              <p className="mt-3 text-lg leading-snug text-ink-dim">
                The whole room plays against two AIs. Write clues your friends get and the bots miss.
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-bold tracking-wider uppercase">
                Your name
              </label>
              <input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={16}
                autoComplete="nickname"
                autoCapitalize="words"
                enterKeyHint="go"
                placeholder="e.g. Priya"
                aria-invalid={!!joinErr}
                aria-describedby="name-note"
                className={FIELD}
              />
              <p
                id="name-note"
                role={joinErr ? 'alert' : undefined}
                className={`min-h-5 text-sm ${joinErr ? 'font-bold text-danger' : 'text-ink-dim'}`}
              >
                {joinErr || 'Shown on the big screen.'}
              </p>
              <PrimaryButton type="submit" busy={joining} disabled={!connected || !name.trim()}>
                {connected ? 'Join the room' : 'Connecting…'}
              </PrimaryButton>
            </div>
          </form>
        ) : phase === 'WRITE' ? (
          deal && deal.round === round ? (
            <section className="flex flex-1 flex-col">
              <Eyebrow>Your word</Eyebrow>
              <div className="mt-3 -rotate-1 animate-rise rounded-3xl border-[3px] border-ink bg-sun px-5 pt-6 pb-1 shadow-hard">
                <p className="display text-6xl leading-none break-words uppercase">{deal.options[deal.mine]}</p>
              </div>
              <p className="mt-6 text-sm font-bold tracking-wider uppercase">Not these</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {deal.options
                  .filter((_, i) => i !== deal.mine)
                  .map((o) => (
                    <li
                      key={o}
                      className="rounded-full border-2 border-dashed border-ink/50 px-3 pt-1.5 pb-1 text-base leading-tight font-bold text-ink-dim"
                    >
                      {o}
                    </li>
                  ))}
              </ul>

              {lockedClue ? (
                <div className="mt-auto pt-8">
                  <div role="status" className="animate-stamp rounded-3xl border-[3px] border-ink bg-win p-5 shadow-hard">
                    <p className="flex items-center gap-2 text-xl leading-tight font-extrabold">
                      <CheckCircle size={28} weight="fill" aria-hidden />
                      Clue locked
                    </p>
                    <p className="mt-2 text-2xl leading-tight font-bold break-words">&ldquo;{lockedClue}&rdquo;</p>
                    <p className="mt-2 text-base leading-snug">Guessing starts when the timer runs out.</p>
                  </div>
                </div>
              ) : (
                <ClueForm
                  value={clue}
                  onChange={(v) => {
                    setClue(v);
                    if (clueErr) setClueErr('');
                  }}
                  onSubmit={onClue}
                  error={clueErr}
                  busy={sending}
                />
              )}
            </section>
          ) : (
            <Waiting
              icon={PencilSimple}
              title="Dealing your cards"
              body="Just joined? You're in from the next round."
            />
          )
        ) : phase === 'GUESS' ? (
          slot && slot.round === round ? (
            slot.clueId && slot.options ? (
              <section key={slot.slot} className="flex flex-1 flex-col">
                <div className="flex items-center justify-between">
                  <Eyebrow>
                    Clue {slot.slot + 1} of {slot.slots}
                  </Eyebrow>
                  <SlotDots current={slot.slot} total={slot.slots} />
                </div>
                <p className="mt-5 text-base font-bold text-ink-dim">Which word is this?</p>
                <blockquote className="mt-2 animate-rise rounded-3xl rounded-bl-md border-[3px] border-ink bg-card p-5 text-3xl leading-tight font-extrabold break-words shadow-hard">
                  &ldquo;{slot.text}&rdquo;
                </blockquote>
                <div role="group" aria-label="Pick a word" className="mt-auto grid gap-3.5 pt-8 pb-[5px]">
                  {slot.options.map((opt, i) => {
                    const chosen = pick === i;
                    const locked = pick !== null;
                    return (
                      <button
                        key={opt}
                        type="button"
                        data-key={'ABCD'[i]}
                        onClick={() => onGuess(i)}
                        disabled={locked}
                        aria-pressed={chosen}
                        className={`flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl border-[3px] border-ink px-3 text-left text-xl font-extrabold transition-[translate,box-shadow,background-color,opacity] duration-100 before:grid before:size-9 before:shrink-0 before:place-items-center before:rounded-lg before:border-2 before:border-current before:font-mono before:text-base before:content-[attr(data-key)] disabled:cursor-default ${
                          chosen
                            ? 'translate-y-[5px] bg-ink text-sun'
                            : locked
                              ? 'translate-y-[5px] bg-card text-ink-dim opacity-45'
                              : 'bg-card text-ink shadow-key active:translate-y-[5px] active:shadow-none'
                        }`}
                      >
                        <span className="text-mid min-w-0 flex-1 truncate">{opt}</span>
                        {chosen && <Check size={26} weight="bold" className="shrink-0 animate-pop" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
                <p
                  aria-live="polite"
                  className={`mt-3 min-h-6 text-center text-base font-bold ${guessErr ? 'text-danger' : 'text-ink-dim'}`}
                >
                  {guessErr || (pick !== null ? 'Locked in. Next clue soon.' : '')}
                </p>
              </section>
            ) : (
              <Waiting
                icon={UsersThree}
                title="Sit this one out"
                body="These clues are from your word group. Your next one is coming."
              />
            )
          ) : (
            <Waiting icon={HandTap} title="Get ready to guess" body="Your first clue is on its way." />
          )
        ) : phase === 'REVEAL' ? (
          result ? (
            <ResultCard round={round} result={result}>
              {cash}
            </ResultCard>
          ) : (
            <Waiting icon={Television} title="Eyes on the big screen" body="See which clues beat the bots." />
          )
        ) : result ? (
          // Back in the lobby: the result stays until the next round starts.
          <ResultCard round={round} result={result} next>
            {cash}
          </ResultCard>
        ) : (
          <Lobby name={name} round={round} />
        )}
      </main>

      {stat && (
        <footer className="mx-auto mt-4 flex shrink-0 items-center gap-2 rounded-full bg-ink px-3.5 py-2 font-mono text-xs leading-none font-bold text-paper">
          <Lightning size={14} weight="fill" className="text-chain" aria-hidden />
          {stat.ms.toLocaleString('en-US')} ms · block {stat.block.toLocaleString('en-US')}
        </footer>
      )}
    </div>
  );
}

const FIELD =
  'h-14 w-full rounded-2xl border-[3px] border-ink bg-card px-4 pt-1 text-lg font-bold text-ink transition-[translate,box-shadow] duration-150 placeholder:font-medium placeholder:text-ink-dim focus:-translate-y-0.5 focus:shadow-hard';

function ClueForm({
  value,
  onChange,
  onSubmit,
  error,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: SubmitEvent) => void;
  error: string;
  busy: boolean;
}) {
  const words = countWords(value);
  const over = words > MAX_WORDS;
  return (
    <form onSubmit={onSubmit} noValidate className="mt-auto space-y-2 pt-8">
      <div className="flex items-baseline justify-between">
        <label htmlFor="clue" className="text-sm font-bold tracking-wider uppercase">
          Your clue
        </label>
        <span className={`font-mono text-sm tabular-nums ${over ? 'font-bold text-danger' : 'text-ink-dim'}`}>
          {value.length}/{MAX_CHARS} · {words}/{MAX_WORDS} words
        </span>
      </div>
      <input
        id="clue"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_CHARS}
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="send"
        placeholder="Hint at it, don't say it"
        aria-invalid={!!error}
        aria-describedby="clue-note"
        className={FIELD}
      />
      <p
        id="clue-note"
        role={error ? 'alert' : undefined}
        className={`min-h-5 text-sm ${error ? 'font-bold text-danger' : 'text-ink-dim'}`}
      >
        {error || "Don't use any of the four words."}
      </p>
      <PrimaryButton type="submit" busy={busy} disabled={!value.trim() || over}>
        Lock my clue
      </PrimaryButton>
    </form>
  );
}

function Lobby({ name, round }: { name: string; round: number }) {
  return (
    <section className="flex flex-1 flex-col">
      <div className="flex animate-stamp items-center gap-3 rounded-3xl border-[3px] border-ink bg-win p-4 shadow-hard">
        <CheckCircle size={38} weight="fill" className="shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-2xl leading-tight font-extrabold">You're in, {name}</p>
          <p className="text-base leading-snug">
            {round > 0 ? `Round ${round} is done. Next one soon.` : 'Your name is on the big screen.'}
          </p>
        </div>
      </div>

      <h2 className="mt-8 text-sm font-bold tracking-wider uppercase">How it works</h2>
      <ol className="mt-3 divide-y-[3px] divide-ink rounded-3xl border-[3px] border-ink bg-card">
        {STEPS.map(({ title, body }, i) => (
          <li key={title} className="flex items-start gap-4 p-4">
            <span className="display cap-mid grid size-11 shrink-0 place-items-center rounded-full bg-ink text-2xl leading-none text-sun">
              {i + 1}
            </span>
            <div>
              <p className="text-xl leading-tight font-extrabold">{title}</p>
              <p className="mt-0.5 text-base leading-snug text-ink-dim">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-auto flex items-center justify-center gap-2 pt-8 text-base font-bold">
        Waiting for the host to start
        <ThinkingDots />
      </p>
    </section>
  );
}

function ResultCard({
  round,
  result,
  next = false,
  children,
}: {
  round: number;
  result: Result;
  next?: boolean;
  children?: ReactNode;
}) {
  const payouts = result.payouts ?? [];
  return (
    <section className="flex flex-1 flex-col">
      <Eyebrow>Round {round} results</Eyebrow>
      {payouts.length > 0 ? (
        <ul className="mt-4 space-y-2.5">
          {payouts.map((p, i) => {
            const bot = botOf(p.label);
            return (
              <li
                key={i}
                className="flex animate-rise items-center gap-3 rounded-2xl border-[3px] border-ink bg-card py-2.5 pr-4 pl-2.5"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                {bot ? (
                  <BotTile bot={bot} mood="beaten" className="size-10" />
                ) : (
                  <span className="grid size-10 shrink-0 place-items-center rounded-[24%] border-[3px] border-ink bg-sun">
                    <Check size={20} weight="bold" aria-hidden />
                  </span>
                )}
                <span className="text-mid min-w-0 flex-1 text-lg leading-tight font-bold">{p.label}</span>
                <span className="font-mono text-lg font-bold text-win-ink tabular-nums">+{p.amount}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="display mt-4 text-5xl leading-none uppercase">The bots held on this time.</p>
      )}
      <div className="mt-auto space-y-5 pt-8">
        {result.balance && (
          <div className="rounded-3xl border-[3px] border-ink bg-win p-5 shadow-hard">
            <p className="text-base font-bold">Your winnings</p>
            <p className="font-mono text-4xl font-bold tabular-nums">{result.balance} MON</p>
          </div>
        )}
        {result.txUrl?.startsWith('https://') && (
          <a
            href={result.txUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1.5 py-1 text-base font-bold underline underline-offset-4"
          >
            See the transaction
            <ArrowSquareOut size={18} weight="bold" aria-hidden />
          </a>
        )}
        {children}
        {next && (
          <p className="flex items-center justify-center gap-2 text-base font-bold">
            Waiting for the next round
            <ThinkingDots />
          </p>
        )}
      </div>
    </section>
  );
}

function toWei(raw: unknown): bigint {
  return typeof raw === 'string' && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
}

function cashError(reason?: unknown) {
  if (reason === 'bad address') return 'That is not a wallet address. Copy it again from your wallet.';
  if (reason === 'nothing') return 'Nothing to cash out yet. Win a round first.';
  if (reason === 'round running') return 'Wait for this round to finish.';
  if (reason === 'already cashing out') return 'Already sending. Give it a moment.';
  if (reason === 'not sent') return 'Your MON left the game but did not reach your wallet. Tap again to send it.';
  return 'Could not cash out. Try again.';
}

// FIELD for a 42-character address: monospace, and 16px so an iPhone does not zoom the page when the field is tapped.
const ADDRESS_FIELD =
  'h-14 w-full rounded-2xl border-[3px] border-ink bg-card px-3 font-mono text-base font-bold text-ink transition-[translate,box-shadow] duration-150 placeholder:font-medium placeholder:text-ink-dim focus:-translate-y-0.5 focus:shadow-hard';

// Winnings are held by the contract under this phone's burner. Cashing out is two
// transactions signed here: withdraw() on the contract, then a transfer to the
// wallet the player pastes. The server only relays them.
function CashOut({
  account,
  playerId,
  chainRef,
}: {
  account: PrivateKeyAccount;
  playerId: string;
  chainRef: RefObject<ChainConfig | null>;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(() => load(PAYTO_SLOT) ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ amount: string; to: string; url?: string } | null>(null);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const dest = to.trim();
    if (!isAddress(dest, { strict: false })) return setErr(cashError('bad address'));
    setBusy(true);
    setErr('');
    try {
      const quote = await postJson('/cashout/quote', { playerId });
      const chain = readChain(quote.data.chain);
      if (!quote.ok || !chain || !chain.gas.withdraw || !chain.gas.send) return setErr(cashError(quote.data.error));
      if (dest.toLowerCase() === chain.contract.toLowerCase()) return setErr(cashError('bad address'));
      const held = toWei(quote.data.held);
      const total = held + toWei(load(OWED_SLOT));
      if (total === 0n) return setErr(cashError('nothing'));
      save(PAYTO_SLOT, dest);

      let nonce = chain.nonce;
      const withdrawTx =
        held > 0n
          ? await signCall(
              account,
              { ...chain, nonce: nonce++ },
              chain.gas.withdraw,
              encodeFunctionData({ abi: GAME_ABI, functionName: 'withdraw' }),
            )
          : undefined;
      const sendTx = await account.signTransaction({
        type: 'eip1559',
        chainId: chain.id,
        to: dest,
        value: total,
        gas: BigInt(chain.gas.send),
        nonce,
        maxFeePerGas: BigInt(chain.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(chain.maxPriorityFeePerGas),
      });
      const { ok, data } = await postJson('/cashout', { playerId, withdrawTx, sendTx });
      if (chainRef.current && typeof data.nonce === 'number') chainRef.current.nonce = data.nonce;
      if (!ok) return setErr(cashError(data.error));
      if (data.sent) {
        save(OWED_SLOT, '0');
        setDone({ amount: formatEther(total), to: dest, url: typeof data.txUrl === 'string' ? data.txUrl : undefined });
        setOpen(false);
      } else {
        // Out of the contract but not in their wallet yet: the next tap sends it.
        if (data.withdrawn) save(OWED_SLOT, total.toString());
        setErr(cashError('not sent'));
      }
    } catch {
      setErr(cashError());
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="animate-rise rounded-3xl border-[3px] border-ink bg-card p-4">
        <p className="flex items-center gap-2 text-lg leading-tight font-extrabold">
          <CheckCircle size={24} weight="fill" aria-hidden />
          Sent {done.amount} MON to your wallet
        </p>
        <p className="mt-1 font-mono text-sm text-ink-dim">
          {done.to.slice(0, 6)}…{done.to.slice(-4)}
        </p>
        {done.url?.startsWith('https://') && (
          <a
            href={done.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center gap-1.5 text-base font-bold underline underline-offset-4"
          >
            See it arrive
            <ArrowSquareOut size={18} weight="bold" aria-hidden />
          </a>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border-[3px] border-ink bg-card text-lg font-extrabold"
      >
        <Wallet size={22} weight="bold" aria-hidden />
        Cash out to my wallet
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-2">
      <label htmlFor="payto" className="block text-sm font-bold tracking-wider uppercase">
        Your wallet address
      </label>
      <input
        id="payto"
        value={to}
        onChange={(e) => {
          setTo(e.target.value);
          if (err) setErr('');
        }}
        maxLength={42}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
        placeholder="0x…"
        aria-invalid={!!err}
        aria-describedby="payto-note"
        className={ADDRESS_FIELD}
      />
      <p
        id="payto-note"
        role={err ? 'alert' : undefined}
        className={`min-h-5 text-sm ${err ? 'font-bold text-danger' : 'text-ink-dim'}`}
      >
        {err || 'Paste it from MetaMask. Your winnings go there on Monad testnet.'}
      </p>
      <PrimaryButton type="submit" busy={busy} disabled={!to.trim()}>
        Send my MON
      </PrimaryButton>
    </form>
  );
}

function Waiting({ icon: WaitIcon, title, body }: { icon: Icon; title: string; body: string }) {
  return (
    <section className="flex flex-1 animate-rise flex-col items-center justify-center pb-12 text-center">
      <span className="grid size-24 -rotate-3 place-items-center rounded-3xl border-[3px] border-ink bg-sun shadow-hard">
        <WaitIcon size={46} weight="bold" aria-hidden />
      </span>
      <p className="display mt-7 text-4xl leading-none uppercase">{title}</p>
      <p className="mt-3 max-w-[28ch] text-lg leading-snug text-ink-dim">{body}</p>
    </section>
  );
}

function SlotDots({ current, total }: { current: number; total: number }) {
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-3 rounded-full border-2 border-ink ${
            i === current ? 'w-7 bg-ink' : i < current ? 'w-3 bg-ink' : 'w-3 bg-card'
          }`}
        />
      ))}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="cap-box w-fit rounded-md bg-ink px-2.5 text-xs font-bold tracking-widest text-paper uppercase [--pad:0.6em]">
      {children}
    </p>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1.5 animate-think rounded-full bg-current" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

// A key you press down: the shadow is the key's depth, and pressing or disabling it removes it.
function PrimaryButton({
  busy,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`display mb-[5px] flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border-[3px] border-ink bg-sun text-2xl leading-none text-ink uppercase shadow-key transition-[translate,box-shadow,background-color] duration-100 active:translate-y-[5px] active:shadow-none disabled:translate-y-[5px] disabled:cursor-not-allowed disabled:bg-sun/40 disabled:text-ink-dim disabled:shadow-none ${className}`}
    >
      {busy && <CircleNotch size={22} weight="bold" className="animate-spin" aria-hidden />}
      <span className="cap-trim">{children}</span>
    </button>
  );
}
