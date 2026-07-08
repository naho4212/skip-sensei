// GENERATED from animations.jsx — do not edit. Rebuild: ../node_modules/.bin/esbuild anim/animations.jsx --loader:.jsx=jsx --jsx=transform --format=iife --banner:js="..." --outfile=anim/animations.js
"use strict";
(() => {
  const Easing = {
    linear: (t) => t,
    easeInQuad: (t) => t * t,
    easeOutQuad: (t) => t * (2 - t),
    easeInOutQuad: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    easeInCubic: (t) => t * t * t,
    easeOutCubic: (t) => --t * t * t + 1,
    easeInOutCubic: (t) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
    easeInQuart: (t) => t * t * t * t,
    easeOutQuart: (t) => 1 - --t * t * t * t,
    easeInOutQuart: (t) => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * --t * t * t * t,
    easeInExpo: (t) => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
    easeOutExpo: (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    easeInOutExpo: (t) => {
      if (t === 0) return 0;
      if (t === 1) return 1;
      if (t < 0.5) return 0.5 * Math.pow(2, 20 * t - 10);
      return 1 - 0.5 * Math.pow(2, -20 * t + 10);
    },
    easeInSine: (t) => 1 - Math.cos(t * Math.PI / 2),
    easeOutSine: (t) => Math.sin(t * Math.PI / 2),
    easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    easeOutBack: (t) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    easeInBack: (t) => {
      const c1 = 1.70158, c3 = c1 + 1;
      return c3 * t * t * t - c1 * t * t;
    },
    easeInOutBack: (t) => {
      const c1 = 1.70158, c2 = c1 * 1.525;
      return t < 0.5 ? Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
    },
    easeOutElastic: (t) => {
      const c4 = 2 * Math.PI / 3;
      if (t === 0) return 0;
      if (t === 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
  };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  function interpolate(input, output, ease = Easing.linear) {
    return (t) => {
      if (t <= input[0]) return output[0];
      if (t >= input[input.length - 1]) return output[output.length - 1];
      for (let i = 0; i < input.length - 1; i++) {
        if (t >= input[i] && t <= input[i + 1]) {
          const span = input[i + 1] - input[i];
          const local = span === 0 ? 0 : (t - input[i]) / span;
          const easeFn = Array.isArray(ease) ? ease[i] || Easing.linear : ease;
          const eased = easeFn(local);
          return output[i] + (output[i + 1] - output[i]) * eased;
        }
      }
      return output[output.length - 1];
    };
  }
  function animate({ from = 0, to = 1, start = 0, end = 1, ease = Easing.easeInOutCubic }) {
    return (t) => {
      if (t <= start) return from;
      if (t >= end) return to;
      const local = (t - start) / (end - start);
      return from + (to - from) * ease(local);
    };
  }
  const TimelineContext = React.createContext({ time: 0, duration: 10, playing: false });
  const useTime = () => React.useContext(TimelineContext).time;
  const useTimeline = () => React.useContext(TimelineContext);
  const SpriteContext = React.createContext({ localTime: 0, progress: 0, duration: 0 });
  const useSprite = () => React.useContext(SpriteContext);
  function Sprite({ start = 0, end = Infinity, children, keepMounted = false }) {
    const { time } = useTimeline();
    const visible = time >= start && time <= end;
    if (!visible && !keepMounted) return null;
    const duration = end - start;
    const localTime = Math.max(0, time - start);
    const progress = duration > 0 && isFinite(duration) ? clamp(localTime / duration, 0, 1) : 0;
    const value = { localTime, progress, duration, visible };
    return /* @__PURE__ */ React.createElement(SpriteContext.Provider, { value }, typeof children === "function" ? children(value) : children);
  }
  function useInlineFontsInto(svgRef) {
    React.useEffect(() => {
      const svg = svgRef.current;
      const host = svg && svg.querySelector("foreignObject > div");
      if (!svg || !host) return;
      let cancelled = false;
      (async () => {
        const rules = [];
        for (const ss of document.styleSheets) {
          let cssRules;
          try {
            cssRules = ss.cssRules;
          } catch {
            if (ss.href) {
              try {
                const txt = await fetch(ss.href).then((r) => {
                  if (!r.ok) throw 0;
                  return r.text();
                });
                for (const ff of txt.match(/@font-face\s*{[^}]*}/g) || [])
                  rules.push({ css: ff, base: ss.href });
              } catch {
              }
            }
            continue;
          }
          if (!cssRules) continue;
          for (const r of cssRules) {
            if (r.type === CSSRule.FONT_FACE_RULE) rules.push({ css: r.cssText, base: ss.href || location.href });
          }
        }
        const toDataURL = (url) => fetch(url).then((r) => {
          if (!r.ok) throw 0;
          return r.blob();
        }).then((b) => new Promise((res) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => res(url);
          fr.readAsDataURL(b);
        })).catch(() => url);
        const parts = await Promise.all(rules.map(async ({ css, base }) => {
          const re = /url\((['"]?)([^'")]+)\1\)/g;
          let out = css, m;
          while (m = re.exec(css)) {
            const u = m[2];
            if (u.startsWith("data:")) continue;
            let abs;
            try {
              abs = new URL(u, base).href;
            } catch {
              continue;
            }
            out = out.split(m[0]).join(`url("${await toDataURL(abs)}")`);
          }
          return out;
        }));
        if (cancelled || !parts.length) {
          svg.setAttribute("data-om-fonts-inlined", "true");
          return;
        }
        const style = document.createElement("style");
        style.textContent = parts.join("\n");
        host.insertBefore(style, host.firstChild);
        svg.setAttribute("data-om-fonts-inlined", "true");
      })();
      return () => {
        cancelled = true;
      };
    }, []);
  }
  function Stage({
    width = 1280,
    height = 720,
    duration = 10,
    background = "#f6f4ef",
    fps = 60,
    loop = true,
    autoplay = true,
    persistKey = "animstage",
    children
  }) {
    width = +width || 1280;
    height = +height || 720;
    duration = +duration || 10;
    fps = +fps || 60;
    if (typeof loop === "string") loop = loop !== "false";
    if (typeof autoplay === "string") autoplay = autoplay !== "false";
    const [time, setTime] = React.useState(0);
    const [playing, setPlaying] = React.useState(autoplay);
    const [scale, setScale] = React.useState(1);
    const stageRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const rafRef = React.useRef(null);
    const lastTsRef = React.useRef(null);
    React.useEffect(() => {
      if (!stageRef.current) return;
      const el = stageRef.current;
      const measure = () => {
        const s = Math.min(el.clientWidth / width, el.clientHeight / height);
        setScale(Math.max(0.05, s));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      window.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
      };
    }, [width, height]);
    React.useEffect(() => {
      if (!playing) {
        lastTsRef.current = null;
        return;
      }
      const step = (ts) => {
        if (lastTsRef.current == null) lastTsRef.current = ts;
        const dt = (ts - lastTsRef.current) / 1e3;
        lastTsRef.current = ts;
        setTime((t) => {
          let next = t + dt;
          if (next >= duration) {
            if (loop) next = next % duration;
            else {
              next = duration;
              setPlaying(false);
            }
          }
          return next;
        });
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        lastTsRef.current = null;
      };
    }, [playing, duration, loop]);
    useInlineFontsInto(canvasRef);
    const ctxValue = React.useMemo(
      () => ({ time, duration, playing, setTime, setPlaying }),
      [time, duration, playing]
    );
    return /* @__PURE__ */ React.createElement("div", { ref: stageRef, style: {
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      overflow: "hidden"
    } }, /* @__PURE__ */ React.createElement(
      "svg",
      {
        ref: canvasRef,
        width,
        height,
        "data-om-exportable-video-with-duration-secs": duration,
        style: { transform: `scale(${scale})`, transformOrigin: "center", flexShrink: 0, display: "block" }
      },
      /* @__PURE__ */ React.createElement("foreignObject", { x: "0", y: "0", width: "100%", height: "100%" }, /* @__PURE__ */ React.createElement(
        "div",
        {
          xmlns: "http://www.w3.org/1999/xhtml",
          style: { width, height, background, position: "relative", overflow: "hidden" }
        },
        /* @__PURE__ */ React.createElement(TimelineContext.Provider, { value: ctxValue }, children)
      ))
    ));
  }
  Object.assign(window, {
    Easing,
    interpolate,
    animate,
    clamp,
    TimelineContext,
    useTime,
    useTimeline,
    Sprite,
    SpriteContext,
    useSprite,
    Stage
  });
})();
