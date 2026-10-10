import { useEffect, useState } from 'react';

export function useCountdown(endsAt: number) {
  const [now, setNow] = useState(() => Date.now());
  const [span, setSpan] = useState({ endsAt: 0, total: 0 });

  if (span.endsAt !== endsAt) {
    setSpan({ endsAt, total: Math.max(0, endsAt - Date.now()) });
  }

  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [endsAt]);

  const left = Math.max(0, endsAt - now);
  return {
    secs: Math.ceil(left / 1000),
    frac: span.total > 0 ? Math.min(1, left / span.total) : 0,
  };
}

export function TimerBar({
  frac,
  urgent,
  className = '',
}: {
  frac: number;
  urgent?: boolean;
  className?: string;
}) {
  return (
    <div className={`w-full overflow-hidden rounded-full bg-surface-2 ${className}`} aria-hidden>
      <div
        className={`h-full w-full origin-left rounded-full transition-[transform,background-color] duration-200 ease-linear ${
          urgent ? 'bg-bot' : 'bg-brand'
        }`}
        style={{ transform: `scaleX(${frac})` }}
      />
    </div>
  );
}
