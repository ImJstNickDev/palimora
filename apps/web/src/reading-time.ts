import { useEffect } from "react";
import { call } from "./api";
export function useReadingTime(id: string) {
  useEffect(() => {
    let activeAt = Date.now(),
      frameDoc: Document | null = null;
    const active = () => {
      activeAt = Date.now();
    };
    for (const type of ["pointerdown", "keydown", "scroll"])
      window.addEventListener(type, active, true);
    const stop = () => {
      void call(
        "readingHeartbeat",
        { id, requestId: crypto.randomUUID(), active: false },
        { keepalive: true },
      ).catch(() => {});
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") stop();
    };
    const blur = () => {
      if (!document.hasFocus()) stop();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", stop);
    const timer = setInterval(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".reader-frame"),
        doc = frame?.contentDocument;
      if (doc && doc !== frameDoc) {
        if (frameDoc)
          for (const type of ["pointerdown", "keydown", "scroll"])
            frameDoc.removeEventListener(type, active, true);
        frameDoc = doc;
        for (const type of ["pointerdown", "keydown", "scroll"])
          doc.addEventListener(type, active, true);
      }
      const rect = frame?.getBoundingClientRect();
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        Date.now() - activeAt < 60000 &&
        rect &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      )
        void call("readingHeartbeat", {
          id,
          requestId: crypto.randomUUID(),
        }).catch(() => {});
    }, 15000);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", stop);
      stop();
      clearInterval(timer);
      for (const type of ["pointerdown", "keydown", "scroll"]) {
        window.removeEventListener(type, active, true);
        frameDoc?.removeEventListener(type, active, true);
      }
    };
  }, [id]);
}
