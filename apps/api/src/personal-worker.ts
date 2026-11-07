import { processPersonalEvents } from "./personal-notifications";
import { deliverPush } from "./web-push";
let timer: NodeJS.Timeout | undefined, active: Promise<void> | undefined;
export function startPersonalWorker(mode: "events" | "push" = "events") {
  timer = setInterval(() => {
    if (active) return;
    active = (mode === "events" ? processPersonalEvents() : deliverPush())
      .catch(() => {
        console.error(
          JSON.stringify({
            event:
              mode === "events"
                ? "personal_events_retry"
                : "personal_push_retry",
          }),
        );
      })
      .finally(() => {
        active = undefined;
      });
  }, 2000);
  timer.unref();
}
export async function stopPersonalWorker() {
  if (timer) clearInterval(timer);
  await active;
}
