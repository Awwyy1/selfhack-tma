import { supabase } from '../lib/supabase.js';
import { anthropic, FREE_COACHING_SYSTEM, PRO_COACHING_SYSTEM } from '../lib/claude.js';

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
    const isPro = isPremium && subscription.plan === 'pro';

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
    const systemPrompt = isPro ? PRO_COACHING_SYSTEM : FREE_COACHING_SYSTEM;
    const maxTokens = isPro ? 400 : 200;

    const aiResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.8,
      system: systemPrompt,
      messages: messages
    });

    const reply = aiResponse.content[0].text;

    // Сохранение в БД
    await supabase.from('telegram_chats').insert([
      { telegram_user_id: user_id, role: 'user', content: message },
      { telegram_user_id: user_id, role: 'assistant', content: reply }
    ]);

    return res.status(200).json({ 
      reply: reply,
      isPro: isPro,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Произошла ошибка. Попробуй ещё раз.'
    });
  }
}
