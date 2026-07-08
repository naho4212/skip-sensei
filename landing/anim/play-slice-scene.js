// GENERATED from play-slice-scene.jsx — do not edit. Rebuild with esbuild (see animations.js header).
"use strict";
(() => {
  (() => {
    const { Stage, Sprite, useTime, Easing, interpolate, animate } = window;
    const lerp = (a, b, p) => a + (b - a) * p;
    const lerpPoly = (A, B, p) => A.map((pt, i) => [lerp(pt[0], B[i][0], p), lerp(pt[1], B[i][1], p)]);
    const pts = (P) => P.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");
    const PLAY = [[780, 70], [1140, 490], [780, 910]];
    const TIP0 = [[960, 280], [1140, 490], [960, 700]];
    const TRAP0 = [[780, 70], [780, 910], [960, 700], [960, 280]];
    const A0s = [[710, 70], [710, 280], [890, 490], [890, 280]];
    const REM = [[710, 280], [710, 910], [890, 700], [890, 490]];
    const MID0s = [[710, 280], [890, 490], [710, 700]];
    const B0s = [[710, 700], [890, 490], [890, 700], [710, 910]];
    const T1 = [[684, 250], [864, 460], [684, 670]];
    const T2c = [999, 460];
    const BAR_A = [[1164, 250], [1164, 461.5], [1236, 461.5], [1236, 250]];
    const BAR_B = [[1164, 458.5], [1236, 458.5], [1236, 670], [1164, 670]];
    const T1_UP = [[684, 250], [768.4, 348.5], [768.4, 348.5], [684, 442.2]];
    const T1_LO = [[684, 442.2], [768.4, 348.5], [864, 460], [684, 670]];
    const S1 = 2.1, SC1 = 4, SC2 = 4.25, S3 = 7.5;
    function Streak({ x, y, len, op, angle, accent }) {
      return /* @__PURE__ */ React.createElement("div", { style: {
        position: "absolute",
        left: x,
        top: y,
        width: len,
        height: 5,
        opacity: op,
        borderRadius: 3,
        background: `linear-gradient(90deg, transparent, #ffffff 50%, ${accent})`,
        boxShadow: `0 0 14px ${accent}`,
        transform: `translate(-50%, -50%) rotate(${angle}deg)`
      } });
    }
    function streakAt(t, when, maxLen) {
      return {
        len: interpolate([when - 0.12, when, when + 0.3], [0, maxLen, 0], Easing.easeOutCubic)(t),
        op: interpolate([when - 0.12, when - 0.02, when + 0.3], [0.15, 0.9, 0])(t)
      };
    }
    function Film({ accent, showWordmark }) {
      const t = useTime();
      const E = Easing;
      const intro = animate({ from: 0, to: 1, start: 0.1, end: 0.9, ease: E.easeOutBack })(t);
      const bobAmp = interpolate([1.5, 2], [1, 0])(t);
      const bob = Math.sin(t * 2.4) * 1.6 * (t < S1 ? bobAmp : 0);
      const sep = animate({ from: 0, to: 1, start: S1, end: S1 + 0.5, ease: E.easeOutCubic })(t);
      const fp = animate({ from: 0, to: 1, start: 2.85, end: 3.7, ease: E.easeOutBack })(t);
      const tipX = lerp(50 * sep, -51, fp);
      const tipY = -30 * fp - 36 * Math.sin(Math.PI * Math.min(1, Math.max(0, fp)));
      const tipSq = interpolate([3.65, 3.8, 4.05], [0, 1, 0])(t);
      const c1 = animate({ from: 0, to: 1, start: SC1, end: SC1 + 0.3, ease: E.easeOutCubic })(t);
      const mp = animate({ from: 0, to: 1, start: 4.45, end: 5.4, ease: E.easeOutBack })(t);
      const midX = -26 * mp;
      const midY = -30 * mp - 30 * Math.sin(Math.PI * Math.min(1, Math.max(0, mp)));
      const midSq = interpolate([5.35, 5.5, 5.75], [0, 1, 0])(t);
      const pa = animate({ from: 0, to: 1, start: 4.6, end: 5.6, ease: E.easeInOutCubic })(t);
      const pb = animate({ from: 0, to: 1, start: 4.75, end: 5.75, ease: E.easeInOutCubic })(t);
      const barSq = interpolate([5.7, 5.88, 6.15], [0, 1, 0])(t);
      const tada = interpolate([6.4, 6.62, 6.9], [0, 1, 0], E.easeInOutQuad)(t);
      const p3 = animate({ from: 0, to: 1, start: S3 + 0.05, end: S3 + 0.7, ease: E.easeOutBack })(t);
      const hopY = -12 * interpolate([S3, S3 + 0.16, S3 + 0.5], [0, 1, 0])(t);
      const bandIn = animate({ from: 0, to: 1, start: 8.35, end: 8.85, ease: E.easeOutCubic })(t);
      const knotP = animate({ from: 0, to: 1, start: 8.8, end: 9.05, ease: E.easeOutBack })(t);
      const cinch = interpolate([8.95, 9.12, 9.4], [0, 1, 0])(t);
      const snap = animate({ from: 0, to: 1, start: 9, end: 9.35, ease: E.easeOutBack })(t);
      const fix = p3 * (1 - snap);
      const wigAmp = interpolate([9.4, 10.2], [1, 0])(t);
      const wig = t >= 9.4 ? 2.2 * Math.sin((t - 9.4) * 13) * wigAmp : 0;
      const wm = animate({ from: 0, to: 1, start: 9.9, end: 10.5, ease: E.easeOutCubic })(t);
      const st1 = streakAt(t, S1, 760);
      const stA = streakAt(t, SC1, 420);
      const stB = streakAt(t, SC2, 420);
      const st3 = streakAt(t, S3, 520);
      const flash = Math.max(
        interpolate([S1 - 0.02, S1 + 0.05, S1 + 0.25], [0, 0.08, 0])(t),
        interpolate([SC2 - 0.02, SC2 + 0.05, SC2 + 0.25], [0, 0.08, 0])(t),
        interpolate([S3 - 0.02, S3 + 0.05, S3 + 0.25], [0, 0.12, 0])(t)
      );
      const squash = (q, cx, cy, bulge = 0.09, dip = 0.11) => ` translate(${cx} ${cy}) scale(${1 + bulge * q} ${1 - dip * q}) translate(${-cx} ${-cy})`;
      const glyphT = `translate(0 ${hopY}) translate(960 460) scale(${1 + 0.035 * tada}) translate(-960 -460) rotate(${wig} 960 460)`;
      return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, fontFamily: "Roboto, Arial, sans-serif" } }, /* @__PURE__ */ React.createElement("svg", { width: "1920", height: "1080", viewBox: "0 0 1920 1080", style: { position: "absolute", inset: 0 } }, /* @__PURE__ */ React.createElement("defs", null, /* @__PURE__ */ React.createElement("clipPath", { id: "psT1clip" }, /* @__PURE__ */ React.createElement("polygon", { points: pts(T1) }))), /* @__PURE__ */ React.createElement("g", { fill: accent, transform: glyphT }, t < S1 && /* @__PURE__ */ React.createElement(
        "polygon",
        {
          points: pts(PLAY),
          transform: `translate(960 490) scale(${intro}) rotate(${bob}) translate(-960 -490)`
        }
      ), t >= S1 && /* @__PURE__ */ React.createElement(
        "polygon",
        {
          points: pts(TIP0),
          transform: `translate(${tipX} ${tipY})` + squash(tipSq, T2c[0], T2c[1])
        }
      ), t >= S1 && t < SC1 && /* @__PURE__ */ React.createElement("polygon", { points: pts(TRAP0), transform: `translate(${-70 * sep} 0)` }), t >= SC1 && t < SC2 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("polygon", { points: pts(A0s), transform: `translate(${-5 * c1} ${-10 * c1})` }), /* @__PURE__ */ React.createElement("polygon", { points: pts(REM) })), t >= SC2 && /* @__PURE__ */ React.createElement(React.Fragment, null, t < S3 && /* @__PURE__ */ React.createElement(
        "polygon",
        {
          points: pts(MID0s),
          transform: `translate(${midX} ${midY})` + squash(midSq, 744, 460)
        }
      ), t >= S3 && /* @__PURE__ */ React.createElement("g", { transform: squash(cinch, 744, 460, -0.07, -0.05) }, snap < 0.999 ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("polygon", { points: pts(T1_LO) }), /* @__PURE__ */ React.createElement("polygon", { points: pts(T1_UP), transform: `translate(${16.5 * fix} ${-19.5 * fix})` })) : /* @__PURE__ */ React.createElement("polygon", { points: pts(T1) }), bandIn > 0.01 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("g", { clipPath: "url(#psT1clip)" }, /* @__PURE__ */ React.createElement(
        "rect",
        {
          x: "654",
          y: "361",
          width: "240",
          height: "54",
          fill: "#f1f1f1",
          transform: `translate(${-520 * (1 - bandIn)} 0) rotate(-7 759 388)`
        }
      )), knotP > 0.01 && /* @__PURE__ */ React.createElement("g", { fill: "#f1f1f1", transform: `translate(667.5 394) scale(${knotP}) translate(-667.5 -394)` }, /* @__PURE__ */ React.createElement("circle", { cx: "667.5", cy: "394", r: "22.5" }), /* @__PURE__ */ React.createElement("rect", { x: "597", y: "358", width: "69", height: "25.5", rx: "12.6", transform: "rotate(-35 666 382)" }), /* @__PURE__ */ React.createElement("rect", { x: "588", y: "403", width: "81", height: "25.5", rx: "12.6", transform: "rotate(-8 669 415)" })))), /* @__PURE__ */ React.createElement("g", { transform: squash(barSq, 1200, 460, 0.1, 0.14) }, /* @__PURE__ */ React.createElement(
        "polygon",
        {
          points: pts(lerpPoly(A0s, BAR_A, pa)),
          transform: `translate(${-5 * (1 - pa)} ${-10 * (1 - pa) - 34 * Math.sin(Math.PI * pa)})`
        }
      ), /* @__PURE__ */ React.createElement(
        "polygon",
        {
          points: pts(lerpPoly(B0s, BAR_B, pb)),
          transform: `translate(0 ${34 * Math.sin(Math.PI * pb)})`
        }
      ))))), st1.op > 0.01 && st1.len > 2 && /* @__PURE__ */ React.createElement(Streak, { x: 960, y: 490, len: st1.len, op: st1.op, angle: 90, accent }), stA.op > 0.01 && stA.len > 2 && /* @__PURE__ */ React.createElement(Streak, { x: 800, y: 385, len: stA.len, op: stA.op, angle: 49.4, accent }), stB.op > 0.01 && stB.len > 2 && /* @__PURE__ */ React.createElement(Streak, { x: 800, y: 595, len: stB.len, op: stB.op, angle: -49.4, accent }), st3.op > 0.01 && st3.len > 2 && /* @__PURE__ */ React.createElement(Streak, { x: 726, y: 395, len: st3.len, op: st3.op, angle: -48, accent }), showWordmark && wm > 0.01 && /* @__PURE__ */ React.createElement("div", { style: {
        position: "absolute",
        left: 0,
        top: 790,
        width: 1920,
        textAlign: "center",
        fontSize: 84,
        fontWeight: 900,
        letterSpacing: "-1px",
        lineHeight: 1,
        opacity: wm,
        transform: `translateY(${(1 - wm) * 26}px)`
      } }, /* @__PURE__ */ React.createElement("span", { style: { color: accent } }, "AD"), " ", /* @__PURE__ */ React.createElement("span", { style: { color: "#f1f1f1" } }, "SENSEI")));
    }
    function PlaySliceScene(props) {
      const accent = props.accent ?? "#7c3aed";
      const showWordmark = props.showWordmark ?? true;
      const loop = props.loop ?? false;
      const autoplay = props.autoplay ?? true;
      return /* @__PURE__ */ React.createElement(Stage, { width: 1920, height: 1080, duration: 12.5, loop, autoplay, background: "transparent" }, /* @__PURE__ */ React.createElement(Sprite, { start: 0, end: 12.5 }, /* @__PURE__ */ React.createElement(Film, { accent, showWordmark })));
    }
    window.PlaySliceScene = PlaySliceScene;
  })();
})();
