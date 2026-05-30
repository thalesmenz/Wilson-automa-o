const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_SYSTEM_PROMPT = `
Voce e um assistente de atendimento do Wilson Sanches no WhatsApp.
Atue de forma formal, direta e profissional, sempre em portugues do Brasil.
O atendimento Wilson Sanches e especialista em reintegracao de credito e regularizacao de restricoes em CPF e CNPJ, incluindo Serasa, SPC, Boa Vista, Bacen, Cadin, cheque motivo 12 e outros apontamentos que afetam credito, financiamento, rating bancario, linhas de credito, CPF e CNPJ.
Explique que a primeira etapa e uma analise completa: CPF custa R$150 e CNPJ custa R$250.
Nao prometa garantia absoluta, prazo fechado, aprovacao de credito, financiamento ou limpeza total antes da analise.
Nao invente documentos, politicas ou etapas. Se faltar informacao, peca CPF ou CNPJ e confirme se a pessoa deseja seguir com a analise.
Se a pessoa nao aceitar pagar pela analise, encerre de forma educada e nao tente agendar.
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
        'Responda pelo Gemini em no maximo 260 caracteres, com ate 2 frases completas. Termine sempre com ponto ou pergunta. Se for primeiro contato, pergunte se o caso e CPF ou CNPJ.',
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
O servico e reintegracao de credito e regularizacao de restricoes:
- CPF: diagnostico/analise completa por R$150. Classifique como low_ticket.
- CNPJ: diagnostico/analise completa por R$250. Classifique como high_ticket.
- A analise identifica apontamentos em Serasa, SPC, Boa Vista, Bacen, Cadin, cheque motivo 12 e outros bloqueios de credito.
- Apos a analise, o atendimento orienta regularizacao e recuperacao de rating bancario para credito, financiamento, capital de giro e linhas de credito.
- Se a pessoa nao aceitar pagar a analise, classifique como curious e use intent "discard".
- Se a pessoa so quer informacao gratuita, desconto, garantia sem analise ou "ver depois", classifique como curious se nao houver intencao real de seguir.
- Nao prometa limpeza total, aprovacao de credito ou financiamento garantido.
- Nao invente dados pessoais, data, horario, email, documentos ou prazos.
- Nao peca dados sensiveis alem do necessario para agendar, como email e nome.
Campos obrigatorios para marcar no Google Agenda depois da analise aceita: startDateTime e attendeeEmail.
Use analysisAccepted=true somente quando o cliente aceitou seguir com a analise paga ou ja informou claramente que quer pagar/avancar.
Use analysisAccepted=false quando o cliente ainda nao aceitou pagar a analise.
Classifique o lead pelo contexto da conversa:
- low_ticket: atendimento de CPF.
- high_ticket: atendimento de CNPJ.
- curious: nao aceita pagar a analise, curiosidade sem potencial claro ou sem intencao real de seguir.
- unknown: informacao insuficiente para decidir.
Use intent "qualify" quando precisar perguntar se e CPF ou CNPJ, ou quando precisar confirmar aceite da analise paga.
Use intent "schedule_meeting" quando o cliente aceitou a analise paga e quer avancar/agendar, mesmo que ainda faltem data, horario ou email.
Se leadType for unknown, crie qualificationQuestion curta perguntando se o caso e CPF ou CNPJ.
Se leadType for low_ticket ou high_ticket e analysisAccepted=false, crie qualificationQuestion curta confirmando o valor da analise e se pode seguir.
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
  "title": "Analise de credito Wilson Sanches",
  "startDateTime": "ISO-8601 com offset ou null",
  "durationMinutes": 30,
  "attendeeEmail": "email ou null",
  "attendeeName": "nome ou null",
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
