import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';
import { getUserTone, getPromptByTone } from '../lib/tone-manager.js';

const MODEL = 'claude-sonnet-4-5-20250929';

// Parse reminder from AI response
function parseReminder(text) {
  // Updated regex to properly capture time in HH:MM format or just minutes
  // Format: [[REMINDER:time:message]] where time is "40" or "14:30"
  const match = text.match(/\[\[REMINDER:(\d{1,2}(?::\d{2})?):([^\]]+)\]\]/);
  if (!match) return null;

  const timeStr = match[1].trim();
  const message = match[2].trim();

  const now = new Date();
  let remindAt;

  // Check if it's time format (e.g., "14:30" or "8:00")
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [hours, mins] = timeStr.split(':').map(Number);
    remindAt = new Date(now);
    remindAt.setHours(hours, mins, 0, 0);
    // If time already passed today, set for tomorrow
    if (remindAt <= now) {
      remindAt.setDate(remindAt.getDate() + 1);
    }
  }
  // Check if it's minutes (e.g., "40")
  else if (/^\d+$/.test(timeStr)) {
    const minutes = parseInt(timeStr);
    remindAt = new Date(now.getTime() + minutes * 60000);
  } else {
    return null;
  }

  return {
    message,
    remind_at: remindAt.toISOString(),
    cleanText: text.replace(/\[\[REMINDER:[^\]]+\]\]/, '').trim()
  };
}

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
      .order('id', { ascending: false })
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

    let reply = aiResponse.content[0].text;
    const wordCount = reply.split(/\s+/).length;

    console.log(`🤖 AI Response (${wordCount} words, tone: ${userTone}): ${reply}`);

    // Parse and create reminder if present
    const reminder = parseReminder(reply);
    if (reminder) {
      try {
        // Check for existing duplicate reminder before inserting
        const { data: existingReminder } = await supabase
          .from('reminders')
          .select('id')
          .eq('telegram_user_id', user_id)
          .eq('message', reminder.message)
          .eq('remind_at', reminder.remind_at)
          .eq('status', 'pending')
          .maybeSingle();

        if (!existingReminder) {
          await supabase.from('reminders').insert({
            telegram_user_id: user_id,
            message: reminder.message,
            remind_at: reminder.remind_at,
            status: 'pending'
          });
          console.log(`⏰ Reminder created for ${user_id}: ${reminder.message} at ${reminder.remind_at}`);
        } else {
          console.log(`⏰ Duplicate reminder skipped for ${user_id}: ${reminder.message} at ${reminder.remind_at}`);
        }
        // Use clean text without reminder markup
        reply = reminder.cleanText;
      } catch (reminderError) {
        console.error('Failed to create reminder:', reminderError);
      }
    }

    // Сохранение в БД - вставляем последовательно для правильного порядка ID
    await supabase.from('telegram_chats').insert(
      { telegram_user_id: user_id, role: 'user', content: message }
    );
    await supabase.from('telegram_chats').insert(
      { telegram_user_id: user_id, role: 'assistant', content: reply }
    );

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
