const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_SYSTEM_PROMPT = `
Voce e um assistente de atendimento do Wilson Sanches no WhatsApp.
Atue de forma formal, direta e profissional, sempre em portugues do Brasil.
O atendimento Wilson Sanches trabalha com Limpa Nome. Existem dois cenarios: nome negativado/restrito em Serasa, SPC, Boa Vista ou score afetado por restricao; e rating bancario baixo, quando a pessoa nao esta negativada nesses orgaos mas nao consegue financiar, aprovar credito, limite ou linha de credito.
No primeiro contato, apresente-se como assistente do Wilson Sanches antes de perguntar sobre o problema do cliente.
Explique que a primeira etapa obrigatoria e uma consulta para identificar exatamente qual problema esta impedindo o credito.
Nao prometa garantia absoluta, prazo fechado, aprovacao de credito, financiamento ou limpeza total antes da consulta.
Nao invente documentos, politicas ou etapas. Se faltar informacao, pergunte se o caso e negativacao ou rating bancario baixo e confirme se a pessoa deseja seguir com a consulta.
Se a pessoa nao aceitar pagar pela consulta, encerre de forma educada e nao tente agendar.
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

  async generateReply({ text, contactName }) {
    if (!this.isReady) {
      throw new Error('Gemini nao configurado.');
    }

    const cleanMessage = cleanText(text);
    if (!cleanMessage) {
      throw new Error('Mensagem vazia.');
    }

    const url = `${GEMINI_ENDPOINT}/models/${this.model}:generateContent`;
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
                  text: `Cliente: ${contactName || 'Contato do WhatsApp'}\nMensagem: ${cleanMessage}`,
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
        'Responda pelo Gemini em no maximo 320 caracteres, com ate 3 frases completas. Termine sempre com ponto ou pergunta. Se for primeiro contato, apresente-se como assistente do Wilson Sanches e pergunte se o caso e nome negativado ou dificuldade de aprovar credito por rating bancario baixo.',
    });

    if (!result.reply) {
      throw new Error('Gemini nao retornou texto.');
    }

    if (result.finishReason === 'MAX_TOKENS' || result.reply.length > 700 || !isCompleteSentence(result.reply)) {
      result = await requestReply({
        instruction:
          'A resposta anterior ficou longa ou incompleta. Gere uma nova resposta, completa, com no maximo 220 caracteres, em 1 ou 2 frases, terminando com ponto ou pergunta. Nao corte a frase.',
        maxOutputTokens: 256,
        temperature: 0.2,
      });
    }

    if (!result.reply || result.finishReason === 'MAX_TOKENS' || result.reply.length > 700 || !isCompleteSentence(result.reply)) {
      throw new Error('Gemini retornou resposta incompleta.');
    }

    return result.reply;
  }

  async analyzeScheduling({ contactName, existing = {}, nowIso, text, timeZone }) {
    if (!this.isReady) {
      throw new Error('Gemini nao configurado.');
    }

    const cleanMessage = cleanText(text);
    if (!cleanMessage) {
      throw new Error('Mensagem vazia.');
    }

    const url = `${GEMINI_ENDPOINT}/models/${this.model}:generateContent`;
    const analysisInstruction = `
Voce extrai dados comerciais e de agendamento de mensagens de WhatsApp.
Responda somente JSON valido, sem markdown.
Use o horario atual e o fuso informados para resolver datas relativas como "amanha" ou "segunda".
Se o cliente confirmar algo pendente, use intent "confirm". Se cancelar, use "cancel".
O produto e Limpa Nome e a primeira etapa obrigatoria e uma consulta:
- Nome negativado/restrito em Serasa, SPC, Boa Vista, score afetado por negativacao ou restricoes similares: classifique como low_ticket.
- Rating bancario baixo: pessoa nao aparece negativada nos orgaos, mas banco nao aprova financiamento, casa, carro, limite, emprestimo ou linha de credito por rating ruim/baixo. Classifique como high_ticket.
- Se a pessoa disser que nao sabe qual e o problema, nao sabe se esta negativada, ou so sabe que nao aprova nada, classifique como low_ticket para consulta inicial.
- Consulta de negativacao/low_ticket: R$150. Consulta de rating bancario/high_ticket: R$250.
- A consulta identifica exatamente qual e o problema: negativacao/restricao ou rating bancario baixo.
- Apos a consulta, o atendimento orienta o caminho para limpar/regularizar e melhorar a condicao bancaria.
- Se a pessoa nao aceitar pagar a consulta, classifique como curious e use intent "discard".
- Se a pessoa so quer informacao gratuita, desconto, garantia sem consulta ou "ver depois", classifique como curious se nao houver intencao real de seguir.
- Nao prometa limpeza total, aprovacao de credito ou financiamento garantido.
- Nao invente dados pessoais, data, horario, email, documentos ou prazos.
- Nao peca dados sensiveis alem do necessario para agendar, como email, nome e telefone.
Campos obrigatorios para marcar no Google Agenda depois da consulta aceita: startDateTime e attendeeEmail. Se o cliente disser que nao tem email ou preferir ligacao, attendeeEmail pode ser null, mas phoneCallAccepted deve ser true e contactPhone deve ser preenchido quando houver telefone.
Use analysisAccepted=true somente quando o cliente aceitou seguir com a consulta paga ou ja informou claramente que quer pagar/avancar.
Use analysisAccepted=false quando o cliente ainda nao aceitou pagar a consulta.
Classifique o lead pelo contexto da conversa:
- low_ticket: pessoa negativada/restrita em Serasa, SPC, Boa Vista, score afetado por restricao ou nome sujo.
- high_ticket: rating bancario baixo ou dificuldade de aprovacao mesmo sem negativacao aparente.
- curious: nao aceita pagar a consulta, curiosidade sem potencial claro ou sem intencao real de seguir.
- unknown: informacao insuficiente para decidir.
Use intent "qualify" quando precisar perguntar se o problema e negativacao ou rating bancario baixo, ou quando precisar confirmar aceite da consulta paga.
Use intent "schedule_meeting" quando o cliente aceitou a consulta paga e quer avancar/agendar, mesmo que ainda faltem data, horario ou email.
Se leadType for unknown, crie qualificationQuestion curta perguntando se o caso e nome negativado/restrito ou dificuldade de aprovacao por rating bancario baixo.
Se leadType for low_ticket ou high_ticket e analysisAccepted=false, crie qualificationQuestion curta confirmando o valor da consulta e se pode seguir.
Nao invente email, data ou horario.
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
          'ATENCAO: sua resposta anterior ficou invalida ou incompleta. Retorne somente um JSON compacto, completo e valido, sem quebras desnecessarias e sem texto fora do JSON.',
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
