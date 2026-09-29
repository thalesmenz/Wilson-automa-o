import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Activity,
  ArrowUpRight,
  Bot,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ListPlus,
  MessageCircle,
  PauseCircle,
  PieChart,
  PlayCircle,
  Power,
  QrCode,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  Unlink,
  UserCheck,
  Wifi,
  Workflow,
  X,
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WHATSAPP_CLEAR_SESSION_CONFIRMATION = 'APAGAR_SESSAO_WHATSAPP';

const STATUS_LABELS = {
  idle: 'Aguardando',
  connecting: 'Gerando QR',
  qr: 'QR pronto',
  connected: 'Conectado',
  disconnected: 'Desconectado',
  logged_out: 'Sessao encerrada',
  error: 'Erro',
};

const VIEWS = {
  overview: {
    eyebrow: 'Operacao',
    title: 'Resumo geral',
  },
  clients: {
    eyebrow: 'Atendimento',
    title: 'Clientes',
  },
  connections: {
    eyebrow: 'Sistema',
    title: 'Conexoes',
  },
  appointments: {
    eyebrow: 'Agenda',
    title: 'Agenda interna',
  },
  followups: {
    eyebrow: 'Agenda',
    title: 'Follow-ups',
  },
  outreach: {
    eyebrow: 'Prospecção',
    title: 'Prospecção',
  },
  agent: {
    eyebrow: 'Automação',
    title: 'Agente e fluxos',
  },
};

const EMPTY_SUMMARY = {
  discarded: 0,
  followupsSent: 0,
  highTicket: 0,
  lowTicket: 0,
  meetingsCreated: 0,
  messagesResponded: 0,
  totalLeads: 0,
};

const METRIC_CONFIG = [
  { key: 'messagesResponded', label: 'Mensagens respondidas', trend: 'total', tone: 'green', icon: MessageCircle },
  { key: 'highTicket', label: 'Rating baixo', trend: 'Wilson', tone: 'blue', icon: ArrowUpRight },
  { key: 'lowTicket', label: 'Negativados', trend: 'Andre', tone: 'teal', icon: UserCheck },
  { key: 'discarded', label: 'Curiosos descartados', trend: 'sem agenda', tone: 'slate', icon: PieChart },
];

const SECONDARY_METRIC_CONFIG = [
  { key: 'meetingsCreated', label: 'Reunioes marcadas', trend: 'total', tone: 'green', icon: CalendarCheck },
  { key: 'followupsSent', label: 'Follow-ups enviados', trend: 'total', tone: 'blue', icon: Clock3 },
];

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Falha na requisicao.');
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
  }).format(new Date(value));
}

function formatCompactDate(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
  }).format(new Date(value));
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const weekday = date.getDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(date, offset);
}

function getWeekDays(value) {
  const firstDay = startOfWeek(value);
  return Array.from({ length: 7 }, (_, index) => addDays(firstDay, index));
}

function getDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'invalid';
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isSameDay(a, b) {
  return getDateKey(a) === getDateKey(b);
}

function formatWeekday(value) {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
  })
    .format(new Date(value))
    .replace('.', '');
}

function formatAgendaRange(days) {
  if (!days.length) {
    return '';
  }

  const first = days[0];
  const last = days[days.length - 1];
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const firstLabel = sameMonth
    ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit' }).format(first)
    : formatCompactDate(first);
  const lastLabel = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(last);

  return `${firstLabel} - ${lastLabel}`;
}

function getConnectionTone(isOnline, isReady = false, isLoading = false) {
  if (isOnline) {
    return 'online';
  }

  if (isLoading) {
    return 'loading';
  }

  if (isReady) {
    return 'ready';
  }

  return 'offline';
}

function MetricCard({ metric, compact = false }) {
  const Icon = metric.icon;

  return (
    <article className={`metric-card ${metric.tone} ${compact ? 'compact' : ''}`}>
      <span className="metric-icon">
        <Icon size={19} />
      </span>
      <div>
        <span>{metric.label}</span>
        <strong>{metric.value}</strong>
      </div>
      <small>{metric.trend}</small>
    </article>
  );
}

function ConnectionItem({ action, icon: Icon, label, meta, tone }) {
  return (
    <div className="connection-item">
      <span className={`connection-dot ${tone}`} />
      <Icon size={18} />
      <div>
        <strong>{label}</strong>
        <span>{meta}</span>
      </div>
      {action}
    </div>
  );
}

function Tag({ type, children }) {
  return <span className={`tag ${type}`}>{children}</span>;
}

function getLeadLabel(lead) {
  if (lead.status === 'meeting_created') {
    return 'Reuniao marcada';
  }

  if (lead.status === 'discarded') {
    return 'Curioso';
  }

  if (lead.leadType === 'high_ticket') {
    return 'Rating baixo';
  }

  if (lead.leadType === 'low_ticket') {
    return 'Negativado';
  }

  return 'Novo';
}

function getLeadTag(lead) {
  if (lead.status === 'meeting_created') {
    return 'meeting';
  }

  if (lead.status === 'discarded') {
    return 'discarded';
  }

  if (lead.leadType === 'high_ticket') {
    return 'high';
  }

  if (lead.leadType === 'low_ticket') {
    return 'low';
  }

  return 'neutral';
}

function isAiPausedForConversation(conversation, lead) {
  return Boolean(conversation?.aiPaused ?? conversation?.lead?.aiPaused ?? lead?.aiPaused);
}

function getLastMessage(conversation) {
  const messages = conversation?.messages || [];
  return messages[messages.length - 1] || null;
}

function leadNeedsReply(conversation) {
  return getLastMessage(conversation)?.direction === 'in';
}

function getAppointmentRoute(appointment) {
  if (appointment.leadType === 'high_ticket') {
    return 'Wilson';
  }

  if (appointment.leadType === 'low_ticket') {
    return 'Andre';
  }

  return 'Agenda';
}

function getAppointmentStatusLabel(status) {
  if (status === 'cancelled') {
    return 'Cancelado';
  }

  if (status === 'done') {
    return 'Concluido';
  }

  return 'Marcado';
}

function getAppointmentStatusTag(status) {
  if (status === 'cancelled') {
    return 'discarded';
  }

  if (status === 'done') {
    return 'neutral';
  }

  return 'meeting';
}

