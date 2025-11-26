import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_id, confirmation } = req.body;

  if (!user_id) {
    return res.status(400).json({
      error: 'Missing user_id',
      message: 'Не указан пользователь'
    });
  }

  // Требуем подтверждение для безопасности
  if (confirmation !== 'DELETE') {
    return res.status(400).json({
      error: 'Missing confirmation',
      message: 'Для удаления аккаунта отправь слово DELETE'
    });
  }

  try {
    // Удаляем все данные пользователя из всех таблиц
    // Порядок важен из-за foreign key constraints

    // 1. Удалить напоминания
    await supabase
      .from('reminders')
      .delete()
      .eq('telegram_user_id', user_id);

    // 2. Удалить использование промокодов
    await supabase
      .from('promo_usage')
      .delete()
      .eq('telegram_user_id', user_id);

    // 3. Удалить чекины
    await supabase
      .from('checkins')
      .delete()
      .eq('telegram_user_id', user_id);

    // 4. Удалить цели
    await supabase
      .from('goals')
      .delete()
      .eq('telegram_user_id', user_id);

    // 5. Удалить историю чата
    await supabase
      .from('telegram_chats')
      .delete()
      .eq('telegram_user_id', user_id);

    // 6. Удалить саммари разговоров
    await supabase
      .from('conversation_summaries')
      .delete()
      .eq('telegram_user_id', user_id);

    // 7. Удалить подписку
    await supabase
      .from('subscriptions')
      .delete()
      .eq('telegram_user_id', user_id);

    // 8. Удалить настройки пользователя
    await supabase
      .from('user_preferences')
      .delete()
      .eq('telegram_user_id', user_id);

    // 9. Удалить обращения в поддержку
    await supabase
      .from('support_tickets')
      .delete()
      .eq('telegram_user_id', user_id);

    console.log(`✅ Account deleted: user ${user_id}`);

    return res.status(200).json({
      success: true,
      message: 'Аккаунт полностью удалён. Все твои данные стёрты.'
    });

  } catch (error) {
    console.error('❌ Delete account API error:', error);
    return res.status(500).json({
      error: 'Internal error',
      message: 'Ошибка при удалении аккаунта'
    });
  }
}
