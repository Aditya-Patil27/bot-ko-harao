import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  HandTap,
  Lightning,
  Question,
  Robot,
  Trophy,
  WifiSlash,
  type Icon,
} from '@phosphor-icons/react';
import { useWs } from '../hooks/useWs';
import { TimerBar, useCountdown } from '../components/Timer';
import { BotTile } from '../components/Bot';

type Phase = 'LOBBY' | 'WRITE' | 'GUESS' | 'REVEAL';

interface SlotClue {
  clueId: string;
  text: string;
  options: string[];
}

interface BotStatus {
  thinkMs: number;
  answeredCount: number;
  balance?: string;
}

// Payload the settle step sends as `reveal`. Names appear only on the "beat" card.
interface RevealCard {
  kind: 'beat' | 'niche' | 'obvious';
  text: string;
  answer: string;
  giver?: string;
  humansRight: number;
  humansTotal: number;
  botsRight: string[];
}

interface Reveal {
  cards: RevealCard[];
  leaderboard: { name: string; earned: string }[];
  beatCount: number;
  bots?: { name: string; from: number; to: number }[];
}

interface Stats {
  block: number;
  txps: number;
  p50: number;
  p95: number;
}

const BOTS = [
  { name: 'Chhota', tagline: 'Fast. Overconfident.', model: 'gpt-oss-20b' },
  { name: 'Bada', tagline: 'Thinks harder. Slower.', model: 'gpt-oss-120b' },
];

const HOW_TO_PLAY = [
  { title: 'Get a secret word', body: 'Only your phone shows it.' },
  { title: 'Write a clue', body: "Hint at it. Don't say it." },
  { title: 'Fool the bots', body: "People get it, the two AIs don't: you win." },
];

const MIN_PLAYERS = 3;
const PHASE_LABEL: Record<Phase, string> = { LOBBY: 'Join now', WRITE: 'Write', GUESS: 'Guess', REVEAL: 'Results' };

// A phone can't reach the projector's localhost, so only trust PUBLIC_URL when it's a real host.
function joinUrl(publicUrl?: string) {
  try {
    const u = new URL(publicUrl ?? '');
    if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return u.origin;
  } catch {
    // fall through
  }
  return location.origin;
}

