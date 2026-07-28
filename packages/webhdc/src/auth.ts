import { bytesToBase64, encodeUtf8 } from './bytes.js';
import { HdcError } from './errors.js';

const DATABASE_VERSION = 1;
const STORE_NAME = 'keys';
const DEFAULT_DATABASE_NAME = 'hdc-web-auth';
const DEFAULT_KEY_ID = 'default';

interface StoredKeyPair {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
  createdAt?: string;
}

export interface HdcKeyStoreOptions {
  databaseName?: string;
  keyId?: string;
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new HdcError('当前环境缺少 Web Crypto，无法完成 HDC 设备鉴权', {
      code: 'WEBCRYPTO_UNSUPPORTED',
    });
  }
  return globalThis.crypto;
}

function openDatabase(databaseName: string): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) {
    return Promise.resolve(null);
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredKey(databaseName: string, keyId: string): Promise<StoredKeyPair | null> {
  const database = await openDatabase(databaseName);
  if (!database) {
    return null;
  }
  try {
    return await new Promise<StoredKeyPair | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(keyId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function writeStoredKey(
  databaseName: string,
  keyId: string,
  value: StoredKeyPair,
): Promise<void> {
  const database = await openDatabase(databaseName);
  if (!database) {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(value, keyId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function deleteStoredKey(databaseName: string, keyId: string): Promise<void> {
  const database = await openDatabase(databaseName);
  if (!database) {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(keyId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function wrapPem(label: string, bytes: Uint8Array): string {
  const base64 = bytesToBase64(bytes);
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export class HdcKeyStore {
  #databaseName: string;
  #keyId: string;
  #keyPair: CryptoKeyPair | null;

  constructor({
    databaseName = DEFAULT_DATABASE_NAME,
    keyId = DEFAULT_KEY_ID,
  }: HdcKeyStoreOptions = {}) {
    this.#databaseName = databaseName;
    this.#keyId = keyId;
    this.#keyPair = null;
  }

  async getOrCreateKeyPair(): Promise<CryptoKeyPair> {
    if (this.#keyPair) {
      return this.#keyPair;
    }
    const cryptoApi = getCrypto();
    const algorithm: RsaHashedKeyGenParams = {
      name: 'RSA-PSS',
      modulusLength: 3072,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-512',
    };
    const stored = await readStoredKey(this.#databaseName, this.#keyId);
    if (stored?.privateKey && stored?.publicKey) {
      try {
        const [privateKey, publicKey] = await Promise.all([
          cryptoApi.subtle.importKey('jwk', stored.privateKey, algorithm, true, ['sign']),
          cryptoApi.subtle.importKey('jwk', stored.publicKey, algorithm, true, ['verify']),
        ]);
        this.#keyPair = { privateKey, publicKey };
        return this.#keyPair;
      } catch {
        await deleteStoredKey(this.#databaseName, this.#keyId);
      }
    }

    this.#keyPair = (await cryptoApi.subtle.generateKey(algorithm, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const [privateKey, publicKey] = await Promise.all([
      cryptoApi.subtle.exportKey('jwk', this.#keyPair.privateKey),
      cryptoApi.subtle.exportKey('jwk', this.#keyPair.publicKey),
    ]);
    await writeStoredKey(this.#databaseName, this.#keyId, {
      privateKey,
      publicKey,
      createdAt: new Date().toISOString(),
    });
    return this.#keyPair;
  }

  async getPublicKeyPem(): Promise<string> {
    const { publicKey } = await this.getOrCreateKeyPair();
    const spki = await getCrypto().subtle.exportKey('spki', publicKey);
    return wrapPem('PUBLIC KEY', new Uint8Array(spki));
  }

  async signToken(token: string | Uint8Array): Promise<string> {
    const { privateKey } = await this.getOrCreateKeyPair();
    const data = Uint8Array.from(typeof token === 'string' ? encodeUtf8(token) : token);
    const signature = await getCrypto().subtle.sign(
      { name: 'RSA-PSS', saltLength: 64 },
      privateKey,
      data,
    );
    return bytesToBase64(new Uint8Array(signature));
  }

  async clear(): Promise<void> {
    this.#keyPair = null;
    await deleteStoredKey(this.#databaseName, this.#keyId);
  }
}

export function defaultHostName(): string {
  const locationName = globalThis.location?.hostname;
  return locationName ? `hdc-web@${locationName}` : 'hdc-web@browser';
}
