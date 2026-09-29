import corejs3Polyfills from "core-js-compat/data.json" with { type: "json" };
import { isRequired } from "@babel/helper-compilation-targets";
import { complianceFixes, obsoleteProposals } from "../lib/ignored-modules.js";

describe("core-js-compat data", () => {
  it("contains all the ignored modules", () => {
    for (const name of [...complianceFixes, ...obsoleteProposals]) {
      expect(corejs3Polyfills).toHaveProperty([name]);
    }
  });

  // When this snapshot changes after updating core-js-compat, check whether
  // any of the new modules only fixes compliance bugs in built-ins that have
  // been available since ES5, and add it to src/ignored-modules.ts.
  it("has not changed the list of modules", () => {
    expect(Object.keys(corejs3Polyfills).sort()).toMatchSnapshot();
  });

  // Some fixtures check that we don't report a built-in's dependencies: they
  // are only meaningful if those dependencies are unsupported.
  it.each([
    ["es.map.group-by", { chrome: "100.0.0" }],
    ["es.set.union.v2", { chrome: "100.0.0" }],
    ["es.iterator.map", { chrome: "100.0.0" }],
    ["es.iterator.filter", { chrome: "100.0.0" }],
    ["es.typed-array.with", { chrome: "100.0.0" }],
  ])("%s is not supported by %j", (name, targets) => {
    expect(isRequired(name, targets, { compatData: corejs3Polyfills })).toBe(
      true,
    );
  });
});
