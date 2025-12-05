import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: {
    bodyParser: false, // Нужно для FormData
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Парсим multipart/form-data
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // Извлекаем boundary из content-type
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'Invalid content type' });
    }
    
    const boundary = boundaryMatch[1];
    const parts = buffer.toString('binary').split(`--${boundary}`);
    
    let audioData = null;
    let userId = null;
    
    for (const part of parts) {
      if (part.includes('name="audio"')) {
        // Извлекаем бинарные данные аудио
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          const binaryData = part.slice(headerEnd + 4);
          // Убираем trailing \r\n
          const cleanData = binaryData.replace(/\r\n$/, '');
          audioData = Buffer.from(cleanData, 'binary');
        }
      } else if (part.includes('name="user_id"')) {
        const match = part.match(/\r\n\r\n(.+?)\r\n/);
        if (match) {
          userId = match[1];
        }
      }
    }
    
    if (!audioData || audioData.length === 0) {
      return res.status(400).json({ error: 'No audio data' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // Проверка PRO подписки
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('telegram_user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    const isPro = subscription && 
                  subscription.plan === 'PRO' && 
                  new Date(subscription.expires_at) > new Date();

    if (!isPro) {
      return res.status(403).json({
        success: false,
        message: 'Голосовые сообщения доступны только в PRO'
      });
    }

    // Используем OpenAI Whisper API для транскрипции
    // (Claude не поддерживает аудио напрямую)
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!openaiApiKey) {
      console.error('OPENAI_API_KEY not configured');
      return res.status(500).json({
        success: false,
        message: 'Сервис транскрипции не настроен'
      });
    }

    // Отправляем на Whisper API
    const formData = new FormData();
    const audioBlob = new Blob([audioData], { type: 'audio/webm' });
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'ru');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: formData
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      console.error('Whisper API error:', errorText);
      return res.status(500).json({
        success: false,
        message: 'Ошибка распознавания речи'
      });
    }

    const whisperData = await whisperResponse.json();
    const transcribedText = whisperData.text?.trim();

    if (!transcribedText) {
      return res.status(200).json({
        success: false,
        message: 'Не удалось распознать речь. Попробуй ещё раз.'
      });
    }

    console.log(`🎤 Voice transcribed for user ${userId}: "${transcribedText.substring(0, 50)}..."`);

    return res.status(200).json({
      success: true,
      text: transcribedText
    });

  } catch (error) {
    console.error('Transcribe error:', error);
    return res.status(500).json({
      success: false,
      message: 'Ошибка обработки аудио'
    });
  }
}
