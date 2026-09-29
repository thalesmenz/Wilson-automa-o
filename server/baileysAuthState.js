import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

function encode(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode(value) {
  return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

// Equivalente ao useMultiFileAuthState do Baileys, gravando no KeyValueStore em vez de uma pasta.
export async function usePostgresAuthState(kv, prefix) {
  const credsKey = `${prefix}/creds`;
  const keyName = (type, id) => `${prefix}/${type}-${id}`;
  const creds = decode(await kv.get(credsKey)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const stored = await kv.getMany(ids.map((id) => keyName(type, id)));
          const data = {};

          for (const id of ids) {
            let value = decode(stored.get(keyName(type, id)));
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }

          return data;
        },
        set: async (data) => {
          const entries = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              entries.push([keyName(category, id), value ? encode(value) : null]);
            }
          }

          await kv.setMany(entries);
        },
      },
    },
    saveCreds: async () => {
      await kv.set(credsKey, encode(creds));
    },
  };
}
