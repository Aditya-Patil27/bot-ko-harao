import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type SubmitEvent, type ReactNode } from 'react';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  Check,
  CheckCircle,
  CircleNotch,
  HandTap,
  Lightning,
  PencilSimple,
  Robot,
  Television,
  UsersThree,
  WifiSlash,
  type Icon,
} from '@phosphor-icons/react';
import { useWs } from '../hooks/useWs';
import { TimerBar, useCountdown } from '../components/Timer';

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
  gas: { postClue: string; guess: string };
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  nonce: number;
}

const GAME_ABI = parseAbi([
  'function postClue(uint32 round, uint16 group, bytes32 commit, string text)',
  'function guess(bytes32 clueId, uint8 choice)',
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
}

const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
const MAX_CHARS = 40;
const MAX_WORDS = 6;
const KEY_SLOT = 'bkh:key';
const NAME_SLOT = 'bkh:name';

const STEPS: { icon: Icon; title: string; body: string }[] = [
  { icon: PencilSimple, title: 'Write a clue', body: 'You get a secret word. Hint at it without saying it.' },
  { icon: HandTap, title: 'Guess fast', body: "Pick the word behind other people's clues." },
  { icon: Robot, title: 'Beat the bots', body: 'Two AIs guess the same clues. Beat them and you earn.' },
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

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[max(env(safe-area-inset-top),8px)] pb-[max(env(safe-area-inset-bottom),16px)]">
      <header className="flex h-12 shrink-0 items-center justify-between">
        <span className="text-lg font-extrabold tracking-tight">
          Bot ko <span className="text-brand">Harao</span>
        </span>
        <span className="flex items-center gap-3 text-sm font-bold text-ink-dim">
          {!connected && (
            <span className="flex items-center gap-1.5 text-warn" role="status">
              <WifiSlash size={18} weight="bold" aria-hidden />
              Reconnecting
            </span>
          )}
          {playerId && round > 0 && <span className="font-mono">Round {round}</span>}
        </span>
      </header>

      {timed && (
        <div className="flex shrink-0 items-center gap-3">
          <TimerBar frac={frac} urgent={secs <= 5} className="h-2" />
          <span className={`w-8 text-right font-mono text-base font-bold tabular-nums ${secs <= 5 ? 'text-bot' : ''}`}>
            {secs}
          </span>
        </div>
      )}

      <main className="flex flex-1 flex-col pt-6">
        {!playerId ? (
          <form onSubmit={onJoin} noValidate className="flex flex-1 flex-col">
            <div className="flex flex-1 flex-col justify-center pb-8">
              <p lang="hi" className="text-xl font-bold text-brand">
                बॉट को हराओ
              </p>
              <h1 className="mt-1 text-5xl leading-[1.05] font-extrabold">Beat the bot.</h1>
              <p className="mt-4 text-lg leading-snug text-ink-dim">
                The whole room plays against two AIs. Write clues your friends get and the bots miss.
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-bold text-ink-dim">
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
                className="h-14 w-full rounded-2xl border-2 border-line bg-surface px-4 text-lg font-bold text-ink transition-colors duration-150 placeholder:text-ink-dim focus:border-brand"
              />
              <p
                id="name-note"
                role={joinErr ? 'alert' : undefined}
                className={`min-h-5 text-sm ${joinErr ? 'font-bold text-bot' : 'text-ink-dim'}`}
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
              <p className="mt-1 animate-rise text-6xl leading-none font-extrabold break-words">
                {deal.options[deal.mine]}
              </p>
              <p className="mt-6 text-sm font-bold text-ink-dim">Not these</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {deal.options
                  .filter((_, i) => i !== deal.mine)
                  .map((o) => (
                    <li key={o} className="rounded-full border border-line px-3 py-1 text-base font-bold text-ink-dim">
                      {o}
                    </li>
                  ))}
              </ul>

              {lockedClue ? (
                <div role="status" className="mt-auto animate-rise rounded-2xl border-2 border-win/50 bg-surface p-5">
                  <p className="flex items-center gap-2 text-lg font-extrabold text-win">
                    <CheckCircle size={26} weight="fill" aria-hidden />
                    Clue locked
                  </p>
                  <p className="mt-2 text-2xl font-bold break-words">&ldquo;{lockedClue}&rdquo;</p>
                  <p className="mt-2 text-base text-ink-dim">Guessing starts when the timer runs out.</p>
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
                <blockquote className="mt-1 animate-rise text-4xl leading-tight font-extrabold break-words">
                  &ldquo;{slot.text}&rdquo;
                </blockquote>
                <div role="group" aria-label="Pick a word" className="mt-auto grid gap-3 pt-8">
                  {slot.options.map((opt, i) => {
                    const chosen = pick === i;
                    const locked = pick !== null;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => onGuess(i)}
                        disabled={locked}
                        aria-pressed={chosen}
                        className={`flex h-16 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border-2 px-5 text-left text-xl font-extrabold transition duration-150 active:scale-[0.98] disabled:cursor-default ${
                          chosen
                            ? 'border-brand bg-brand-strong text-white'
                            : locked
                              ? 'border-line bg-surface text-ink-dim opacity-50'
                              : 'border-line bg-surface-2 text-ink hover:border-brand'
                        }`}
                      >
                        <span className="truncate">{opt}</span>
                        {chosen && <Check size={26} weight="bold" className="shrink-0 animate-pop" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
                <p
                  aria-live="polite"
                  className={`mt-3 min-h-6 text-center text-base font-bold ${guessErr ? 'text-bot' : 'text-ink-dim'}`}
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
            <ResultCard round={round} result={result} />
          ) : (
            <Waiting icon={Television} title="Eyes on the big screen" body="See which clues beat the bots." />
          )
        ) : (
          <Lobby name={name} round={round} />
        )}
      </main>

      {stat && (
        <footer className="flex shrink-0 items-center justify-center gap-1.5 pt-4 font-mono text-xs text-ink-dim">
          <Lightning size={14} weight="fill" className="text-brand" aria-hidden />
          {stat.ms.toLocaleString('en-US')} ms · block {stat.block.toLocaleString('en-US')}
        </footer>
      )}
    </div>
  );
}

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
        <label htmlFor="clue" className="text-sm font-bold text-ink-dim">
          Your clue
        </label>
        <span className={`font-mono text-sm tabular-nums ${over ? 'font-bold text-bot' : 'text-ink-dim'}`}>
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
        className="h-14 w-full rounded-2xl border-2 border-line bg-surface px-4 text-lg font-bold text-ink transition-colors duration-150 placeholder:text-ink-dim focus:border-brand"
      />
      <p
        id="clue-note"
        role={error ? 'alert' : undefined}
        className={`min-h-5 text-sm ${error ? 'font-bold text-bot' : 'text-ink-dim'}`}
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
      <div className="flex animate-rise items-center gap-3 rounded-2xl bg-surface p-4">
        <CheckCircle size={34} weight="fill" className="shrink-0 text-win" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-xl leading-tight font-extrabold">You're in, {name}</p>
          <p className="text-base text-ink-dim">
            {round > 0 ? `Round ${round} is done. Next one soon.` : 'Your name is on the big screen.'}
          </p>
        </div>
      </div>

      <h2 className="mt-8 text-sm font-bold tracking-wider text-ink-dim uppercase">How it works</h2>
      <ol className="mt-3 space-y-3">
        {STEPS.map(({ icon: StepIcon, title, body }) => (
          <li key={title} className="flex gap-4 rounded-2xl border border-line p-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-brand">
              <StepIcon size={24} weight="bold" aria-hidden />
            </span>
            <div>
              <p className="text-lg leading-tight font-bold">{title}</p>
              <p className="mt-0.5 text-base leading-snug text-ink-dim">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-auto flex items-center justify-center gap-2 pt-8 text-base font-bold text-ink-dim">
        Waiting for the host to start
        <ThinkingDots />
      </p>
    </section>
  );
}

function ResultCard({ round, result }: { round: number; result: Result }) {
  const payouts = result.payouts ?? [];
  return (
    <section className="flex flex-1 flex-col">
      <Eyebrow>Round {round} results</Eyebrow>
      {payouts.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {payouts.map((p, i) => (
            <li key={i} className="flex animate-rise items-center justify-between rounded-2xl bg-surface p-4">
              <span className="text-lg font-bold">{p.label}</span>
              <span className="font-mono text-lg font-bold text-win">+{p.amount}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-2xl font-extrabold">The bots held on this time.</p>
      )}
      {result.balance && (
        <div className="mt-auto rounded-2xl border border-line p-4">
          <p className="text-sm font-bold text-ink-dim">Your balance</p>
          <p className="font-mono text-3xl font-bold tabular-nums">{result.balance} MON</p>
        </div>
      )}
    </section>
  );
}

function Waiting({ icon: WaitIcon, title, body }: { icon: Icon; title: string; body: string }) {
  return (
    <section className="flex flex-1 animate-rise flex-col items-center justify-center pb-12 text-center">
      <span className="grid size-20 place-items-center rounded-3xl bg-surface text-brand">
        <WaitIcon size={40} weight="bold" aria-hidden />
      </span>
      <p className="mt-5 text-3xl font-extrabold">{title}</p>
      <p className="mt-2 max-w-[28ch] text-lg leading-snug text-ink-dim">{body}</p>
    </section>
  );
}

function SlotDots({ current, total }: { current: number; total: number }) {
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-2 rounded-full ${i === current ? 'w-6 bg-ink' : i < current ? 'w-2 bg-brand' : 'w-2 bg-surface-2'}`}
        />
      ))}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-sm font-bold tracking-wider text-ink-dim uppercase">{children}</p>;
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
      className={`flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-brand-strong text-lg font-extrabold text-white transition duration-150 hover:brightness-110 active:scale-[0.98] active:bg-brand-deep disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
    >
      {busy && <CircleNotch size={22} weight="bold" className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
