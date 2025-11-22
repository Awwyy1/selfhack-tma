import { supabase } from '../lib/supabase.js';
import { anthropic } from '../lib/claude.js';
import { getUserTone, getPromptByTone } from '../lib/tone-manager.js';
import { checkAndCreateSummary } from '../lib/summarizer.js';

const MODEL = 'claude-sonnet-4-5-20250929';

// Format user goals for system prompt
function formatGoalsForPrompt(goals) {
  if (!goals || goals.length === 0) {
    return '\n\n=== ЦЕЛИ ПОЛЬЗОВАТЕЛЯ ===\nПока нет целей.\n\nИспользуй эти цели в коучинге. Если нет целей — предложи поставить.\nНе выдумывай цели — только эти или "пока нет целей".';
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const formattedGoals = goals.map(goal => {
    const deadline = new Date(goal.target_date);
    deadline.setHours(0, 0, 0, 0);

    const diffTime = deadline - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const dateStr = deadline.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    let status;
    if (diffDays < 0) {
      status = `просрочено на ${Math.abs(diffDays)} дн.`;
    } else if (diffDays === 0) {
      status = 'сегодня';
    } else {
      status = `${diffDays} дн.`;
    }

    return `• "${goal.text}" — срок: ${dateStr} (${status})`;
  }).join('\n');

  return `\n\n=== ЦЕЛИ ПОЛЬЗОВАТЕЛЯ ===\n${formattedGoals}\n\nИспользуй эти цели в коучинге. Если нет целей — предложи поставить.\nНе выдумывай цели — только эти или "пока нет целей".`;
}

// Parse reminder from AI response
// timezoneOffset: user's timezone offset in minutes (positive for west of UTC, e.g., -180 for Moscow UTC+3)
function parseReminder(text, timezoneOffset = 0) {
  // Updated regex to properly capture time in HH:MM format or just minutes
  // Format: [[REMINDER:time:message]] where time is "40" or "14:30"
  const match = text.match(/\[\[REMINDER:(\d{1,2}(?::\d{2})?):([^\]]+)\]\]/);
  if (!match) return null;

  const timeStr = match[1].trim();
  const message = match[2].trim();

  // Get current time in user's timezone
  const now = new Date();
  let remindAt;

  // Check if it's time format (e.g., "14:30" or "8:00")
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [hours, mins] = timeStr.split(':').map(Number);

    // Calculate the reminder time in user's timezone
    // Create a date in UTC that represents the user's local time
    const userNow = new Date(now.getTime() - timezoneOffset * 60000);

    // Set the time in user's local context
    remindAt = new Date(Date.UTC(
      userNow.getUTCFullYear(),
      userNow.getUTCMonth(),
      userNow.getUTCDate(),
      hours,
      mins,
      0,
      0
    ));

    // Convert back to actual UTC by adding the offset
    remindAt = new Date(remindAt.getTime() + timezoneOffset * 60000);

    // If time already passed today in user's timezone, set for tomorrow
    if (remindAt <= now) {
      remindAt.setUTCDate(remindAt.getUTCDate() + 1);
    }
  }
  // Check if it's minutes (e.g., "40")
  else if (/^\d+$/.test(timeStr)) {
    const minutes = parseInt(timeStr);
    remindAt = new Date(now.getTime() + minutes * 60000);
  } else {
    return null;
  }

  // Normalize to nearest minute (remove seconds and milliseconds) for better deduplication
  remindAt.setSeconds(0, 0);

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

  const { message, user_id, timezone_offset } = req.body;

  if (!message || !user_id) {
    return res.status(400).json({ error: 'Missing message or user_id' });
  }

  // timezone_offset: minutes offset from UTC (positive for west, negative for east)
  // e.g., Moscow (UTC+3) = -180, New York (UTC-5) = 300
  const userTimezoneOffset = typeof timezone_offset === 'number' ? timezone_offset : 0;

  console.log(`🕐 Timezone debug: received=${timezone_offset}, type=${typeof timezone_offset}, using=${userTimezoneOffset}`);

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
    let systemPrompt = getPromptByTone(userTone);

    // Загрузить активные цели пользователя
    const { data: userGoals } = await supabase
      .from('goals')
      .select('text, target_date')
      .eq('telegram_user_id', user_id)
      .eq('status', 'active')
      .order('target_date', { ascending: true });

    // Добавить блок целей к системному промпту
    systemPrompt += formatGoalsForPrompt(userGoals);

    console.log(`📝 User ${user_id} | Tone: ${userTone} | Goals: ${userGoals?.length || 0} | Message: ${message.substring(0, 50)}...`);

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
    const reminder = parseReminder(reply, userTimezoneOffset);
    if (reminder) {
      try {
        // Normalize message for better deduplication (trim and lowercase for comparison)
        const normalizedMessage = reminder.message.trim().toLowerCase();

        // Check for existing duplicate reminder before inserting
        // Use a time window of 1 minute for deduplication
        const reminderTime = new Date(reminder.remind_at);
        const timeWindowStart = new Date(reminderTime.getTime() - 60000).toISOString();
        const timeWindowEnd = new Date(reminderTime.getTime() + 60000).toISOString();

        const { data: existingReminders } = await supabase
          .from('reminders')
          .select('id, message')
          .eq('telegram_user_id', user_id)
          .eq('status', 'pending')
          .gte('remind_at', timeWindowStart)
          .lte('remind_at', timeWindowEnd);

        // Check if any existing reminder has similar message (case-insensitive)
        const isDuplicate = existingReminders?.some(r =>
          r.message.trim().toLowerCase() === normalizedMessage
        );

        if (!isDuplicate) {
          const { data: insertedReminder, error: insertError } = await supabase.from('reminders').insert({
            telegram_user_id: user_id,
            message: reminder.message,
            remind_at: reminder.remind_at,
            status: 'pending'
          }).select().single();

          if (insertError) {
            console.error(`❌ Failed to insert reminder:`, insertError);
          } else {
            const remindAtDate = new Date(reminder.remind_at);
            const userLocalTime = new Date(remindAtDate.getTime() - userTimezoneOffset * 60000);
            console.log(`⏰ Reminder created for ${user_id}:`);
            console.log(`   Message: ${reminder.message}`);
            console.log(`   UTC time: ${reminder.remind_at}`);
            console.log(`   User local time: ${userLocalTime.toISOString().replace('Z', '')} (offset: ${userTimezoneOffset}min)`);
            console.log(`   DB ID: ${insertedReminder?.id}`);
          }
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

    // Проверить и создать summary если нужно (каждые 50 сообщений пользователя)
    try {
      await checkAndCreateSummary(user_id);
    } catch (summaryError) {
      console.error('Error creating summary:', summaryError);
      // Don't fail the request if summary creation fails
    }

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
