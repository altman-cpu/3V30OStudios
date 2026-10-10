interface BlueVetteProps {
  /** 0..1 engine load, derived from worker activity. */
  load: number;
  running: boolean;
  stalled: boolean;
  recovering: boolean;
  uptime: string;
  version: string;
  rpm: number;
  ticks: number;
  recovers: number;
}

/**
 * BLUE VETTE — the co-driver. A stylised blue mid-engine sports car whose
 * engine note and wheel speed are driven by the Joey Ortiz work loop: it idles
 * when the queue is empty, revs while a caption is being spoken, flashes amber
 * when the watchdog fires, and always shows the odometer it has actually run.
 */
export function BlueVette({
  load,
  running,
  stalled,
  recovering,
  uptime,
  version,
  rpm,
  ticks,
  recovers,
}: BlueVetteProps): React.ReactElement {
  const clamped = Math.min(1, Math.max(0, load));
  const state = stalled ? 'STALL' : recovering ? 'RECOVER' : running ? 'RUNNING' : 'PARKED';
  const stateTone = stalled ? 'bad' : recovering ? 'warn' : running ? 'good' : 'idle';

  // Faster spin under load; paused entirely when parked.
  const spinSeconds = running ? Math.max(0.18, 1.6 - clamped * 1.3) : 0;
  const needleAngle = -118 + clamped * 236;

  return (
    <section className="vette" data-state={stateTone}>
      <header className="vette__head">
        <h2>
          BLUE VETTE <span className="vette__ver">v{version}</span>
        </h2>
        <span className={`vette__state vette__state--${stateTone}`}>{state}</span>
      </header>

      <div className="vette__stage">
        <svg viewBox="0 0 560 250" role="img" aria-label={`Blue Vette, engine ${state}, load ${Math.round(clamped * 100)} percent`}>
          <defs>
            <linearGradient id="vetteBody" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5fb8ff" />
              <stop offset="42%" stopColor="#1f7ae0" />
              <stop offset="100%" stopColor="#0a3f8f" />
            </linearGradient>
            <linearGradient id="vetteGlass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#bfe9ff" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#123a63" stopOpacity="0.9" />
            </linearGradient>
            <radialGradient id="headlamp" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="55%" stopColor="#ffe9a8" />
              <stop offset="100%" stopColor="#ffb700" stopOpacity="0" />
            </radialGradient>
            <filter id="vetteGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* road */}
          <line x1="0" y1="212" x2="560" y2="212" stroke="#22314f" strokeWidth="3" />
          <g stroke="#2f4368" strokeWidth="3" strokeDasharray="26 22" className={running ? 'vette__road' : undefined}>
            <line x1="0" y1="226" x2="620" y2="226" />
          </g>

          {/* speed streaks under load */}
          <g opacity={clamped} stroke="#7fd0ff" strokeWidth="2" strokeLinecap="round">
            <line x1="8" y1="150" x2={8 + 40 * clamped} y2="150" />
            <line x1="2" y1="168" x2={2 + 62 * clamped} y2="168" />
            <line x1="14" y1="186" x2={14 + 30 * clamped} y2="186" />
          </g>

          {/* exhaust puffs scale with load */}
          <g fill="#8fa6c9" opacity={clamped * 0.55}>
            <circle cx="524" cy="176" r={3 + 5 * clamped} />
            <circle cx="540" cy="170" r={2 + 4 * clamped} />
            <circle cx="552" cy="164" r={1.5 + 3 * clamped} />
          </g>

          {/* body */}
          <path
            d="M40 186 C42 160 72 148 108 142 L186 132 C214 100 262 88 322 90 L392 96 C452 104 498 128 520 152 C534 162 536 178 532 190 L500 190 L470 190 L188 190 L120 190 Z"
            fill="url(#vetteBody)"
            stroke="#8fd4ff"
            strokeOpacity="0.65"
            strokeWidth="2"
          />

          {/* greenhouse / windows */}
          <path d="M206 130 C228 106 268 96 320 98 L372 102 L382 128 Z" fill="url(#vetteGlass)" stroke="#a9e2ff" strokeOpacity="0.5" strokeWidth="1.5" />
          <line x1="300" y1="99" x2="308" y2="128" stroke="#0a3f8f" strokeWidth="3" />

          {/* side intake + crease */}
          <path d="M330 150 q46 6 78 22" stroke="#0a3f8f" strokeWidth="7" fill="none" strokeLinecap="round" opacity="0.7" />
          <path d="M120 152 q70 -8 132 -4" stroke="#bfe9ff" strokeWidth="2" fill="none" opacity="0.35" />

          {/* headlamp */}
          <g filter="url(#vetteGlow)">
            <ellipse cx="72" cy="160" rx="16" ry="8" fill="url(#headlamp)" opacity={running ? 1 : 0.35} />
          </g>
          {/* tail lamp */}
          <rect x="518" y="156" width="14" height="8" rx="3" fill="#ff5470" opacity={running ? 0.95 : 0.4} />

          {/* wheels */}
          {[
            { cx: 158, label: 'front' },
            { cx: 434, label: 'rear' },
          ].map((wheel) => (
            <g key={wheel.label}>
              <circle cx={wheel.cx} cy="186" r="40" fill="#0b1120" stroke="#3a5580" strokeWidth="3" />
              <g
                className="vette__wheel"
                style={{
                  transformOrigin: `${wheel.cx}px 186px`,
                  animationDuration: spinSeconds > 0 ? `${spinSeconds}s` : undefined,
                  animationPlayState: spinSeconds > 0 ? 'running' : 'paused',
                }}
              >
                <circle cx={wheel.cx} cy="186" r="24" fill="#16233c" stroke="#7fd0ff" strokeOpacity="0.6" strokeWidth="2" />
                {[0, 60, 120].map((angle) => (
                  <line
                    key={angle}
                    x1={wheel.cx}
                    y1={186 - 22}
                    x2={wheel.cx}
                    y2={186 + 22}
                    stroke="#7fd0ff"
                    strokeOpacity="0.55"
                    strokeWidth="3"
                    transform={`rotate(${angle} ${wheel.cx} 186)`}
                  />
                ))}
              </g>
              <circle cx={wheel.cx} cy="186" r="6" fill="#7fd0ff" opacity="0.8" />
            </g>
          ))}

          {/* licence plate */}
          <g>
            <rect x="238" y="176" width="84" height="20" rx="3" fill="#0b1120" stroke="#7fd0ff" strokeOpacity="0.6" />
            <text x="280" y="191" textAnchor="middle" fontSize="13" fill="#bfe9ff" fontFamily="ui-monospace, monospace">
              JOEY-01
            </text>
          </g>
        </svg>

        {/* tachometer */}
        <div className="vette__tach" aria-hidden="true">
          <svg viewBox="0 0 120 120">
            <path d="M18 92 A 48 48 0 1 1 102 92" fill="none" stroke="#22314f" strokeWidth="10" strokeLinecap="round" />
            <path
              d="M18 92 A 48 48 0 1 1 102 92"
              fill="none"
              stroke={stalled ? '#ff5470' : '#4ea3ff'}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${clamped * 226} 300`}
            />
            <line
              x1="60"
              y1="70"
              x2="60"
              y2="30"
              stroke={stalled ? '#ff5470' : '#eaf6ff'}
              strokeWidth="3.5"
              strokeLinecap="round"
              transform={`rotate(${needleAngle} 60 70)`}
            />
            <circle cx="60" cy="70" r="6" fill="#0b1120" stroke="#7fd0ff" strokeWidth="2" />
            <text x="60" y="104" textAnchor="middle" fontSize="15" fill="#bfe9ff" fontFamily="ui-monospace, monospace">
              {Math.round(rpm)}
            </text>
            <text x="60" y="116" textAnchor="middle" fontSize="8" fill="#6f86ad" fontFamily="ui-monospace, monospace">
              RPM x100
            </text>
          </svg>
        </div>
      </div>

      <dl className="vette__gauges">
        <div>
          <dt>UPTIME</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>TICKS</dt>
          <dd>{ticks.toLocaleString()}</dd>
        </div>
        <div>
          <dt>RECOVERS</dt>
          <dd>{recovers}</dd>
        </div>
        <div>
          <dt>LOAD</dt>
          <dd>{Math.round(clamped * 100)}%</dd>
        </div>
      </dl>
    </section>
  );
}
