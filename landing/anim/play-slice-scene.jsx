// play-slice-scene.jsx — Ad Sensei logo sting v2 (playful cut)
// A big play button is sliced apart; every cut carves a piece at its true
// final shape: the tip cut = one glyph triangle, a V-chop = the second,
// and the two offcuts clap together and squish into the bar. A final
// accidental slice clips the lead triangle's tip — the sliced logo.
(() => {
  const { Stage, Sprite, useTime, Easing, interpolate, animate } = window;

  const lerp = (a, b, p) => a + (b - a) * p;
  const lerpPoly = (A, B, p) => A.map((pt, i) => [lerp(pt[0], B[i][0], p), lerp(pt[1], B[i][1], p)]);
  const pts = (P) => P.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");

  // ---- geometry (stage px, S = 30 px/brand-unit — pieces never change size) ----
  // play button: brand-proportioned triangle at 2× glyph scale (12×28 units)
  const PLAY   = [[780,70],[1140,490],[780,910]];
  // cut 1 (vertical at x=960): tip = EXACT glyph triangle 6×14
  const TIP0   = [[960,280],[1140,490],[960,700]];
  const TRAP0  = [[780,70],[780,910],[960,700],[960,280]];
  // trapezoid pieces after separation (shifted −70), V-chop carves EXACT triangle
  const A0s    = [[710,70],[710,280],[890,490],[890,280]];   // top offcut (parallelogram)
  const REM    = [[710,280],[710,910],[890,700],[890,490]];  // rest, between chops
  const MID0s  = [[710,280],[890,490],[710,700]];             // EXACT glyph triangle
  const B0s    = [[710,700],[890,490],[890,700],[710,910]];  // bottom offcut
  // final glyph positions (brand geometry, S=30, centered)
  const T1     = [[684,250],[864,460],[684,670]];
  const T2c    = [999, 460];   // tip lands here via translate(−51,−30) — exact T2
  const BAR_A  = [[1164,250],[1164,461.5],[1236,461.5],[1236,250]]; // top half of bar (overlaps seam)
  const BAR_B  = [[1164,458.5],[1236,458.5],[1236,670],[1164,670]]; // bottom half (overlaps seam)
  // accidental slice through T1 (lockup 5d cut)
  const T1_UP  = [[684,250],[768.4,348.5],[768.4,348.5],[684,442.2]];
  const T1_LO  = [[684,442.2],[768.4,348.5],[864,460],[684,670]];

  // slice timings (slower, breathing room between beats)
  const S1 = 2.1, SC1 = 4.0, SC2 = 4.25, S3 = 7.5;

  function Streak({ x, y, len, op, angle, accent }) {
    return (
      <div style={{ position: "absolute", left: x, top: y, width: len, height: 5,
        opacity: op, borderRadius: 3,
        background: `linear-gradient(90deg, transparent, #ffffff 50%, ${accent})`,
        boxShadow: `0 0 14px ${accent}`,
        transform: `translate(-50%, -50%) rotate(${angle}deg)` }}></div>
    );
  }

  function streakAt(t, when, maxLen) {
    return {
      len: interpolate([when - 0.12, when, when + 0.3], [0, maxLen, 0], Easing.easeOutCubic)(t),
      op:  interpolate([when - 0.12, when - 0.02, when + 0.3], [0.15, 0.9, 0])(t),
    };
  }

  function Film({ accent, showWordmark }) {
    const t = useTime();
    const E = Easing;

    // ---- intro: bouncy pop + gentle idle bob ----
    const intro = animate({ from: 0, to: 1, start: 0.1, end: 0.9, ease: E.easeOutBack })(t);
    const bobAmp = interpolate([1.5, 2.0], [1, 0])(t);
    const bob = Math.sin(t * 2.4) * 1.6 * (t < S1 ? bobAmp : 0);

    // ---- cut 1: pieces gently separate ----
    const sep = animate({ from: 0, to: 1, start: S1, end: S1 + 0.5, ease: E.easeOutCubic })(t);
    // tip glides to T2 with a little arc
    const fp = animate({ from: 0, to: 1, start: 2.85, end: 3.7, ease: E.easeOutBack })(t);
    const tipX = lerp(50 * sep, -51, fp);
    const tipY = -30 * fp - 36 * Math.sin(Math.PI * Math.min(1, Math.max(0, fp)));
    const tipSq = interpolate([3.65, 3.8, 4.05], [0, 1, 0])(t); // landing squash
    // ---- V-chop: top offcut pops, then mid triangle + bottom offcut free ----
    const c1 = animate({ from: 0, to: 1, start: SC1, end: SC1 + 0.3, ease: E.easeOutCubic })(t);
    const mp = animate({ from: 0, to: 1, start: 4.45, end: 5.4, ease: E.easeOutBack })(t);
    const midX = -26 * mp;
    const midY = -30 * mp - 30 * Math.sin(Math.PI * Math.min(1, Math.max(0, mp)));
    const midSq = interpolate([5.35, 5.5, 5.75], [0, 1, 0])(t);
    // offcuts clap together into the bar (morph, with an arc)
    const pa = animate({ from: 0, to: 1, start: 4.6, end: 5.6, ease: E.easeInOutCubic })(t);
    const pb = animate({ from: 0, to: 1, start: 4.75, end: 5.75, ease: E.easeInOutCubic })(t);
    const barSq = interpolate([5.7, 5.88, 6.15], [0, 1, 0])(t); // cartoon squish on landing
    // ---- ta-da: whole glyph does a tiny bounce ----
    const tada = interpolate([6.4, 6.62, 6.9], [0, 1, 0], E.easeInOutQuad)(t);
    // ---- accidental slice: startled hop + tip drifts off ----
    const p3 = animate({ from: 0, to: 1, start: S3 + 0.05, end: S3 + 0.7, ease: E.easeOutBack })(t);
    const hopY = -12 * interpolate([S3, S3 + 0.16, S3 + 0.5], [0, 1, 0])(t);
    // ---- hachimaki bandage: band slides across the cut, knot pops, cinches, tip snaps back ----
    const bandIn = animate({ from: 0, to: 1, start: 8.35, end: 8.85, ease: E.easeOutCubic })(t);
    const knotP = animate({ from: 0, to: 1, start: 8.8, end: 9.05, ease: E.easeOutBack })(t);
    const cinch = interpolate([8.95, 9.12, 9.4], [0, 1, 0])(t);
    const snap = animate({ from: 0, to: 1, start: 9.0, end: 9.35, ease: E.easeOutBack })(t);
    const fix = p3 * (1 - snap);
    const wigAmp = interpolate([9.4, 10.2], [1, 0])(t);
    const wig = t >= 9.4 ? 2.2 * Math.sin((t - 9.4) * 13) * wigAmp : 0;
    // wordmark
    const wm = animate({ from: 0, to: 1, start: 9.9, end: 10.5, ease: E.easeOutCubic })(t);

    // streaks
    const st1 = streakAt(t, S1, 760);
    const stA = streakAt(t, SC1, 420);
    const stB = streakAt(t, SC2, 420);
    const st3 = streakAt(t, S3, 520);
    const flash = Math.max(
      interpolate([S1 - 0.02, S1 + 0.05, S1 + 0.25], [0, 0.08, 0])(t),
      interpolate([SC2 - 0.02, SC2 + 0.05, SC2 + 0.25], [0, 0.08, 0])(t),
      interpolate([S3 - 0.02, S3 + 0.05, S3 + 0.25], [0, 0.12, 0])(t));

    const squash = (q, cx, cy, bulge = 0.09, dip = 0.11) =>
      ` translate(${cx} ${cy}) scale(${1 + bulge * q} ${1 - dip * q}) translate(${-cx} ${-cy})`;

    const glyphT = `translate(0 ${hopY}) translate(960 460) scale(${1 + 0.035 * tada}) translate(-960 -460) rotate(${wig} 960 460)`;

    return (
      <div style={{ position: "absolute", inset: 0, fontFamily: "Roboto, Arial, sans-serif" }}>
        <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0 }}>
          <defs>
            <clipPath id="psT1clip"><polygon points={pts(T1)} /></clipPath>
          </defs>
          <g fill={accent} transform={glyphT}>
            {/* whole play button, bobbing */}
            {t < S1 && (
              <polygon points={pts(PLAY)}
                transform={`translate(960 490) scale(${intro}) rotate(${bob}) translate(-960 -490)`} />
            )}

            {/* tip piece → T2 (exact shape, translate only) */}
            {t >= S1 && (
              <polygon points={pts(TIP0)}
                transform={`translate(${tipX} ${tipY})` + squash(tipSq, T2c[0], T2c[1])} />
            )}

            {/* back trapezoid, pre-chop */}
            {t >= S1 && t < SC1 && (
              <polygon points={pts(TRAP0)} transform={`translate(${-70 * sep} 0)`} />
            )}

            {/* between the two chops: top offcut pops, rest holds */}
            {t >= SC1 && t < SC2 && (
              <>
                <polygon points={pts(A0s)} transform={`translate(${-5 * c1} ${-10 * c1})`} />
                <polygon points={pts(REM)} />
              </>
            )}

            {/* after chop 2 */}
            {t >= SC2 && (
              <>
                {/* mid triangle → T1 (exact shape, translate only) */}
                {t < S3 && (
                  <polygon points={pts(MID0s)}
                    transform={`translate(${midX} ${midY})` + squash(midSq, 744, 460)} />
                )}
                {/* after the accidental slice: T1 splits, tip drifts — then the band ties it back */}
                {t >= S3 && (
                  <g transform={squash(cinch, 744, 460, -0.07, -0.05)}>
                    {snap < 0.999 ? (
                      <>
                        <polygon points={pts(T1_LO)} />
                        <polygon points={pts(T1_UP)} transform={`translate(${16.5 * fix} ${-19.5 * fix})`} />
                      </>
                    ) : (
                      <polygon points={pts(T1)} />
                    )}
                    {/* hachimaki (lockup 5a): band clipped to the triangle, knot + tails behind */}
                    {bandIn > 0.01 && (
                      <>
                        <g clipPath="url(#psT1clip)">
                          <rect x="654" y="361" width="240" height="54" fill="#f1f1f1"
                            transform={`translate(${-520 * (1 - bandIn)} 0) rotate(-7 759 388)`} />
                        </g>
                        {knotP > 0.01 && (
                          <g fill="#f1f1f1" transform={`translate(667.5 394) scale(${knotP}) translate(-667.5 -394)`}>
                            <circle cx="667.5" cy="394" r="22.5" />
                            <rect x="597" y="358" width="69" height="25.5" rx="12.6" transform="rotate(-35 666 382)" />
                            <rect x="588" y="403" width="81" height="25.5" rx="12.6" transform="rotate(-8 669 415)" />
                          </g>
                        )}
                      </>
                    )}
                  </g>
                )}
                {/* the two offcuts clap together and squish into the bar */}
                <g transform={squash(barSq, 1200, 460, 0.1, 0.14)}>
                  <polygon points={pts(lerpPoly(A0s, BAR_A, pa))}
                    transform={`translate(${-5 * (1 - pa)} ${-10 * (1 - pa) - 34 * Math.sin(Math.PI * pa)})`} />
                  <polygon points={pts(lerpPoly(B0s, BAR_B, pb))}
                    transform={`translate(0 ${34 * Math.sin(Math.PI * pb)})`} />
                </g>
              </>
            )}
          </g>
        </svg>

        {/* katana streaks — softer */}
        {st1.op > 0.01 && st1.len > 2 && <Streak x={960} y={490} len={st1.len} op={st1.op} angle={90} accent={accent} />}
        {stA.op > 0.01 && stA.len > 2 && <Streak x={800} y={385} len={stA.len} op={stA.op} angle={49.4} accent={accent} />}
        {stB.op > 0.01 && stB.len > 2 && <Streak x={800} y={595} len={stB.len} op={stB.op} angle={-49.4} accent={accent} />}
        {st3.op > 0.01 && st3.len > 2 && <Streak x={726} y={395} len={st3.len} op={st3.op} angle={-48} accent={accent} />}

        {/* wordmark */}
        {showWordmark && wm > 0.01 && (
          <div style={{ position: "absolute", left: 0, top: 790, width: 1920, textAlign: "center",
            fontSize: 84, fontWeight: 900, letterSpacing: "-1px", lineHeight: 1, opacity: wm,
            transform: `translateY(${(1 - wm) * 26}px)` }}>
            <span style={{ color: accent }}>AD</span> <span style={{ color: "#f1f1f1" }}>SENSEI</span>
          </div>
        )}

        {/* impact flash removed — the full-stage white overlay read as a
            flashing box; the diagonal slice beam stays */}
      </div>
    );
  }

  function PlaySliceScene(props) {
    const accent = props.accent ?? "#7c3aed";
    const showWordmark = props.showWordmark ?? true;
    const loop = props.loop ?? false;
    const autoplay = props.autoplay ?? true;
    return (
      <Stage width={1920} height={1080} duration={12.5} loop={loop} autoplay={autoplay} background="transparent">
        <Sprite start={0} end={12.5}>
          <Film accent={accent} showWordmark={showWordmark} />
        </Sprite>
      </Stage>
    );
  }

  window.PlaySliceScene = PlaySliceScene;
})();
