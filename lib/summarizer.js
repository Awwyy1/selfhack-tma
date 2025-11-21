import { supabase } from './supabase.js';
import { anthropic } from './claude.js';

const SUMMARY_BLOCK_SIZE = 50;

// Создать summary для блока сообщений
export async function createSummary(userId, blockStart, blockEnd) {
  // Загрузить сообщения блока
  const { data: messages } = await supabase
    .from('telegram_chats')
    .select('role, content')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: true })
    .range(blockStart - 1, blockEnd - 1);

  if (!messages || messages.length === 0) return null;

  // Формируем диалог для Claude
  const dialogText = messages
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Коуч'}: ${m.content}`)
    .join('\n');

  // Запрос к Claude для создания summary
  const summaryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 300,
    temperature: 0.3,
    messages: [
      {
        role: 'user',
        content: `Ты коуч-ассистент. Сделай краткое резюме этого диалога (3-5 предложений).

ВАЖНО сохранить:
- Главные цели пользователя
- Ключевые проблемы и триггеры
- Прогресс и срывы
- Паттерны поведения

Диалог:
${dialogText}

Резюме (только факты, без воды):`
      }
    ]
  });

  const summaryText = summaryResponse.content[0].text;

  // Сохранить в базу
  await supabase.from('message_summaries').insert({
    telegram_user_id: userId,
    block_start: blockStart,
    block_end: blockEnd,
    summary: summaryText
  });

  console.log(`✅ Summary created for user ${userId}, block ${blockStart}-${blockEnd}`);
  return summaryText;
}

// Проверить нужно ли создавать новый summary
export async function checkAndCreateSummary(userId) {
  // Посчитать сколько всего сообщений у пользователя
  const { count: totalMessages } = await supabase
    .from('telegram_chats')
    .select('*', { count: 'exact', head: true })
    .eq('telegram_user_id', userId)
    .eq('role', 'user');

  console.log(`📊 Summary check for user ${userId}: ${totalMessages} user messages`);

  // Проверяем кратно ли 50
  if (totalMessages > 0 && totalMessages % SUMMARY_BLOCK_SIZE === 0) {
    const blockEnd = totalMessages * 2; // × 2 потому что user + assistant
    const blockStart = blockEnd - (SUMMARY_BLOCK_SIZE * 2) + 1;

    console.log(`📊 Creating summary for block ${blockStart}-${blockEnd}`);

    // Проверяем не создан ли уже этот summary
    const { data: existing } = await supabase
      .from('message_summaries')
      .select('id')
      .eq('telegram_user_id', userId)
      .eq('block_start', blockStart)
      .maybeSingle();

    if (!existing) {
      await createSummary(userId, blockStart, blockEnd);
    } else {
      console.log(`📊 Summary already exists for block ${blockStart}-${blockEnd}`);
    }
  }
}

// Создать все недостающие summaries для пользователя
export async function createMissingSummaries(userId) {
  // Посчитать сколько всего сообщений у пользователя
  const { count: totalMessages } = await supabase
    .from('telegram_chats')
    .select('*', { count: 'exact', head: true })
    .eq('telegram_user_id', userId)
    .eq('role', 'user');

  if (!totalMessages || totalMessages < SUMMARY_BLOCK_SIZE) {
    console.log(`📊 User ${userId} has only ${totalMessages} messages, need at least ${SUMMARY_BLOCK_SIZE} for summary`);
    return;
  }

  // Загрузить существующие summaries
  const { data: existingSummaries } = await supabase
    .from('message_summaries')
    .select('block_start, block_end')
    .eq('telegram_user_id', userId);

  const existingBlocks = new Set(existingSummaries?.map(s => s.block_start) || []);

  // Определить сколько блоков должно быть
  const completedBlocks = Math.floor(totalMessages / SUMMARY_BLOCK_SIZE);

  console.log(`📊 User ${userId}: ${totalMessages} messages, ${completedBlocks} blocks should exist, ${existingSummaries?.length || 0} exist`);

  // Создать недостающие summaries
  for (let i = 1; i <= completedBlocks; i++) {
    const blockEnd = i * SUMMARY_BLOCK_SIZE * 2;
    const blockStart = blockEnd - (SUMMARY_BLOCK_SIZE * 2) + 1;

    if (!existingBlocks.has(blockStart)) {
      console.log(`📊 Creating missing summary for block ${blockStart}-${blockEnd}`);
      try {
        await createSummary(userId, blockStart, blockEnd);
      } catch (err) {
        console.error(`❌ Failed to create summary for block ${blockStart}-${blockEnd}:`, err);
      }
    }
  }
}

// Загрузить все summaries + последние N сообщений
export async function loadConversationWithSummaries(userId, recentLimit = 50) {
  // 1. Загрузить все summaries
  const { data: summaries } = await supabase
    .from('message_summaries')
    .select('summary, block_start, block_end')
    .eq('telegram_user_id', userId)
    .order('block_start', { ascending: true });

  // 2. Загрузить последние N сообщений
  const { data: recentMessages } = await supabase
    .from('telegram_chats')
    .select('role, content')
    .eq('telegram_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(recentLimit);

  // 3. Формируем итоговый массив для Claude
  const messages = [];

  // Добавляем summaries как контекст
  if (summaries && summaries.length > 0) {
    summaries.forEach(s => {
      messages.push({
        role: 'user',
        content: `[КОНТЕКСТ сообщений ${s.block_start}-${s.block_end}] ${s.summary}`
      });
    });
  }

  // Добавляем последние сообщения
  if (recentMessages && recentMessages.length > 0) {
    messages.push(...recentMessages.reverse());
  }

  return messages;
}
