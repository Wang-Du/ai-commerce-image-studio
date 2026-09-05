import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesUrl = new URL("../styles.css", import.meta.url);

test("desktop layout does not force a viewport wider than the browser", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.doesNotMatch(styles, /html,\s*body\s*\{[^}]*min-width:\s*1180px/s);
  assert.match(styles, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(styles, /\.workspace\s*\{[^}]*grid-template-columns:\s*380px\s+minmax\(0,\s*1fr\)/s);
});
