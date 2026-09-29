const DEFAULT_TABLE = process.env.DB_KV_TABLE || 'app_kv';

function defaultNamespace() {
  return process.env.KV_NAMESPACE || (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');
}

// Chave/valor no Postgres para o que antes ia para disco (settings, tokens, sessao do WhatsApp).
// O namespace separa ambientes que usam o mesmo banco, para o dev nao disputar a sessao do WhatsApp com producao.
export class KeyValueStore {
  constructor({ database, namespace = defaultNamespace(), table = DEFAULT_TABLE } = {}) {
    this.database = database;
    this.namespace = namespace;
    this.table = table;
    this.tableSql = `"${table.replace(/"/g, '""')}"`;
    this.readyPromise = null;
  }

  get isReady() {
    return Boolean(this.database?.isReady);
  }

  key(name) {
    return `${this.namespace}:${name}`;
  }

  async ensureTable() {
    if (!this.readyPromise) {
      this.readyPromise = this.database
        .query(
          `create table if not exists ${this.tableSql} (
             key text primary key,
             value jsonb not null,
             updated_at timestamptz not null default now()
           )`,
        )
        .catch((error) => {
          this.readyPromise = null;
          throw error;
        });
    }

    return this.readyPromise;
  }

  async get(name) {
    await this.ensureTable();
    const [row] = await this.database.query(`select value from ${this.tableSql} where key = $1`, [this.key(name)]);
    return row ? row.value : null;
  }

  async getMany(names) {
    if (!names.length) {
      return new Map();
    }

    await this.ensureTable();
    const rows = await this.database.query(`select key, value from ${this.tableSql} where key = any($1)`, [
      names.map((name) => this.key(name)),
    ]);
    const prefixLength = this.namespace.length + 1;
    return new Map(rows.map((row) => [row.key.slice(prefixLength), row.value]));
  }

  async set(name, value) {
    await this.setMany([[name, value]]);
  }

  // entries: [[name, value]]; value null/undefined remove a chave.
  async setMany(entries) {
    const upserts = entries.filter(([, value]) => value !== null && value !== undefined);
    const removals = entries.filter(([, value]) => value === null || value === undefined).map(([name]) => this.key(name));

    await this.ensureTable();

    if (upserts.length) {
      await this.database.query(
        `insert into ${this.tableSql} (key, value, updated_at)
         select key, value, now() from unnest($1::text[], $2::jsonb[]) as t(key, value)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [upserts.map(([name]) => this.key(name)), upserts.map(([, value]) => JSON.stringify(value))],
      );
    }

    if (removals.length) {
      await this.database.query(`delete from ${this.tableSql} where key = any($1)`, [removals]);
    }
  }

  async delete(name) {
    await this.setMany([[name, null]]);
  }

  async deletePrefix(prefix) {
    await this.ensureTable();
    const rows = await this.database.query(`delete from ${this.tableSql} where starts_with(key, $1) returning key`, [
      this.key(prefix),
    ]);
    return rows.length;
  }

  async countPrefix(prefix) {
    await this.ensureTable();
    const [row] = await this.database.query(`select count(*)::int as count from ${this.tableSql} where starts_with(key, $1)`, [
      this.key(prefix),
    ]);
    return row.count;
  }

  async copyPrefix(fromPrefix, toPrefix) {
    await this.ensureTable();
    const from = this.key(fromPrefix);
    const rows = await this.database.query(
      `insert into ${this.tableSql} (key, value, updated_at)
       select $2 || substr(key, length($1) + 1), value, now() from ${this.tableSql} where starts_with(key, $1)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
       returning key`,
      [from, this.key(toPrefix)],
    );
    return rows.length;
  }

  async listPrefixes(prefix, separator = '/') {
    await this.ensureTable();
    const base = this.key(prefix);
    const rows = await this.database.query(
      `select distinct split_part(substr(key, length($1) + 1), $2, 1) as name
       from ${this.tableSql} where starts_with(key, $1) order by 1`,
      [base, separator],
    );
    return rows.map((row) => row.name);
  }
}
