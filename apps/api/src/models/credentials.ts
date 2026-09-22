import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApiFailure } from "../routes/errors.js";

export interface CredentialScope { ownerId: string; profileId: string; version: number }
export interface SealedCredential { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }

export function createCredentialVault(encodedMasterKey: string) {
  const masterKey = Buffer.from(encodedMasterKey, "base64");
  if (masterKey.byteLength !== 32 || masterKey.toString("base64") !== encodedMasterKey) {
    throw new ApiFailure(503, "MODEL_CONFIGURATION_MISSING", "模型凭据服务尚未配置。", false);
  }
  const aad = (scope: CredentialScope) => Buffer.from(`pivloom:model:v1:${scope.ownerId}:${scope.profileId}:${scope.version}`, "utf8");
  return {
    seal(apiKey: string, scope: CredentialScope): SealedCredential {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
      cipher.setAAD(aad(scope));
      const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
      return { ciphertext, nonce, authTag: cipher.getAuthTag() };
    },
    open(sealed: SealedCredential, scope: CredentialScope) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", masterKey, sealed.nonce);
        decipher.setAAD(aad(scope));
        decipher.setAuthTag(sealed.authTag);
        return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new ApiFailure(503, "MODEL_CREDENTIAL_UNAVAILABLE", "无法读取这个版本的模型凭据，请联系维护者。", false);
      }
    },
  };
}
export type CredentialVault = ReturnType<typeof createCredentialVault>;
