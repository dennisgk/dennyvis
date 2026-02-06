// src/components/GeneralOffscreenCanvas.tsx

import React, { useEffect, useRef } from "react";

export type GeneralPointerPayload = {
  xCss: number;
  yCss: number;
  buttons: number;
  button: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  time: number;
};

export type GeneralWheelPayload = GeneralPointerPayload & {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
};

export type GeneralKeyPayload = {
  key: string;
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  repeat: boolean;
  time: number;
};

export type GeneralEvent =
  | { type: "pointerenter"; payload: GeneralPointerPayload }
  | { type: "pointerleave"; payload: GeneralPointerPayload }
  | { type: "pointermove"; payload: GeneralPointerPayload }
  | { type: "pointerdown"; payload: GeneralPointerPayload }
  | { type: "pointerup"; payload: GeneralPointerPayload }
  | { type: "wheel"; payload: GeneralWheelPayload }
  | { type: "keydown"; payload: GeneralKeyPayload }
  | { type: "keyup"; payload: GeneralKeyPayload };

export type RegisterCanvasFn = (
  offscreen: OffscreenCanvas,
  elem: HTMLCanvasElement,
) => Promise<void>;
export type TickCanvasFn = (events: GeneralEvent[]) => Promise<void>;
export type UnregisterCanvasFn = () => Promise<void>;

export type GeneralOffscreenCanvasProps =
  React.CanvasHTMLAttributes<HTMLCanvasElement> & {
    registerCanvas: RegisterCanvasFn;
    /** Optional: if omitted, no listeners are bound and no RAF loop runs. */
    tickCanvas?: TickCanvasFn;
    unregisterCanvas: UnregisterCanvasFn;
    /** If provided, only these event types will be listened for. If omitted/empty, no events are listened for. */
    events?: Array<GeneralEvent["type"]>;
  };

function getPosCss(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
) {
  const r = canvas.getBoundingClientRect();
  return { xCss: clientX - r.left, yCss: clientY - r.top };
}

export function GeneralOffscreenCanvas(props: GeneralOffscreenCanvasProps) {
  const {
    registerCanvas,
    tickCanvas,
    unregisterCanvas,
    events,
    ...canvasProps
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const aliveRef = useRef<boolean>(false);

  const eventBufRef = useRef<GeneralEvent[]>([]);

  const pushEv = (ev: GeneralEvent) => {
    eventBufRef.current.push(ev);
    if (eventBufRef.current.length > 5000) {
      eventBufRef.current.splice(0, eventBufRef.current.length - 5000);
    }
  };

  const drainEvents = (): GeneralEvent[] => {
    const buf = eventBufRef.current;
    if (buf.length === 0) return [];
    eventBufRef.current = [];
    return buf;
  };

  // Keep latest fns + events without rebinding listeners
  const fnsRef = useRef({
    registerCanvas,
    tickCanvas,
    unregisterCanvas,
    events,
  });
  fnsRef.current = {
    registerCanvas,
    tickCanvas,
    unregisterCanvas,
    events,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    aliveRef.current = true;

    if (!("transferControlToOffscreen" in canvas)) {
      throw new Error(
        "This browser does not support canvas.transferControlToOffscreen()",
      );
    }

    // Transfer once
    const offscreen = canvas.transferControlToOffscreen();

    (async () => {
      await fnsRef.current.registerCanvas(offscreen, canvas);
    })().catch(console.error);

    const hasTick = typeof fnsRef.current.tickCanvas === "function";

    // Only listen / animate if tickCanvas is provided
    if (!hasTick) {
      return () => {
        aliveRef.current = false;
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        fnsRef.current.unregisterCanvas().catch(console.error);
      };
    }

    const shouldListen = (t: GeneralEvent["type"]) =>
      Array.isArray(fnsRef.current.events) && fnsRef.current.events.includes(t);

    const mkPointerPayload = (e: MouseEvent) => {
      const { xCss, yCss } = getPosCss(canvas, e.clientX, e.clientY);
      return {
        xCss,
        yCss,
        buttons: e.buttons ?? 0,
        button: e.button ?? 0,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
        time: performance.now(),
      };
    };

    const onPointerEnter = (e: PointerEvent) => {
      if (!shouldListen("pointerenter")) return;
      pushEv({ type: "pointerenter", payload: mkPointerPayload(e as any) });
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (!shouldListen("pointerleave")) return;
      pushEv({ type: "pointerleave", payload: mkPointerPayload(e as any) });
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!shouldListen("pointermove")) return;
      pushEv({ type: "pointermove", payload: mkPointerPayload(e as any) });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!shouldListen("pointerdown")) return;
      canvas.focus();
      canvas.setPointerCapture?.(e.pointerId);
      pushEv({ type: "pointerdown", payload: mkPointerPayload(e as any) });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!shouldListen("pointerup")) return;
      pushEv({ type: "pointerup", payload: mkPointerPayload(e as any) });
      try {
        canvas.releasePointerCapture?.(e.pointerId);
      } catch {}
    };

    const onWheel = (e: WheelEvent) => {
      if (!shouldListen("wheel")) return;
      const base = mkPointerPayload(e);
      pushEv({
        type: "wheel",
        payload: {
          ...base,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
        },
      });
      e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldListen("keydown")) return;
      pushEv({
        type: "keydown",
        payload: {
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
          repeat: e.repeat,
          time: performance.now(),
        },
      });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!shouldListen("keyup")) return;
      pushEv({
        type: "keyup",
        payload: {
          key: e.key,
          code: e.code,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
          repeat: e.repeat,
          time: performance.now(),
        },
      });
    };

    canvas.addEventListener("pointerenter", onPointerEnter);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);

    canvas.addEventListener("wheel", onWheel, { passive: false });

    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);

    const loop = async () => {
      if (!aliveRef.current) return;

      const evs = drainEvents();
      try {
        // tickCanvas is guaranteed by hasTick
        await fnsRef.current.tickCanvas!(evs);
      } catch (err) {
        console.error(err);
      }

      if (!aliveRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        loop().catch(console.error);
      });
    };

    rafRef.current = requestAnimationFrame(() => {
      loop().catch(console.error);
    });

    return () => {
      aliveRef.current = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);

      canvas.removeEventListener("wheel", onWheel as any);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);

      fnsRef.current.unregisterCanvas().catch(console.error);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} {...canvasProps} />;
}
