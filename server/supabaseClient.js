import { createClient } from '@supabase/supabase-js';

export class SupabaseService {
  constructor({
    serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
    url = process.env.SUPABASE_URL,
  } = {}) {
    this.serviceRoleKey = serviceRoleKey;
    this.url = url;
    this.client = null;
  }

  get isReady() {
    return Boolean(this.url && this.serviceRoleKey);
  }

  getStatus() {
    return {
      enabled: this.isReady,
      provider: 'Supabase',
    };
  }

  getClient() {
    if (!this.isReady) {
      throw new Error('Supabase nao configurado.');
    }

    if (!this.client) {
      this.client = createClient(this.url, this.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }

    return this.client;
  }
}
