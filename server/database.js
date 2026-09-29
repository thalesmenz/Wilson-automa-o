import pg from 'pg';

// Mantem timestamptz como string ISO, igual ao que a API do Supabase devolvia.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString());

export function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export class DatabaseService {
  constructor({ connectionString = process.env.DATABASE_URL } = {}) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  get isReady() {
    return Boolean(this.connectionString);
  }

  getStatus() {
    return {
      enabled: this.isReady,
      provider: 'Neon',
    };
  }

  getPool() {
    if (!this.isReady) {
      throw new Error('DATABASE_URL nao configurada.');
    }

    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        idleTimeoutMillis: 30000,
        max: 5,
      });
      this.pool.on('error', (error) => {
        console.warn(`Conexao ociosa com o banco caiu: ${error.message}`);
      });
    }

    return this.pool;
  }

  async query(text, params = []) {
    const { rows } = await this.getPool().query(text, params);
    return rows;
  }

  async close() {
    if (this.pool) {
      // Solta a referencia antes de encerrar: chamadas que chegarem durante o desligamento abrem um pool novo
      // em vez de falhar com "Cannot use a pool after calling end on the pool".
      const pool = this.pool;
      this.pool = null;
      await pool.end();
    }
  }
}
