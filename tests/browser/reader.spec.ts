import { test, expect } from "@playwright/test";
import { readerDocument, safeHtml } from "../../apps/api/src/reader-safety";
test("isolated work styles cannot change the shell or execute imported scripts", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  const doc = readerDocument(
    safeHtml(
      '<script>parent.document.body.id="owned"</script><p style="color:black!important;background:white!important" onclick="alert(1)">Chapter text</p><img src="https://tracker.invalid/x">',
    ),
    'body{background-color:#ffffff;text-align:justify;margin:2%;color:red}#workskin p{color:black!important;background:white!important} @import "https://tracker.invalid/css"; p{background:url(https://tracker.invalid/a)}',
    { theme: "dark" },
  );
  await page.setContent(
    '<main style="color:rgb(0, 0, 0)">Library</main><iframe sandbox="allow-popups"></iframe>',
  );
  await page
    .locator("iframe")
    .evaluate(
      (frame, html) => ((frame as HTMLIFrameElement).srcdoc = html),
      doc,
    );
  await expect(
    page.frameLocator("iframe").getByText("Chapter text"),
  ).toBeVisible();
  await expect(page.frameLocator("iframe").locator("html")).toHaveCSS(
    "background-color",
    "rgb(32, 39, 46)",
  );
  await expect(page.frameLocator("iframe").locator("body")).toHaveCSS(
    "background-color",
    "rgb(32, 39, 46)",
  );
  await expect(page.frameLocator("iframe").getByText("Chapter text")).toHaveCSS(
    "color",
    "rgb(233, 231, 225)",
  );
  await expect(page.frameLocator("iframe").getByText("Chapter text")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator("main")).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(page.locator("body")).not.toHaveAttribute("id", "owned");
  expect(requested.filter((url) => url.includes("tracker.invalid"))).toEqual(
    [],
  );
});
