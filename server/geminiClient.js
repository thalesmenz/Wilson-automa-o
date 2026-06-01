const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_SYSTEM_PROMPT = `
Você é um assistente de atendimento do Wilson Sanches no WhatsApp.
Atue de forma formal, direta e profissional, sempre em português do Brasil.
Você se apresenta como assistente do Wilson Sanches da Cresce Mais.
O atendimento Wilson Sanches trabalha com Limpa Nome. Existem dois cenários: nome negativado/restrito em Serasa, SPC, Boa Vista ou score afetado por restrição; e rating bancário baixo, quando a pessoa não está negativada nesses órgãos mas não consegue financiar, aprovar crédito, limite ou linha de crédito.
Antes de qualificar o problema, pergunte a área de atuação do cliente. Se for agro, direcione para atendimento preferencial por ligação com horário marcado.
No primeiro contato, apresente-se como assistente do Wilson Sanches antes de perguntar sobre o problema do cliente.
Explique que a primeira etapa obrigatória é uma consulta para identificar exatamente qual problema está impedindo o crédito.
Não prometa garantia absoluta, prazo fechado, aprovação de crédito, financiamento ou limpeza total antes da consulta.
Não invente documentos, políticas ou etapas. Se faltar informação, pergunte se o caso é negativação ou rating bancário baixo e confirme se a pessoa deseja seguir com a consulta.
Se a pessoa não aceitar pagar pela consulta, encerre de forma educada e não tente agendar.
Use mensagens curtas, sem markdown pesado e sem listas longas.
`.trim();

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('\n').trim();
}

function parseJsonText(value) {
  const text = String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  return JSON.parse(text);
}

function isCompleteSentence(value) {
  return /[.!?]$/.test(String(value || '').trim());
}

function formatHistoryForPrompt(history = []) {
  const lines = history
    .slice(-14)
    .map((message) => {
      const speaker = message.role === 'assistant' ? 'Assistente' : 'Cliente';
      const text = cleanText(message.text);
      return text ? `${speaker}: ${text}` : null;
    })
    .filter(Boolean);

  return lines.length ? lines.join('\n') : 'Sem histórico recente.';
}

export class GeminiClient {
  constructor({
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    enabled = process.env.GEMINI_ENABLED !== 'false',
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = {}) {
    this.apiKey = apiKey;
    this.model = String(model || 'gemini-2.5-flash').replace(/^models\//, '');
    this.enabled = enabled;
    this.systemPrompt = systemPrompt;
  }

  get isReady() {
    return Boolean(this.enabled && this.apiKey);
  }

  getStatus() {
    return {
      enabled: this.isReady,
      model: this.model,
      provider: 'Gemini',
    };
  }

  async generateReply({ text, contactName, history = [] }) {
    if (!this.isReady) {
      throw new Error('Gemini não configurado.');
    }

    const cleanMessage = cleanText(text);
    if (!cleanMessage) {
      throw new Error('Mensagem vazia.');
    }

    const url = `${GEMINI_ENDPOINT}/models/${this.model}:generateContent`;
    const historyText = formatHistoryForPrompt(history);
    const requestReply = async ({ instruction, maxOutputTokens = 512, temperature = 0.35 }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: this.systemPrompt }],
          },
          contents: [
            {
              parts: [
                {
                  text: `Cliente: ${contactName || 'Contato do WhatsApp'}\nHistórico recente:\n${historyText}\n\nMensagem atual: ${cleanMessage}`,
                },
                {
                  text: instruction,
                },
              ],
            },
          ],
          generationConfig: {
            temperature,
            topP: 0.9,
            maxOutputTokens,
          },
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.error?.message || `Gemini retornou HTTP ${response.status}.`;
        throw new Error(message);
      }

