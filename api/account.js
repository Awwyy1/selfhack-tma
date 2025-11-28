// api/account.js
// Объединённый endpoint для: промокодов и удаления аккаунта
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ success: false, message: 'user_id required' });
  }

  // ==================== APPLY PROMO ====================
  if (action === 'apply-promo') {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ success: false, message: 'Промокод не указан' });
    }

    try {
      // 1. Найти промокод в базе
      const { data: voucher, error: voucherError } = await supabase
        .from('premium_vouchers')
        .select('*')
        .eq('code', code.toUpperCase())
        .single();

      if (voucherError || !voucher) {
        return res.status(400).json({ 
          success: false, 
          message: 'Промокод недействителен или истёк' 
        });
      }

      // 2. Проверить срок действия промокода
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Срок действия промокода истёк' 
        });
      }

      // 3. Проверить лимит использований
      if (voucher.max_uses !== null && voucher.used_count >= voucher.max_uses) {
        return res.status(400).json({ 
          success: false, 
          message: 'Промокод больше не действителен' 
        });
      }

      // 4. Проверить, не использовал ли уже этот юзер
      const { data: existingUsage } = await supabase
        .from('voucher_usage')
        .select('id')
        .eq('voucher_id', voucher.id)
        .eq('user_id', user_id)
        .single();

      if (existingUsage) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ты уже использовал этот промокод' 
        });
      }

      // 5. Вычислить дату окончания Premium
      const daysToAdd = voucher.duration_days || 7;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysToAdd);

      // 6. Проверить есть ли уже подписка у пользователя
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('telegram_user_id', user_id)
        .single();

      if (existingSub) {
        // Обновить существующую подписку
        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            plan: 'PREMIUM',
            expires_at: expiresAt.toISOString(),
            status: 'active'
          })
          .eq('telegram_user_id', user_id);

        if (updateError) {
          console.error('Update subscription error:', updateError);
          return res.status(500).json({ 
            success: false, 
            message: 'Ошибка активации' 
          });
        }
      } else {
        // Создать новую подписку
        const { error: insertError } = await supabase
          .from('subscriptions')
          .insert({
            telegram_user_id: user_id,
            plan: 'PREMIUM',
            expires_at: expiresAt.toISOString(),
            status: 'active'
          });

        if (insertError) {
          console.error('Insert subscription error:', insertError);
          return res.status(500).json({ 
            success: false, 
            message: 'Ошибка активации' 
          });
        }
      }

      // 7. Записать использование промокода
      await supabase
        .from('voucher_usage')
        .insert({
          voucher_id: voucher.id,
          user_id: user_id,
          used_at: new Date().toISOString()
        });

      // 8. Увеличить used_count в промокоде
      await supabase
        .from('premium_vouchers')
        .update({ used_count: (voucher.used_count || 0) + 1 })
        .eq('id', voucher.id);

      // 9. Форматировать дату для ответа
      const months = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
      ];
      const day = expiresAt.getDate();
      const month = months[expiresAt.getMonth()];
      const year = expiresAt.getFullYear();
      const expiresAtFormatted = `${day} ${month} ${year}`;

      return res.status(200).json({
        success: true,
        message: `Premium активирован на ${daysToAdd} дней!`,
        expiresAt: expiresAtFormatted,
        plan: 'PREMIUM'
      });

    } catch (error) {
      console.error('Promo error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Ошибка сервера' 
      });
    }
  }

  // ==================== DELETE ACCOUNT ====================
  if (action === 'delete') {
    try {
      // Все таблицы используют telegram_user_id как int8
      const odtelegramUserId = user_id;
      
      console.log('Deleting data for user:', telegramUserId);

      // 1. Удалить историю чатов
      const { error: chatsError } = await supabase
        .from('telegram_chats')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (chatsError) console.error('Delete telegram_chats error:', chatsError);

      // 2. Удалить САММАРИ (правильное имя таблицы!)
      const { error: summariesError } = await supabase
        .from('message_summaries')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (summariesError) console.error('Delete message_summaries error:', summariesError);

      // 3. Удалить цели
      const { error: goalsError } = await supabase
        .from('goals')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (goalsError) console.error('Delete goals error:', goalsError);

      // 4. Удалить чекины
      const { error: checkinsError } = await supabase
        .from('checkins')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (checkinsError) console.error('Delete checkins error:', checkinsError);

      // 5. Удалить напоминания
      const { error: remindersError } = await supabase
        .from('reminders')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (remindersError) console.error('Delete reminders error:', remindersError);

      // 6. Удалить использования промокодов
      const { error: voucherError } = await supabase
        .from('voucher_usage')
        .delete()
        .eq('user_id', telegramUserId);
      if (voucherError) console.error('Delete voucher_usage error:', voucherError);

      // 7. Удалить настройки пользователя
      const { error: prefsError } = await supabase
        .from('user_preferences')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (prefsError) console.error('Delete user_preferences error:', prefsError);

      // 8. Удалить аналитику
      const { error: analyticsError } = await supabase
        .from('user_analytics')
        .delete()
        .eq('telegram_user_id', telegramUserId);
      if (analyticsError) console.error('Delete user_analytics error:', analyticsError);

      // 9. Пометить подписку как удалённую (НЕ удаляем - защита от абьюза)
      const { error: subsError } = await supabase
        .from('subscriptions')
        .update({ 
          status: 'deleted',
          plan: 'DELETED'
        })
        .eq('telegram_user_id', telegramUserId);
      if (subsError) console.error('Update subscriptions error:', subsError);

      return res.status(200).json({
        success: true,
        message: 'Все данные удалены'
      });

    } catch (error) {
      console.error('Delete account error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Ошибка сервера' 
      });
    }
  }

  // ==================== UNKNOWN ACTION ====================
  return res.status(400).json({ 
    success: false, 
    message: 'Неизвестное действие. Используй action: "apply-promo" или "delete"' 
  });
}
