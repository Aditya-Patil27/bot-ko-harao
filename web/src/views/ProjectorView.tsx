import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  HandTap,
  Lightning,
  Question,
  Robot,
  Scales,
  Trophy,
  WifiSlash,
  type Icon,
} from '@phosphor-icons/react';
import { useWs } from '../hooks/useWs';
import { TimerBar, useCountdown } from '../components/Timer';

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

const MIN_PLAYERS = 3;
const PHASE_LABEL: Record<Phase, string> = { LOBBY: 'Join now', WRITE: 'Write', GUESS: 'Guess', REVEAL: 'Reveal' };

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

  return (
    <div className="flex h-dvh flex-col overflow-hidden px-[3vw] py-[3vh]">
      <header className="flex shrink-0 items-center justify-between gap-8">
        <p className="flex items-baseline gap-4">
          <span className="text-[clamp(1.5rem,2.2vw,2.5rem)] font-extrabold tracking-tight">
            Bot ko <span className="text-brand">Harao</span>
          </span>
          {round > 0 && (
            <span className="font-mono text-[clamp(1rem,1.3vw,1.5rem)] text-ink-dim">
              Round {round} · {PHASE_LABEL[phase]}
            </span>
          )}
        </p>
        <div className="flex items-center gap-6">
          {!connected && (
            <span className="flex items-center gap-2 text-xl font-bold text-warn" role="status">
              <WifiSlash size={28} weight="bold" aria-hidden />
              Reconnecting
            </span>
          )}
          {timed && (
            <div className="flex w-[clamp(10rem,16vw,18rem)] flex-col items-end gap-2">
              <span
                className={`font-mono text-[clamp(2.5rem,4.5vw,5rem)] leading-none font-bold tabular-nums ${urgent ? 'text-bot' : ''}`}
              >
                {secs}
              </span>
              <TimerBar frac={frac} urgent={urgent} className="h-2.5" />
            </div>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 pt-[3vh]">
        {phase === 'LOBBY' && <Lobby url={url} names={names} starting={starting} />}
        {phase === 'WRITE' && <Write round={round} names={names} wrote={wrote} />}
        {phase === 'GUESS' && (
          <Guess slot={slot} clues={clues} guesses={guesses} guessTotal={guessTotal} bots={bots} />
        )}
        {phase === 'REVEAL' && (reveal ? <RevealBoard reveal={reveal} /> : <Settling />)}
      </main>

      {stats && (
        <footer className="flex shrink-0 items-center justify-center gap-3 pt-[2vh] font-mono text-[clamp(0.9rem,1.1vw,1.25rem)] text-ink-dim">
          <Lightning size={20} weight="fill" className="text-brand" aria-hidden />
          <span>block {stats.block.toLocaleString('en-US')}</span>
          <span aria-hidden>·</span>
          <span>{stats.txps} tx/s</span>
          <span aria-hidden>·</span>
          <span>p50 {stats.p50} ms</span>
          <span aria-hidden>·</span>
          <span>p95 {stats.p95} ms</span>
        </footer>
      )}
    </div>
  );
}

function Lobby({ url, names, starting }: { url: string; names: string[]; starting: boolean }) {
  const need = Math.max(0, MIN_PLAYERS - names.length);
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-[1.15fr_1fr] items-center gap-[4vw]">
        <div className="flex min-h-0 flex-col">
          <p lang="hi" className="text-[clamp(2.25rem,4.6vw,5.5rem)] leading-none font-extrabold text-brand">
            बॉट को हराओ
          </p>
          <h1 className="mt-[1vh] text-[clamp(3rem,6.6vw,8rem)] leading-[0.95] font-extrabold">Beat the bot.</h1>
          <p className="mt-[2.5vh] max-w-[30ch] text-[clamp(1.25rem,1.9vw,2.25rem)] leading-snug text-ink-dim">
            The whole room against two AIs. Write clues people get and the bots miss.
          </p>
          <div className="mt-[4vh] grid grid-cols-2 gap-[1.2vw]">
            {BOTS.map((b) => (
              <BotIntro key={b.name} {...b} />
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-col items-center">
          <div className="w-[min(38vh,28vw)] rounded-[2rem] border border-line bg-surface p-[1.2vw]">
            <div className="rounded-2xl bg-white p-[0.9vw]">
              <QRCodeSVG value={url} size={512} level="M" className="block h-auto w-full" title={`Join at ${url}`} />
            </div>
            <p className="mt-[1.2vh] text-center font-mono text-[clamp(1rem,1.5vw,1.75rem)] font-bold break-all">
              {url.replace(/^https?:\/\//, '')}
            </p>
          </div>

          <p className="mt-[2.5vh] flex items-baseline gap-3">
            <span className="font-mono text-[clamp(2.5rem,4.8vw,5.5rem)] leading-none font-bold tabular-nums">
              {names.length}
            </span>
            <span className="text-[clamp(1.25rem,2vw,2.25rem)] font-bold text-ink-dim">
              {names.length === 1 ? 'player in' : 'players in'}
            </span>
          </p>
          <p className="mt-[1.5vh] text-[clamp(1.1rem,1.6vw,1.9rem)] font-bold text-ink-dim">
            {starting ? (
              'Starting…'
            ) : need > 0 ? (
              `Need ${MIN_PLAYERS} to start · ${need} more`
            ) : (
              <>
                Press <Kbd>N</Kbd> to start
              </>
            )}
          </p>
        </div>
      </div>

      {/* Fixed two-row strip, newest first: a new joiner always sees their name land,
          and the QR above never moves while people are scanning it. */}
      <ul
        aria-label="Players in the room"
        className="mt-[2.5vh] flex h-[4.5em] shrink-0 flex-wrap content-start justify-center gap-[0.5em] overflow-hidden text-[clamp(1rem,1.2vw,1.4rem)] font-bold"
      >
        {names.length === 0 ? (
          <li className="py-[0.5em] leading-none text-ink-dim">Scan the code. Your name shows up here.</li>
        ) : (
          names
            .map((n, i) => ({ n, i }))
            .reverse()
            .map(({ n, i }) => (
              <li key={i} className="animate-pop rounded-full bg-surface-2 px-[0.9em] py-[0.5em] leading-none">
                {n}
              </li>
            ))
        )}
      </ul>
    </section>
  );
}

function Write({ round, names, wrote }: { round: number; names: string[]; wrote: Set<string> }) {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-end justify-between gap-8">
        <div>
          <Eyebrow>Round {round}</Eyebrow>
          <h2 className="text-[clamp(2.5rem,5vw,6rem)] leading-none font-extrabold">Write your clue</h2>
          <p className="mt-[1.5vh] text-[clamp(1.1rem,1.7vw,2rem)] text-ink-dim">
            Hint at your word. Don't say it. Make the bots guess wrong.
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="font-mono text-[clamp(3rem,6vw,7rem)] leading-none font-bold tabular-nums">
            {wrote.size}
            <span className="text-ink-dim">/{names.length}</span>
          </span>
          <span className="block text-[clamp(1rem,1.4vw,1.6rem)] font-bold text-ink-dim">clues in</span>
        </p>
      </div>
      <PlayerTiles names={names} lit={wrote} />
    </section>
  );
}

function PlayerTiles({ names, lit }: { names: string[]; lit: Set<string> }) {
  return (
    <ul className="mt-[4vh] grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(clamp(9rem,11vw,14rem),1fr))] content-start gap-[0.8vw] overflow-hidden">
      {names.map((n, i) => {
        const on = lit.has(n);
        return (
          <li
            key={i}
            className={`flex items-center justify-between gap-2 rounded-xl px-4 py-[1vh] text-[clamp(1rem,1.3vw,1.6rem)] font-bold transition-colors duration-300 ${
              on ? 'animate-pop bg-brand-strong text-white' : 'border border-line text-ink-dim'
            }`}
          >
            <span className="truncate">{n}</span>
            {on && <Check size={22} weight="bold" className="shrink-0" aria-label="clue in" />}
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
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const textSize =
    n <= 2
      ? 'text-[clamp(2rem,3.6vw,4.5rem)]'
      : n <= 6
        ? 'text-[clamp(1.5rem,2.3vw,3rem)]'
        : 'text-[clamp(1.1rem,1.6vw,2rem)]';
  return (
    <section className="grid h-full min-h-0 grid-cols-[1fr_clamp(18rem,25vw,30rem)] gap-[2vw]">
      <div className="flex min-h-0 flex-col">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[clamp(2rem,3.6vw,4.5rem)] leading-none font-extrabold">
            Clue {slot.index + 1} <span className="text-ink-dim">of {slot.total}</span>
          </h2>
          <p className="flex items-center gap-2 text-[clamp(1.1rem,1.6vw,1.9rem)] font-bold text-ink-dim">
            <HandTap size={28} weight="bold" aria-hidden />
            <span className="font-mono text-ink tabular-nums">{guessTotal}</span> guesses in
          </p>
        </div>
        <ul
          className="mt-[3vh] grid min-h-0 flex-1 auto-rows-fr gap-[1vw]"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {clues.map((c) => {
            const count = guesses[c.clueId] ?? 0;
            return (
              <li
                key={c.clueId}
                className="flex min-h-0 animate-rise flex-col justify-between gap-[1.5vh] rounded-3xl border border-line bg-surface p-[1.4vw]"
              >
                <p className={`${textSize} leading-tight font-extrabold break-words`}>&ldquo;{c.text}&rdquo;</p>
                <div className="flex flex-wrap items-center gap-2">
                  {n <= 9 &&
                    c.options.map((o) => (
                      <span
                        key={o}
                        className="rounded-full bg-surface-2 px-3 py-1 text-[clamp(0.9rem,1.1vw,1.4rem)] font-bold text-ink-dim"
                      >
                        {o}
                      </span>
                    ))}
                  <span
                    key={count}
                    className={`ml-auto flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[clamp(0.9rem,1.1vw,1.4rem)] font-bold ${
                      count > 0 ? 'animate-pop bg-brand-strong text-white' : 'text-ink-dim'
                    }`}
                  >
                    <HandTap size={18} weight="bold" aria-hidden />
                    {count}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <aside className="flex min-h-0 flex-col gap-[2vh]">
        {BOTS.map((b) => (
          <BotCard key={b.name} {...b} status={bots[b.name]} clueCount={n} />
        ))}
      </aside>
    </section>
  );
}

function BotIntro({ name, tagline, model }: { name: string; tagline: string; model: string }) {
  return (
    <div className="flex items-center gap-[1vw] rounded-3xl border border-line bg-surface p-[1.2vw]">
      <span className="grid size-[clamp(3rem,4vw,4.5rem)] shrink-0 place-items-center rounded-2xl bg-bot/15 text-bot">
        <Robot weight="fill" className="size-3/5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[clamp(1.4rem,2vw,2.4rem)] leading-none font-extrabold">{name}</p>
        <p className="mt-1 text-[clamp(0.95rem,1.2vw,1.4rem)] text-ink-dim">{tagline}</p>
        <p className="mt-0.5 font-mono text-[clamp(0.8rem,0.95vw,1.1rem)] text-ink-dim">{model}</p>
      </div>
    </div>
  );
}

function BotCard({
  name,
  tagline,
  model,
  status,
  clueCount,
}: {
  name: string;
  tagline: string;
  model: string;
  status?: BotStatus;
  clueCount: number;
}) {
  return (
    <article
      className={`flex flex-1 flex-col rounded-3xl border-2 bg-surface p-[1.4vw] transition-colors duration-300 ${
        status ? 'border-line' : 'border-bot/60'
      }`}
    >
      <div className="flex items-center gap-[1vw]">
        <span className="grid size-[clamp(3.5rem,4.6vw,5.5rem)] shrink-0 place-items-center rounded-2xl bg-bot/15 text-bot">
          <Robot weight="fill" className="size-3/5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[clamp(1.75rem,2.6vw,3.25rem)] leading-none font-extrabold">{name}</p>
          <p className="mt-1 text-[clamp(1rem,1.3vw,1.5rem)] text-ink-dim">{tagline}</p>
        </div>
      </div>
      <p className="mt-[1vh] font-mono text-[clamp(0.85rem,1vw,1.15rem)] text-ink-dim">{model}</p>

      <div className="mt-auto pt-[2vh]" aria-live="polite">
        {status ? (
          <p className="animate-pop text-[clamp(1.25rem,1.9vw,2.25rem)] leading-tight font-extrabold">
            {status.answeredCount === 0 ? (
              <span className="text-warn">No answer · counts as wrong</span>
            ) : (
              <>
                Answered{' '}
                <span className="font-mono tabular-nums">
                  {status.answeredCount}/{clueCount}
                </span>
                <span className="block font-mono text-[0.7em] font-bold text-ink-dim tabular-nums">
                  in {status.thinkMs.toLocaleString('en-US')} ms
                </span>
              </>
            )}
          </p>
        ) : (
          <p className="flex items-center gap-3 text-[clamp(1.25rem,1.9vw,2.25rem)] font-extrabold text-bot">
            still thinking
            <span className="inline-flex gap-1.5" aria-hidden>
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="size-2.5 animate-think rounded-full bg-current"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
          </p>
        )}
        {status?.balance && (
          <p className="mt-[1vh] font-mono text-[clamp(1rem,1.3vw,1.5rem)] text-ink-dim tabular-nums">
            {status.balance} MON left
          </p>
        )}
      </div>
    </article>
  );
}

const CARD_STYLE: Record<RevealCard['kind'], { label: string; icon: Icon; tone: string; border: string }> = {
  beat: { label: 'Beat the bot', icon: Trophy, tone: 'text-win', border: 'border-win/60' },
  niche: { label: 'Too niche', icon: Question, tone: 'text-warn', border: 'border-warn/50' },
  obvious: { label: 'Too obvious', icon: Robot, tone: 'text-bot', border: 'border-bot/50' },
};

function RevealBoard({ reveal }: { reveal: Reveal }) {
  const kinds: RevealCard['kind'][] = ['beat', 'niche', 'obvious'];
  return (
    <section className="grid h-full min-h-0 grid-rows-[1fr_auto] gap-[3vh]">
      <ul className="grid min-h-0 grid-cols-3 gap-[1.5vw]">
        {kinds.map((kind, i) => {
          const card = reveal.cards.find((c) => c.kind === kind);
          const { label, icon: CardIcon, tone, border } = CARD_STYLE[kind];
          return (
            <li
              key={kind}
              className={`flex min-h-0 animate-rise flex-col rounded-3xl border-2 bg-surface p-[1.6vw] ${card ? border : 'border-line'}`}
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <p className={`flex items-center gap-3 text-[clamp(1.25rem,1.9vw,2.25rem)] font-extrabold ${tone}`}>
                <CardIcon size={36} weight="fill" aria-hidden />
                {label}
              </p>
              {card ? (
                <>
                  <p className="mt-[2vh] text-[clamp(1.6rem,2.6vw,3.25rem)] leading-tight font-extrabold break-words">
                    &ldquo;{card.text}&rdquo;
                  </p>
                  <p className="mt-[1vh] text-[clamp(1.1rem,1.6vw,1.9rem)] font-bold text-ink-dim">
                    Answer: <span className="text-ink">{card.answer}</span>
                  </p>
                  <div className="mt-auto space-y-1 pt-[2vh] text-[clamp(1rem,1.35vw,1.6rem)] text-ink-dim">
                    {kind === 'beat' && card.giver && (
                      <p className="text-[1.15em] font-extrabold text-ink">by {card.giver}</p>
                    )}
                    <p>
                      <span className="font-mono font-bold text-ink tabular-nums">
                        {card.humansRight}/{card.humansTotal}
                      </span>{' '}
                      people got it
                    </p>
                    <p>{card.botsRight.length ? `${card.botsRight.join(' and ')} got it` : 'Both bots missed'}</p>
                  </div>
                </>
              ) : (
                <p className="mt-[2vh] text-[clamp(1.1rem,1.6vw,1.9rem)] text-ink-dim">None this round</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-[3vw]">
        <div>
          {reveal.bots?.length ? (
            <>
              <Eyebrow>Bot wallets · MON</Eyebrow>
              <div className="space-y-[1vh]">
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
              <Eyebrow>Top earners · MON</Eyebrow>
              <ol className="max-w-[28rem] space-y-1">
                {reveal.leaderboard.slice(0, 5).map((p, i) => (
                  <li key={i} className="flex items-baseline gap-3 text-[clamp(1.1rem,1.5vw,1.75rem)]">
                    <span className="w-6 font-mono text-ink-dim">{i + 1}</span>
                    <span className="flex-1 truncate font-bold">{p.name}</span>
                    <span className="font-mono font-bold text-win tabular-nums">+{p.earned}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="text-right">
          <Eyebrow>Tonight</Eyebrow>
          <p className="font-mono text-[clamp(3rem,6vw,7rem)] leading-none font-bold text-win tabular-nums">
            {reveal.beatCount}
          </p>
          <p className="mt-1 text-[clamp(1rem,1.4vw,1.6rem)] font-bold text-ink-dim">clues beat the AI</p>
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

function BotBalance({ name, from, to }: { name: string; from: number; to: number }) {
  const now = useTween(from, to);
  return (
    <p className="flex items-baseline gap-4 text-[clamp(1.25rem,1.8vw,2.1rem)]">
      <Robot size={28} weight="fill" className="shrink-0 self-center text-bot" aria-hidden />
      <span className="w-[5ch] font-extrabold">{name}</span>
      <span className="font-mono text-ink-dim tabular-nums">{from.toFixed(2)}</span>
      <span className="text-ink-dim" aria-hidden>
        →
      </span>
      <span className="font-mono font-bold text-bot tabular-nums">{now.toFixed(2)}</span>
    </p>
  );
}

function Settling() {
  return (
    <section className="flex h-full flex-col items-center justify-center text-center">
      <span className="grid size-[clamp(5rem,8vw,9rem)] place-items-center rounded-[2rem] bg-surface text-brand">
        <Scales weight="bold" className="size-1/2" aria-hidden />
      </span>
      <h2 className="mt-[3vh] text-[clamp(2.5rem,5vw,6rem)] leading-none font-extrabold">Settling on Monad</h2>
      <p className="mt-[2vh] flex items-center gap-3 text-[clamp(1.25rem,2vw,2.25rem)] font-bold text-ink-dim">
        Scoring every clue against both bots
        <span className="inline-flex gap-1.5" aria-hidden>
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-2.5 animate-think rounded-full bg-current" style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
      </p>
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-[1vh] text-[clamp(1rem,1.3vw,1.5rem)] font-bold tracking-wider text-ink-dim uppercase">
      {children}
    </p>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-1 inline-grid min-w-[1.8em] place-items-center rounded-lg border-2 border-b-4 border-line bg-surface-2 px-2 font-mono text-ink">
      {children}
    </kbd>
  );
}
