import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_AUTOMATIONS = [
  {
    id: 'welcome',
    name: 'Saudação inicial',
    keyword: 'oi',
    matchMode: 'contains',
    response: 'Olá! Obrigado por chamar. Já recebemos sua mensagem e vamos te responder em breve.',
    active: true,
    delayMs: 800,
    cooldownSeconds: 300,
    includeGroups: false,
  },
  {
    id: 'hours',
    name: 'Horário de atendimento',
    keyword: 'horario',
    matchMode: 'contains',
    response: 'Nosso atendimento é de segunda a sexta, das 9h às 18h.',
    active: true,
    delayMs: 600,
    cooldownSeconds: 300,
    includeGroups: false,
  },
];
const DEFAULT_CONVERSATIONS_TABLE = process.env.SUPABASE_CONVERSATIONS_TABLE || 'whatsapp_conversations';
const DEFAULT_EVENTS_TABLE = process.env.SUPABASE_EVENTS_TABLE || 'whatsapp_events';

function toConversationRow(conversation) {
  return {
    contact_name: conversation.contactName || conversation.jid,
    jid: conversation.jid,
    lead: conversation.lead || {},
    messages: conversation.messages || [],
    updated_at: conversation.updatedAt || new Date().toISOString(),
  };
}

function fromConversationRow(row) {
  return {
    contactName: row.contact_name || row.jid,
    jid: row.jid,
    lead: row.lead || {
      status: 'new',
      route: 'Aguardando',
      updatedAt: row.updated_at,
    },
    messages: row.messages || [],
    updatedAt: row.updated_at,
  };
}

function toEventRow(event) {
  return {
    contact_name: event.contactName,
    created_at: event.createdAt,
    id: event.id,
    jid: event.jid,
    lead_status: event.leadStatus,
    lead_type: event.leadType,
    meta: event.meta || {},
    route: event.route,
    type: event.type,
  };
}

function fromEventRow(row) {
  return {
    contactName: row.contact_name,
    createdAt: row.created_at,
    id: row.id,
    jid: row.jid,
    leadStatus: row.lead_status,
    leadType: row.lead_type,
    meta: row.meta || {},
    route: row.route,
    type: row.type,
  };
}

