import bcd from "@mdn/browser-compat-data" with { type: "json" };
import corejs3Polyfills from "core-js-compat/data.json" with { type: "json" };
import {
  NEVER_SUPPORTED,
  SINGLETONS,
  bcdSupportToCompat,
  coreJSWebModuleReplacements,
  getWebApis,
} from "../lib/web-apis.js";

const unknown = {
  android: "0",
  chrome: "0",
  deno: "0",
  edge: "0",
  electron: "0",
  firefox: "0",
  ie: "0",
  ios: "0",
  node: "0",
  opera: "0",
  opera_mobile: "0",
  rhino: "0",
  safari: "0",
  samsung: "0",
};

describe("bcdSupportToCompat", () => {
  it("considers features supported when there is no data", () => {
    expect(bcdSupportToCompat({})).toEqual(unknown);
  });

  it("maps BCD browsers to Babel targets", () => {
    expect(
      bcdSupportToCompat({
        safari_ios: { version_added: "13.4" },
        webview_android: { version_added: "66" },
        samsunginternet_android: { version_added: "9.0" },
        opera_android: { version_added: "47" },
        nodejs: { version_added: "18.0.0" },
        firefox_android: { version_added: "1" },
      }),
    ).toEqual({
      ...unknown,
      ios: "13.4",
      android: "66",
      samsung: "9.0",
      opera_mobile: "47",
      node: "18.0.0",
    });
  });

  it("omits targets that don't support the feature", () => {
    const compat = bcdSupportToCompat({
      firefox: { version_added: false },
      safari: { version_added: "preview" },
    });
    expect(compat).not.toHaveProperty("firefox");
    expect(compat).not.toHaveProperty("safari");
  });

  // Babel would otherwise fall back to the Chrome version.
  it("marks features unsupported on Android with a version that never exists", () => {
    const compat = bcdSupportToCompat({
      chrome: { version_added: "89" },
      webview_android: { version_added: false },
    });
    expect(compat.chrome).toBe("89");
    expect(compat.android).toBe(NEVER_SUPPORTED);
  });

  it("uses the upper bound of ranged versions", () => {
    expect(bcdSupportToCompat({ edge: { version_added: "≤18" } }).edge).toBe(
      "18",
    );
  });

  it.each([
    ["flags", { flags: [{ type: "preference", name: "x" }] }],
    ["prefix", { prefix: "webkit" }],
    ["alternative_name", { alternative_name: "webkitFoo" }],
    ["partial_implementation", { partial_implementation: true }],
    ["version_removed", { version_removed: "80" }],
  ])("ignores statements with %s", (_, statement) => {
    expect(
      bcdSupportToCompat({ chrome: { version_added: "50", ...statement } }),
    ).not.toHaveProperty("chrome");
    expect(
      bcdSupportToCompat({
        chrome: [
          { version_added: "90" },
          { version_added: "50", ...statement },
        ],
      }).chrome,
    ).toBe("90");
  });

  it("uses the lowest supported version", () => {
    expect(
      bcdSupportToCompat({
        chrome: [{ version_added: "90" }, { version_added: "80" }],
      }).chrome,
    ).toBe("80");
  });

  it("derives Electron from Chrome", () => {
    expect(bcdSupportToCompat({ chrome: { version_added: "66" } })).toEqual({
      ...unknown,
      chrome: "66",
      electron: "3.0",
    });
    expect(
      bcdSupportToCompat({ chrome: { version_added: false } }),
    ).not.toHaveProperty("electron");
    expect(
      bcdSupportToCompat({ chrome: { version_added: "9999" } }),
    ).not.toHaveProperty("electron");
  });

  it("can ignore data about server runtimes", () => {
    expect(
      bcdSupportToCompat(
        { nodejs: { version_added: false }, deno: { version_added: false } },
        { ignoreServerData: true },
      ),
    ).toEqual(unknown);
  });
});

// This plugin makes some assumptions about the structure of BCD's data:
// these tests make sure that updating BCD doesn't silently break them.
describe("@mdn/browser-compat-data data", () => {
  it("contains all the browsers that are mapped to Babel targets", () => {
    for (const browser of [
      "chrome",
      "deno",
      "edge",
      "firefox",
      "ie",
      "nodejs",
      "opera",
      "opera_android",
      "safari",
      "safari_ios",
      "samsunginternet_android",
      "webview_android",
    ]) {
      expect(bcd.browsers).toHaveProperty([browser]);
    }
  });

  it("describes global functions and static methods as expected", () => {
    expect(bcd.api).toHaveProperty(["fetch", "__compat"]);
    expect(bcd.api).toHaveProperty([
      "Window",
      "requestIdleCallback",
      "__compat",
    ]);
    expect(bcd.api).toHaveProperty(["AbortSignal", "any_static", "__compat"]);
  });

  it("contains the interfaces of all the singletons", () => {
    for (const iface of Object.values(SINGLETONS)) {
      expect(bcd.api).toHaveProperty([iface, "__compat"]);
    }
  });
});

describe("getWebApis", () => {
  const webApis = getWebApis();

  it("defines globals, static properties and properties of singletons", () => {
    expect(webApis.global.ResizeObserver.global).toEqual([
      "web.ResizeObserver",
    ]);
    expect(webApis.global.fetch.global).toEqual(["web.fetch"]);
    expect(webApis.global.requestIdleCallback.global).toEqual([
      "web.Window.requestIdleCallback",
    ]);
    expect(webApis.static.AbortSignal.any.global).toEqual([
      "web.AbortSignal.any_static",
    ]);
    expect(webApis.static.navigator.share.global).toEqual([
      "web.Navigator.share",
    ]);
    for (const name of [
      "web.ResizeObserver",
      "web.fetch",
      "web.Window.requestIdleCallback",
      "web.AbortSignal.any_static",
      "web.Navigator.share",
    ]) {
      expect(webApis.compatData).toHaveProperty([name]);
    }
  });

  it("doesn't define sub-features that are not properties", () => {
    expect(webApis.global).not.toHaveProperty(["ANGLE_instanced_arrays"]);
    expect(webApis.global).not.toHaveProperty(["afterprint_event"]);
    expect(webApis.instance).not.toHaveProperty(["worker_support"]);
    expect(webApis.instance).not.toHaveProperty(["@@iterator"]);
  });

  it("lists all the interfaces with an instance property", () => {
    const { global } = webApis.instance.observe;
    expect(global).toContain("web.ResizeObserver.observe");
    expect(global).toContain("web.IntersectionObserver.observe");
    for (const name of global) {
      expect(webApis.instanceCompatData).toHaveProperty([name]);
    }
  });
});

describe("core-js web modules", () => {
  it("have a replacement for each module", () => {
    expect(Object.keys(coreJSWebModuleReplacements).sort()).toEqual(
      Object.keys(corejs3Polyfills)
        .filter(name => name.startsWith("web."))
        .sort(),
    );
  });

  it("are replaced by existing MDN features", () => {
    const { compatData } = getWebApis();
    for (const names of Object.values(coreJSWebModuleReplacements)) {
      for (const name of names ?? []) {
        expect(compatData).toHaveProperty([name]);
      }
    }
  });
});
