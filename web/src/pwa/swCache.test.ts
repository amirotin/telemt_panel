import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const script = readFileSync("public/sw.js", "utf8");

function cacheStorage(beforeWrite?: () => Promise<void>) {
  const entries = new Map<string, Map<string, Response>>();
  async function open(name: string) {
    if (!entries.has(name)) entries.set(name, new Map());
    const data = entries.get(name)!;
    return {
      addAll: async () => {},
      match: async (request: Request) => data.get(request.url),
      put: async (request: Request, response: Response) => {
        await beforeWrite?.();
        data.set(request.url, response);
      },
    };
  }
  return {
    open,
    keys: async () => [...entries.keys()],
    delete: async (key: string) => entries.delete(key),
    match: async (request: Request) => {
      for (const cache of entries.values())
        if (cache.has(request.url)) return cache.get(request.url);
      return undefined;
    },
  };
}

function worker(scope: string, caches: ReturnType<typeof cacheStorage>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const origin = "https://example.org";
  runInNewContext(script, {
    URL,
    caches,
    fetch: async () => new Response(scope),
    self: {
      registration: { scope: origin + scope },
      location: { origin },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
    },
  });
  return {
    lifecycle(name: string) {
      let task: Promise<void> | undefined;
      listeners.get(name)!({
        waitUntil: (result: Promise<void>) => {
          task = result;
        },
      });
      return task;
    },
    fetch(path: string) {
      let result: Promise<Response> | undefined;
      listeners.get("fetch")!({
        request: new Request(origin + path),
        waitUntil: (task: Promise<void>) => {
          void task;
        },
        respondWith: (value: Promise<Response>) => {
          result = value;
        },
      });
      return result;
    },
  };
}

it("keeps unrelated and sibling caches during activation and reads only its own cache", async () => {
  const caches = cacheStorage();
  const first = worker("/first/", caches),
    second = worker("/second/", caches);
  const foreign = await caches.open("other-application");
  await foreign.put(new Request("https://example.org/first/assets/main.js"), new Response("other"));
  await first.lifecycle("install");
  const ownName = (await caches.keys()).find((name) => name !== "other-application")!;
  const obsoleteName = ownName.replace(/v\d+$/, "v0");
  await caches.open(obsoleteName);
  await second.lifecycle("install");
  await first.lifecycle("activate");
  expect(await caches.keys()).toHaveLength(3);
  expect(await caches.keys()).not.toContain(obsoleteName);
  expect(await (await first.fetch("/first/assets/main.js"))!.text()).toBe("/first/");
  expect(second.fetch("/first/assets/main.js")).toBeUndefined();
});

it.each(["/", "/panel/"])("routes live and shell requests under %s", async (scope) => {
  const sw = worker(scope, cacheStorage());
  expect(sw.fetch(scope + "api/users")).toBeUndefined();
  expect(sw.fetch(scope + "sub/token")).toBeUndefined();
  for (const path of ["", "assets/main.js", "apikey", "subway", "manifest.webmanifest", "people"]) {
    expect(await (await sw.fetch(scope + path))!.text()).toBe(scope);
  }
});

it.each(["/panel/assets/app.js", "/panel/people"])(
  "streams a successful response while its cache write is still running: %s",
  async (path) => {
    let acknowledge!: () => void, finish!: () => void;
    const writing = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sw = worker(
      "/panel/",
      cacheStorage(async () => {
        acknowledge();
        await ready;
      }),
    );
    let delivered = false;
    const request = sw.fetch(path)!.then((response) => {
      delivered = response.ok;
    });
    try {
      await writing;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(delivered).toBe(true);
    } finally {
      finish();
      await request;
    }
  },
);
