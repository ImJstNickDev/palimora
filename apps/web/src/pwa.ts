let registration: ServiceWorkerRegistration | undefined;
let registering: Promise<void> | undefined;
export type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
let installPrompt: InstallPrompt | undefined;
export const availableInstall = () => installPrompt;
export const availableUpdate = () => registration?.waiting;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
  window.dispatchEvent(new Event("pwa-change"));
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  window.dispatchEvent(new Event("pwa-change"));
});
export async function installApp() {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = undefined;
  window.dispatchEvent(new Event("pwa-change"));
}
async function register() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (controlled) location.reload();
    controlled = true;
  });
  registration = await navigator.serviceWorker.getRegistration();
  if (!registration || navigator.onLine) {
    try {
      registration = await navigator.serviceWorker.register("/push-worker.js", {
        updateViaCache: "none",
      });
    } catch (e) {
      if (!registration) throw e;
    }
  }
  registration.addEventListener("updatefound", () => {
    registration?.installing?.addEventListener("statechange", () =>
      window.dispatchEvent(new Event("pwa-change")),
    );
  });
  window.dispatchEvent(new Event("pwa-change"));
  window.addEventListener(
    "online",
    () => void registration?.update().catch(() => {}),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine)
      void registration?.update().catch(() => {});
  });
}
export async function appReady() {
  if (!import.meta.env.PROD) throw Error("OFFLINE_BUILD_REQUIRED");
  if (!("serviceWorker" in navigator)) throw Error("OFFLINE_UNSUPPORTED");
  await registerApp();
  const installing = registration?.installing;
  if (
    installing &&
    !["installed", "activated", "redundant"].includes(installing.state)
  )
    await new Promise<void>((resolve, reject) => {
      installing.addEventListener("statechange", () => {
        if (installing.state === "redundant")
          reject(Error("OFFLINE_UNSUPPORTED"));
        else if (["installed", "activated"].includes(installing.state))
          resolve();
      });
    });
  if (registration?.waiting) throw Error("OFFLINE_UPDATE_REQUIRED");
  await navigator.serviceWorker.ready;
}
export function activateUpdate() {
  registration?.waiting?.postMessage("ACTIVATE_UPDATE");
}

export function registerApp() {
  return (registering ??= register().catch((e) => {
    registering = undefined;
    throw e;
  }));
}
