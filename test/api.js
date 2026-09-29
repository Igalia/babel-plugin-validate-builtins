import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSync,
  transformAsync,
  transformFromAstSync,
  transformSync,
} from "@babel/core";
import validateBuiltins from "@igalia/babel-plugin-validate-builtins";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function babelOptions(options = {}, targets = { chrome: "90" }, rest = {}) {
  return {
    configFile: false,
    babelrc: false,
    filename: "input.js",
    ...(targets && { targets }),
    plugins: [[validateBuiltins, options]],
    ...rest,
  };
}

function transform(code, options, targets, rest) {
  return transformSync(code, babelOptions(options, targets, rest)).code;
}

function getError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error to be thrown");
}

const countReports = message => message.match(/is not supported/g).length;

describe("@igalia/babel-plugin-validate-builtins", () => {
  it("does not modify the input code", () => {
    const code = "new Map();\n[1, 2].map(x => x);\nObject.entries(o);";
    expect(transform(code)).toBe(code);
  });

  describe("error message", () => {
    it("reports the location of the unsupported built-in", () => {
      const { message } = getError(() =>
        transform("const a = 1;\nconst b = Object.hasOwn(a, 'x');"),
      );
      expect(message).toContain(
        "> 2 | const b = Object.hasOwn(a, 'x');\n" +
          "    |           ^^^^^^^^^^^^^",
      );
    });

    it("reports all the unsupported built-ins in a file, sorted", () => {
      const { message } = getError(() =>
        transform("arr.findLast(x => x);\nObject.hasOwn(a, b);\nnew Map();"),
      );
      const findLast = message.indexOf(".findLast is not supported");
      const hasOwn = message.indexOf("Object.hasOwn is not supported");
      expect(findLast).toBeGreaterThan(-1);
      expect(hasOwn).toBeGreaterThan(findLast);
      expect(countReports(message)).toBe(2);
      expect(message).toContain("> 1 | arr.findLast(x => x);");
      expect(message).toContain("> 2 | Object.hasOwn(a, b);");
      expect(message.match(/"exclude" option/g)).toHaveLength(1);
    });

    it("prefixes each error with the core-js modules to exclude", () => {
      expect(() => transform("Object.hasOwn(a, b);")).toThrow(
        "[es.object.has-own] Object.hasOwn is not supported by your targets",
      );
      expect(() => transform("x.includes(y);", {}, { chrome: "50" })).toThrow(
        "[es.array.includes, es.string.includes] .includes is not supported",
      );
    });
  });

  describe("exclude", () => {
    it("supports RegExp patterns", () => {
      const code = "Object.hasOwn(a, b);\narr.findLast(x => x);";
      expect(
        transform(code, {
          exclude: [/^es\.object\./, /^es\.array\.find-last$/],
        }),
      ).toBe(code);
    });

    it("only allows the excluded built-ins", () => {
      const { message } = getError(() =>
        transform("Object.hasOwn(a, b);\narr.findLast(x => x);", {
          exclude: ["es.object.has-own"],
        }),
      );
      expect(message).toContain(".findLast is not supported");
      expect(message).not.toContain("Object.hasOwn is not supported");
    });
  });

  describe("per-file state", () => {
    it("reports each usage only once, even if it is visited multiple times", () => {
      // A plugin that requeues nodes, so that they are visited again.
      const requeue = () => ({
        visitor: {
          CallExpression(path) {
            if (path.node._requeued) return;
            path.node._requeued = true;
            path.requeue();
          },
        },
      });
      const { message } = getError(() =>
        transform("Object.hasOwn(a, b);", {}, undefined, {
          plugins: [requeue, validateBuiltins],
        }),
      );
      expect(countReports(message)).toBe(1);
    });

    it("resets the state between files", () => {
      const options = babelOptions();
      expect(() => transformSync("Object.hasOwn(a, b);", options)).toThrow();
      expect(transformSync("Object.entries(a);", options).code).toBe(
        "Object.entries(a);",
      );
      const { message } = getError(() =>
        transformSync("arr.findLast(x => x);", options),
      );
      expect(message).not.toContain("Object.hasOwn is not supported");
    });

    it("works with concurrent async transforms", async () => {
      const results = await Promise.allSettled([
        transformAsync("Object.hasOwn(a, b);", babelOptions()),
        transformAsync("arr.findLast(x => x);", babelOptions()),
        transformAsync("Object.entries(a);", babelOptions()),
      ]);
      expect(results.map(r => r.status)).toEqual([
        "rejected",
        "rejected",
        "fulfilled",
      ]);
      expect(countReports(results[0].reason.message)).toBe(1);
      expect(results[0].reason.message).toContain("Object.hasOwn");
      expect(countReports(results[1].reason.message)).toBe(1);
      expect(results[1].reason.message).toContain(".findLast");
    });

    it("works when reusing the same AST", () => {
      const code = "arr.findLast(x => x);";
      const ast = parseSync(code, { configFile: false, babelrc: false });
      const options = babelOptions({}, undefined, { cloneInputAst: false });
      for (let i = 0; i < 2; i++) {
        expect(() => transformFromAstSync(ast, code, options)).toThrow(
          ".findLast is not supported",
        );
      }
    });
  });

  describe("code injected by other plugins", () => {
    it("is not validated", () => {
      const inject = ({ template }) => ({
        visitor: {
          Program(path) {
            path.unshiftContainer(
              "body",
              template.statement.ast`
              Object.hasOwn(a, b);
            `,
            );
          },
        },
      });
      const { message } = getError(() =>
        transform("arr.findLast(x => x);", {}, undefined, {
          plugins: [inject, validateBuiltins],
        }),
      );
      expect(countReports(message)).toBe(1);
      expect(message).toContain(".findLast");
    });

    it("does not include @babel/preset-env helpers", () => {
      const { message } = getError(() =>
        transform(
          "class A { #x; m() { return #x in this; } }\n" +
            "[...b];\n" +
            "a.findLast(...args);\n" +
            "async function f() {}",
          {},
          { chrome: "40" },
          { presets: ["@babel/preset-env"] },
        ),
      );
      expect(countReports(message)).toBe(1);
      expect(message).toContain(".findLast");
    });
  });

  describe("targets", () => {
    it("can be read from a browserslist config", () => {
      const configPath = path.join(dirname, "browserslist");
      const code = "Object.hasOwn(a, b);";
      // browserslist/.browserslistrc contains "chrome 90"
      expect(() => transform(code, { configPath }, null)).toThrow(
        "Object.hasOwn is not supported by your targets (chrome 90,",
      );
    });

    it("uses browserslist's defaults when there are no targets", () => {
      expect(() => transform("Math.signbit(x);", {}, null)).toThrow(
        "Math.signbit is not supported by your targets",
      );
    });

    it("throws when there are no targets at all", () => {
      expect(() =>
        transform("a;", {}, null, { browserslistConfigFile: false }),
      ).toThrow("could not find any target to validate against");
    });
  });

  it("only supports Babel 8", () => {
    expect(() =>
      validateBuiltins({
        assertVersion: () => {
          throw new Error("Unsupported Babel version");
        },
      }),
    ).toThrow("Unsupported Babel version");
  });
});
