const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");

const FEATURE_ENV_NAMES = [
  "BROWSERBASE_PROXY_ENABLED",
  "BROWSERBASE_VERIFIED",
  "BROWSERBASE_SOLVE_CAPTCHAS",
];

const originalFetch = global.fetch;

function resetEnvironment() {
  process.env.BROWSERBASE_API_KEY = "bb_test_placeholder";
  process.env.BROWSERBASE_PROJECT_ID = "project-placeholder";
  for (const name of FEATURE_ENV_NAMES) {
    delete process.env[name];
  }
}

function mockSessionApi() {
  let createRequest;

  global.fetch = async (url, options = {}) => {
    if (url === "https://api.browserbase.com/v1/sessions" && options.method === "POST") {
      createRequest = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          id: "session-placeholder",
          status: "RUNNING",
          connectUrl: "wss://connect.example.test",
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }

    if (
      url === "https://api.browserbase.com/v1/sessions/session-placeholder/debug" &&
      options.method === "GET"
    ) {
      return new Response(
        JSON.stringify({ debuggerFullscreenUrl: "https://debug.example.test" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
  };

  return () => createRequest;
}

afterEach(() => {
  global.fetch = originalFetch;
  resetEnvironment();
});

test("preserves the existing session payload when feature flags are unset", async () => {
  resetEnvironment();
  const getCreateRequest = mockSessionApi();
  const { BrowserbaseClient } = require("../dist/main/browserbase.js");

  await new BrowserbaseClient().createSession();

  assert.deepEqual(getCreateRequest(), {
    projectId: "project-placeholder",
    browserSettings: { stealth: true },
  });
});

test("maps protected-site environment flags to Browserbase session options", async () => {
  resetEnvironment();
  process.env.BROWSERBASE_PROXY_ENABLED = "true";
  process.env.BROWSERBASE_VERIFIED = "1";
  process.env.BROWSERBASE_SOLVE_CAPTCHAS = "yes";
  const getCreateRequest = mockSessionApi();
  const { BrowserbaseClient } = require("../dist/main/browserbase.js");

  await new BrowserbaseClient().createSession({
    browserSettings: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    },
  });

  assert.deepEqual(getCreateRequest(), {
    projectId: "project-placeholder",
    proxies: true,
    browserSettings: {
      stealth: true,
      verified: true,
      solveCaptchas: true,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    },
  });
});

test("explicit session options override environment flags", async () => {
  resetEnvironment();
  process.env.BROWSERBASE_PROXY_ENABLED = "true";
  process.env.BROWSERBASE_VERIFIED = "true";
  process.env.BROWSERBASE_SOLVE_CAPTCHAS = "true";
  const getCreateRequest = mockSessionApi();
  const { BrowserbaseClient } = require("../dist/main/browserbase.js");

  await new BrowserbaseClient().createSession({
    proxies: false,
    browserSettings: {
      stealth: false,
      verified: false,
      solveCaptchas: false,
    },
  });

  assert.deepEqual(getCreateRequest(), {
    projectId: "project-placeholder",
    proxies: false,
    browserSettings: {
      stealth: false,
      verified: false,
      solveCaptchas: false,
    },
  });
});

test("rejects invalid boolean feature flags before creating a session", async () => {
  resetEnvironment();
  process.env.BROWSERBASE_VERIFIED = "sometimes";
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  };
  const { BrowserbaseClient } = require("../dist/main/browserbase.js");

  await assert.rejects(
    new BrowserbaseClient().createSession(),
    /BROWSERBASE_VERIFIED must be one of/
  );
  assert.equal(fetchCalled, false);
});