export function ProjectorView() {
  const [phase, setPhase] = useState<Phase>('LOBBY');
  const [round, setRound] = useState(0);
  const [endsAt, setEndsAt] = useState(0);
  const [url, setUrl] = useState(() => location.origin);

  const [names, setNames] = useState<string[]>([]);
  const [wrote, setWrote] = useState<Set<string>>(new Set());

  const [slot, setSlot] = useState({ index: 0, total: 0 });
  const [clues, setClues] = useState<SlotClue[]>([]);
  const [guesses, setGuesses] = useState<Record<string, number>>({});
  const [bots, setBots] = useState<Record<string, BotStatus>>({});

  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [starting, setStarting] = useState(false);

  const { secs, frac } = useCountdown(endsAt);

  const onMessage = useCallback((type: string, data: any) => {
    switch (type) {
      case 'phase':
        setPhase(data.name);
        setRound(data.round);
        setEndsAt(data.endsAt);
        if (data.name === 'WRITE') {
          setWrote(new Set());
          setReveal(null);
        }
        if (data.name !== 'LOBBY') setStarting(false);
        break;
      case 'players':
        setNames(data.names ?? []);
        break;
      case 'clue':
        if (data.who) setWrote((prev) => new Set(prev).add(data.who));
        break;
      case 'slot':
        setSlot({ index: data.slot ?? 0, total: data.slots ?? 0 });
        setClues(data.clues ?? []);
        setEndsAt(data.endsAt);
        setGuesses({});
        setBots({});
        break;
      case 'guess':
        setGuesses((prev) => ({ ...prev, [data.clueId]: (prev[data.clueId] ?? 0) + 1 }));
        break;
      case 'bot':
        setBots((prev) => ({
          ...prev,
          [data.name]: { thinkMs: data.thinkMs, answeredCount: data.answeredCount, balance: data.balance },
        }));
        break;
      case 'reveal':
        setReveal(data);
        break;
      case 'stats':
        setStats(data);
        break;
    }
  }, []);

  const { connected } = useWs('projector', onMessage);

  // Resync on every (re)connect: the server may have restarted mid-game.
  useEffect(() => {
    if (!connected) return;
    fetch('/state')
      .then((r) => r.json())
      .then((s) => {
        setPhase(s.phase);
        setRound(s.round);
        setEndsAt(s.endsAt);
        setNames(s.names ?? []);
        setUrl(joinUrl(s.publicUrl));
      })
      .catch(() => {});
  }, [connected]);

  // Operator presses N to start the round.
  const canStart = phase === 'LOBBY' && names.length >= MIN_PLAYERS;
  const canStartRef = useRef(canStart);
  canStartRef.current = canStart;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (!canStartRef.current) return;
      setStarting(true);
      fetch('/start', { method: 'POST' })
        .catch(() => {})
        .finally(() => setTimeout(() => setStarting(false), 1500));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const guessTotal = Object.values(guesses).reduce((a, b) => a + b, 0);
  const timed = phase !== 'LOBBY' && endsAt > 0;
  const urgent = secs <= 5;
  // The results stay up after the round, until the operator starts the next one.
  const held = phase === 'LOBBY' && reveal !== null;
  const stage: Phase = held ? 'REVEAL' : phase;
  const need = Math.max(0, MIN_PLAYERS - names.length);

  return (
    // Sized in cqw, not vw: a window wider than 16:9 (a laptop browser, not full screen) keeps the 16:9 layout, centred.
    <div className="sunburst h-dvh overflow-hidden">
      <div className="@container mx-auto h-full w-[min(100%,177.78dvh)]">
        <div className="flex h-full flex-col px-[3cqw] py-[2.5vh]">
          {/* As tall as the timer, so the stage does not jump when the timer leaves. */}
          <header
            className={`flex shrink-0 items-center justify-between gap-8 ${
              timed || held ? 'min-h-[calc(clamp(2.5rem,4.2cqw,5rem)*1.2+8px)]' : ''
            }`}
          >
            <div className="flex items-center gap-[1.6cqw]">
              <p className="display text-[clamp(1.6rem,2.5cqw,3rem)] leading-none uppercase">
                Bot ko <span className="cap-box inline-block rounded-[0.22em] bg-ink px-[0.3em] text-stage [--pad:0.22em]">Harao</span>
              </p>
              {round > 0 && (
                <ol
                  aria-label={`Round ${round}, ${PHASE_LABEL[stage]}`}
                  className="flex items-center gap-[0.5cqw] text-[clamp(0.9rem,1.15cqw,1.4rem)] leading-none font-bold uppercase"
                >
                  <li className="rounded-full bg-ink px-[1em] py-[0.6em] font-mono text-stage">Round {round}</li>
                  {STAGES.map((p) => (
                    <li
                      key={p}
                      aria-current={p === stage ? 'step' : undefined}
                      className={`cap-box rounded-full border-[3px] border-ink px-[0.9em] [--pad:0.6em] ${
                        p === stage ? 'bg-card shadow-hard-sm' : 'opacity-40'
                      }`}
                    >
                      {PHASE_LABEL[p]}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="flex items-center gap-[1.5cqw]">
              {!connected && (
                <span
                  className="flex items-center gap-2 rounded-full border-[3px] border-ink bg-card px-4 py-2 text-xl font-bold"
                  role="status"
                >
                  <WifiSlash size={28} weight="bold" aria-hidden />
                  Reconnecting
                </span>
              )}
              {timed && (
                <div className="flex items-center gap-[1cqw]">
                  <TimerBar
                    frac={frac}
                    urgent={urgent}
                    className="h-[clamp(1rem,2.4vh,1.75rem)] w-[clamp(10rem,16cqw,20rem)]"
                  />
                  <span
                    className={`grid min-w-[1.9em] place-items-center rounded-[0.2em] border-4 border-ink px-[0.15em] py-[0.1em] font-mono text-[clamp(2.5rem,4.2cqw,5rem)] leading-none font-bold tabular-nums shadow-stage ${
                      urgent ? 'bg-chhota' : 'bg-card'
                    }`}
                  >
                    {secs}
                  </span>
                </div>
              )}
              {held && (
                <p className="text-[clamp(1.1rem,1.6cqw,1.9rem)] font-bold" role="status">
                  <StartHint need={need} starting={starting} next />
                </p>
              )}
            </div>
          </header>

          <main className="min-h-0 flex-1 pt-[3vh]">
            {phase === 'LOBBY' && !held && <Lobby url={url} names={names} need={need} starting={starting} />}
            {phase === 'WRITE' && <Write names={names} wrote={wrote} />}
            {phase === 'GUESS' && (
              <Guess slot={slot} clues={clues} guesses={guesses} guessTotal={guessTotal} bots={bots} />
            )}
            {(phase === 'REVEAL' || held) && (reveal ? <RevealBoard reveal={reveal} url={url} /> : <Settling />)}
          </main>

          {stats && (
            <footer className="mx-auto mt-[2vh] flex shrink-0 items-center gap-[0.8em] rounded-full bg-ink px-[1.6em] py-[0.7em] font-mono text-[clamp(0.9rem,1.1cqw,1.25rem)] leading-none font-bold text-paper">
              <Lightning size={20} weight="fill" className="text-chain" aria-hidden />
              <span>block {stats.block.toLocaleString('en-US')}</span>
              <span className="text-chain" aria-hidden>
                ·
              </span>
              <span>{stats.txps} tx/s</span>
              <span className="text-chain" aria-hidden>
                ·
              </span>
              <span>p50 {stats.p50} ms</span>
              <span className="text-chain" aria-hidden>
                ·
              </span>
              <span>p95 {stats.p95} ms</span>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

const STAGES: Phase[] = ['WRITE', 'GUESS', 'REVEAL'];

// During a round the bots keep one place: a rail on the right of the stage.
const STAGE_GRID = 'grid h-full min-h-0 grid-cols-[1fr_clamp(18rem,26cqw,32rem)] gap-[2cqw]';
const BOT_RAIL = 'flex min-h-0 flex-col gap-[2.2vh] pr-[0.6cqw] pb-[0.6cqw]';

function StartHint({ need, starting, next = false }: { need: number; starting: boolean; next?: boolean }) {
  if (starting) return <>Starting…</>;
  if (need > 0) return <>{need} more to start</>;
  return (
    <>
      Press <Kbd>N</Kbd> {next ? 'for the next round' : 'to start'}
    </>
  );
}

function Lobby({ url, names, need, starting }: { url: string; names: string[]; need: number; starting: boolean }) {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[1.25fr_1fr] items-center gap-[4cqw]">
        <div className="flex min-h-0 flex-col">
          <p lang="hi" className="display text-[clamp(3.5rem,7.8cqw,10rem)] leading-[1.15] whitespace-nowrap">
            बॉट को{' '}
            <span className="inline-block -rotate-2 rounded-[0.14em] bg-ink px-[0.14em] pt-[0.48em] pb-[0.05em] leading-[0.7] text-stage">
              हराओ
            </span>
          </p>
          <h1 className="display mt-[1vh] text-[clamp(2.25rem,4.4cqw,5.5rem)] leading-none uppercase">Beat the bot.</h1>
          <ol aria-label="How to play" className="mt-[2.4vh] space-y-[1.1vh]">
            {HOW_TO_PLAY.map(({ title, body }, i) => (
              <li key={title} className="flex items-center gap-[0.9cqw]">
                <span
                  className="display cap-mid grid size-[clamp(2.1rem,2.9cqw,3.5rem)] shrink-0 place-items-center rounded-full bg-ink text-[clamp(1.3rem,1.8cqw,2.2rem)] leading-none text-stage"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <p className="text-mid leading-none">
                  <span className="display mr-[0.45em] text-[clamp(1.4rem,2cqw,2.5rem)] uppercase">{title}</span>
                  <span className="text-[clamp(1.05rem,1.4cqw,1.75rem)] font-semibold">{body}</span>
                </p>
              </li>
            ))}
          </ol>
          <div className="mt-[3vh] grid grid-cols-2 gap-[1.4cqw]">
            {BOTS.map((b) => (
              <BotIntro key={b.name} {...b} />
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-col items-center">
          <div className="relative w-[min(40vh,27cqw)] rotate-1 rounded-[1.6cqw] border-4 border-ink bg-card p-[1.1cqw] shadow-stage">
            <p className="display cap-box absolute -top-[1.15em] -left-[1.3em] -rotate-6 rounded-[0.3em] border-4 border-ink bg-chhota px-[0.5em] text-[clamp(1.25rem,1.9cqw,2.4rem)] uppercase [--pad:0.34em]">
              Scan to play
            </p>
            <QRCodeSVG value={url} size={512} level="M" className="block h-auto w-full" title={`Join at ${url}`} />
            <p className="mt-[1.2vh] text-center font-mono text-[clamp(1rem,1.45cqw,1.75rem)] leading-tight font-bold break-all">
              {url.replace(/^https?:\/\//, '')}
            </p>
          </div>

          <p className="mt-[3vh] flex items-baseline gap-[0.8cqw]">
            <span className="display text-[clamp(3rem,5.6cqw,6.5rem)] leading-none tabular-nums">{names.length}</span>
            <span className="text-[clamp(1.25rem,2cqw,2.25rem)] font-bold">
              {names.length === 1 ? 'player in' : 'players in'}
            </span>
          </p>
          <p className="mt-[1vh] text-[clamp(1.1rem,1.6cqw,1.9rem)] font-bold">
            <StartHint need={need} starting={starting} />
          </p>
        </div>
      </div>

      {/* Fixed two-row strip, newest first: a new joiner always sees their name land,
          and the QR above never moves while people are scanning it. */}
      <ul
        aria-label="Players in the room"
        className="mt-[2.5vh] flex h-[5.2em] shrink-0 flex-wrap content-start justify-center gap-[0.5em] overflow-hidden text-[clamp(1rem,1.2cqw,1.4rem)] font-bold"
      >
        {names.length === 0 ? (
          <li className="py-[0.5em] leading-none">Scan the code. Your name shows up here.</li>
        ) : (
          names
            .map((n, i) => ({ n, i }))
            .reverse()
            .map(({ n, i }) => (
              <li
                key={i}
                className="animate-pop rounded-full border-[3px] border-ink bg-card px-[0.9em] pt-[0.55em] pb-[0.35em] leading-none"
              >
                {n}
              </li>
            ))
        )}
      </ul>
    </section>
  );
}

function Write({ names, wrote }: { names: string[]; wrote: Set<string> }) {
  return (
    <section className={STAGE_GRID}>
      <div className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-[2cqw] pr-[0.9cqw]">
          <div>
            <h2 className="display cap-trim text-[clamp(2.75rem,5.6cqw,7rem)] uppercase">Write your clue</h2>
            <p className="mt-[2vh] text-[clamp(1.1rem,1.6cqw,1.9rem)] leading-tight font-semibold">
              Your secret word is on your phone.
              <br />
              Hint at it so people get it and the bots don't.
            </p>
          </div>
          <p className="flex shrink-0 flex-col items-end rounded-[1.3cqw] border-4 border-ink bg-card px-[1.4cqw] pt-[2vh] pb-[1.2vh] shadow-stage">
            <span className="display cap-trim text-[clamp(2.75rem,5.2cqw,6.5rem)] tabular-nums">
              {wrote.size}
              <span className="text-ink-dim">/{names.length}</span>
            </span>
            <span className="mt-[1.2vh] text-[clamp(1rem,1.4cqw,1.6rem)] leading-tight font-bold">clues in</span>
          </p>
        </div>
        <PlayerTiles names={names} lit={wrote} />
      </div>

      <aside className={BOT_RAIL}>
        {BOTS.map((b) => (
          <BotCard key={b.name} {...b} waiting />
        ))}
      </aside>
    </section>
  );
}

// Few players get big tiles. Rows shrink to share the height, so a full room of 60 still fits.
function PlayerTiles({ names, lit }: { names: string[]; lit: Set<string> }) {
  const n = names.length;
  const cols = n <= 8 ? 2 : n <= 15 ? 3 : n <= 28 ? 4 : n <= 45 ? 5 : 6;
  const size =
    n <= 15
      ? 'gap-[0.8cqw] text-[clamp(1.3rem,1.9cqw,2.4rem)] [--tile-h:3.2em]'
      : n <= 28
        ? 'gap-[0.8cqw] text-[clamp(1.1rem,1.5cqw,1.9rem)] [--tile-h:2.8em]'
        : 'gap-[0.5cqw] text-[clamp(0.95rem,1.15cqw,1.4rem)] [--tile-h:2.75em]';
  return (
    <ul
      className={`mt-[3.5vh] grid min-h-0 flex-1 auto-rows-[minmax(0,var(--tile-h))] content-start overflow-hidden pr-[0.9cqw] ${size}`}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {names.map((name, i) => {
        const on = lit.has(name);
        return (
          <li
            key={i}
            className={`flex items-center justify-between gap-[0.5em] min-h-0 rounded-[0.6em] border-[3px] px-[0.8em] leading-tight font-bold transition-colors duration-300 ${
              on ? 'animate-pop border-ink bg-win' : 'border-dashed border-ink/50 text-ink/65'
            }`}
          >
            <span className="text-mid truncate">{name}</span>
            {on && <Check weight="bold" className="size-[1.1em] shrink-0" aria-label="clue in" />}
          </li>
        );
      })}
    </ul>
  );
}

function Guess({
  slot,
  clues,
  guesses,
  guessTotal,
  bots,
}: {
  slot: { index: number; total: number };
  clues: SlotClue[];
  guesses: Record<string, number>;
  guessTotal: number;
  bots: Record<string, BotStatus>;
}) {
  const n = clues.length;
  const cols = n <= 2 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const solo = n === 1;
  const textSize = solo
    ? 'text-[clamp(3rem,6.2cqw,7.75rem)]'
    : n <= 2
      ? 'text-[clamp(2.5rem,5cqw,6.25rem)]'
      : n <= 4
        ? 'text-[clamp(1.9rem,3.2cqw,4rem)]'
        : n <= 9
          ? 'text-[clamp(1.5rem,2.3cqw,3rem)]'
          : 'text-[clamp(1.1rem,1.7cqw,2.1rem)]';
  const optionList = solo
    ? 'grid grid-cols-2 gap-[0.8cqw] text-[clamp(1.3rem,1.9cqw,2.4rem)]'
    : `flex flex-wrap items-center gap-[0.45em] ${
        n <= 2 ? 'text-[clamp(1.1rem,1.5cqw,1.9rem)]' : 'text-[clamp(0.9rem,1.1cqw,1.4rem)]'
      }`;
  const optionChip = solo ? 'min-w-0 rounded-[0.5em] p-[0.45em]' : 'rounded-full py-[0.22em] pr-[0.8em] pl-[0.25em]';
  return (
    <section className={STAGE_GRID}>
      <div className="flex min-h-0 flex-col">
        <div className="flex items-start justify-between gap-[2cqw] pr-[0.9cqw]">
          <div>
            <h2 className="display cap-trim text-[clamp(2.25rem,4.2cqw,5.25rem)] uppercase">Which word is it?</h2>
            {/* More than four clues fill the stage: the line gives its height back. */}
            {n <= 4 && (
              <p className="mt-[1.8vh] text-[clamp(1.1rem,1.6cqw,1.9rem)] leading-tight font-semibold">
                Tap your answer on your phone. The bots are guessing too.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-[0.7cqw] text-[clamp(1.1rem,1.5cqw,1.9rem)] leading-none font-bold">
            <p className="rounded-full border-[3px] border-ink bg-card px-[1em] py-[0.5em]">
              Guess <span className="font-mono tabular-nums">{slot.index + 1}</span> of{' '}
              <span className="font-mono tabular-nums">{slot.total}</span>
            </p>
            <p className="flex items-center gap-[0.5em] rounded-full bg-ink px-[1em] py-[0.5em] text-stage">
              <HandTap size={28} weight="bold" aria-hidden />
              <span className="font-mono tabular-nums">{guessTotal}</span> guesses in
            </p>
          </div>
        </div>
        <ul
          className="mt-[1.5vh] grid min-h-0 flex-1 auto-rows-fr gap-[1.2cqw] pt-[1.2cqw] pr-[0.9cqw] pb-[0.6cqw]"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {clues.map((c, i) => {
            const count = guesses[c.clueId] ?? 0;
            return (
              <li
                key={c.clueId}
                className="relative flex min-h-0 animate-rise flex-col justify-between gap-[1.5vh] rounded-[1.4cqw] border-4 border-ink bg-card p-[1.4cqw] shadow-stage"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <p className={`display ${textSize} leading-[1.05] break-words ${solo ? 'my-auto' : ''}`}>
                  {/* Keeps the first line clear of the guess count pinned to the corner. */}
                  <span className="float-right h-[0.6em] w-[2em] text-[clamp(1rem,1.35cqw,1.7rem)]" aria-hidden />
                  &ldquo;{c.text}&rdquo;
                </p>
                {/* Three rows of cards leave no room for the options under a long clue. */}
                {n <= 6 && (
                  <ol className={`leading-none font-bold ${optionList}`}>
                    {c.options.map((o, k) => (
                      <li key={o} className={`flex items-center gap-[0.45em] border-[3px] border-ink ${optionChip}`}>
                        <span
                          className="grid size-[1.7em] shrink-0 place-items-center rounded-full bg-ink font-mono text-[0.78em] text-card"
                          aria-hidden
                        >
                          {'ABCD'[k]}
                        </span>
                        <span className="text-mid min-w-0 truncate">{o}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {count > 0 && (
                  <span
                    key={count}
                    className="absolute -top-[0.8em] -right-[0.55em] flex rotate-3 animate-pop items-center gap-[0.3em] rounded-full border-[3px] border-ink bg-ink px-[0.7em] py-[0.4em] font-mono text-[clamp(1rem,1.35cqw,1.7rem)] leading-none font-bold text-stage"
                  >
                    <HandTap weight="bold" className="size-[1em]" aria-hidden />
                    {count}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <aside className={BOT_RAIL}>
        {BOTS.map((b) => (
          <BotCard key={b.name} {...b} status={bots[b.name]} clueCount={n} />
        ))}
      </aside>
    </section>
  );
}

function BotIntro({ name, tagline, model }: { name: string; tagline: string; model: string }) {
  return (
    <div className="flex items-center gap-[1cqw] rounded-[1.3cqw] border-4 border-ink bg-card p-[1cqw] shadow-stage">
      <BotTile bot={name} className="size-[clamp(3.5rem,5.2cqw,6.25rem)]" />
      <div className="min-w-0">
        <p className="display text-[clamp(1.6rem,2.4cqw,3rem)] leading-none uppercase">{name}</p>
        <p className="mt-[0.35em] text-[clamp(0.95rem,1.2cqw,1.4rem)] leading-tight font-semibold">{tagline}</p>
        <p className="mt-[0.3em] font-mono text-[clamp(0.75rem,0.9cqw,1.05rem)] text-ink-dim">{model}</p>
      </div>
    </div>
  );
}

function BotCard({
  name,
  tagline,
  model,
  status,
  clueCount = 0,
  waiting = false,
}: {
  name: string;
  tagline: string;
  model: string;
  status?: BotStatus;
  clueCount?: number;
  /** Write phase: nothing to read yet. */
  waiting?: boolean;
}) {
  const silent = status?.answeredCount === 0;
  const thinking = !waiting && !status;
  return (
    <article className="flex min-h-0 flex-1 flex-col rounded-[1.4cqw] border-4 border-ink bg-card p-[1.3cqw] shadow-stage">
      <div className="flex items-center gap-[1cqw]">
        <BotTile
          bot={name}
          mood={thinking ? 'thinking' : silent ? 'beaten' : 'idle'}
          className={`size-[clamp(4.5rem,min(8.4cqw,16.5vh),10rem)] shrink-0 ${thinking ? 'animate-nod' : ''}`}
        />
        <div className="min-w-0">
          <p className="display text-[clamp(1.9rem,2.9cqw,3.6rem)] leading-none uppercase">{name}</p>
          <p className="mt-[0.3em] text-[clamp(1rem,1.25cqw,1.5rem)] leading-tight font-semibold">{tagline}</p>
          <p className="mt-[0.25em] font-mono text-[clamp(0.8rem,0.95cqw,1.1rem)] text-ink-dim">{model}</p>
        </div>
      </div>

      <div className="mt-auto pt-[1.5vh]" aria-live="polite">
        {waiting ? (
          <p className="rounded-[0.5em] border-[3px] border-dashed border-ink/50 px-[0.6em] py-[0.4em] text-[clamp(1.2rem,1.8cqw,2.2rem)] leading-tight font-extrabold text-ink/65">
            Waiting for your clues
          </p>
        ) : status ? (
          <p
            className={`animate-pop rounded-[0.5em] border-[3px] border-ink px-[0.6em] py-[0.4em] text-[clamp(1.2rem,1.8cqw,2.2rem)] leading-tight font-extrabold ${
              silent ? 'bg-sun' : 'bg-win'
            }`}
          >
            {silent ? (
              'No answer. Counts as wrong.'
            ) : (
              <>
                Guessed{' '}
                <span className="font-mono tabular-nums">
                  {status.answeredCount}/{clueCount}
                </span>
                <span className="block font-mono text-[0.7em] font-bold tabular-nums">
                  in {status.thinkMs.toLocaleString('en-US')} ms
                </span>
              </>
            )}
          </p>
        ) : (
          <p className="flex items-center gap-3 rounded-[0.5em] border-[3px] border-ink bg-ink px-[0.6em] py-[0.4em] text-[clamp(1.2rem,1.8cqw,2.2rem)] leading-tight font-extrabold text-stage">
            still thinking
            <Dots />
          </p>
        )}
        {status?.balance && (
          <p className="mt-[1vh] font-mono text-[clamp(1rem,1.3cqw,1.5rem)] leading-tight font-bold tabular-nums">
            {status.balance} MON left to win
          </p>
        )}
      </div>
    </article>
  );
}

// `rule` says in plain words what put a clue on this card.
const CARD_STYLE: Record<RevealCard['kind'], { label: string; rule: string; icon: Icon; band: string }> = {
  beat: { label: 'Beat the bot', rule: "People got it. The bots didn't.", icon: Trophy, band: 'bg-win' },
  niche: { label: 'Too niche', rule: 'So hard that no person got it.', icon: Question, band: 'bg-ink text-stage' },
  obvious: { label: 'Too obvious', rule: 'So easy that a bot got it.', icon: Robot, band: 'bg-chhota' },
};

function RevealBoard({ reveal, url }: { reveal: Reveal; url: string }) {
  const kinds: RevealCard['kind'][] = ['beat', 'niche', 'obvious'];
  return (
    <section className="grid h-full min-h-0 grid-rows-[1fr_auto] gap-[3vh]">
      <ul className="grid min-h-0 grid-cols-[1.3fr_1fr_1fr] gap-[1.5cqw] pr-[0.6cqw] pb-[0.6cqw]">
        {kinds.map((kind, i) => {
          const card = reveal.cards.find((c) => c.kind === kind);
          const { label, rule, icon: CardIcon, band } = CARD_STYLE[kind];
          return (
            <li
              key={kind}
              className="flex min-h-0 animate-stamp flex-col overflow-hidden rounded-[1.4cqw] border-4 border-ink bg-card shadow-stage"
              style={{ animationDelay: `${i * 140}ms` }}
            >
              <div className={`shrink-0 border-b-4 border-ink px-[1.4cqw] py-[1.3vh] ${band}`}>
                <p className="display flex items-center gap-[0.45em] text-[clamp(1.4rem,2.2cqw,2.75rem)] leading-none uppercase">
                  <CardIcon weight="fill" className="size-[1.05em] shrink-0" aria-hidden />
                  <span className="cap-trim">{label}</span>
                </p>
                <p className="mt-[1vh] text-[clamp(1rem,1.3cqw,1.6rem)] leading-tight font-bold">{rule}</p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col p-[1.4cqw]">
                {card ? (
                  <>
                    <p className="display text-[clamp(1.9rem,3.2cqw,4rem)] leading-[1.05] break-words">
                      &ldquo;{card.text}&rdquo;
                    </p>
                    <p className="mt-[1.4vh] text-[clamp(1.1rem,1.6cqw,1.9rem)] leading-tight font-semibold">
                      Answer: <span className="rounded-[0.25em] bg-sun px-[0.3em] font-extrabold">{card.answer}</span>
                    </p>
                    <div className="mt-auto space-y-[0.2em] pt-[2vh] text-[clamp(1rem,1.35cqw,1.6rem)] leading-tight font-semibold">
                      {kind === 'beat' && card.giver && <p className="text-[1.2em] font-extrabold">by {card.giver}</p>}
                      <p>
                        <span className="font-mono font-bold tabular-nums">
                          {card.humansRight}/{card.humansTotal}
                        </span>{' '}
                        people got it
                      </p>
                      <p>{card.botsRight.length ? `${card.botsRight.join(' and ')} got it` : 'Both bots missed'}</p>
                    </div>
                  </>
                ) : (
                  <p className="text-[clamp(1.1rem,1.6cqw,1.9rem)] font-semibold text-ink-dim">None this round</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="grid grid-cols-[1fr_1fr_auto_auto] items-start gap-[3cqw]">
        <div>
          {reveal.bots?.length ? (
            <>
              <Eyebrow>MON left to win</Eyebrow>
              <div className="space-y-[1.4vh]">
                {reveal.bots.map((b) => (
                  <BotBalance key={b.name} {...b} />
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div>
          {reveal.leaderboard.length > 0 && (
            <>
              <Eyebrow>Top winners tonight, in MON</Eyebrow>
              <ol className="max-w-[30rem] space-y-[0.15em] text-[clamp(1.1rem,1.5cqw,1.75rem)] leading-tight">
                {reveal.leaderboard.slice(0, 5).map((p, i) => (
                  <li key={i} className="flex items-baseline gap-[0.6em]">
                    <span className="w-[1.2em] font-mono font-bold">{i + 1}</span>
                    <span className="flex-1 truncate font-bold">{p.name}</span>
                    <span className="font-mono font-bold tabular-nums">+{p.earned}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="text-right">
          <Eyebrow className="ml-auto">Tonight</Eyebrow>
          <p className="flex items-baseline justify-end gap-[0.8cqw]">
            <span className="display cap-trim text-[clamp(3.5rem,7cqw,8.5rem)] tabular-nums">{reveal.beatCount}</span>
            <span className="text-[clamp(1rem,1.4cqw,1.6rem)] leading-tight font-bold">
              {reveal.beatCount === 1 ? 'clue' : 'clues'} beat the AI
            </span>
          </p>
        </div>
        {/* The lobby's code, small: someone who walks in between rounds can still join. */}
        <div>
          <Eyebrow>Scan to join</Eyebrow>
          <div className="rounded-[0.8cqw] border-4 border-ink bg-card p-[0.5cqw]">
            <QRCodeSVG
              value={url}
              size={256}
              level="M"
              className="block size-[clamp(5.5rem,13vh,9rem)]"
              title={`Join at ${url}`}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function useTween(from: number, to: number, ms = 1400) {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setValue(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, ms]);
  return value;
}

// The fullest each bot's wallet has been on this screen: the bar drains against it.
const poolFull = new Map<string, number>();

function BotBalance({ name, from, to }: { name: string; from: number; to: number }) {
  const now = useTween(from, to);
  const full = Math.max(poolFull.get(name) ?? 0, from, to);
  poolFull.set(name, full);
  return (
    <div className="flex items-center gap-[1cqw]">
      <BotTile bot={name} mood={to < from ? 'beaten' : 'idle'} className="size-[clamp(2.75rem,3.6cqw,4.25rem)]" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-[0.7em] text-[clamp(1.15rem,1.6cqw,1.9rem)] leading-tight">
          <span className="display uppercase">{name}</span>
          <span className="ml-auto font-mono tabular-nums">{from.toFixed(2)}</span>
          <span aria-hidden>→</span>
          <span className="font-mono font-bold tabular-nums">{now.toFixed(2)}</span>
        </p>
        <div className="mt-[0.5vh] h-[clamp(0.8rem,1.6vh,1.2rem)] overflow-hidden rounded-full border-[3px] border-ink bg-card">
          <div
            className={`h-full origin-left ${name === 'Bada' ? 'bg-bada' : 'bg-chhota'}`}
            style={{ transform: `scaleX(${full > 0 ? Math.min(1, now / full) : 0})` }}
          />
        </div>
      </div>
    </div>
  );
}

function Settling() {
  return (
    <section className="flex h-full flex-col items-center justify-center text-center">
      <span className="grid size-[clamp(5rem,8cqw,9rem)] -rotate-3 place-items-center rounded-[22%] border-4 border-ink bg-card shadow-stage">
        <Trophy weight="fill" className="size-1/2" aria-hidden />
      </span>
      <h2 className="display mt-[3.5vh] text-[clamp(3rem,6.4cqw,8rem)] leading-none uppercase">Who beat the bots?</h2>
      <p className="mt-[2vh] flex items-center gap-3 text-[clamp(1.25rem,2cqw,2.25rem)] font-bold">
        Checking every guess against Chhota and Bada
        <Dots />
      </p>
    </section>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-1.5" aria-hidden>
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-2.5 animate-think rounded-full bg-current" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`cap-box mb-[1.2vh] w-fit rounded-[0.35em] bg-ink px-[0.6em] text-[clamp(0.85rem,1.05cqw,1.25rem)] font-bold tracking-wider text-stage uppercase [--pad:0.5em] ${className}`}
    >
      {children}
    </p>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-[0.25em] inline-grid min-w-[1.8em] place-items-center rounded-[0.3em] border-[3px] border-ink bg-card px-[0.4em] font-mono shadow-hard-sm">
      {children}
    </kbd>
  );
}
