import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Activity,
  ArrowUpRight,
  Bot,
  CalendarCheck,
  CheckCircle2,
  Clock3,
  MessageCircle,
  PieChart,
  Power,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Unlink,
  UserCheck,
  Wifi,
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
  const [conversations, setConversations] = useState({});
  const [followups, setFollowups] = useState({ recent: [], upcoming: [] });
  const [leads, setLeads] = useState([]);
  const [notice, setNotice] = useState('');
  const [selectedClientJid, setSelectedClientJid] = useState(null);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [busy, setBusy] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);

  const connected = status.status === 'connected';
  const hasQr = Boolean(status.qrDataUrl);
  const googleOauthConfigured = Boolean(status.calendar?.oauth?.configured);
  const lowTicketCalendarConnected = Boolean(status.calendar?.oauth?.connected?.lowTicket);
  const highTicketCalendarConnected = Boolean(status.calendar?.oauth?.connected?.highTicket);
  const followupsConfigured = Boolean(status.followups?.configured);
  const followupsEnabled = Boolean(status.followups?.enabled);
  const followupsTone = getConnectionTone(followupsEnabled, followupsConfigured);
  const connectionTone = getConnectionTone(connected, hasQr, status.status === 'connecting');
  const botLabel = connected ? 'Bot ativo' : hasQr ? 'QR pronto' : 'Bot pausado';
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
  const selectedConversation = selectedClientJid ? conversations[selectedClientJid] : null;
  const selectedMessages = selectedConversation?.messages || [];

  const recentActivity = useMemo(() => {
    return activity.slice(0, 4);
  }, [activity]);

  async function refreshDashboard() {
    const [summaryPayload, leadsPayload, followupsPayload, conversationsPayload, appointmentsPayload] = await Promise.all([
      request('/api/dashboard/summary'),
      request('/api/leads'),
      request('/api/followups'),
      request('/api/conversations'),
      request('/api/appointments').catch(() => ({ appointments: [] })),
    ]);

    setSummary({ ...EMPTY_SUMMARY, ...(summaryPayload || {}) });
    setLeads(Array.isArray(leadsPayload) ? leadsPayload : []);
    setFollowups(followupsPayload || { recent: [], upcoming: [] });
    setConversations(conversationsPayload && typeof conversationsPayload === 'object' ? conversationsPayload : {});
    setAppointments(Array.isArray(appointmentsPayload?.appointments) ? appointmentsPayload.appointments : []);
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
    socket.on('conversations', (payload) => {
      setConversations(payload && typeof payload === 'object' ? payload : {});
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

  async function openQrModal() {
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
              <ConnectionItem icon={MessageCircle} label="WhatsApp" meta={STATUS_LABELS[status.status] || status.status} tone={connectionTone} />
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
            <span className="eyebrow">Pipeline</span>
            <h2>Clientes recentes</h2>
          </div>
          <Tag type="neutral">{leads.length} registros</Tag>
        </div>

        <div className={`clients-layout ${selectedLead ? 'has-selection' : ''}`}>
          <div className="client-list">
            {leads.length ? (
              leads.map((lead) => (
                <button
                  type="button"
                  className={`client-row ${selectedClientJid === lead.jid ? 'selected' : ''}`}
                  key={lead.jid}
                  onClick={() => setSelectedClientJid(lead.jid)}
                >
                  <div className="client-avatar">{(lead.contactName || lead.phone || '?').slice(0, 1)}</div>
                  <div className="client-main">
                    <div className="client-heading">
                      <strong>{lead.contactName || lead.phone}</strong>
                      <time>{formatTime(lead.lastMessageAt)}</time>
                    </div>
                    <span>{lead.phone}</span>
                    <p>{lead.lastMessage || 'Sem mensagens recentes.'}</p>
                  </div>
                  <div className="client-route">
                    <Tag type={getLeadTag(lead)}>{getLeadLabel(lead)}</Tag>
                    <small>{lead.route}</small>
                  </div>
                </button>
              ))
            ) : (
              <p className="empty-state">Nenhum cliente registrado ainda.</p>
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
                    <Tag type={getLeadTag(selectedLead)}>{getLeadLabel(selectedLead)}</Tag>
                    <small>{selectedMessages.length} mensagens</small>
                  </div>
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
                </div>
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
              <h2>Conexao principal</h2>
            </div>
            <MessageCircle size={20} />
          </div>

          <div className="hero-connection">
            <span className={`status-pill ${connectionTone}`}>
              <span />
              {botLabel}
            </span>
            <button type="button" className={connected ? 'danger' : 'primary-action'} disabled={busy} onClick={connected ? disconnectWhatsApp : openQrModal}>
              {connected ? <Power size={19} /> : <QrCode size={19} />}
              {connected ? 'Desconectar' : 'Conectar'}
            </button>
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

  function renderAppointments() {
    return (
      <section className="agenda-page">
        <article className="panel agenda-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Sistema</span>
              <h2>Reunioes registradas</h2>
            </div>
            <Tag type="neutral">{appointments.length} registros</Tag>
          </div>

          <div className="agenda-list">
            {appointments.length ? (
              appointments.map((item) => (
                <div className={`agenda-row ${item.status || 'scheduled'}`} key={item.id || item.eventId}>
                  <div className="agenda-time">
                    <strong>{formatTime(item.startDateTime)}</strong>
                    <span>{formatDate(item.startDateTime)}</span>
                  </div>

                  <div className="agenda-main">
                    <strong>{item.contactName || item.attendeeEmail || item.jid || 'Cliente'}</strong>
                    <span>{item.title || 'Reuniao marcada'}</span>
                    <small>{item.attendeeEmail || item.jid || 'Sem contato salvo'}</small>
                  </div>

                  <div className="agenda-route">
                    <Tag type={getAppointmentStatusTag(item.status)}>{getAppointmentStatusLabel(item.status)}</Tag>
                    <small>{getAppointmentRoute(item)}</small>
                  </div>

                  <div className="agenda-actions">
                    {item.calendarLink ? (
                      <a className="link-button" href={item.calendarLink} target="_blank" rel="noreferrer">
                        <CalendarCheck size={16} />
                        Agenda
                      </a>
                    ) : null}
                    {item.meetLink ? (
                      <a className="link-button" href={item.meetLink} target="_blank" rel="noreferrer">
                        <ArrowUpRight size={16} />
                        Meet
                      </a>
                    ) : null}
                    {!item.calendarLink && !item.meetLink ? <small className="agenda-empty-link">Sem link</small> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="empty-state">Nenhuma reuniao registrada na agenda interna.</p>
            )}
          </div>
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
              <QrCode size={19} />
              {connected ? 'WhatsApp conectado' : 'Conectar WhatsApp'}
            </button>
          </div>
        </header>

        {notice ? <p className="notice">{notice}</p> : null}
        {status.lastError ? <p className="error-text">{status.lastError}</p> : null}

        {activeView === 'overview' ? renderOverview() : null}
        {activeView === 'clients' ? renderClients() : null}
        {activeView === 'connections' ? renderConnections() : null}
        {activeView === 'appointments' ? renderAppointments() : null}
        {activeView === 'followups' ? renderFollowups() : null}
      </section>

      {qrModalOpen ? (
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
