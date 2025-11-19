import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';
import { getUserTone, getPromptByTone } from '../lib/tone-manager.js';

const MODEL = 'claude-sonnet-4-5-20250929';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { message, user_id } = req.body;

  if (!message || !user_id) {
    return res.status(400).json({ error: 'Missing message or user_id' });
  }

  try {
    // Проверка подписки
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('telegram_user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();

    const isPremium = subscription && new Date(subscription.expires_at) > new Date();

    // Проверка лимитов FREE
    if (!isPremium) {
      const { count: totalMessages } = await supabase
        .from('telegram_chats')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_user_id', user_id)
        .eq('role', 'user');

      if (totalMessages >= 50) {
        return res.status(403).json({ 
          error: 'Лимит FREE достигнут',
          message: 'Лимит FREE (50 сообщений) достигнут. Купи Premium для продолжения.',
          limit_reached: true
        });
      }
    }

    // Получить тональность пользователя
    const userTone = await getUserTone(user_id);
    const systemPrompt = getPromptByTone(userTone);

    console.log(`📝 User ${user_id} | Tone: ${userTone} | Message: ${message.substring(0, 50)}...`);

    // Загрузка истории
    const { data: historyData } = await supabase
      .from('telegram_chats')
      .select('role, content')
      .eq('telegram_user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(50);

    const conversationHistory = historyData ? historyData.reverse() : [];

    const messages = [
      ...conversationHistory,
      { role: 'user', content: message }
    ];

    // Запрос к Claude
    const maxTokens = userTone === 'focused' ? 100 : 200; // Focused короче

    const aiResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.8,
      system: systemPrompt,
      messages: messages
    });

    const reply = aiResponse.content[0].text;
    const wordCount = reply.split(/\s+/).length;

    console.log(`🤖 AI Response (${wordCount} words, tone: ${userTone}): ${reply}`);

    // Сохранение в БД
    await supabase.from('telegram_chats').insert([
      { telegram_user_id: user_id, role: 'user', content: message },
      { telegram_user_id: user_id, role: 'assistant', content: reply }
    ]);

    // Получить статистику для ответа
    const { count: userMessages } = await supabase
      .from('telegram_chats')
      .select('*', { count: 'exact', head: true })
      .eq('telegram_user_id', user_id)
      .eq('role', 'user');

    const { data: allMessages } = await supabase
      .from('telegram_chats')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_user_id', user_id);

    return res.status(200).json({ 
      reply: reply,
      tone: userTone,
      stats: {
        messagesUsed: userMessages || 0,
        totalMessages: allMessages?.length || 0
      },
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Chat API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Произошла ошибка. Попробуй ещё раз.'
    });
  }
}
