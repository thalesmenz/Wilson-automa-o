import { EventEmitter } from 'node:events';

export const WHATSAPP_PROVIDERS = {
  baileys: {
    id: 'baileys',
    label: 'WhatsApp via QR',
  },
  meta: {
    id: 'meta',
    label: 'WhatsApp Oficial Meta',
  },
};

export function normalizeWhatsappProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (['meta', 'official', 'cloud', 'cloud_api'].includes(normalized)) {
    return 'meta';
  }

  return 'baileys';
}

export class WhatsAppProviderManager extends EventEmitter {
  constructor({ activeProvider = 'baileys', clients }) {
    super();
    this.activeProvider = normalizeWhatsappProvider(activeProvider);
    this.clients = clients;
    this.syncActiveProvider();

    for (const [provider, client] of Object.entries(this.clients)) {
      client.on('state', () => this.emit('state', this.getState()));
      client.on('qr', (payload) => {
        if (this.activeProvider === provider) {
          this.emit('qr', payload);
        }

        this.emit('state', this.getState());
      });
      client.on('message', (payload) => this.emit('message', { ...payload, provider }));
      client.on('automation:reply', (payload) => this.emit('automation:reply', { ...payload, provider }));
      client.on('activity', (payload) => this.emit('activity', { ...payload, meta: { ...(payload.meta || {}), provider } }));
    }
  }

  get activeClient() {
    return this.clients[this.activeProvider] || this.clients.baileys;
  }

  getProvider(provider) {
    return this.clients[normalizeWhatsappProvider(provider)];
  }

  syncActiveProvider() {
    for (const [provider, client] of Object.entries(this.clients)) {
      client.setProviderActive?.(provider === this.activeProvider);
    }
  }

  getState() {
    const activeState = this.activeClient.getState();
    const providerStates = Object.fromEntries(
      Object.entries(this.clients).map(([provider, client]) => {
        const state = client.getState();

        return [
          provider,
          {
            lastError: state.lastError,
            provider: state.provider,
            qrDataUrl: provider === this.activeProvider ? state.qrDataUrl : null,
            startedAt: state.startedAt,
            status: state.status,
          },
        ];
      }),
    );

    return {
      ...activeState,
      activeProvider: this.activeProvider,
      providerOptions: Object.values(WHATSAPP_PROVIDERS),
      providers: providerStates,
    };
  }

  setActiveProvider(provider) {
    this.activeProvider = normalizeWhatsappProvider(provider);
    this.syncActiveProvider();
    this.emit('state', this.getState());
    return this.getState();
  }

  async connect() {
    await this.activeClient.connect();
    return this.getState();
  }

  async disconnect(options) {
    await this.activeClient.disconnect(options);
    return this.getState();
  }

  async disconnectAll(options) {
    await Promise.all(Object.values(this.clients).map((client) => client.disconnect(options).catch(() => null)));
    return this.getState();
  }

  getSessionDiagnostics() {
    return this.activeClient.getSessionDiagnostics();
  }

  sendText(phone, text) {
    return this.activeClient.sendText(phone, text);
  }

  sendTextToJid(jid, text, options) {
    return this.activeClient.sendTextToJid(jid, text, options);
  }

  cancelPendingReply(jid) {
    for (const client of Object.values(this.clients)) {
      client.cancelPendingReply?.(jid);
    }
  }

  emitActivity(type, message, meta = {}) {
    return this.activeClient.emitActivity(type, message, meta);
  }

  recordEvent(type, payload = {}) {
    return this.activeClient.recordEvent(type, payload);
  }
}
