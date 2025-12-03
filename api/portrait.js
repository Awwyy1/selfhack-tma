import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';

const MODEL = 'claude-sonnet-4-5-20250929';

export default async function handler(req, res) {
  const { method } = req;

  // ========== GET — Получить портреты пользователя ==========
  if (method === 'GET') {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
      // Проверить PRO подписку
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan, expires_at')
        .eq('telegram_user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();

      const isPro = subscription && 
                    subscription.plan === 'PRO' && 
                    new Date(subscription.expires_at) > new Date();

      if (!isPro) {
        return res.status(403).json({ 
          error: 'PRO required',
          message: 'AI-Портрет доступен только в тарифе PRO'
        });
      }

      // Загрузить последние 5 портретов
      const { data: portraits, error } = await supabase
        .from('portraits')
        .select('*')
        .eq('telegram_user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;

      // Проверить возможность создания нового портрета
      let canCreate = true;
      let daysUntilNext = 0;
      let messagesNeeded = 0;

      if (portraits && portraits.length > 0) {
        const lastPortrait = portraits[0];
        const lastCreated = new Date(lastPortrait.created_at);
        const now = new Date();
        const daysSinceLast = Math.floor((now - lastCreated) / (1000 * 60 * 60 * 24));

        if (daysSinceLast < 10) {
          canCreate = false;
          daysUntilNext = 10 - daysSinceLast;
        }

        // Проверить количество сообщений с последнего портрета
        if (canCreate) {
          const { count: messagesSinceLast } = await supabase
            .from('telegram_chats')
            .select('*', { count: 'exact', head: true })
            .eq('telegram_user_id', user_id)
            .eq('role', 'user')
            .gt('created_at', lastPortrait.created_at);

          if (messagesSinceLast < 50) {
            canCreate = false;
            messagesNeeded = 50 - messagesSinceLast;
          }
        }
      } else {
        // Первый портрет — проверить минимум 50 сообщений всего
        const { count: totalMessages } = await supabase
          .from('telegram_chats')
          .select('*', { count: 'exact', head: true })
          .eq('telegram_user_id', user_id)
          .eq('role', 'user');

        if (totalMessages < 50) {
          canCreate = false;
          messagesNeeded = 50 - totalMessages;
        }
      }

      return res.status(200).json({
        success: true,
        portraits: portraits || [],
        canCreate,
        daysUntilNext,
        messagesNeeded
      });

    } catch (error) {
      console.error('Get portraits error:', error);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  // ========== POST — Создать новый портрет ==========
  if (method === 'POST') {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
      // Проверить PRO подписку
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan, expires_at')
        .eq('telegram_user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();

      const isPro = subscription && 
                    subscription.plan === 'PRO' && 
                    new Date(subscription.expires_at) > new Date();

      if (!isPro) {
        return res.status(403).json({ 
          error: 'PRO required',
          message: 'AI-Портрет доступен только в тарифе PRO'
        });
      }

      // Получить последний портрет
      const { data: lastPortrait } = await supabase
        .from('portraits')
        .select('created_at')
        .eq('telegram_user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Проверить 10 дней
      if (lastPortrait) {
        const lastCreated = new Date(lastPortrait.created_at);
        const now = new Date();
        const daysSinceLast = Math.floor((now - lastCreated) / (1000 * 60 * 60 * 24));

        if (daysSinceLast < 10) {
          return res.status(400).json({
            error: 'Too soon',
            message: `Следующий портрет доступен через ${10 - daysSinceLast} дней`
          });
        }
      }

      // Определить период анализа
      const periodStart = lastPortrait ? lastPortrait.created_at : null;
      const periodEnd = new Date().toISOString();

      // Загрузить сообщения за период
      let messagesQuery = supabase
        .from('telegram_chats')
        .select('role, content, created_at')
        .eq('telegram_user_id', user_id)
        .order('created_at', { ascending: true });

      if (periodStart) {
        messagesQuery = messagesQuery.gt('created_at', periodStart);
      }

      const { data: messages } = await messagesQuery;

      // Проверить минимум 50 сообщений пользователя
      const userMessages = messages?.filter(m => m.role === 'user') || [];
      if (userMessages.length < 50) {
        return res.status(400).json({
          error: 'Not enough messages',
          message: `Нужно ещё ${50 - userMessages.length} сообщений для создания портрета`
        });
      }

      // Загрузить mood данные за период
      let moodQuery = supabase
        .from('mood_tracking')
        .select('mood_score, tracked_at')
        .eq('telegram_user_id', user_id)
        .order('tracked_at', { ascending: true });

      if (periodStart) {
        moodQuery = moodQuery.gt('tracked_at', periodStart);
      }

      const { data: moodData } = await moodQuery;

      // Загрузить цели
      const { data: goals } = await supabase
        .from('goals')
        .select('text, status, target_date, completed_at')
        .eq('telegram_user_id', user_id);

      // Загрузить статистику
      const { count: totalMessages } = await supabase
        .from('telegram_chats')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_user_id', user_id)
        .eq('role', 'user');

      const { data: checkinData } = await supabase
        .from('checkins')
        .select('checkin_date')
        .eq('telegram_user_id', user_id);

      // Форматировать данные для анализа
      const dialogText = messages
        .map(m => `${m.role === 'user' ? 'Пользователь' : 'Коуч'}: ${m.content}`)
        .join('\n');

      const moodStats = moodData && moodData.length > 0
        ? {
            average: (moodData.reduce((sum, m) => sum + m.mood_score, 0) / moodData.length).toFixed(1),
            count: moodData.length,
            trend: moodData.length >= 3 
              ? (moodData.slice(-3).reduce((s, m) => s + m.mood_score, 0) / 3 > 
                 moodData.slice(0, 3).reduce((s, m) => s + m.mood_score, 0) / 3 ? 'улучшение' : 'снижение')
              : 'недостаточно данных'
          }
        : null;

      const goalsStats = {
        total: goals?.length || 0,
        achieved: goals?.filter(g => g.status === 'achieved').length || 0,
        failed: goals?.filter(g => g.status === 'failed').length || 0,
        active: goals?.filter(g => !g.status || g.status === 'active').length || 0
      };

      // Запрос к Claude для анализа
      const prompt = `Ты психолог-аналитик. Проанализируй диалоги пользователя с AI-коучем и создай структурированный психологический портрет.

ДАННЫЕ ДЛЯ АНАЛИЗА:

Диалоги (${userMessages.length} сообщений пользователя):
${dialogText}

${moodStats ? `Эмоциональный трекинг:
- Средний mood score: ${moodStats.average}/5
- Записей: ${moodStats.count}
- Тренд: ${moodStats.trend}` : 'Эмоциональный трекинг: нет данных'}

Цели:
- Всего целей: ${goalsStats.total}
- Достигнуто: ${goalsStats.achieved}
- Не выполнено: ${goalsStats.failed}
- Активных: ${goalsStats.active}

Чекинов всего: ${checkinData?.length || 0}

СОЗДАЙ JSON-ПОРТРЕТ в формате:
{
  "themes": ["тема1", "тема2", "тема3"],
  "patterns": ["паттерн1", "паттерн2", "паттерн3"],
  "strengths": ["сила1", "сила2", "сила3"],
  "growth_zones": ["зона1", "зона2", "зона3"],
  "emotional_background": {
    "summary": "краткое описание эмоционального состояния",
    "average_mood": ${moodStats?.average || 'null'},
    "trend": "${moodStats?.trend || 'нет данных'}"
  },
  "recommendations": ["рекомендация1", "рекомендация2", "рекомендация3"],
  "statistics": {
    "messages_analyzed": ${userMessages.length},
    "goals_achieved": ${goalsStats.achieved},
    "goals_total": ${goalsStats.total},
    "checkins": ${checkinData?.length || 0}
  }
}

ВАЖНО:
- Пиши на русском языке
- Каждый пункт — 1-2 предложения максимум
- Темы — о чём чаще всего говорит
- Паттерны — повторяющиеся модели мышления/поведения
- Сильные стороны — позитивные качества из диалогов
- Зоны роста — над чем стоит поработать
- Рекомендации — конкретные действия

Ответь ТОЛЬКО валидным JSON без markdown.`;

      const aiResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0.5,
        messages: [{ role: 'user', content: prompt }]
      });

      let portraitContent;
      try {
        const responseText = aiResponse.content[0].text
          .replace(/```json\n?/g, '')
          .replace(/```\n?/g, '')
          .trim();
        portraitContent = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Failed to parse portrait JSON:', parseError);
        console.error('Raw response:', aiResponse.content[0].text);
        return res.status(500).json({ error: 'Failed to generate portrait' });
      }

      // Сохранить портрет
      const { data: newPortrait, error: insertError } = await supabase
        .from('portraits')
        .insert({
          telegram_user_id: user_id,
          content: portraitContent,
          messages_analyzed: userMessages.length,
          period_start: periodStart,
          period_end: periodEnd
        })
        .select()
        .single();

      if (insertError) throw insertError;

      console.log(`Portrait created for user ${user_id}: ${userMessages.length} messages analyzed`);

      return res.status(200).json({
        success: true,
        portrait: newPortrait
      });

    } catch (error) {
      console.error('Create portrait error:', error);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
