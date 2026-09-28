import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Clerk's side of authentication: an RSA key pair, a JWKS
 * endpoint serving its public half, and a signer for session tokens. The API
 * verifies these exactly as it verifies Clerk's — same fetch of the JWKS,
 * same RS256 check, same issuer and expiry rules — so auth is exercised, not
 * mocked.
 */
export const TEST_ISSUER = "https://clerk.integration.test";
const KID = "integration-test-key";

let privateKey: CryptoKey;
let server: Server;

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(bytes).toString("base64url");
}

/** Start the key server and return its JWKS URL. */
export async function startClerk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as { privateKey: CryptoKey; publicKey: CryptoKey };
  privateKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });

  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/.well-known/jwks.json`;
}

export async function stopClerk(): Promise<void> {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
}

/** A session token for `sub`, signed like Clerk's. */
export async function tokenFor(
  sub: string,
  overrides: { iss?: string; expiresInSec?: number } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub,
      iss: overrides.iss ?? TEST_ISSUER,
      iat: now,
      nbf: now - 5,
      exp: now + (overrides.expiresInSec ?? 300),
    })
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`))
  );
  return `${header}.${payload}.${b64url(signature)}`;
}
