import { createHash, timingSafeEqual } from "node:crypto";

function hashBridgeSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function bridgeSecretMatches(expectedSecret: string, receivedSecret: string): boolean {
  if (!expectedSecret || !receivedSecret) return false;
  const expectedHash = hashBridgeSecret(expectedSecret);
  const receivedHash = hashBridgeSecret(receivedSecret);
  return timingSafeEqual(expectedHash, receivedHash);
}
