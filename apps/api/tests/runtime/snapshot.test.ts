import { expect, test } from "vitest";
import { sourceHash } from "../../src/runtime/generation.js";

test("source identity uses the versioned canonical snapshot regardless of enumeration order", () => {
  const files = [
    {
      path: "b.ts",
      content: Buffer.from("hello"),
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    },
    {
      path: "a.ts",
      content: Buffer.from(""),
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  ];
  expect(sourceHash(files)).toBe(
    "b637c44e352e71e9178896abdbab85380f33feecbf7c2df0b1486f9975f6db8c",
  );
  expect(sourceHash([...files].reverse())).toBe(sourceHash(files));
});
