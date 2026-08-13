import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestServer, type TestServer } from "./helpers/server.js";

const TRUSTED_PROXY_ENV = {
  HOST: "127.0.0.1",
  TRUSTED_PROXY_EMAIL_HEADER: "X-Forwarded-Email",
  SIGNUP_MODE: "open",
};

let server: TestServer;

afterEach(() => {
  server?.close();
});

describe("an instance with no trusted proxy configured", () => {
  beforeEach(() => {
    server = createTestServer({ SIGNUP_MODE: "open" });
  });

  it("ignores the header entirely", async () => {
    const response = await server.request("/api/auth/me", {
      headers: { "X-Forwarded-Email": "someone@example.com" },
    });
    expect(response.status).toBe(401);
  });

  it("reports its own accounts system as available", async () => {
    const response = await server.request("/api/auth/methods");
    expect(await response.json()).toMatchObject({
      emailCode: true,
      trustedProxy: false,
    });
  });
});

describe("an instance delegating sign-in to a trusted proxy", () => {
  beforeEach(() => {
    server = createTestServer(TRUSTED_PROXY_ENV);
  });

  it("signs in and provisions an account from the header alone", async () => {
    const response = await server.request("/api/auth/me", {
      headers: { "X-Forwarded-Email": "person@example.com" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: "person@example.com",
    });
    expect(response.headers.get("set-cookie")).toContain("oa_session=");
  });

  it("leaves the request unauthenticated when the header is absent", async () => {
    const response = await server.request("/api/auth/me");
    expect(response.status).toBe(401);
  });

  it("reuses the same account across requests rather than making a new one each time", async () => {
    const first = await server.request("/api/auth/me", {
      headers: { "X-Forwarded-Email": "person@example.com" },
    });
    const second = await server.request("/api/auth/me", {
      headers: { "X-Forwarded-Email": "person@example.com" },
    });

    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const count = server.database.raw
      .prepare("select count(*) as count from users")
      .get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it("does not mint a fresh session when a valid one is already attached", async () => {
    const signedIn = await server.request("/api/auth/me", {
      headers: { "X-Forwarded-Email": "person@example.com" },
    });
    const cookie =
      (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // Present both the cookie the header already minted and the header again:
    // attachUser resolves the cookie first, so trustProxyHeader should no-op.
    const response = await server.request("/api/auth/me", {
      headers: { Cookie: cookie, "X-Forwarded-Email": "person@example.com" },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("never trusts the header on /mcp, matching attachUser", async () => {
    const response = await server.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Email": "person@example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reports itself in /api/auth/methods and hides the accounts this instance does not offer", async () => {
    const response = await server.request("/api/auth/methods");
    expect(await response.json()).toMatchObject({
      emailCode: false,
      google: false,
      trustedProxy: true,
    });
  });

  it("refuses to send a sign-in code rather than fail on an absent mail server", async () => {
    const response = await server.request("/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuses to exchange a code for a CLI token", async () => {
    const response = await server.request("/api/auth/cli-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", code: "123456" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuses to start a Google sign-in even if credentials happen to be set", async () => {
    const withGoogle = createTestServer({
      ...TRUSTED_PROXY_ENV,
      GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    try {
      const response = await withGoogle.request("/auth/google/start", {
        redirect: "manual",
      });
      expect(response.status).toBe(404);
    } finally {
      withGoogle.close();
    }
  });
});