export default function App() {
  const [activeView, setActiveView] = useState('overview');
  const [status, setStatus] = useState({ status: 'idle' });
  const [activity, setActivity] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [agendaDate, setAgendaDate] = useState(() => new Date());
  const [agendaView, setAgendaView] = useState('week');
  const [chatFilter, setChatFilter] = useState('all');
  const [chatSearch, setChatSearch] = useState('');
  const [conversations, setConversations] = useState({});
  const [followups, setFollowups] = useState({ recent: [], upcoming: [] });
  const [leads, setLeads] = useState([]);
  const [manualMessage, setManualMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedClientJid, setSelectedClientJid] = useState(null);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [outreach, setOutreach] = useState({ contacts: [], counts: {}, intervalMinutes: 1, message: '', status: 'idle' });
  const [outreachDraft, setOutreachDraft] = useState({ name: '', company: '', phone: '' });
  const [outreachMessage, setOutreachMessage] = useState('');
  const [outreachInterval, setOutreachInterval] = useState(1);
  const [outreachBusy, setOutreachBusy] = useState(false);
  const [agent, setAgent] = useState({ flows: [], prompt: '' });
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentFlowDraft, setAgentFlowDraft] = useState({ active: true, instructions: '', name: '', trigger: 'inbound' });
  const [agentBusy, setAgentBusy] = useState(false);
  const messagesEndRef = useRef(null);

  const whatsappProvider = status.provider || {};
  const activeProvider = status.activeProvider || whatsappProvider.id || 'baileys';
  const providerOptions = status.providerOptions || [
    { id: 'baileys', label: 'WhatsApp via QR' },
    { id: 'meta', label: 'WhatsApp Oficial Meta' },
  ];
  const providerStates = status.providers || {};
  const activeProviderState = providerStates[activeProvider] || status;
  const isMetaProvider = activeProvider === 'meta';
  const connectionLabel = activeProviderState.provider?.label || whatsappProvider.label || 'WhatsApp';
  const connected = status.status === 'connected';
  const hasQr = Boolean(status.qrDataUrl);
  const googleOauthConfigured = Boolean(status.calendar?.oauth?.configured);
  const lowTicketCalendarConnected = Boolean(status.calendar?.oauth?.connected?.lowTicket);
  const highTicketCalendarConnected = Boolean(status.calendar?.oauth?.connected?.highTicket);
  const followupsConfigured = Boolean(status.followups?.configured);
  const followupsEnabled = Boolean(status.followups?.enabled);
  const followupsTone = getConnectionTone(followupsEnabled, followupsConfigured);
  const connectionTone = getConnectionTone(connected, hasQr, status.status === 'connecting');
  const dashboardStorage = status.dashboardStorage || {};
  const dashboardStorageError = dashboardStorage.configured && dashboardStorage.lastError ? dashboardStorage.lastError : '';
  const botLabel = isMetaProvider
    ? connected
      ? 'Meta ativa'
      : whatsappProvider.configured
        ? 'Meta pronta'
        : 'Meta pendente'
    : connected
      ? 'Bot ativo'
      : hasQr
        ? 'QR pronto'
        : 'Bot pausado';
  const view = VIEWS[activeView] || VIEWS.overview;
  const metrics = METRIC_CONFIG.map((metric) => ({
    ...metric,
    value: summary[metric.key] ?? 0,
  }));
  const secondaryMetrics = SECONDARY_METRIC_CONFIG.map((metric) => ({
    ...metric,
    value: summary[metric.key] ?? 0,
  }));
  const selectedLead = useMemo(() => {
    return leads.find((lead) => lead.jid === selectedClientJid) || null;
  }, [leads, selectedClientJid]);
  const sortedAppointments = useMemo(() => {
    return [...appointments].sort((a, b) => new Date(a.startDateTime || 0).getTime() - new Date(b.startDateTime || 0).getTime());
  }, [appointments]);
  const agendaDays = useMemo(() => getWeekDays(agendaDate), [agendaDate]);
  const appointmentsByDay = useMemo(() => {
    return sortedAppointments.reduce((groups, appointment) => {
      const key = getDateKey(appointment.startDateTime);
      groups[key] = groups[key] || [];
      groups[key].push(appointment);
      return groups;
    }, {});
  }, [sortedAppointments]);
  const weeklyAppointmentCount = useMemo(() => {
    return agendaDays.reduce((total, day) => total + (appointmentsByDay[getDateKey(day)]?.length || 0), 0);
  }, [agendaDays, appointmentsByDay]);
  const selectedConversation = selectedClientJid ? conversations[selectedClientJid] : null;
  const selectedMessages = selectedConversation?.messages || [];
  const selectedAiPaused = isAiPausedForConversation(selectedConversation, selectedLead);
  const selectedLastMessage = getLastMessage(selectedConversation);
  const selectedNeedsReply = leadNeedsReply(selectedConversation);
  const canSendManualMessage = Boolean(selectedLead?.jid && connected && manualMessage.trim() && !sendingMessage);

  const chatSummary = useMemo(() => {
    return leads.reduce(
      (totals, lead) => {
        const conversation = conversations[lead.jid];
        if (leadNeedsReply(conversation)) {
          totals.needsReply += 1;
        }

        if (isAiPausedForConversation(conversation, lead)) {
          totals.manual += 1;
        }

        return totals;
      },
      { needsReply: 0, manual: 0 },
    );
  }, [conversations, leads]);

  const filteredLeads = useMemo(() => {
    const query = chatSearch.trim().toLocaleLowerCase('pt-BR');

    return leads.filter((lead) => {
      const conversation = conversations[lead.jid];
      const matchesFilter =
        chatFilter === 'manual'
          ? isAiPausedForConversation(conversation, lead)
          : chatFilter === 'needsReply'
            ? leadNeedsReply(conversation)
            : true;

      if (!matchesFilter) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [lead.contactName, lead.phone, lead.route, lead.lastMessage, getLeadLabel(lead)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('pt-BR');

      return haystack.includes(query);
    });
  }, [chatFilter, chatSearch, conversations, leads]);

  const recentActivity = useMemo(() => {
    return activity.slice(0, 4);
  }, [activity]);

  async function refreshDashboard() {
    const [summaryPayload, leadsPayload, followupsPayload, conversationsPayload, appointmentsPayload, outreachPayload, agentPayload] = await Promise.all([
      request('/api/dashboard/summary'),
      request('/api/leads'),
      request('/api/followups'),
      request('/api/conversations'),
      request('/api/appointments').catch(() => ({ appointments: [] })),
      request('/api/outreach').catch(() => ({ contacts: [], counts: {}, intervalMinutes: 1, message: '', status: 'idle' })),
      request('/api/agent').catch(() => ({ flows: [], prompt: '' })),
    ]);

    setSummary({ ...EMPTY_SUMMARY, ...(summaryPayload || {}) });
    setLeads(Array.isArray(leadsPayload) ? leadsPayload : []);
    setFollowups(followupsPayload || { recent: [], upcoming: [] });
    setConversations(conversationsPayload && typeof conversationsPayload === 'object' ? conversationsPayload : {});
    setAppointments(Array.isArray(appointmentsPayload?.appointments) ? appointmentsPayload.appointments : []);
    setOutreach(outreachPayload || { contacts: [], counts: {}, intervalMinutes: 1, message: '', status: 'idle' });
    setOutreachMessage(outreachPayload?.message || '');
    setOutreachInterval(outreachPayload?.intervalMinutes || 1);
    setAgent(agentPayload || { flows: [], prompt: '' });
    setAgentPrompt(agentPayload?.prompt || '');
  }

  useEffect(() => {
    const socket = io(API_URL);

    request('/api/status').then(setStatus).catch(() => null);
    refreshDashboard().catch(() => null);

    socket.on('status', setStatus);
    socket.on('qr', (payload) => {
      setQrModalOpen(true);
      setStatus((current) => ({ ...current, ...payload, status: 'qr' }));
    });
    socket.on('activity:init', setActivity);
    socket.on('outreach', (payload) => {
      setOutreach(payload || { contacts: [], counts: {}, intervalMinutes: 1, message: '', status: 'idle' });
      setOutreachMessage((current) => (current === '' ? payload?.message || '' : current));
      setOutreachInterval(payload?.intervalMinutes || 1);
    });
    socket.on('agent', (payload) => {
      setAgent(payload || { flows: [], prompt: '' });
      setAgentPrompt(payload?.prompt || '');
    });
    socket.on('conversations', (payload) => {
      setConversations(payload && typeof payload === 'object' ? payload : {});
      refreshDashboard().catch(() => null);
    });
    socket.on('activity', (item) => {
      setActivity((current) => [item, ...current].slice(0, 8));
      refreshDashboard().catch(() => null);
    });

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (selectedClientJid && !leads.some((lead) => lead.jid === selectedClientJid)) {
      setSelectedClientJid(null);
    }
  }, [leads, selectedClientJid]);

  useEffect(() => {
    setManualMessage('');
  }, [selectedClientJid]);

  useEffect(() => {
    if (activeView !== 'clients' || !selectedClientJid) {
      return;
    }

    window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    });
  }, [activeView, selectedClientJid, selectedMessages.length]);

  useEffect(() => {
    if (activeView !== 'clients' || !selectedClientJid || !window.matchMedia('(max-width: 920px)').matches) {
      return;
    }

    window.requestAnimationFrame(() => {
      document.querySelector('.conversation-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [activeView, selectedClientJid]);

  async function runAction(action, successMessage) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      await refreshDashboard().catch(() => null);
      setNotice(successMessage);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendManualMessage(event) {
    event.preventDefault();

    const text = manualMessage.trim();
    if (!selectedLead?.jid || !text || sendingMessage) {
      return;
    }

    setSendingMessage(true);
    setNotice('');

    try {
      const payload = await request(`/api/conversations/${encodeURIComponent(selectedLead.jid)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ pauseAi: true, text }),
      });

      setManualMessage('');

      if (payload?.conversation?.jid) {
        setConversations((current) => ({ ...current, [payload.conversation.jid]: payload.conversation }));
      }

      await refreshDashboard().catch(() => null);
      setNotice('Mensagem enviada. Atendimento manual ativo para este cliente.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSendingMessage(false);
    }
  }

  async function openQrModal() {
    if (isMetaProvider) {
      await runAction(async () => {
        const payload = await request('/api/whatsapp/connect', { method: 'POST' });
        setStatus(payload);
      }, 'Meta verificada.');
      return;
    }

    setQrModalOpen(true);

    if (!connected && !hasQr && status.status !== 'connecting') {
      await runAction(() => request('/api/whatsapp/connect', { method: 'POST' }), 'QR Code gerado.');
    }
  }

  async function disconnectWhatsApp() {
    await runAction(async () => {
      const payload = await request('/api/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({ clearSession: false }) });
      setStatus(payload);
    }, 'WhatsApp desconectado.');
  }

  async function selectWhatsappProvider(provider) {
    if (provider === activeProvider) {
      return;
    }

    await runAction(async () => {
      const payload = await request('/api/whatsapp/provider', {
        method: 'PUT',
        body: JSON.stringify({ provider }),
      });
      setStatus(payload);
      if (provider === 'meta') {
        setQrModalOpen(false);
      }
    }, provider === 'meta' ? 'WhatsApp Oficial Meta selecionado.' : 'WhatsApp via QR selecionado.');
  }

  async function clearWhatsAppSession() {
    const confirmation = window.prompt(`Digite ${WHATSAPP_CLEAR_SESSION_CONFIRMATION} para limpar a sessao local do WhatsApp.`);

    if (confirmation !== WHATSAPP_CLEAR_SESSION_CONFIRMATION) {
      setNotice('Limpeza da sessao cancelada.');
      return;
    }

    await runAction(
      () =>
        request('/api/whatsapp/disconnect', {
          method: 'POST',
          body: JSON.stringify({ clearSession: true, confirm: confirmation }),
        }),
      'Backup criado e sessao local limpa.'
    );
  }

  async function toggleFollowups() {
    const enabled = !followupsEnabled;
    await runAction(async () => {
      const payload = await request('/api/followups/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      setStatus(payload);
    }, enabled ? 'Follow-ups ativados.' : 'Follow-ups desativados.');
  }

  async function connectGoogle(leadType) {
    setBusy(true);
    setNotice('');
    try {
      const suffix = leadType ? `?leadType=${leadType}` : '';
      const payload = await request(`/api/google/auth-url${suffix}`);
      window.location.assign(payload.authUrl);
    } catch (error) {
      setNotice(error.message);
      setBusy(false);
    }
  }

  async function disconnectGoogle(leadType) {
    await runAction(async () => {
      const payload = await request('/api/google/disconnect', { method: 'POST', body: JSON.stringify({ leadType }) });
      setStatus(payload);
    }, leadType === 'high_ticket' ? 'Agenda Wilson desconectada.' : 'Agenda Andre desconectada.');
  }

  async function toggleSelectedConversationAi() {
    if (!selectedLead?.jid) {
      return;
    }

    const aiPaused = !selectedAiPaused;
    await runAction(async () => {
      const payload = await request(`/api/conversations/${encodeURIComponent(selectedLead.jid)}/ai`, {
        method: 'PATCH',
        body: JSON.stringify({ aiPaused }),
      });
      setConversations((current) => ({ ...current, [payload.jid]: payload }));
    }, aiPaused ? 'IA pausada nesta conversa.' : 'IA retomada nesta conversa.');
  }

  async function saveOutreachMessage(event) {
    event.preventDefault();
    setOutreachBusy(true);
    setNotice('');

    try {
      const payload = await request('/api/outreach/message', {
        method: 'PUT',
        body: JSON.stringify({ message: outreachMessage }),
      });
      setOutreach(payload);
      setNotice('Mensagem de prospecção salva.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setOutreachBusy(false);
    }
  }

  async function saveOutreachInterval(event) {
    event.preventDefault();
    setOutreachBusy(true);
    setNotice('');

    try {
      const payload = await request('/api/outreach/interval', {
        method: 'PUT',
        body: JSON.stringify({ intervalMinutes: Number(outreachInterval) }),
      });
      setOutreach(payload);
      setOutreachInterval(payload.intervalMinutes);
      setNotice(`Intervalo definido: uma chamada a cada ${payload.intervalMinutes} minuto${payload.intervalMinutes === 1 ? '' : 's'}.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setOutreachBusy(false);
    }
  }

  async function addOutreachContact(event) {
    event.preventDefault();
    setOutreachBusy(true);
    setNotice('');

    try {
      const payload = await request('/api/outreach/contacts', {
        method: 'POST',
        body: JSON.stringify(outreachDraft),
      });
      setOutreach(payload);
      setOutreachDraft({ name: '', company: '', phone: '' });
      setNotice('Contato adicionado à lista.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setOutreachBusy(false);
    }
  }

  async function removeOutreachContact(id) {
    setOutreachBusy(true);
    setNotice('');

    try {
      const payload = await request(`/api/outreach/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setOutreach(payload);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setOutreachBusy(false);
    }
  }

  async function toggleOutreach() {
    setOutreachBusy(true);
    setNotice('');

    try {
      const isRunning = outreach.status === 'running';
      const payload = await request(isRunning ? '/api/outreach/pause' : '/api/outreach/start', {
        method: 'POST',
        body: isRunning ? undefined : JSON.stringify({ retryFailed: outreach.counts?.failed > 0 }),
      });
      setOutreach(payload);
      setNotice(isRunning ? 'Prospecção pausada. Os contatos pendentes permanecem na fila.' : 'Prospecção iniciada. Os contatos serão chamados um por vez.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setOutreachBusy(false);
    }
  }

  async function saveAgentPrompt(event) {
    event.preventDefault();
    setAgentBusy(true);
    setNotice('');

    try {
      const payload = await request('/api/agent/prompt', {
        method: 'PUT',
        body: JSON.stringify({ prompt: agentPrompt }),
      });
      setAgent(payload);
      setNotice('Prompt principal do agente salvo.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAgentBusy(false);
    }
  }

  async function createAgentFlow(event) {
    event.preventDefault();
    setAgentBusy(true);
    setNotice('');

    try {
      const payload = await request('/api/agent/flows', {
        method: 'POST',
        body: JSON.stringify(agentFlowDraft),
      });
      setAgent(payload);
      setAgentFlowDraft({ active: true, instructions: '', name: '', trigger: 'inbound' });
      setNotice('Fluxo criado e pronto para uso.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAgentBusy(false);
    }
  }

  function changeAgentFlow(id, changes) {
    setAgent((current) => ({
      ...current,
      flows: (current.flows || []).map((flow) => (flow.id === id ? { ...flow, ...changes } : flow)),
    }));
  }

  async function saveAgentFlow(event, flow) {
    event.preventDefault();
    setAgentBusy(true);
    setNotice('');

    try {
      const payload = await request(`/api/agent/flows/${encodeURIComponent(flow.id)}`, {
        method: 'PUT',
        body: JSON.stringify(flow),
      });
      setAgent(payload);
      setNotice(`Fluxo "${flow.name}" atualizado.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAgentBusy(false);
    }
  }

  async function deleteAgentFlow(id) {
    setAgentBusy(true);
    setNotice('');

    try {
      const payload = await request(`/api/agent/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setAgent(payload);
      setNotice('Fluxo removido.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAgentBusy(false);
    }
  }

  function getProviderStatusMeta(provider) {
    const providerState = providerStates[provider] || {};
    const providerConfig = providerState.provider || {};
    const statusValue = providerState.status || 'disconnected';
    const isActive = provider === activeProvider;
    const configured = provider === 'baileys' ? true : Boolean(providerConfig.configured);

    if (provider === 'meta' && !configured) {
      return {
        label: isActive ? 'Ativo - aguardando credenciais' : 'Aguardando credenciais',
        tone: 'offline',
      };
    }

    if (statusValue === 'connected') {
      return {
        label: isActive ? 'Ativo - conectado' : 'Conectado',
        tone: 'online',
      };
    }

    if (statusValue === 'connecting') {
      return {
        label: isActive ? 'Ativo - conectando' : 'Conectando',
        tone: 'loading',
      };
    }

    if (providerState.qrDataUrl || configured) {
      return {
        label: isActive ? 'Ativo - pronto' : 'Pronto para usar',
        tone: 'ready',
      };
    }

    return {
      label: isActive ? 'Ativo - desconectado' : 'Desconectado',
      tone: 'offline',
    };
  }

  function renderOverview() {
    return (
      <>
        <section className="metrics-grid summary">
          {metrics.map((metric) => (
            <MetricCard key={metric.label} metric={metric} />
          ))}
        </section>

        <section className="overview-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Hoje</span>
                <h2>Operacao</h2>
              </div>
              <Tag type="neutral">{summary.totalLeads} leads</Tag>
            </div>

            <div className="mini-metrics">
              {secondaryMetrics.map((metric) => (
                <MetricCard key={metric.label} metric={metric} compact />
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Sistema</span>
                <h2>Estado atual</h2>
              </div>
              <ShieldCheck size={20} />
            </div>

            <div className="status-stack">
              <ConnectionItem icon={MessageCircle} label={connectionLabel} meta={STATUS_LABELS[status.status] || status.status} tone={connectionTone} />
              <ConnectionItem
                icon={CalendarCheck}
                label="Agendas"
                meta={highTicketCalendarConnected || lowTicketCalendarConnected ? 'Conectadas' : googleOauthConfigured ? 'Prontas para conectar' : 'Nao configuradas'}
                tone={getConnectionTone(highTicketCalendarConnected || lowTicketCalendarConnected, googleOauthConfigured)}
              />
              <ConnectionItem
                icon={Clock3}
                label="Follow-ups"
                meta={followupsEnabled ? 'Ativos' : followupsConfigured ? 'Desativados' : 'Nao configurados'}
                tone={followupsTone}
              />
            </div>
          </article>
        </section>
      </>
    );
  }

  function renderClients() {
    return (
      <article className="panel clients-panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Atendimento</span>
            <h2>Chats de clientes</h2>
          </div>
          <div className="chat-header-tags">
            <Tag type="neutral">{leads.length} registros</Tag>
            {chatSummary.needsReply ? <Tag type="high">{chatSummary.needsReply} para responder</Tag> : null}
            {chatSummary.manual ? <Tag type="manual">{chatSummary.manual} manual</Tag> : null}
          </div>
        </div>

        <div className="chat-toolbar">
          <label className="chat-search">
            <Search size={17} />
            <input
              type="search"
              value={chatSearch}
              onChange={(event) => setChatSearch(event.target.value)}
              placeholder="Buscar cliente, telefone ou mensagem"
            />
          </label>
          <div className="segmented-control" aria-label="Filtrar chats">
            <button type="button" className={chatFilter === 'all' ? 'active' : ''} onClick={() => setChatFilter('all')}>
              Todos
            </button>
            <button type="button" className={chatFilter === 'needsReply' ? 'active' : ''} onClick={() => setChatFilter('needsReply')}>
              Responder
            </button>
            <button type="button" className={chatFilter === 'manual' ? 'active' : ''} onClick={() => setChatFilter('manual')}>
              Manual
            </button>
          </div>
        </div>

        <div className={`clients-layout ${selectedLead ? 'has-selection' : ''}`}>
          <div className="client-list">
            {filteredLeads.length ? (
              filteredLeads.map((lead) => {
                const conversation = conversations[lead.jid];
                const paused = isAiPausedForConversation(conversation, lead);
                const needsReply = leadNeedsReply(conversation);

                return (
                  <button
                    type="button"
                    className={`client-row ${selectedClientJid === lead.jid ? 'selected' : ''} ${needsReply ? 'needs-reply' : ''}`}
                    key={lead.jid}
                    onClick={() => setSelectedClientJid(lead.jid)}
                  >
                    <div className="client-avatar">{(lead.contactName || lead.phone || '?').slice(0, 1).toUpperCase()}</div>
                    <div className="client-main">
                      <div className="client-heading">
                        <strong>{lead.contactName || lead.phone}</strong>
                        <time>{formatTime(lead.lastMessageAt)}</time>
                      </div>
                      <span>{lead.phone}</span>
                      <p>{lead.lastMessage || 'Sem mensagens recentes.'}</p>
                    </div>
                    <div className="client-route">
                      <Tag type={paused ? 'manual' : getLeadTag(lead)}>{paused ? 'Manual' : getLeadLabel(lead)}</Tag>
                      <small>{needsReply ? 'Responder cliente' : paused ? 'IA pausada' : lead.route}</small>
                    </div>
                  </button>
                );
              })
            ) : (
              <p className="empty-state">Nenhum chat encontrado.</p>
            )}
          </div>

          <section className={`conversation-panel ${selectedLead ? '' : 'empty'}`}>
            {selectedLead ? (
              <>
                <div className="conversation-header">
                  <div className="conversation-title">
                    <strong>{selectedLead.contactName || selectedLead.phone || 'Cliente'}</strong>
                    <span>{selectedLead.phone || selectedLead.jid}</span>
                  </div>
                  <div className="conversation-status">
                    <div className="conversation-tags">
                      <Tag type={getLeadTag(selectedLead)}>{getLeadLabel(selectedLead)}</Tag>
                      {selectedNeedsReply ? <Tag type="high">Responder</Tag> : null}
                      {selectedAiPaused ? <Tag type="manual">Manual</Tag> : null}
                    </div>
                    <small>{selectedAiPaused ? 'IA pausada' : `${selectedMessages.length} mensagens`}</small>
                    <button
                      type="button"
                      className={`manual-toggle ${selectedAiPaused ? 'active' : ''}`}
                      disabled={busy}
                      onClick={toggleSelectedConversationAi}
                      title={selectedAiPaused ? 'Retomar IA nesta conversa' : 'Assumir atendimento manual'}
                    >
                      {selectedAiPaused ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
                      <span>{selectedAiPaused ? 'Retomar IA' : 'Assumir'}</span>
                    </button>
                  </div>
                </div>

                <div className="conversation-context">
                  <span>{selectedLead.route || 'Aguardando'}</span>
                  <span>{selectedLead.messageCount || selectedMessages.length} mensagens</span>
                  {selectedLastMessage ? <span>Ultima {formatTime(selectedLastMessage.createdAt)}</span> : null}
                </div>

                <div className="conversation-messages">
                  {selectedMessages.length ? (
                    selectedMessages.map((message) => (
                      <div className={`message-bubble ${message.direction === 'out' ? 'out' : 'in'}`} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.direction === 'out' ? message.automationName || 'Bot' : 'Cliente'}</strong>
                          <time>{formatTime(message.createdAt)}</time>
                        </div>
                        <p>{message.text || 'Mensagem sem texto.'}</p>
                      </div>
                    ))
                  ) : (
                    <p className="empty-state">Sem historico salvo para este cliente.</p>
                  )}
                  <span ref={messagesEndRef} />
                </div>

                <form className="message-composer" onSubmit={sendManualMessage}>
                  <textarea
                    value={manualMessage}
                    onChange={(event) => setManualMessage(event.target.value)}
                    placeholder={`Mensagem para ${selectedLead.contactName || selectedLead.phone || 'cliente'}`}
                    disabled={!connected || sendingMessage}
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>
                      {!connected
                        ? `${connectionLabel} precisa estar conectado.`
                        : selectedAiPaused
                          ? 'Atendimento manual ativo.'
                          : 'Ao enviar, a IA sera pausada para este cliente.'}
                    </span>
                    <button type="submit" className="primary-action send-message-button" disabled={!canSendManualMessage}>
                      <Send size={18} />
                      {sendingMessage ? 'Enviando' : 'Enviar'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="conversation-empty">
                <MessageCircle size={34} />
                <strong>Selecione um cliente</strong>
                <span>A conversa completa aparece aqui.</span>
              </div>
            )}
          </section>
        </div>
      </article>
    );
  }

  function renderConnections() {
    return (
      <section className="connection-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">WhatsApp</span>
              <h2>Canal ativo</h2>
            </div>
            <MessageCircle size={20} />
          </div>

          <div className="provider-switcher">
            <div className="segmented-control" aria-label="Selecionar canal do WhatsApp">
              {providerOptions.map((provider) => (
                <button
                  type="button"
                  className={activeProvider === provider.id ? 'active' : ''}
                  disabled={busy}
                  key={provider.id}
                  onClick={() => selectWhatsappProvider(provider.id)}
                >
                  {provider.id === 'meta' ? 'Meta Oficial' : 'QR Code'}
                </button>
              ))}
            </div>
          </div>

          <div className="hero-connection">
            <span className={`status-pill ${connectionTone}`}>
              <span />
              {botLabel}
            </span>
            {isMetaProvider ? (
              <button type="button" className="primary-action" disabled={busy || connected} onClick={openQrModal}>
                {connected ? <CheckCircle2 size={19} /> : <RefreshCcw size={19} />}
                {connected ? 'Ativo' : 'Verificar'}
              </button>
            ) : (
              <button type="button" className={connected ? 'danger' : 'primary-action'} disabled={busy} onClick={connected ? disconnectWhatsApp : openQrModal}>
                {connected ? <Power size={19} /> : <QrCode size={19} />}
                {connected ? 'Desconectar' : 'Conectar'}
              </button>
            )}
          </div>

          <div className="connection-list">
            {providerOptions.map((provider) => {
              const providerMeta = getProviderStatusMeta(provider.id);

              return (
                <ConnectionItem
                  icon={provider.id === 'meta' ? ShieldCheck : QrCode}
                  key={provider.id}
                  label={provider.label}
                  meta={providerMeta.label}
                  tone={providerMeta.tone}
                  action={
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy || activeProvider === provider.id}
                      onClick={() => selectWhatsappProvider(provider.id)}
                      aria-label={`Selecionar ${provider.label}`}
                      title={activeProvider === provider.id ? 'Canal ativo' : `Selecionar ${provider.label}`}
                    >
                      {activeProvider === provider.id ? <CheckCircle2 size={17} /> : <ArrowUpRight size={17} />}
                    </button>
                  }
                />
              );
            })}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Agenda</span>
              <h2>Roteamento</h2>
            </div>
            <CalendarCheck size={20} />
          </div>

          <div className="connection-list">
            <ConnectionItem
              icon={CalendarCheck}
              label="Agenda Wilson"
              meta={highTicketCalendarConnected ? 'Rating baixo ativo' : googleOauthConfigured ? 'Pronto para OAuth' : 'Nao configurado'}
              tone={getConnectionTone(highTicketCalendarConnected, googleOauthConfigured)}
              action={
                <button
                  type="button"
                  className={`icon-button ${highTicketCalendarConnected ? 'danger' : ''}`}
                  disabled={busy || (!highTicketCalendarConnected && !googleOauthConfigured)}
                  onClick={() => (highTicketCalendarConnected ? disconnectGoogle('high_ticket') : connectGoogle('high_ticket'))}
                  aria-label={highTicketCalendarConnected ? 'Desconectar agenda Wilson' : 'Conectar agenda Wilson'}
                  title={highTicketCalendarConnected ? 'Desconectar agenda Wilson' : 'Conectar agenda Wilson'}
                >
                  {highTicketCalendarConnected ? <Unlink size={17} /> : <ArrowUpRight size={17} />}
                </button>
              }
            />
            <ConnectionItem
              icon={CalendarCheck}
              label="Agenda Andre"
              meta={lowTicketCalendarConnected ? 'Negativado ativo' : googleOauthConfigured ? 'Pronto para OAuth' : 'Nao configurado'}
              tone={getConnectionTone(lowTicketCalendarConnected, googleOauthConfigured)}
              action={
                <button
                  type="button"
                  className={`icon-button ${lowTicketCalendarConnected ? 'danger' : ''}`}
                  disabled={busy || (!lowTicketCalendarConnected && !googleOauthConfigured)}
                  onClick={() => (lowTicketCalendarConnected ? disconnectGoogle('low_ticket') : connectGoogle('low_ticket'))}
                  aria-label={lowTicketCalendarConnected ? 'Desconectar agenda Andre' : 'Conectar agenda Andre'}
                  title={lowTicketCalendarConnected ? 'Desconectar agenda Andre' : 'Conectar agenda Andre'}
                >
                  {lowTicketCalendarConnected ? <Unlink size={17} /> : <ArrowUpRight size={17} />}
                </button>
              }
            />
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Follow-ups</span>
              <h2>Lembretes automaticos</h2>
            </div>
            <Clock3 size={20} />
          </div>

          <div className="hero-connection">
            <span className={`status-pill ${followupsTone}`}>
              <span />
              {followupsEnabled ? 'Ativos' : followupsConfigured ? 'Desativados' : 'Nao configurados'}
            </span>
            <button type="button" className={followupsEnabled ? 'danger' : 'primary-action'} disabled={busy || !followupsConfigured} onClick={toggleFollowups}>
              <Power size={19} />
              {followupsEnabled ? 'Desativar' : 'Ativar'}
            </button>
          </div>
        </article>
      </section>
    );
  }

  function renderAgendaEvent(item, { compact = false } = {}) {
    const route = item.source === 'pipeline' ? `${getAppointmentRoute(item)} - Pipeline` : getAppointmentRoute(item);

    return (
      <article className={`calendar-event ${item.status || 'scheduled'} ${item.leadType || 'unknown'} ${compact ? 'compact' : ''}`} key={item.id || item.eventId}>
        <div className="calendar-event-time">
          <strong>{formatTime(item.startDateTime)}</strong>
          {!compact ? <span>{formatDate(item.startDateTime)}</span> : null}
        </div>
        <div className="calendar-event-main">
          <strong>{item.contactName || item.attendeeEmail || item.jid || 'Cliente'}</strong>
          <span>{item.title || 'Reuniao marcada'}</span>
          <small>{route}</small>
        </div>
        <div className="calendar-event-meta">
          <Tag type={getAppointmentStatusTag(item.status)}>{getAppointmentStatusLabel(item.status)}</Tag>
          <div className="calendar-event-actions">
            {item.calendarLink ? (
              <a className="link-button" href={item.calendarLink} target="_blank" rel="noreferrer" aria-label="Abrir no Google Agenda">
                <CalendarCheck size={16} />
                {!compact ? 'Agenda' : null}
              </a>
            ) : null}
            {item.meetLink ? (
              <a className="link-button" href={item.meetLink} target="_blank" rel="noreferrer" aria-label="Abrir Meet">
                <ArrowUpRight size={16} />
                {!compact ? 'Meet' : null}
              </a>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  function renderAppointments() {
    return (
      <section className="agenda-page">
        <article className="calendar-shell">
          <div className="calendar-toolbar">
            <div className="calendar-navigation">
              <button type="button" className="today-button" onClick={() => setAgendaDate(new Date())}>
                Hoje
              </button>
              <button type="button" className="icon-button" onClick={() => setAgendaDate((date) => addDays(date, -7))} aria-label="Semana anterior">
                <ChevronLeft size={17} />
              </button>
              <button type="button" className="icon-button" onClick={() => setAgendaDate((date) => addDays(date, 7))} aria-label="Proxima semana">
                <ChevronRight size={17} />
              </button>
              <div className="calendar-title">
                <CalendarDays size={20} />
                <strong>{formatAgendaRange(agendaDays)}</strong>
              </div>
            </div>

            <div className="calendar-toolbar-side">
              <Tag type="neutral">{agendaView === 'week' ? `${weeklyAppointmentCount} na semana` : `${appointments.length} registros`}</Tag>
              <div className="segmented-control" aria-label="Modo da agenda">
                <button type="button" className={agendaView === 'week' ? 'active' : ''} onClick={() => setAgendaView('week')}>
                  Semana
                </button>
                <button type="button" className={agendaView === 'list' ? 'active' : ''} onClick={() => setAgendaView('list')}>
                  Lista
                </button>
              </div>
            </div>
          </div>

          {agendaView === 'week' ? (
            <div className="calendar-week-grid">
              {agendaDays.map((day) => {
                const dayAppointments = appointmentsByDay[getDateKey(day)] || [];

                return (
                  <section className={`calendar-day ${isSameDay(day, new Date()) ? 'today' : ''}`} key={getDateKey(day)}>
                    <header className="calendar-day-header">
                      <span>{formatWeekday(day)}</span>
                      <strong>{new Intl.DateTimeFormat('pt-BR', { day: '2-digit' }).format(day)}</strong>
                    </header>

                    <div className="calendar-day-events">
                      {dayAppointments.length ? (
                        dayAppointments.map((item) => renderAgendaEvent(item, { compact: true }))
                      ) : (
                        <span className="calendar-empty-slot">Sem reuniões</span>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="calendar-list">
              {sortedAppointments.length ? (
                sortedAppointments.map((item) => renderAgendaEvent(item))
              ) : (
                <p className="empty-state">Nenhuma reuniao registrada na agenda interna.</p>
              )}
            </div>
          )}
        </article>
      </section>
    );
  }

  function renderFollowups() {
    return (
      <section className="follow-page">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Agenda</span>
              <h2>Proximos follow-ups</h2>
            </div>
            <Clock3 size={20} />
          </div>

          <div className="follow-list">
            {followups.upcoming?.length ? (
              followups.upcoming.map((item) => (
                <div className="follow-row" key={item.id || item.eventId}>
                  <div>
                    <strong>{item.contactName || item.attendeeEmail || 'Cliente'}</strong>
                    <span>{formatDateTime(item.startDateTime)}</span>
                  </div>
                  <small>{item.leadType === 'high_ticket' ? 'Wilson' : item.leadType === 'low_ticket' ? 'Andre' : 'Agenda'}</small>
                  <Tag type="neutral">pendente</Tag>
                </div>
              ))
            ) : (
              <p className="empty-state">Nenhum follow-up pendente.</p>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Log</span>
              <h2>Atividade recente</h2>
            </div>
            <Activity size={20} />
          </div>

          <div className="activity-list">
            {recentActivity.length ? (
              recentActivity.map((item) => (
                <div className="activity-row" key={item.id}>
                  <span>{item.message}</span>
                  <time>{formatTime(item.createdAt)}</time>
                </div>
              ))
            ) : (
              <p className="empty-state">Nenhuma atividade recente.</p>
            )}
          </div>
        </article>
      </section>
    );
  }

  function renderOutreach() {
    const contacts = outreach.contacts || [];
    const counts = outreach.counts || {};
    const isRunning = outreach.status === 'running';
    const statusLabel = isRunning ? 'Em andamento' : outreach.status === 'completed' ? 'Concluída' : outreach.status === 'paused' ? 'Pausada' : 'Pronta para iniciar';

    return (
      <section className="outreach-page">
        <article className="panel outreach-intro">
          <div>
            <span className="eyebrow">Disparo individual</span>
            <h2>Chamadas de prospecção pelo WhatsApp</h2>
            <p>Cadastre os contatos e inicie quando estiver pronto. Cada mensagem é enviada uma por vez, usando as pausas e limites de segurança do canal conectado.</p>
          </div>
          <div className="outreach-progress" aria-label="Resumo da lista">
            <span><strong>{contacts.length}</strong> contatos</span>
            <span><strong>{counts.sent || 0}</strong> enviados</span>
            <span><strong>{counts.failed || 0}</strong> falharam</span>
          </div>
        </article>

        <article className="panel outreach-timing">
          <div>
            <span className="eyebrow">Ritmo da prospecção</span>
            <h2>Intervalo entre as chamadas</h2>
            <p>O primeiro contato é chamado imediatamente ao iniciar; os próximos seguem este intervalo.</p>
          </div>
          <form className="outreach-interval-form" onSubmit={saveOutreachInterval}>
            <label htmlFor="outreach-interval">Chamar a cada</label>
            <input id="outreach-interval" type="number" min="1" max="1440" step="1" value={outreachInterval} onChange={(event) => setOutreachInterval(event.target.value)} disabled={outreachBusy || isRunning} />
            <span>minutos</span>
            <button type="submit" disabled={outreachBusy || isRunning}>Salvar intervalo</button>
          </form>
        </article>

        {isMetaProvider ? <p className="outreach-warning">No WhatsApp Oficial Meta, a primeira mensagem para um contato só pode ser enviada por um template aprovado. Para esta lista de texto livre, use o canal WhatsApp via QR.</p> : null}

        <div className="outreach-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">1. Mensagem</span>
                <h2>Mensagem de abertura</h2>
              </div>
              <MessageCircle size={20} />
            </div>
            <form className="outreach-form" onSubmit={saveOutreachMessage}>
              <textarea
                value={outreachMessage}
                onChange={(event) => setOutreachMessage(event.target.value)}
                placeholder="Olá, {{nome}}! Tudo bem?"
                rows={7}
                disabled={outreachBusy || isRunning}
              />
              <p className="form-hint">Use <code>{'{{nome}}'}</code> e <code>{'{{empresa}}'}</code> para personalizar a mensagem. Se o campo estiver vazio, será usado um texto neutro.</p>
              <button type="submit" disabled={outreachBusy || isRunning}>
                Salvar mensagem
              </button>
            </form>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">2. Contatos</span>
                <h2>Adicionar à lista</h2>
              </div>
              <ListPlus size={20} />
            </div>
            <form className="outreach-form" onSubmit={addOutreachContact}>
              <label>Nome
                <input value={outreachDraft.name} onChange={(event) => setOutreachDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Ex.: Maria Silva" disabled={outreachBusy || isRunning} />
              </label>
              <label>Empresa
                <input value={outreachDraft.company} onChange={(event) => setOutreachDraft((current) => ({ ...current, company: event.target.value }))} placeholder="Ex.: Empresa Ltda." disabled={outreachBusy || isRunning} />
              </label>
              <label>Telefone <small>obrigatório</small>
                <input value={outreachDraft.phone} onChange={(event) => setOutreachDraft((current) => ({ ...current, phone: event.target.value }))} placeholder="5511999999999" inputMode="tel" required disabled={outreachBusy || isRunning} />
              </label>
              <button type="submit" disabled={outreachBusy || isRunning}>Adicionar contato</button>
            </form>
          </article>
        </div>

        <article className="panel outreach-list-panel">
          <div className="panel-header outreach-list-header">
            <div>
              <span className="eyebrow">3. Envio</span>
              <h2>Fila de prospecção</h2>
              <p className="outreach-status">{statusLabel} · a cada {outreach.intervalMinutes || 1} minuto{(outreach.intervalMinutes || 1) === 1 ? '' : 's'}</p>
            </div>
            <button type="button" className={isRunning ? 'danger' : 'primary-action'} disabled={outreachBusy || (!isRunning && !connected)} onClick={toggleOutreach}>
              {isRunning ? <PauseCircle size={18} /> : <PlayCircle size={18} />}
              {isRunning ? 'Pausar lista' : 'Iniciar lista'}
            </button>
          </div>
          {!connected ? <p className="outreach-warning">Conecte o WhatsApp para iniciar o envio.</p> : null}
          <div className="outreach-contacts">
            {contacts.length ? contacts.map((contact) => (
              <div className="outreach-contact" key={contact.id}>
                <div>
                  <strong>{contact.name || contact.phone}</strong>
                  <span>{contact.company ? `${contact.company} · ` : ''}{contact.phone}</span>
                  {contact.error ? <small className="error-text">{contact.error}</small> : null}
                </div>
                <div className="outreach-contact-actions">
                  <Tag type={contact.status === 'sent' ? 'meeting' : contact.status === 'failed' ? 'discarded' : 'neutral'}>{contact.status === 'sent' ? 'enviado' : contact.status === 'failed' ? 'falhou' : contact.status === 'processing' ? 'enviando' : 'aguardando'}</Tag>
                  <button type="button" className="icon-button" aria-label={`Remover ${contact.name || contact.phone}`} disabled={outreachBusy || isRunning} onClick={() => removeOutreachContact(contact.id)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            )) : <p className="empty-state">Nenhum contato na lista ainda.</p>}
          </div>
        </article>
      </section>
    );
  }

  function renderAgent() {
    const flows = agent.flows || [];

    return (
      <section className="agent-page">
        <article className="panel agent-intro">
          <div>
            <span className="eyebrow">IA configurável</span>
            <h2>Você define como o agente trabalha</h2>
            <p>O prompt principal define a personalidade e as regras gerais. Cada fluxo define o que a IA deve fazer em uma situação específica.</p>
          </div>
          <div className="agent-intro-tags">
            <span><strong>{flows.filter((flow) => flow.active).length}</strong> fluxos ativos</span>
            <span><strong>{flows.filter((flow) => flow.trigger === 'inbound').length}</strong> entrada</span>
            <span><strong>{flows.filter((flow) => flow.trigger === 'prospecting').length}</strong> prospecção</span>
          </div>
        </article>

        <div className="agent-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Prompt principal</span>
                <h2>Instruções gerais do agente</h2>
              </div>
              <Bot size={20} />
            </div>
            <form className="agent-form" onSubmit={saveAgentPrompt}>
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={10} placeholder="Ex.: Você representa minha empresa. Fale de forma direta, consultiva e use português do Brasil." disabled={agentBusy} />
              <p className="form-hint">Esse texto vale para todos os fluxos. Escreva aqui tom de voz, regras, produto e tudo que a IA precisa saber sempre.</p>
              <button type="submit" className="primary-action" disabled={agentBusy}>Salvar prompt</button>
            </form>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Novo fluxo</span>
                <h2>Criar uma automação da IA</h2>
              </div>
              <Workflow size={20} />
            </div>
            <form className="agent-form" onSubmit={createAgentFlow}>
              <label>Nome do fluxo
                <input value={agentFlowDraft.name} onChange={(event) => setAgentFlowDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Ex.: Atendimento inicial" disabled={agentBusy} required />
              </label>
              <label>Quando usar
                <select value={agentFlowDraft.trigger} onChange={(event) => setAgentFlowDraft((current) => ({ ...current, trigger: event.target.value }))} disabled={agentBusy}>
                  <option value="inbound">Quando a pessoa entra em contato</option>
                  <option value="prospecting">Quando eu inicio a prospecção</option>
                </select>
              </label>
              <label>Instruções do fluxo
                <textarea value={agentFlowDraft.instructions} onChange={(event) => setAgentFlowDraft((current) => ({ ...current, instructions: event.target.value }))} rows={6} placeholder="Explique para a IA o objetivo, a sequência da conversa e o que ela pode ou não pode fazer." disabled={agentBusy} required />
              </label>
              <label className="checkbox-field"><input type="checkbox" checked={agentFlowDraft.active} onChange={(event) => setAgentFlowDraft((current) => ({ ...current, active: event.target.checked }))} disabled={agentBusy} /> Ativar este fluxo assim que salvar</label>
              <button type="submit" disabled={agentBusy}>Criar fluxo</button>
            </form>
          </article>
        </div>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Fluxos criados</span>
              <h2>Editar os comportamentos da IA</h2>
            </div>
            <Workflow size={20} />
          </div>
          <div className="agent-flow-list">
            {flows.length ? flows.map((flow) => (
              <form className="agent-flow-card" key={flow.id} onSubmit={(event) => saveAgentFlow(event, flow)}>
                <div className="agent-flow-heading">
                  <label>Nome
                    <input value={flow.name} onChange={(event) => changeAgentFlow(flow.id, { name: event.target.value })} disabled={agentBusy} required />
                  </label>
                  <label>Gatilho
                    <select value={flow.trigger} onChange={(event) => changeAgentFlow(flow.id, { trigger: event.target.value })} disabled={agentBusy}>
                      <option value="inbound">Entrada de contato</option>
                      <option value="prospecting">Prospecção</option>
                    </select>
                  </label>
                </div>
                <label>Instruções
                  <textarea value={flow.instructions} onChange={(event) => changeAgentFlow(flow.id, { instructions: event.target.value })} rows={6} disabled={agentBusy} required />
                </label>
                <div className="agent-flow-actions">
                  <label className="checkbox-field"><input type="checkbox" checked={flow.active} onChange={(event) => changeAgentFlow(flow.id, { active: event.target.checked })} disabled={agentBusy} /> Fluxo ativo</label>
                  <div>
                    <button type="button" className="danger" disabled={agentBusy} onClick={() => deleteAgentFlow(flow.id)}><Trash2 size={17} /> Excluir</button>
                    <button type="submit" className="primary-action" disabled={agentBusy}>Salvar fluxo</button>
                  </div>
                </div>
              </form>
            )) : <p className="empty-state">Nenhum fluxo criado. Comece pelo fluxo de entrada ou pelo de prospecção.</p>}
          </div>
        </article>
      </section>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-line">
          <span className="brand-icon">
            <Bot size={22} />
          </span>
          <div>
            <strong>Wilson Sanches</strong>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Dashboard">
          <button type="button" className={activeView === 'overview' ? 'active' : ''} onClick={() => setActiveView('overview')}>
            <Activity size={18} />
            Operacao
          </button>
          <button type="button" className={activeView === 'clients' ? 'active' : ''} onClick={() => setActiveView('clients')}>
            <MessageCircle size={18} />
            Clientes
          </button>
          <button type="button" className={activeView === 'connections' ? 'active' : ''} onClick={() => setActiveView('connections')}>
            <Wifi size={18} />
            Conexoes
          </button>
          <button type="button" className={activeView === 'appointments' ? 'active' : ''} onClick={() => setActiveView('appointments')}>
            <CalendarCheck size={18} />
            Agenda
          </button>
          <button type="button" className={activeView === 'followups' ? 'active' : ''} onClick={() => setActiveView('followups')}>
            <Clock3 size={18} />
            Follow-ups
          </button>
          <button type="button" className={activeView === 'outreach' ? 'active' : ''} onClick={() => setActiveView('outreach')}>
            <ListPlus size={18} />
            Prospecção
          </button>
          <button type="button" className={activeView === 'agent' ? 'active' : ''} onClick={() => setActiveView('agent')}>
            <Workflow size={18} />
            Agente e fluxos
          </button>
        </nav>

        <div className={`sidebar-status ${connectionTone}`}>
          <span>WhatsApp</span>
          <strong>{STATUS_LABELS[status.status] || status.status}</strong>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">{view.eyebrow}</span>
            <h1>{view.title}</h1>
          </div>

          <div className="topbar-actions">
            <span className={`status-pill ${connectionTone}`}>
              <span />
              {botLabel}
            </span>
            <button type="button" className="primary-action" disabled={busy || connected} onClick={openQrModal}>
              {isMetaProvider ? connected ? <CheckCircle2 size={19} /> : <RefreshCcw size={19} /> : <QrCode size={19} />}
              {connected ? `${connectionLabel} conectado` : isMetaProvider ? 'Verificar Meta' : 'Conectar WhatsApp'}
            </button>
          </div>
        </header>

        {notice ? <p className="notice">{notice}</p> : null}
        {status.lastError ? <p className="error-text">{status.lastError}</p> : null}
        {dashboardStorageError ? <p className="error-text">Banco de clientes indisponivel: {dashboardStorageError}</p> : null}

        {activeView === 'overview' ? renderOverview() : null}
        {activeView === 'clients' ? renderClients() : null}
        {activeView === 'connections' ? renderConnections() : null}
        {activeView === 'appointments' ? renderAppointments() : null}
        {activeView === 'followups' ? renderFollowups() : null}
        {activeView === 'outreach' ? renderOutreach() : null}
        {activeView === 'agent' ? renderAgent() : null}
      </section>

      {qrModalOpen && !isMetaProvider ? (
        <div className="modal-backdrop" role="presentation">
          <section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-modal-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">WhatsApp</span>
                <h2 id="qr-modal-title">{connected ? 'Sessao conectada' : 'Conectar aparelho'}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setQrModalOpen(false)} aria-label="Fechar modal">
                <X size={18} />
              </button>
            </div>

            <div className="qr-stage">
              {hasQr ? (
                <img src={status.qrDataUrl} alt="QR Code do WhatsApp" />
              ) : (
                <div className="qr-placeholder">
                  {connected ? <CheckCircle2 size={86} /> : <QrCode size={86} />}
                  <strong>{connected ? 'WhatsApp conectado' : status.status === 'connecting' ? 'Gerando QR Code' : 'QR Code indisponivel'}</strong>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                disabled={busy || connected}
                onClick={() => runAction(() => request('/api/whatsapp/connect', { method: 'POST' }), 'QR Code gerado.')}
              >
                <RefreshCcw size={18} />
                Gerar novo QR
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(() => request('/api/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({ clearSession: false }) }), 'Desconectado.')}
              >
                <Power size={18} />
                Desconectar
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={clearWhatsAppSession}
              >
                <Trash2 size={18} />
                Limpar sessao
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