      return {
        finishReason: payload?.candidates?.[0]?.finishReason || null,
        reply: cleanText(extractGeminiText(payload)),
      };
    };

    let result = await requestReply({
      instruction:
        'Responda pelo Gemini em no máximo 320 caracteres, com até 3 frases completas. Termine sempre com ponto ou pergunta. Se for primeiro contato, apresente-se como assistente do Wilson Sanches da Cresce Mais e pergunte a área de atuação com opções numeradas: 1 Agro, 2 Comércio ou serviços, 3 Indústria, 4 Pessoa física, 5 Outro segmento.',
    });

    if (!result.reply) {
      throw new Error('Gemini não retornou texto.');
    }

    if (result.finishReason === 'MAX_TOKENS' || result.reply.length > 700 || !isCompleteSentence(result.reply)) {
      result = await requestReply({
        instruction:
          'A resposta anterior ficou longa ou incompleta. Gere uma nova resposta, completa, com no máximo 220 caracteres, em 1 ou 2 frases, terminando com ponto ou pergunta. Não corte a frase.',
        maxOutputTokens: 256,
        temperature: 0.2,
      });
    }

    if (!result.reply || result.finishReason === 'MAX_TOKENS' || result.reply.length > 700 || !isCompleteSentence(result.reply)) {
      throw new Error('Gemini retornou resposta incompleta.');
    }

    return result.reply;
  }

  async analyzeScheduling({ contactName, existing = {}, history = [], nowIso, text, timeZone }) {
    if (!this.isReady) {
      throw new Error('Gemini não configurado.');
    }

    const cleanMessage = cleanText(text);
    if (!cleanMessage) {
      throw new Error('Mensagem vazia.');
    }

    const url = `${GEMINI_ENDPOINT}/models/${this.model}:generateContent`;
    const analysisInstruction = `
Você extrai dados comerciais e de agendamento de mensagens de WhatsApp.
Responda somente JSON válido, sem markdown.
Use o horário atual e o fuso informados para resolver datas relativas como "amanhã" ou "segunda".
Use history para entender referências a mensagens anteriores, como "esse", "aquele horário", "o segundo", "não tenho email", "sou do agro", "manda o pix" ou continuações curtas.
O campo existing.conversationStatus indica a etapa atual do funil. Quando ele existir, nunca reinicie o atendimento: preserve os dados existentes e avance somente a partir dessa etapa.
Use existing.availableSlotOptions para entender respostas como "o primeiro", "12h", "pode ser o das 13" ou "a segunda opção".
Regras por etapa:
- awaiting_segment: se o cliente disser que é agro, retorne schedule_meeting com atendimento preferencial por ligação; se ele responder o problema em vez do segmento, classifique leadType e use qualify para seguir sem repetir a abertura.
- awaiting_qualification: interprete texto livre sobre negativação, Serasa/SPC/Boa Vista, rating baixo, crédito, limite ou financiamento e classifique o leadType correspondente.
- awaiting_payment_confirmation: frases como "quero pagar", "manda o pix", "como pago", "pode seguir" aceitam a consulta; recusa, preço caro ou grátis descartam; dúvidas pedem mais explicação.
- awaiting_details: extraia data, horário, email e telefone. Se a pessoa pedir outro dia/horário, mais cedo, mais tarde ou disser que não consegue naquele horário, mantenha o agendamento aberto e não reinicie a qualificação.
- awaiting_confirmation: confirme somente quando a pessoa aceitar o horário; se pedir troca ou enviar outro horário, retorne schedule_meeting com os novos dados; se cancelar, retorne cancel.
Se o cliente confirmar algo pendente, use intent "confirm". Se cancelar, use "cancel".
O produto é Limpa Nome e a primeira etapa obrigatória é uma consulta:
- Se o cliente disser que atua no agro, agronegócio, produtor rural, fazenda, pecuária, lavoura, soja, milho, café, cana, grãos ou insumos, direcione para atendimento preferencial Cresce Mais por ligação. Use intent "schedule_meeting", leadType "high_ticket", analysisAccepted=true, meetingChannel "phone", phoneCallAccepted=true e não cobre consulta nessa etapa.
- Nome negativado/restrito em Serasa, SPC, Boa Vista, score afetado por negativação ou restrições similares: classifique como low_ticket.
- Rating bancário baixo: pessoa não aparece negativada nos órgãos, mas banco não aprova financiamento, casa, carro, limite, empréstimo ou linha de crédito por rating ruim/baixo. Classifique como high_ticket.
- Se a pessoa disser que não sabe qual é o problema, não sabe se está negativada, ou só sabe que não aprova nada, classifique como low_ticket para consulta inicial.
- Consulta de negativação/low_ticket: R$150. Consulta de rating bancário/high_ticket: R$250.
- A consulta identifica exatamente qual é o problema: negativação/restrição ou rating bancário baixo.
- Após a consulta, o atendimento orienta o caminho para limpar/regularizar e melhorar a condição bancária.
- Se a pessoa não aceitar pagar a consulta, classifique como curious e use intent "discard".
- Se a pessoa só quer informação gratuita, desconto, garantia sem consulta ou "ver depois", classifique como curious se não houver intenção real de seguir.
- Não prometa limpeza total, aprovação de crédito ou financiamento garantido.
- Não invente dados pessoais, data, horário, email, documentos ou prazos.
- Não peça dados sensíveis além do necessário para agendar, como email, nome e telefone.
Campos obrigatórios para marcar no Google Agenda depois da consulta aceita: startDateTime e attendeeEmail. Se o cliente disser que não tem email ou preferir ligação, attendeeEmail pode ser null, mas phoneCallAccepted deve ser true e contactPhone deve ser preenchido quando houver telefone.
Use analysisAccepted=true somente quando o cliente aceitou seguir com a consulta paga ou já informou claramente que quer pagar/avançar.
Use analysisAccepted=false quando o cliente ainda não aceitou pagar a consulta.
Classifique o lead pelo contexto da conversa:
- low_ticket: pessoa negativada/restrita em Serasa, SPC, Boa Vista, score afetado por restrição ou nome sujo.
- high_ticket: rating bancário baixo ou dificuldade de aprovação mesmo sem negativação aparente.
- curious: não aceita pagar a consulta, curiosidade sem potencial claro ou sem intenção real de seguir.
- unknown: informação insuficiente para decidir.
Use intent "qualify" quando precisar perguntar se o problema é negativação ou rating bancário baixo, ou quando precisar confirmar aceite da consulta paga.
Use intent "schedule_meeting" quando o cliente aceitou a consulta paga e quer avançar/agendar, mesmo que ainda faltem data, horário ou email.
Se leadType for unknown, crie qualificationQuestion curta perguntando se o caso é nome negativado/restrito ou dificuldade de aprovação por rating bancário baixo.
Se leadType for low_ticket ou high_ticket e analysisAccepted=false, crie qualificationQuestion curta confirmando o valor da consulta e se pode seguir.
Não invente email, data ou horário.
Formato:
{
  "intent": "schedule_meeting" | "qualify" | "confirm" | "cancel" | "discard" | "other",
  "confidence": 0.0,
  "leadType": "low_ticket" | "high_ticket" | "curious" | "unknown",
  "leadConfidence": 0.0,
  "analysisAccepted": true,
  "paymentAmount": 150,
  "qualificationQuestion": "pergunta curta ou null",
  "title": "Consulta Limpa Nome Wilson Sanches",
  "startDateTime": "ISO-8601 com offset ou null",
  "durationMinutes": 30,
  "attendeeEmail": "email ou null",
  "attendeeName": "nome ou null",
  "contactPhone": "telefone ou null",
  "meetingChannel": "email ou phone",
  "phoneCallAccepted": false,
  "notes": "observacoes ou null",
  "missing": ["date", "time", "email"]
}
`.trim();
    const analysisContext = JSON.stringify({
      contactName,
      existing,
      history,
      message: cleanMessage,
      nowIso,
      timeZone,
    });
    const parseAnalysisPayload = (payload) => {
      if (payload?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini retornou JSON incompleto.');
      }

      return parseJsonText(extractGeminiText(payload));
    };
    const requestAnalysis = async ({ extraInstruction = '', maxOutputTokens = 1200 } = {}) => {
      const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: `${analysisInstruction}${extraInstruction ? `\n${extraInstruction}` : ''}`,
            },
          ],
        },
        contents: [
          {
            parts: [
              {
                text: analysisContext,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens,
        },
      }),
    });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.error?.message || `Gemini retornou HTTP ${response.status}.`;
        throw new Error(message);
      }

      return payload;
    };

    try {
      return parseAnalysisPayload(await requestAnalysis());
    } catch (error) {
      const retryPayload = await requestAnalysis({
        extraInstruction:
          'ATENÇÃO: sua resposta anterior ficou inválida ou incompleta. Retorne somente um JSON compacto, completo e válido, sem quebras desnecessárias e sem texto fora do JSON.',
        maxOutputTokens: 1800,
      });

      try {
        return parseAnalysisPayload(retryPayload);
      } catch (retryError) {
        throw new Error(`Gemini retornou JSON invalido: ${retryError.message}`);
      }
    }
  }
}
