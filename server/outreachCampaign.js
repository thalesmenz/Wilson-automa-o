import { randomUUID } from 'node:crypto';

function cleanText(value, maxLength = 5000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizePhone(value) {
  const phone = String(value || '').replace(/\D/g, '');

  if (phone.length < 10 || phone.length > 15) {
    throw new Error('Informe um telefone com DDI e DDD.');
  }

  return phone;
}

function normalizeIntervalMinutes(value) {
  const minutes = Number(value);

  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('Informe um intervalo inteiro entre 1 e 1440 minutos.');
  }

  return minutes;
}

function createContact(value = {}) {
  return {
    id: String(value.id || randomUUID()),
    name: cleanText(value.name, 120),
    company: cleanText(value.company, 160),
    phone: normalizePhone(value.phone),
    status: ['sent', 'failed', 'pending'].includes(value.status) ? value.status : 'pending',
    error: cleanText(value.error, 500) || null,
    sentAt: value.sentAt || null,
  };
}

function makeInitialState(value = {}) {
  const contacts = Array.isArray(value.contacts)
    ? value.contacts.map((contact) => {
        try {
          const normalized = createContact(contact);
          return normalized.status === 'processing' ? { ...normalized, status: 'pending' } : normalized;
        } catch {
          return null;
        }
      }).filter(Boolean)
    : [];

  return {
    message: cleanText(value.message),
    contacts,
    intervalMinutes: (() => {
      try {
        return normalizeIntervalMinutes(value.intervalMinutes ?? 1);
      } catch {
        return 1;
      }
    })(),
    status: value.status === 'running' ? 'paused' : ['idle', 'paused', 'completed'].includes(value.status) ? value.status : 'idle',
    updatedAt: value.updatedAt || new Date().toISOString(),
  };
}

export class OutreachCampaign {
  constructor({ initialState, persist, sendText, buildMessage, canBuildMessage, getConnectionState, onChange, onActivity }) {
    this.state = makeInitialState(initialState);
    this.persist = persist;
    this.sendText = sendText;
    this.buildMessage = buildMessage;
    this.canBuildMessage = canBuildMessage;
    this.getConnectionState = getConnectionState;
    this.onChange = onChange;
    this.onActivity = onActivity;
    this.timer = null;
    this.sending = false;
  }

  getState() {
    const counts = this.state.contacts.reduce(
      (total, contact) => {
        total[contact.status] = (total[contact.status] || 0) + 1;
        return total;
      },
      { pending: 0, processing: 0, sent: 0, failed: 0 },
    );

    return { ...this.state, contacts: [...this.state.contacts], counts };
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    await this.persist(this.getState());
    this.onChange?.(this.getState());
  }

  async setMessage(value) {
    this.state.message = cleanText(value);
    await this.save();
    return this.getState();
  }

  async setIntervalMinutes(value) {
    this.state.intervalMinutes = normalizeIntervalMinutes(value);
    await this.save();
    return this.getState();
  }

  async addContact(value) {
    const contact = createContact(value);

    if (this.state.contacts.some((item) => item.phone === contact.phone)) {
      throw new Error('Esse telefone já está na lista.');
    }

    const previousContacts = this.state.contacts;
    this.state.contacts = [...previousContacts, contact];

    try {
      await this.save();
    } catch (error) {
      // Sem isso o contato fica so na memoria e a proxima tentativa cai em "ja esta na lista".
      this.state.contacts = previousContacts;
      throw error;
    }

    return this.getState();
  }

  async removeContact(id) {
    const previousContacts = this.state.contacts;
    this.state.contacts = previousContacts.filter((contact) => contact.id !== id);

    if (this.state.contacts.length === previousContacts.length) {
      throw new Error('Contato não encontrado na lista.');
    }

    try {
      await this.save();
    } catch (error) {
      this.state.contacts = previousContacts;
      throw error;
    }

    return this.getState();
  }

  async start({ retryFailed = false } = {}) {
    if (!this.state.message && !this.canBuildMessage?.()) {
      throw new Error('Escreva uma mensagem de abertura ou ative um fluxo de prospecção da IA antes de iniciar.');
    }

    if (!this.state.contacts.length) {
      throw new Error('Adicione pelo menos um telefone à lista.');
    }

    if (this.getConnectionState()?.status !== 'connected') {
      throw new Error('Conecte o WhatsApp antes de iniciar a lista.');
    }

    for (const contact of this.state.contacts) {
      if (contact.status === 'processing' || (retryFailed && contact.status === 'failed')) {
        contact.status = 'pending';
        contact.error = null;
      }
    }

    if (!this.state.contacts.some((contact) => contact.status === 'pending')) {
      throw new Error('Não há contatos pendentes para chamar.');
    }

    this.state.status = 'running';
    await this.save();
    this.onActivity?.('Prospecção iniciada.', { total: this.state.contacts.length });
    this.scheduleNext(0);
    return this.getState();
  }

  async pause() {
    if (this.state.status !== 'running') {
      return this.getState();
    }

    this.state.status = 'paused';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.save();
    this.onActivity?.('Prospecção pausada.');
    return this.getState();
  }

  scheduleNext(delay = this.state.intervalMinutes * 60 * 1000) {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.processNext().catch((error) => {
        this.onActivity?.('Falha ao processar a prospecção.', { error: error.message }, 'error');
      });
    }, delay);
    this.timer.unref?.();
  }

  personalize(contact) {
    return this.state.message
      .replaceAll('{{nome}}', contact.name || 'tudo bem')
      .replaceAll('{{empresa}}', contact.company || 'sua empresa');
  }

  async getMessageForContact(contact) {
    const fallback = this.personalize(contact);
    if (!this.buildMessage) {
      return fallback;
    }

    const generated = cleanText(await this.buildMessage({ contact, fallback }));
    return generated || fallback;
  }

  async processNext() {
    if (this.sending || this.state.status !== 'running') {
      return;
    }

    const contact = this.state.contacts.find((item) => item.status === 'pending');
    if (!contact) {
      this.state.status = 'completed';
      await this.save();
      this.onActivity?.('Prospecção finalizada.');
      return;
    }

    this.sending = true;
    contact.status = 'processing';
    contact.error = null;
    await this.save();

    try {
      await this.sendText(contact.phone, await this.getMessageForContact(contact));
      contact.status = 'sent';
      contact.sentAt = new Date().toISOString();
      this.onActivity?.(`Mensagem de prospecção enviada para ${contact.name || contact.phone}.`, { phone: contact.phone });
    } catch (error) {
      contact.status = 'failed';
      contact.error = cleanText(error.message, 500) || 'Falha no envio.';
      this.onActivity?.(`Não foi possível enviar para ${contact.name || contact.phone}.`, { phone: contact.phone, error: contact.error }, 'error');
    } finally {
      this.sending = false;
      await this.save();
    }

    if (this.state.status === 'running') {
      this.scheduleNext();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
