import test from "node:test";
import assert from "node:assert/strict";
import {
  safeHtml,
  safeCss,
  readerDocument,
} from "../apps/api/src/reader-safety";
test("reader removes executable markup, network resources and CSS fetches", () => {
  const html = safeHtml(
    '<script>alert(1)</script><form action="/admin"><input></form><svg onload="alert(1)"></svg><img src="https://tracker.test/a"><p onclick="x()">safe <a href="javascript:alert(1)">link</a></p><iframe src="/admin"></iframe>',
  );
  assert.doesNotMatch(
    html,
    /<script|<form|<input|<svg|<iframe|onclick|javascript:|https:\/\/tracker/,
  );
  assert.match(html, /safe/);
  assert.doesNotMatch(
    safeHtml(
      "<html><head><title>Document heading</title></head><body><h2>Chapter heading</h2></body></html>",
    ),
    /Document heading/,
  );
  assert.doesNotMatch(
    safeCss(
      '@import "https://tracker.test"; p{background:url(https://tracker.test);color:red;behavior:url(x)}',
    ),
    /https:|url\(|behavior|@import/,
  );
  assert.match(safeCss("p{color:red}"), /color:red/);
  assert.doesNotMatch(
    readerDocument(
      "<p>text</p>",
      'p{font-family:"</style><script>bad</script>"}',
    ),
    /<script>/,
  );
});

test("reader declares language and escapes its HTML attribute", () => {
  assert.match(
    readerDocument("<p>text</p>", "", { language: "it" }),
    /<html lang="it"/,
  );
  assert.match(readerDocument("<p>text</p>", ""), /<html lang="und"/);
  assert.doesNotMatch(
    readerDocument("<p>text</p>", "", { language: '\" onload=\"bad' }),
    /lang="" onload/,
  );
});
