import { randomUUID } from 'node:crypto';

export const FLOW_TRIGGERS = {
  inbound: 'inbound',
  prospecting: 'prospecting',
};

function cleanText(value, maxLength = 12000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeTrigger(value) {
  return value === FLOW_TRIGGERS.prospecting ? FLOW_TRIGGERS.prospecting : FLOW_TRIGGERS.inbound;
}

function normalizeFlow(value = {}) {
  return {
    id: String(value.id || randomUUID()),
    name: cleanText(value.name, 120),
    trigger: normalizeTrigger(value.trigger),
    instructions: cleanText(value.instructions),
    active: Boolean(value.active ?? true),
    updatedAt: value.updatedAt || new Date().toISOString(),
  };
}

function normalizeConfig(value = {}) {
  const flows = Array.isArray(value.flows)
    ? value.flows
        .map((flow) => normalizeFlow(flow))
        .filter((flow) => flow.name && flow.instructions)
    : [];

  return {
    prompt: cleanText(value.prompt),
    flows,
    updatedAt: value.updatedAt || new Date().toISOString(),
  };
}

export class AgentConfig {
  constructor({ initialState, onChange, persist }) {
    this.state = normalizeConfig(initialState);
    this.persist = persist;
    this.onChange = onChange;
  }

  getState() {
    return {
      ...this.state,
      flows: this.state.flows.map((flow) => ({ ...flow })),
    };
  }

  getActiveFlow(trigger) {
    return this.state.flows.find((flow) => flow.active && flow.trigger === normalizeTrigger(trigger)) || null;
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    const state = this.getState();
    await this.persist(state);
    this.onChange?.(state);
  }

  async setPrompt(prompt) {
    this.state.prompt = cleanText(prompt);
    await this.save();
    return this.getState();
  }

  async createFlow(value) {
    const flow = normalizeFlow(value);
    if (!flow.name || !flow.instructions) {
      throw new Error('Informe o nome e as instruções do fluxo.');
    }

    this.state.flows.push(flow);
    await this.save();
    return this.getState();
  }

  async updateFlow(id, value) {
    const index = this.state.flows.findIndex((flow) => flow.id === id);
    if (index === -1) {
      throw new Error('Fluxo não encontrado.');
    }

    const current = this.state.flows[index];
    const flow = normalizeFlow({ ...current, ...value, id: current.id, updatedAt: new Date().toISOString() });
    if (!flow.name || !flow.instructions) {
      throw new Error('Informe o nome e as instruções do fluxo.');
    }

    this.state.flows[index] = flow;
    await this.save();
    return this.getState();
  }

  async deleteFlow(id) {
    const originalLength = this.state.flows.length;
    this.state.flows = this.state.flows.filter((flow) => flow.id !== id);
    if (this.state.flows.length === originalLength) {
      throw new Error('Fluxo não encontrado.');
    }

    await this.save();
    return this.getState();
  }
}
