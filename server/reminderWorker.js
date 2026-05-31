function formatMeetingTime(value, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

function buildReminderMessage(appointment, type, timeZone) {
  const time = formatMeetingTime(appointment.startDateTime, timeZone);
  const meetLine = appointment.meetLink ? `\nLink do Meet: ${appointment.meetLink}` : '';

  if (type === 'day') {
    return `Bom dia! Confirmando nossa reunião de hoje às ${time}.${meetLine}`;
  }

  return `Passando para lembrar: nossa reunião começa em 30 minutos, às ${time}.${meetLine}`;
}

export class ReminderWorker {
  constructor({
    appointmentStore,
    intervalMs = process.env.FOLLOWUP_CHECK_INTERVAL_MS || 60000,
    timeZone = process.env.GOOGLE_CALENDAR_TIME_ZONE || 'America/Sao_Paulo',
    whatsapp,
  }) {
    this.appointmentStore = appointmentStore;
    this.intervalMs = Number(intervalMs || 60000);
    this.running = false;
    this.timer = null;
    this.timeZone = timeZone;
    this.whatsapp = whatsapp;
  }

  start() {
    if (this.timer || !this.appointmentStore?.isReady) {
      return false;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.whatsapp?.emitActivity?.('error', 'Falha ao verificar follow-ups.', { error: error.message });
      });
    }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  getStatus() {
    return {
      active: Boolean(this.appointmentStore?.enabled),
      configured: Boolean(this.appointmentStore?.supabase?.isReady),
      enabled: Boolean(this.appointmentStore?.isReady),
      intervalMs: this.intervalMs,
      provider: 'Supabase',
      running: Boolean(this.timer),
    };
  }

  setEnabled(enabled) {
    this.appointmentStore?.setEnabled?.(enabled);

    if (enabled) {
      this.start();
    } else {
      this.stop();
    }

    return this.getStatus();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running || !this.appointmentStore?.isReady) {
      return;
    }

    this.running = true;
    try {
      const dueReminders = await this.appointmentStore.listDueReminders(new Date());

      for (const reminder of dueReminders) {
        try {
          const message = buildReminderMessage(reminder.appointment, reminder.type, this.timeZone);
          await this.whatsapp.sendTextToJid(reminder.appointment.jid, message, {
            contactName: reminder.appointment.contactName,
            automationName: reminder.type === 'day' ? 'Follow-up do dia' : 'Follow-up 30 minutos',
          });
          await this.appointmentStore.markReminderSent(reminder.appointment.id, reminder.type);
          await this.whatsapp.recordEvent?.('followup_sent', {
            jid: reminder.appointment.jid,
            contactName: reminder.appointment.contactName,
            leadType: reminder.appointment.leadType,
            meta: {
              appointmentId: reminder.appointment.id,
              type: reminder.type,
            },
          });
          this.whatsapp.emitActivity('followup', 'Follow-up enviado pelo WhatsApp.', {
            appointmentId: reminder.appointment.id,
            type: reminder.type,
          });
        } catch (error) {
          await this.whatsapp.recordEvent?.('followup_failed', {
            jid: reminder.appointment.jid,
            contactName: reminder.appointment.contactName,
            leadType: reminder.appointment.leadType,
            meta: {
              appointmentId: reminder.appointment.id,
              error: error.message,
              type: reminder.type,
            },
          });
          this.whatsapp.emitActivity('error', 'Falha ao enviar follow-up pelo WhatsApp.', {
            appointmentId: reminder.appointment.id,
            error: error.message,
            type: reminder.type,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
