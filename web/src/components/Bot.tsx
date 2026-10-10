export type BotMood = 'idle' | 'thinking' | 'beaten';

const TILE: Record<string, string> = { Chhota: 'bg-chhota', Bada: 'bg-bada' };

// Which bot a payout line is about, e.g. "Beat Chhota" or "Your clue fooled Bada".
export function botOf(label: string): 'Chhota' | 'Bada' | null {
  if (/chhota/i.test(label)) return 'Chhota';
  if (/bada/i.test(label)) return 'Bada';
  return null;
}

// A bot's portrait: its colour with its face on top. Size it with className.
export function BotTile({ bot, mood = 'idle', className = '' }: { bot: string; mood?: BotMood; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-[24%] border-[3px] border-ink ${TILE[bot] ?? 'bg-ink'} ${className}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 64 64"
        className="size-[84%]"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {bot === 'Bada' ? <Bada mood={mood} /> : <Chhota mood={mood} />}
      </svg>
    </span>
  );
}

const CROSSES = 'M19 27l8 8M27 27l-8 8M37 27l8 8M45 27l-8 8';

// Small head, one antenna, a raised brow and a smirk.
function Chhota({ mood }: { mood: BotMood }) {
  const up = mood === 'thinking' ? -3 : 0;
  return (
    <>
      <path d="M32 16V9" />
      <circle cx="32" cy="7" r="3.5" fill="var(--color-sun)" />
      <rect x="12" y="16" width="40" height="38" rx="13" fill="var(--color-card)" />
      {mood === 'beaten' ? (
        <>
          <path d={`${CROSSES}`} transform="translate(0 2)" />
          <path d="M24 48q8-6 16 0" />
        </>
      ) : (
        <>
          <circle cx="23" cy={33 + up} r="3.4" fill="var(--color-ink)" stroke="none" />
          <circle cx="41" cy={33 + up} r="3.4" fill="var(--color-ink)" stroke="none" />
          <path d="M17 25l10-3" />
          {mood === 'thinking' ? <path d="M27 45h10" /> : <path d="M23 43q9 8 19-2" />}
        </>
      )}
    </>
  );
}

// Wide head, ear bolts, a heavy brow and a grille for a mouth.
function Bada({ mood }: { mood: BotMood }) {
  const up = mood === 'thinking' ? -2 : 0;
  return (
    <>
      <path d="M5 28v11M59 28v11" strokeWidth="5" />
      <rect x="9" y="10" width="46" height="45" rx="7" fill="var(--color-card)" />
      <path d="M16 20h32" />
      {mood === 'beaten' ? (
        <>
          <path d={CROSSES} />
          <path d="M22 48q10-6 20 0" />
        </>
      ) : (
        <>
          <rect x="17" y="26" width="11" height="10" rx="2" fill="var(--color-ink)" stroke="none" />
          <rect x="36" y="26" width="11" height="10" rx="2" fill="var(--color-ink)" stroke="none" />
          <rect x="23" y={31 + up * 2} width="3" height="3" fill="var(--color-card)" stroke="none" />
          <rect x="42" y={31 + up * 2} width="3" height="3" fill="var(--color-card)" stroke="none" />
          <rect x="20" y="42" width="24" height="7" rx="2" />
          <path d="M28 42v7M36 42v7" />
        </>
      )}
    </>
  );
}