async function ensureJsonFile(filePath, fallback) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export class AutomationStore {
  constructor({ conversationsTable = DEFAULT_CONVERSATIONS_TABLE, dataDir, eventsTable = DEFAULT_EVENTS_TABLE, supabase } = {}) {
    this.automationsPath = path.join(dataDir, 'automations.json');
    this.conversationsPath = path.join(dataDir, 'conversations.json');
    this.eventsPath = path.join(dataDir, 'events.json');
    this.conversationsTable = conversationsTable;
    this.eventsTable = eventsTable;
    this.remoteStorageDisabled = false;
    this.supabase = supabase;
    this.automations = [];
    this.conversations = {};
    this.events = [];
    this.ready = this.load();
  }

  async load() {
    this.automations = await ensureJsonFile(this.automationsPath, DEFAULT_AUTOMATIONS);
    this.conversations = await ensureJsonFile(this.conversationsPath, {});
    this.events = await ensureJsonFile(this.eventsPath, []);
    await this.loadRemoteDashboardData();
  }

  async saveAutomations() {
    await writeJson(this.automationsPath, this.automations);
  }

  get hasRemoteStorage() {
    return Boolean(!this.remoteStorageDisabled && this.supabase?.isReady);
  }

  getRemoteClient() {
    return this.supabase.getClient();
  }

  async loadRemoteDashboardData() {
    if (!this.supabase?.isReady) {
      return;
    }

    try {
      const client = this.getRemoteClient();
      const [{ data: conversations, error: conversationsError }, { data: events, error: eventsError }] = await Promise.all([
        client.from(this.conversationsTable).select('*'),
        client.from(this.eventsTable).select('*').order('created_at', { ascending: false }).limit(2500),
      ]);

      if (conversationsError || eventsError) {
        throw conversationsError || eventsError;
      }

      this.conversations = Object.fromEntries((conversations || []).map((row) => [row.jid, fromConversationRow(row)]));
      this.events = (events || []).map(fromEventRow);
    } catch (error) {
      this.remoteStorageDisabled = true;
      console.warn(`Dashboard remoto indisponivel. Usando armazenamento local: ${error.message}`);
    }
  }

  async saveConversationRemote(conversation) {
    if (!this.hasRemoteStorage || !conversation) {
      return;
    }

    try {
      const { error } = await this.getRemoteClient()
        .from(this.conversationsTable)
        .upsert(toConversationRow(conversation), { onConflict: 'jid' });

      if (error) {
        throw error;
      }
    } catch (error) {
      this.remoteStorageDisabled = true;
      console.warn(`Falha ao salvar conversa no banco. Mantendo local: ${error.message}`);
    }
  }

  async saveEventRemote(event) {
    if (!this.hasRemoteStorage || !event) {
      return;
    }

    try {
      const { error } = await this.getRemoteClient().from(this.eventsTable).upsert(toEventRow(event), { onConflict: 'id' });

      if (error) {
        throw error;
      }
    } catch (error) {
      this.remoteStorageDisabled = true;
      console.warn(`Falha ao salvar evento no banco. Mantendo local: ${error.message}`);
    }
  }

  async saveConversations(conversation = null) {
    await writeJson(this.conversationsPath, this.conversations);
    await this.saveConversationRemote(conversation);
  }

  async saveEvents() {
    await writeJson(this.eventsPath, this.events);
  }

  getAutomations() {
    return this.automations;
  }

  async createAutomation(payload) {
    const automation = {
      id: randomUUID(),
      name: String(payload.name || 'Nova automacao').trim(),
      keyword: String(payload.keyword || '').trim(),
      matchMode: payload.matchMode === 'exact' ? 'exact' : 'contains',
      response: String(payload.response || '').trim(),
      active: Boolean(payload.active ?? true),
      delayMs: Math.max(0, Number(payload.delayMs ?? 500)),
      cooldownSeconds: Math.max(0, Number(payload.cooldownSeconds ?? 300)),
      includeGroups: Boolean(payload.includeGroups ?? false),
    };

    this.automations = [automation, ...this.automations];
    await this.saveAutomations();
    return automation;
  }

  async updateAutomation(id, payload) {
    const index = this.automations.findIndex((automation) => automation.id === id);
    if (index === -1) {
      return null;
    }

    const current = this.automations[index];
    const next = {
      ...current,
      ...payload,
      id: current.id,
      name: String(payload.name ?? current.name).trim(),
      keyword: String(payload.keyword ?? current.keyword).trim(),
      response: String(payload.response ?? current.response).trim(),
      matchMode: payload.matchMode === 'exact' ? 'exact' : 'contains',
      active: Boolean(payload.active ?? current.active),
      delayMs: Math.max(0, Number(payload.delayMs ?? current.delayMs)),
      cooldownSeconds: Math.max(0, Number(payload.cooldownSeconds ?? current.cooldownSeconds)),
      includeGroups: Boolean(payload.includeGroups ?? current.includeGroups),
    };

    this.automations[index] = next;
    await this.saveAutomations();
    return next;
  }

  async deleteAutomation(id) {
    const before = this.automations.length;
    this.automations = this.automations.filter((automation) => automation.id !== id);
    await this.saveAutomations();
    return this.automations.length !== before;
  }

  getConversations() {
    return this.conversations;
  }

  getConversation(jid) {
    return this.conversations[jid] || null;
  }

  async addConversationMessage(message) {
    const jid = message.jid;
    const existing = this.conversations[jid] || {
      jid,
      contactName: message.contactName || jid,
      messages: [],
      lead: {
        status: 'new',
        route: 'Aguardando',
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };

    const nextMessage = {
      id: message.id || randomUUID(),
      direction: message.direction,
      text: message.text,
      createdAt: message.createdAt || new Date().toISOString(),
      automationName: message.automationName || null,
    };

    existing.contactName = message.contactName || existing.contactName;
    existing.lead = existing.lead || {
      status: 'new',
      route: 'Aguardando',
      updatedAt: nextMessage.createdAt,
    };
    existing.updatedAt = nextMessage.createdAt;
    existing.messages = [...existing.messages, nextMessage].slice(-40);
    this.conversations[jid] = existing;

    await this.saveConversations(existing);
    return existing;
  }

  async updateLead(jid, payload = {}) {
    const existing = this.conversations[jid] || {
      jid,
      contactName: payload.contactName || jid,
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    const previousLead = existing.lead || {};
    const lead = {
      status: payload.status || previousLead.status || 'new',
      leadType: payload.leadType ?? previousLead.leadType ?? null,
      route: payload.route || previousLead.route || 'Aguardando',
      reason: payload.reason ?? previousLead.reason ?? null,
      calendarId: payload.calendarId ?? previousLead.calendarId ?? null,
      eventId: payload.eventId ?? previousLead.eventId ?? null,
      meetingAt: payload.meetingAt ?? previousLead.meetingAt ?? null,
      updatedAt: new Date().toISOString(),
    };
    const changed =
      previousLead.status !== lead.status ||
      previousLead.leadType !== lead.leadType ||
      previousLead.route !== lead.route ||
      previousLead.eventId !== lead.eventId;

    existing.contactName = payload.contactName || existing.contactName;
    existing.lead = lead;
    existing.updatedAt = lead.updatedAt;
    this.conversations[jid] = existing;

    await this.saveConversations(existing);
    return {
      changed,
      conversation: existing,
      lead,
      previousLead,
    };
  }

  async addEvent(event = {}) {
    const normalized = {
      id: event.id || randomUUID(),
      type: String(event.type || 'event'),
      jid: event.jid || null,
      contactName: event.contactName || null,
      leadType: event.leadType || null,
      leadStatus: event.leadStatus || null,
      route: event.route || null,
      meta: event.meta || {},
      createdAt: event.createdAt || new Date().toISOString(),
    };

    this.events = [normalized, ...this.events].slice(0, 2500);
    await this.saveEvents();
    await this.saveEventRemote(normalized);
    return normalized;
  }

  getEvents({ limit = 250, type } = {}) {
    const events = type ? this.events.filter((event) => event.type === type) : this.events;
    return events.slice(0, Math.max(0, Number(limit || 250)));
  }

  getLeads() {
    return Object.values(this.conversations)
      .map((conversation) => {
        const messages = conversation.messages || [];
        const lastMessage = messages[messages.length - 1] || null;
        const lead = conversation.lead || {};

        return {
          jid: conversation.jid,
          contactName: conversation.contactName || conversation.jid,
          leadType: lead.leadType || null,
          lastMessage: lastMessage?.text || '',
          lastMessageAt: lastMessage?.createdAt || conversation.updatedAt,
          messageCount: messages.length,
          phone: conversation.jid?.replace('@s.whatsapp.net', '') || conversation.jid,
          reason: lead.reason || null,
          route: lead.route || 'Aguardando',
          status: lead.status || 'new',
          updatedAt: conversation.updatedAt,
        };
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  getDashboardSummary() {
    const leads = this.getLeads();
    const countEvents = (type) => this.events.filter((event) => event.type === type).length;

    return {
      discarded: leads.filter((lead) => lead.status === 'discarded').length,
      followupsSent: countEvents('followup_sent'),
      highTicket: leads.filter((lead) => lead.leadType === 'high_ticket').length,
      lowTicket: leads.filter((lead) => lead.leadType === 'low_ticket').length,
      meetingsCreated: countEvents('meeting_created'),
      messagesResponded: countEvents('message_replied'),
      totalLeads: leads.length,
      updatedAt: new Date().toISOString(),
    };
  }
}
